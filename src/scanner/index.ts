import fs from 'node:fs';
import path from 'node:path';
import { shannonEntropy } from './entropy.js';
import rulesData from './rules.json' with { type: 'json' };

// ─── Types ───

export type SecretFinding = {
  ruleId: string;
  description: string;
  filePath: string;
  line: number;
  secret: string; // redacted
};

export type ScanResult = {
  findings: SecretFinding[];
  filesScanned: number;
  filesSkipped: number;
  rulesLoaded: number;
  durationMs: number;
};

type FileInfo = {
  path: string;
  size: number;
};

// ─── Constants ───

const BINARY_EXTENSIONS = new Set([
  '.sqlite', '.db', '.sqlite3', '.sqlite-wal', '.sqlite-shm',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff', '.tif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.gz', '.tar', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.eot', '.ttf', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.lock', '.wal', '.shm',
]);

const MAX_FILE_SIZE = 1_000_000; // 1MB

// ─── Rule compilation ───

interface CompiledRule {
  id: string;
  description: string;
  regex: RegExp;
  keywords: string[];
  secretGroup: number;
  entropy: number | null;
  pathRegex: RegExp | null;
  allowlist: {
    regexTarget?: string;
    regexes?: RegExp[];
    paths?: RegExp[];
    stopwords?: Set<string>;
    condition?: string;
  } | null;
  isMultiline: boolean;
}

function compileRegex(pattern: string): RegExp | null {
  try {
    let flags = '';
    let p = pattern;

    // If (?i) appears anywhere, use the i flag globally (slightly more permissive but safe)
    if (p.includes('(?i)')) {
      flags = 'i';
    }
    // Strip all standalone (?i) inline toggles
    p = p.replace(/\(\?i\)/g, '');

    // Strip scoped inline flag groups: (?-i:...) and (?i:...) → (?:...)
    p = p.replace(/\(\?-i:((?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*)\)/g, '(?:$1)');
    p = p.replace(/\(\?i:((?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*)\)/g, '(?:$1)');
    return new RegExp(p, flags);
  } catch {
    return null;
  }
}

let compiledRules: CompiledRule[] | null = null;
let globalPathRegexes: RegExp[] | null = null;
let globalContentRegexes: RegExp[] | null = null;
let globalStopwords: Set<string> | null = null;

function getCompiledRules() {
  if (compiledRules) return compiledRules;

  compiledRules = [];
  for (const rule of rulesData.rules) {
    const regex = compileRegex(rule.regex);
    if (!regex) continue;

    let allowlist: CompiledRule['allowlist'] = null;
    if (rule.allowlist) {
      const al = rule.allowlist as {
        regexTarget?: string;
        regexes?: string[];
        paths?: string[];
        stopwords?: string[];
        condition?: string;
      };
      const compiledRegexes: RegExp[] = [];
      if (al.regexes) {
        for (const r of al.regexes) {
          const compiled = compileRegex(r);
          if (compiled) compiledRegexes.push(compiled);
        }
      }
      const compiledPaths: RegExp[] = [];
      if (al.paths) {
        for (const p of al.paths) {
          try { compiledPaths.push(new RegExp(p, 'i')); } catch { /* skip */ }
        }
      }
      allowlist = {
        regexTarget: al.regexTarget,
        regexes: compiledRegexes.length ? compiledRegexes : undefined,
        paths: compiledPaths.length ? compiledPaths : undefined,
        stopwords: al.stopwords?.length ? new Set(al.stopwords.map(s => s.toLowerCase())) : undefined,
        condition: al.condition,
      };
    }

    let pathRegex: RegExp | null = null;
    if (rule.path) {
      try { pathRegex = new RegExp(rule.path, 'i'); } catch { /* skip */ }
    }

    compiledRules.push({
      id: rule.id,
      description: rule.description,
      regex,
      keywords: rule.keywords,
      secretGroup: rule.secretGroup,
      entropy: rule.entropy,
      pathRegex,
      allowlist,
      isMultiline: rule.regex.includes('[\\s\\S]') || rule.regex.includes('[\\S\\s]'),
    });
  }

  return compiledRules;
}

function getGlobalAllowlists() {
  if (globalPathRegexes) return { paths: globalPathRegexes, regexes: globalContentRegexes!, stopwords: globalStopwords! };

  globalPathRegexes = [];
  for (const p of rulesData.globalAllowlist.paths) {
    const compiled = compileRegex(p);
    if (compiled) globalPathRegexes.push(compiled);
  }

  globalContentRegexes = [];
  for (const r of rulesData.globalAllowlist.regexes) {
    const compiled = compileRegex(r);
    if (compiled) globalContentRegexes.push(compiled);
  }

  globalStopwords = new Set(rulesData.globalAllowlist.stopwords.map((s: string) => s.toLowerCase()));

  return { paths: globalPathRegexes, regexes: globalContentRegexes, stopwords: globalStopwords };
}

// ─── Scanning ───

function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function redactSecret(secret: string): string {
  if (secret.length <= 8) return '****';
  return secret.slice(0, 4) + '...' + secret.slice(-2);
}

function matchesGlobalContentAllowlist(text: string): boolean {
  const { regexes, stopwords } = getGlobalAllowlists();
  for (const re of regexes) {
    if (re.test(text)) return true;
  }
  if (stopwords.has(text.toLowerCase())) return true;
  return false;
}

function matchesRuleAllowlist(rule: CompiledRule, matchText: string, fullLine: string, filePath: string): boolean {
  if (!rule.allowlist) return false;
  const al = rule.allowlist;

  // Determine if we need to match all conditions (AND) or any (OR, default)
  const useAnd = al.condition === 'AND';

  let pathMatch: boolean | null = null;
  let regexMatch: boolean | null = null;

  // Check path allowlist
  if (al.paths?.length) {
    pathMatch = al.paths.some(re => re.test(filePath));
  }

  // Check regex allowlist
  if (al.regexes?.length) {
    const target = al.regexTarget === 'line' ? fullLine : matchText;
    regexMatch = al.regexes.some(re => re.test(target));
  }

  // Check stopwords
  if (al.stopwords?.size) {
    if (al.stopwords.has(matchText.toLowerCase())) return true;
  }

  if (useAnd) {
    // AND: all non-null conditions must be true
    if (pathMatch !== null && regexMatch !== null) return pathMatch && regexMatch;
    if (pathMatch !== null) return pathMatch;
    if (regexMatch !== null) return regexMatch;
    return false;
  } else {
    // OR: any condition can be true
    if (pathMatch) return true;
    if (regexMatch) return true;
    return false;
  }
}

function scanFileContent(
  content: string,
  filePath: string,
  rules: CompiledRule[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');
  const contentLower = content.toLowerCase();

  // Build keyword → rules index for single-line rules
  const keywordMap = new Map<string, CompiledRule[]>();
  const noKeywordRules: CompiledRule[] = [];
  const multilineRules: CompiledRule[] = [];

  for (const rule of rules) {
    // Skip rules with path restrictions that don't match
    if (rule.pathRegex && !rule.pathRegex.test(filePath)) continue;

    if (rule.isMultiline) {
      multilineRules.push(rule);
      continue;
    }

    if (rule.keywords.length === 0) {
      noKeywordRules.push(rule);
      continue;
    }

    for (const kw of rule.keywords) {
      if (!keywordMap.has(kw)) keywordMap.set(kw, []);
      keywordMap.get(kw)!.push(rule);
    }
  }

  // Process multiline rules (run against full content if keyword found)
  for (const rule of multilineRules) {
    const hasKeyword = rule.keywords.length === 0 ||
      rule.keywords.some(kw => contentLower.includes(kw));
    if (!hasKeyword) continue;

    rule.regex.lastIndex = 0;
    const m = rule.regex.exec(content);
    if (!m) continue;

    const secretIdx = rule.secretGroup || 0;
    const secret = m[secretIdx] || m[0];

    if (rule.entropy !== null && shannonEntropy(secret) < rule.entropy) continue;
    if (matchesGlobalContentAllowlist(secret)) continue;
    if (matchesRuleAllowlist(rule, secret, m[0], filePath)) continue;

    // Find line number
    const matchPos = m.index;
    let lineNum = 1;
    for (let i = 0; i < matchPos && i < content.length; i++) {
      if (content[i] === '\n') lineNum++;
    }

    findings.push({
      ruleId: rule.id,
      description: rule.description,
      filePath,
      line: lineNum,
      secret: redactSecret(secret),
    });
  }

  // Process single-line rules
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineLower = line.toLowerCase();

    // Collect candidate rules via keyword pre-filter
    const candidates = new Set<CompiledRule>();
    for (const [kw, kwRules] of keywordMap) {
      if (lineLower.includes(kw)) {
        for (const r of kwRules) candidates.add(r);
      }
    }
    // Always-test rules
    for (const r of noKeywordRules) candidates.add(r);

    if (candidates.size === 0) continue;

    for (const rule of candidates) {
      rule.regex.lastIndex = 0;
      const m = rule.regex.exec(line);
      if (!m) continue;

      const secretIdx = rule.secretGroup || 0;
      const secret = m[secretIdx] || m[0];

      // Entropy check
      if (rule.entropy !== null && shannonEntropy(secret) < rule.entropy) continue;

      // Global content allowlist
      if (matchesGlobalContentAllowlist(secret)) continue;

      // Per-rule allowlist
      if (matchesRuleAllowlist(rule, secret, line, filePath)) continue;

      findings.push({
        ruleId: rule.id,
        description: rule.description,
        filePath,
        line: lineIdx + 1,
        secret: redactSecret(secret),
      });

      // One finding per rule per line is enough
      break;
    }
  }

  return findings;
}

// ─── Public API ───

export async function scanFiles(
  files: FileInfo[],
  baseDir: string,
): Promise<ScanResult> {
  const start = Date.now();
  const rules = getCompiledRules();
  const globalAllow = getGlobalAllowlists();
  const findings: SecretFinding[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;

  for (const file of files) {
    // Skip binary files
    if (isBinaryFile(file.path)) {
      filesSkipped++;
      continue;
    }

    // Skip large files
    if (file.size > MAX_FILE_SIZE) {
      filesSkipped++;
      continue;
    }

    // Check global path allowlist
    if (globalAllow.paths.some(re => re.test(file.path))) {
      filesSkipped++;
      continue;
    }

    // Read file content
    const fullPath = path.join(baseDir, file.path);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      filesSkipped++;
      continue;
    }

    // Null byte check (binary file that wasn't caught by extension)
    if (content.includes('\0')) {
      filesSkipped++;
      continue;
    }

    const fileFindings = scanFileContent(content, file.path, rules);
    findings.push(...fileFindings);
    filesScanned++;
  }

  return {
    findings,
    filesScanned,
    filesSkipped,
    rulesLoaded: rules.length,
    durationMs: Date.now() - start,
  };
}

export function formatFindings(findings: SecretFinding[]): string {
  const lines: string[] = [];
  lines.push(`\n\u26a0 Found ${findings.length} potential secret(s):\n`);

  for (const f of findings) {
    lines.push(`  ${f.filePath}:${f.line}`);
    lines.push(`    ${f.description.split(',')[0]} (${f.ruleId})\n`);
  }

  return lines.join('\n');
}
