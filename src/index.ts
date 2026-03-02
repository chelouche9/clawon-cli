#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.clawport');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');

type ClawportConfig = {
  apiKey: string;
  profileId: string;
  apiBaseUrl: string;
  connectedAt: string;
};

type FileInfo = {
  path: string;
  size: number;
  content?: string;
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readConfig(): ClawportConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(cfg: ClawportConfig) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─────────────────────────────────────────────────────────────
// API Helpers
// ─────────────────────────────────────────────────────────────

async function api(
  baseUrl: string,
  endpoint: string,
  method: 'GET' | 'POST',
  apiKey: string,
  body?: unknown
) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-clawport-api-key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || json.message || `HTTP ${res.status}`);
  return json;
}

// ─────────────────────────────────────────────────────────────
// OpenClaw File Discovery
// ─────────────────────────────────────────────────────────────

const INCLUDE_PATTERNS = [
  'workspace/*.md',
  'workspace/memory/*.md',
  'workspace/memory/**/*.md',
  'workspace/skills/**',
  'workspace/canvas/**',
  'skills/**',
  'agents/*/config.json',
];

const EXCLUDE_PATTERNS = [
  'credentials/**',
  'agents/*/sessions/**',
  'memory/lancedb/**',
  'memory/*.sqlite',
  '*.lock',
  '*.wal',
  '*.shm',
  'node_modules/**',
  '.git/**',
  '.DS_Store',
  'Thumbs.db',
];

function matchGlob(filePath: string, pattern: string): boolean {
  let regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '(.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${regexPattern}$`).test(filePath);
}

function shouldInclude(relativePath: string): boolean {
  for (const pattern of EXCLUDE_PATTERNS) {
    if (matchGlob(relativePath, pattern)) return false;
  }
  for (const pattern of INCLUDE_PATTERNS) {
    if (matchGlob(relativePath, pattern)) return true;
  }
  return false;
}

function discoverFiles(baseDir: string): FileInfo[] {
  const files: FileInfo[] = [];

  function walk(dir: string, relativePath: string = '') {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (shouldInclude(relPath)) {
          const stats = fs.statSync(fullPath);
          files.push({
            path: relPath,
            size: stats.size,
          });
        }
      }
    }
  }

  walk(baseDir);
  return files;
}

// ─────────────────────────────────────────────────────────────
// CLI Program
// ─────────────────────────────────────────────────────────────

const program = new Command();
program.name('clawport').description('Backup and restore your OpenClaw workspace').version('1.0.0');

// ─────────────────────────────────────────────────────────────
// clawport login
// ─────────────────────────────────────────────────────────────

program
  .command('login')
  .description('Connect to ClawPort with your API key')
  .requiredOption('--api-key <key>', 'Your ClawPort API key')
  .option('--api-url <url>', 'API base URL', 'http://localhost:3001')
  .action(async (opts) => {
    try {
      const connectJson = await api(opts.apiUrl, '/api/v1/profile/connect', 'POST', opts.apiKey, {
        profileName: 'default',
        instanceName: os.hostname(),
        syncIntervalMinutes: 60,
      });

      writeConfig({
        apiKey: opts.apiKey,
        profileId: connectJson.profileId,
        apiBaseUrl: opts.apiUrl,
        connectedAt: new Date().toISOString(),
      });

      console.log('✓ Logged in');
      console.log(`  Profile ID: ${connectJson.profileId}`);
    } catch (e) {
      console.error(`✗ Login failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawport backup
// ─────────────────────────────────────────────────────────────

program
  .command('backup')
  .description('Backup your OpenClaw workspace to the cloud')
  .option('--dry-run', 'Show what would be backed up without uploading')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawport login --api-key <key>');
      process.exit(1);
    }

    if (!fs.existsSync(OPENCLAW_DIR)) {
      console.error(`✗ OpenClaw directory not found: ${OPENCLAW_DIR}`);
      process.exit(1);
    }

    console.log('Discovering files...');
    const files = discoverFiles(OPENCLAW_DIR);

    if (files.length === 0) {
      console.error('✗ No files found to backup');
      process.exit(1);
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const categories = {
      workspace: files.filter(f => f.path.startsWith('workspace/')),
      skills: files.filter(f => f.path.startsWith('skills/')),
      agents: files.filter(f => f.path.startsWith('agents/')),
    };

    console.log(`Found ${files.length} files (${(totalSize / 1024).toFixed(1)} KB):`);
    if (categories.workspace.length) console.log(`  • workspace: ${categories.workspace.length} files`);
    if (categories.skills.length) console.log(`  • skills: ${categories.skills.length} files`);
    if (categories.agents.length) console.log(`  • agents: ${categories.agents.length} files`);

    if (opts.dryRun) {
      console.log('\n[Dry run] Files that would be backed up:');
      files.forEach(f => console.log(`  ${f.path} (${f.size} bytes)`));
      return;
    }

    try {
      // Step 1: Create snapshot record and get signed upload URLs
      console.log('\nCreating backup...');
      const { snapshotId, uploadUrls } = await api(
        cfg.apiBaseUrl,
        '/api/v1/backups/prepare',
        'POST',
        cfg.apiKey,
        {
          profileId: cfg.profileId,
          files: files.map(f => ({ path: f.path, size: f.size })),
        }
      );

      // Step 2: Upload each file via signed URLs
      console.log(`Uploading ${files.length} files...`);
      let uploaded = 0;

      for (const file of files) {
        const fullPath = path.join(OPENCLAW_DIR, file.path);
        const content = fs.readFileSync(fullPath);

        const uploadRes = await fetch(uploadUrls[file.path], {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: content,
        });

        if (!uploadRes.ok) {
          const errText = await uploadRes.text();
          throw new Error(`Failed to upload ${file.path}: ${uploadRes.status} ${errText}`);
        }

        uploaded++;
        process.stdout.write(`\r  Uploaded: ${uploaded}/${files.length}`);
      }
      console.log('');

      // Step 3: Confirm backup
      await api(cfg.apiBaseUrl, '/api/v1/backups/confirm', 'POST', cfg.apiKey, {
        snapshotId,
        profileId: cfg.profileId,
      });

      console.log('\n✓ Backup complete!');
      console.log(`  Snapshot ID: ${snapshotId}`);
      console.log(`  Files: ${files.length}`);
      console.log(`  Size: ${(totalSize / 1024).toFixed(1)} KB`);
    } catch (e) {
      console.error(`\n✗ Backup failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawport restore
// ─────────────────────────────────────────────────────────────

program
  .command('restore')
  .description('Restore your OpenClaw workspace from the cloud')
  .option('--snapshot <id>', 'Specific snapshot ID to restore (default: latest)')
  .option('--dry-run', 'Show what would be restored without extracting')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawport login --api-key <key>');
      process.exit(1);
    }

    try {
      // Get snapshot info, file list, and signed download URLs
      console.log('Fetching backup...');
      const { snapshot, files, downloadUrls } = await api(
        cfg.apiBaseUrl,
        '/api/v1/backups/download',
        'POST',
        cfg.apiKey,
        {
          profileId: cfg.profileId,
          snapshotId: opts.snapshot || null,
        }
      );

      const totalSize = files.reduce((sum: number, f: FileInfo) => sum + f.size, 0);

      console.log(`Found backup from ${new Date(snapshot.created_at).toLocaleString()}`);
      console.log(`  Files: ${files.length}`);
      console.log(`  Size: ${(totalSize / 1024).toFixed(1)} KB`);

      if (opts.dryRun) {
        console.log('\n[Dry run] Files that would be restored:');
        files.forEach((f: FileInfo) => console.log(`  ${f.path}`));
        return;
      }

      // Download and restore each file via signed URLs
      console.log('\nDownloading files...');
      let downloaded = 0;

      for (const file of files as FileInfo[]) {
        const res = await fetch(downloadUrls[file.path]);
        if (!res.ok) {
          throw new Error(`Failed to download ${file.path}: ${res.status}`);
        }

        const content = Buffer.from(await res.arrayBuffer());
        const targetPath = path.join(OPENCLAW_DIR, file.path);

        // Ensure directory exists
        ensureDir(path.dirname(targetPath));

        // Write file
        fs.writeFileSync(targetPath, content);

        downloaded++;
        process.stdout.write(`\r  Downloaded: ${downloaded}/${files.length}`);
      }
      console.log('');

      console.log('\n✓ Restore complete!');
      console.log(`  Restored to: ${OPENCLAW_DIR}`);
      console.log(`  Files: ${files.length}`);
    } catch (e) {
      console.error(`\n✗ Restore failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawport list
// ─────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List your backups')
  .option('--limit <n>', 'Number of backups to show', '10')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawport login --api-key <key>');
      process.exit(1);
    }

    try {
      const { snapshots } = await api(
        cfg.apiBaseUrl,
        `/api/v1/snapshots/list?profileId=${cfg.profileId}&limit=${opts.limit}`,
        'GET',
        cfg.apiKey
      );

      if (!snapshots?.length) {
        console.log('No backups yet. Run: clawport backup');
        return;
      }

      console.log('Your backups:\n');
      console.log('ID                                   | Date                 | Files | Size');
      console.log('─'.repeat(80));

      for (const s of snapshots) {
        const date = new Date(s.created_at).toLocaleString();
        const size = s.size_bytes ? `${(s.size_bytes / 1024).toFixed(1)} KB` : 'N/A';
        const files = s.changed_files_count || 'N/A';
        console.log(`${s.id} | ${date.padEnd(20)} | ${String(files).padEnd(5)} | ${size}`);
      }

      console.log(`\nTotal: ${snapshots.length} backup(s)`);
    } catch (e) {
      console.error(`✗ Failed to list backups: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawport files
// ─────────────────────────────────────────────────────────────

program
  .command('files')
  .description('List files in a backup')
  .option('--snapshot <id>', 'Snapshot ID (default: latest)')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawport login --api-key <key>');
      process.exit(1);
    }

    try {
      const { snapshot, files } = await api(
        cfg.apiBaseUrl,
        '/api/v1/backups/files',
        'POST',
        cfg.apiKey,
        {
          profileId: cfg.profileId,
          snapshotId: opts.snapshot || null,
        }
      );

      console.log(`Backup: ${snapshot.id}`);
      console.log(`Date: ${new Date(snapshot.created_at).toLocaleString()}\n`);

      // Group by directory
      const tree: Record<string, FileInfo[]> = {};
      for (const f of files as FileInfo[]) {
        const dir = path.dirname(f.path);
        if (!tree[dir]) tree[dir] = [];
        tree[dir].push(f);
      }

      for (const dir of Object.keys(tree).sort()) {
        console.log(`📁 ${dir}/`);
        for (const f of tree[dir]) {
          const name = path.basename(f.path);
          console.log(`   📄 ${name} (${f.size} bytes)`);
        }
      }

      console.log(`\nTotal: ${files.length} files`);
    } catch (e) {
      console.error(`✗ Failed to list files: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawport status
// ─────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show current status')
  .action(async () => {
    const cfg = readConfig();

    console.log('ClawPort Status\n');

    if (cfg) {
      console.log(`✓ Logged in`);
      console.log(`  Profile ID: ${cfg.profileId}`);
      console.log(`  API: ${cfg.apiBaseUrl}`);
    } else {
      console.log(`✗ Not logged in`);
      console.log(`  Run: clawport login --api-key <key>`);
    }

    console.log('');
    if (fs.existsSync(OPENCLAW_DIR)) {
      const files = discoverFiles(OPENCLAW_DIR);
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      console.log(`✓ OpenClaw found: ${OPENCLAW_DIR}`);
      console.log(`  Backupable files: ${files.length} (${(totalSize / 1024).toFixed(1)} KB)`);
    } else {
      console.log(`✗ OpenClaw not found: ${OPENCLAW_DIR}`);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawport logout
// ─────────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Remove local credentials')
  .action(() => {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
      console.log('✓ Logged out');
    } else {
      console.log('Already logged out');
    }
  });

program.parseAsync(process.argv);
