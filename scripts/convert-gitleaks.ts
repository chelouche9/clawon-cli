#!/usr/bin/env npx tsx
/**
 * Dev-only script: Downloads gitleaks.toml and converts it to src/scanner/rules.json.
 *
 * Usage: npx tsx scripts/convert-gitleaks.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'scanner', 'rules.json');

const GITLEAKS_TOML_URL =
  'https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml';

// ─── Minimal TOML parser (only the subset gitleaks uses) ───

interface RawRule {
  id: string;
  description: string;
  regex: string;
  keywords: string[];
  entropy?: number;
  secretGroup?: number;
  path?: string;
  allowlists?: RawAllowlist[];
}

interface RawAllowlist {
  description?: string;
  regexTarget?: string;
  regexes?: string[];
  paths?: string[];
  stopwords?: string[];
  condition?: string;
}

interface GlobalAllowlist {
  paths: string[];
  regexes: string[];
  stopwords: string[];
}

function parseTOML(text: string): { globalAllowlist: GlobalAllowlist; rules: RawRule[] } {
  const lines = text.split('\n');
  const rules: RawRule[] = [];
  const globalAllowlist: GlobalAllowlist = { paths: [], regexes: [], stopwords: [] };

  let currentRule: Partial<RawRule> | null = null;
  let currentAllowlist: Partial<RawAllowlist> | null = null;
  let inGlobalAllowlist = false;
  let arrayKey: string | null = null;
  let arrayBuffer: string[] = [];
  let inMultilineString = false;
  let multilineKey = '';
  let multilineBuffer = '';

  function flushArray(target: Record<string, unknown>) {
    if (arrayKey) {
      target[arrayKey] = arrayBuffer;
      arrayKey = null;
      arrayBuffer = [];
    }
  }

  function flushRule() {
    if (currentAllowlist && currentRule) {
      if (!currentRule.allowlists) currentRule.allowlists = [];
      currentRule.allowlists.push(currentAllowlist as RawAllowlist);
      currentAllowlist = null;
    }
    if (currentRule && currentRule.id && currentRule.regex) {
      rules.push(currentRule as RawRule);
    }
    currentRule = null;
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle multiline strings (triple quotes)
    if (inMultilineString) {
      if (line.includes("'''")) {
        multilineBuffer += line.slice(0, line.indexOf("'''"));
        const target = currentAllowlist || (inGlobalAllowlist ? globalAllowlist : currentRule);
        if (target) (target as Record<string, unknown>)[multilineKey] = multilineBuffer;
        inMultilineString = false;
        multilineKey = '';
        multilineBuffer = '';
      } else {
        multilineBuffer += line + '\n';
      }
      continue;
    }

    // Strip comments (but not inside strings)
    const commentIdx = line.indexOf('#');
    if (commentIdx >= 0) {
      // Only strip if not inside a string
      const beforeComment = line.slice(0, commentIdx);
      const singleQuotes = (beforeComment.match(/'/g) || []).length;
      const tripleQuotes = (beforeComment.match(/'''/g) || []).length;
      if (singleQuotes % 2 === 0 && tripleQuotes % 2 === 0) {
        line = beforeComment;
      }
    }
    line = line.trim();
    if (!line) continue;

    // Section headers
    if (line === '[[rules]]') {
      const target = currentAllowlist || (inGlobalAllowlist ? globalAllowlist : currentRule);
      if (target) flushArray(target as Record<string, unknown>);
      if (currentAllowlist && currentRule) {
        if (!currentRule.allowlists) currentRule.allowlists = [];
        currentRule.allowlists.push(currentAllowlist as RawAllowlist);
        currentAllowlist = null;
      }
      flushRule();
      currentRule = {};
      inGlobalAllowlist = false;
      continue;
    }
    if (line === '[[rules.allowlists]]') {
      const target = currentAllowlist || (inGlobalAllowlist ? globalAllowlist : currentRule);
      if (target) flushArray(target as Record<string, unknown>);
      if (currentAllowlist && currentRule) {
        if (!currentRule.allowlists) currentRule.allowlists = [];
        currentRule.allowlists.push(currentAllowlist as RawAllowlist);
      }
      currentAllowlist = {};
      continue;
    }
    if (line === '[allowlist]') {
      const target = currentAllowlist || currentRule;
      if (target) flushArray(target as Record<string, unknown>);
      flushRule();
      inGlobalAllowlist = true;
      continue;
    }
    // Skip top-level metadata
    if (line.startsWith('[') && line.endsWith(']')) continue;

    // Array continuation lines
    if (arrayKey) {
      // Standalone closing bracket
      if (line === ']') {
        const target = currentAllowlist || (inGlobalAllowlist ? globalAllowlist : currentRule);
        if (target) flushArray(target as Record<string, unknown>);
        continue;
      }
      // Lines with quoted values
      if (line.startsWith("'''") || line.startsWith('"') || line.startsWith("'")) {
        const values = parseArrayLine(line);
        arrayBuffer.push(...values);
        continue;
      }
    }

    // Key = value parsing
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Array start
    if (value.startsWith('[')) {
      if (value.endsWith(']')) {
        // Single-line array
        const values = parseArrayLine(value);
        const target = currentAllowlist || (inGlobalAllowlist ? globalAllowlist : currentRule);
        if (target) (target as Record<string, unknown>)[key] = values;
      } else {
        // Multi-line array
        arrayKey = key;
        arrayBuffer = parseArrayLine(value);
      }
      continue;
    }

    // Triple-quoted string
    if (value.startsWith("'''")) {
      const rest = value.slice(3);
      const endIdx = rest.indexOf("'''");
      if (endIdx >= 0) {
        const strVal = rest.slice(0, endIdx);
        const target = currentAllowlist || (inGlobalAllowlist ? globalAllowlist : currentRule);
        if (target) (target as Record<string, unknown>)[key] = strVal;
      } else {
        inMultilineString = true;
        multilineKey = key;
        multilineBuffer = rest + '\n';
      }
      continue;
    }

    // Regular string or number
    const parsed = parseValue(value);
    const target = currentAllowlist || (inGlobalAllowlist ? globalAllowlist : currentRule);
    if (target) (target as Record<string, unknown>)[key] = parsed;
  }

  // Flush remaining
  const target = currentAllowlist || (inGlobalAllowlist ? globalAllowlist : currentRule);
  if (target) flushArray(target as Record<string, unknown>);
  if (currentAllowlist && currentRule) {
    if (!currentRule.allowlists) currentRule.allowlists = [];
    currentRule.allowlists.push(currentAllowlist as RawAllowlist);
  }
  if (currentRule) flushRule();

  return { globalAllowlist, rules };
}

function parseArrayLine(line: string): string[] {
  const results: string[] = [];
  // Match triple-quoted, single-quoted, or double-quoted strings
  const regex = /'''([\s\S]*?)'''|'([^']*)'|"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    results.push(m[1] ?? m[2] ?? m[3]);
  }
  return results;
}

function parseValue(s: string): string | number | boolean {
  // Remove trailing comma
  s = s.replace(/,\s*$/, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  // Strip quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── PCRE → JS regex transforms ───

function convertRegex(pcre: string): string | null {
  let js = pcre;

  // (?P<name>...) → (?<name>...)
  js = js.replace(/\(\?P<([^>]+)>/g, '(?<$1>');

  // Possessive quantifiers: ++→+, *+→*, ?+→?
  js = js.replace(/\+\+/g, '+');
  js = js.replace(/\*\+/g, '*');
  js = js.replace(/\?\+/g, '?');

  // POSIX character classes: [[:alnum:]] → [a-zA-Z0-9]
  js = js.replace(/\[:alnum:]/g, 'a-zA-Z0-9');
  js = js.replace(/\[:alpha:]/g, 'a-zA-Z');
  js = js.replace(/\[:digit:]/g, '0-9');

  // (?s:.) — dot-all scoped → [\s\S]
  js = js.replace(/\(\?s:\.\)/g, '[\\s\\S]');
  // (?s:...) — dot-all scoped groups, replace . with [\s\S] inside
  js = js.replace(/\(\?s:((?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*)\)/g, (_match, inner) => {
    return '(?:' + inner.replace(/(?<!\\)\./g, '[\\s\\S]') + ')';
  });

  // (?-i:...) — turn off case-insensitive scoped — JS doesn't support inline mode toggles well
  // We'll leave (?i) and (?-i:...) as-is since they may cause RegExp failures; handle below.

  // \z → $ (end of string)
  js = js.replace(/\\z/g, '$');

  // Validate
  try {
    // Test with case-insensitive and dotall flags
    // Remove inline flags (?i) and (?-i:...) for validation
    let testPattern = js;
    testPattern = testPattern.replace(/\(\?i\)/g, '');
    testPattern = testPattern.replace(/\(\?-i:([^)]*)\)/g, '(?:$1)');
    testPattern = testPattern.replace(/\(\?i:([^)]*)\)/g, '(?:$1)');
    new RegExp(testPattern);
    return js;
  } catch {
    return null;
  }
}

// ─── Main ───

async function main() {
  console.log('Downloading gitleaks.toml...');
  const res = await fetch(GITLEAKS_TOML_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const toml = await res.text();

  console.log('Parsing TOML...');
  const { globalAllowlist, rules: rawRules } = parseTOML(toml);

  console.log(`Found ${rawRules.length} raw rules`);

  // Convert rules
  let skipped = 0;
  const rules: Array<{
    id: string;
    description: string;
    regex: string;
    keywords: string[];
    secretGroup: number;
    entropy: number | null;
    path: string | null;
    allowlist: RawAllowlist | null;
  }> = [];

  for (const raw of rawRules) {
    const jsRegex = convertRegex(raw.regex);
    if (!jsRegex) {
      console.warn(`  ⚠ Skipping rule "${raw.id}": regex not JS-compatible`);
      skipped++;
      continue;
    }

    // Convert per-rule allowlist regexes too
    let allowlist: RawAllowlist | null = null;
    if (raw.allowlists && raw.allowlists.length > 0) {
      // Merge multiple allowlist blocks
      const mergedRegexes: string[] = [];
      const mergedPaths: string[] = [];
      const mergedStopwords: string[] = [];
      let regexTarget = 'match';
      let condition: string | undefined;

      for (const al of raw.allowlists) {
        if (al.regexTarget) regexTarget = al.regexTarget;
        if (al.condition) condition = al.condition;
        if (al.regexes) {
          for (const r of al.regexes) {
            const converted = convertRegex(r);
            if (converted) mergedRegexes.push(converted);
          }
        }
        if (al.paths) mergedPaths.push(...al.paths);
        if (al.stopwords) mergedStopwords.push(...al.stopwords);
      }

      if (mergedRegexes.length || mergedPaths.length || mergedStopwords.length) {
        allowlist = {
          ...(mergedRegexes.length ? { regexes: mergedRegexes, regexTarget } : {}),
          ...(mergedPaths.length ? { paths: mergedPaths } : {}),
          ...(mergedStopwords.length ? { stopwords: mergedStopwords } : {}),
          ...(condition ? { condition } : {}),
        };
      }
    }

    // Convert path regex if present
    let pathRegex: string | null = null;
    if (raw.path) {
      const converted = convertRegex(raw.path);
      if (converted) pathRegex = converted;
    }

    rules.push({
      id: raw.id,
      description: raw.description,
      regex: jsRegex,
      keywords: (raw.keywords || []).map(k => k.toLowerCase()),
      secretGroup: raw.secretGroup ?? 0,
      entropy: raw.entropy ?? null,
      path: pathRegex,
      allowlist,
    });
  }

  // Convert global allowlist path regexes
  const globalPaths: string[] = [];
  for (const p of globalAllowlist.paths || []) {
    const converted = convertRegex(p);
    if (converted) globalPaths.push(converted);
  }

  const globalRegexes: string[] = [];
  for (const r of globalAllowlist.regexes || []) {
    const converted = convertRegex(r);
    if (converted) globalRegexes.push(converted);
  }

  const output = {
    globalAllowlist: {
      paths: globalPaths,
      regexes: globalRegexes,
      stopwords: globalAllowlist.stopwords || [],
    },
    rules,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\n✓ Generated ${OUTPUT_PATH}`);
  console.log(`  Rules: ${rules.length} (skipped ${skipped})`);
  console.log(`  Global allowlist paths: ${globalPaths.length}`);
  console.log(`  Global allowlist regexes: ${globalRegexes.length}`);
  console.log(`  File size: ${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error('✗ Conversion failed:', err);
  process.exit(1);
});
