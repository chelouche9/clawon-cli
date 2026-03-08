#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import * as tar from 'tar';

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.clawon');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const BACKUPS_DIR = path.join(CONFIG_DIR, 'backups');

type ScheduleConfig = {
  enabled: boolean;
  intervalHours: number;
  maxSnapshots?: number | null;
  includeMemoryDb?: boolean;
  includeSessions?: boolean;
};

type ClawonConfig = {
  apiKey?: string;
  profileId?: string;
  apiBaseUrl?: string;
  connectedAt?: string;
  schedule?: {
    local?: ScheduleConfig;
    cloud?: ScheduleConfig;
  };
};

type FileInfo = {
  path: string;
  size: number;
  content?: string;
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readConfig(): ClawonConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(cfg: ClawonConfig) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function updateConfig(partial: Partial<ClawonConfig>) {
  const existing = readConfig() || {};
  const merged = { ...existing, ...partial };
  if (partial.schedule) {
    merged.schedule = { ...existing.schedule, ...partial.schedule };
  }
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
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
      'x-clawon-api-key': apiKey,
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
  'agents/*/models.json',
  'agents/*/agent/**',
  'cron/runs/*.jsonl',
];

const EXCLUDE_PATTERNS = [
  'credentials/**',
  'openclaw.json',
  'agents/*/auth.json',
  'agents/*/auth-profiles.json',
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

function shouldInclude(relativePath: string, includeMemoryDb: boolean = false, includeSessions: boolean = false): boolean {
  // Allow memory DB files through when flag is set
  if (includeMemoryDb && matchGlob(relativePath, 'memory/*.sqlite')) {
    return true;
  }
  // Allow session files through when flag is set
  if (includeSessions && matchGlob(relativePath, 'agents/*/sessions/**')) {
    return true;
  }
  for (const pattern of EXCLUDE_PATTERNS) {
    if (matchGlob(relativePath, pattern)) return false;
  }
  for (const pattern of INCLUDE_PATTERNS) {
    if (matchGlob(relativePath, pattern)) return true;
  }
  return false;
}

function discoverFiles(baseDir: string, includeMemoryDb: boolean = false, includeSessions: boolean = false): FileInfo[] {
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
        if (shouldInclude(relPath, includeMemoryDb, includeSessions)) {
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
// Local Archive Helpers
// ─────────────────────────────────────────────────────────────

type ClawonMeta = { version: number; created: string; tag?: string; file_count: number; include_memory_db?: boolean; include_sessions?: boolean; trigger?: 'manual' | 'scheduled' };

async function createLocalArchive(files: FileInfo[], openclawDir: string, outputPath: string, tag?: string, includeMemoryDb?: boolean, includeSessions?: boolean, trigger?: 'manual' | 'scheduled'): Promise<void> {
  // Write metadata file temporarily
  const meta: ClawonMeta = {
    version: 2,
    created: new Date().toISOString(),
    ...(tag ? { tag } : {}),
    file_count: files.length,
    ...(includeMemoryDb ? { include_memory_db: true } : {}),
    ...(includeSessions ? { include_sessions: true } : {}),
    ...(trigger ? { trigger } : {}),
  };
  const metaPath = path.join(openclawDir, '_clawon_meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  try {
    await tar.create(
      { gzip: true, file: outputPath, cwd: openclawDir },
      ['_clawon_meta.json', ...files.map((f) => f.path)]
    );
  } finally {
    fs.unlinkSync(metaPath);
  }
}

async function readArchiveMeta(archivePath: string): Promise<ClawonMeta> {
  let meta: ClawonMeta | null = null;

  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      if (entry.path === '_clawon_meta.json') {
        const chunks: Buffer[] = [];
        entry.on('data', (c: Buffer) => chunks.push(c));
        entry.on('end', () => {
          meta = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        });
      }
    },
  });

  if (!meta) throw new Error('Invalid archive: missing _clawon_meta.json');
  return meta;
}

async function extractLocalArchive(archivePath: string, targetDir: string): Promise<ClawonMeta> {
  const meta = await readArchiveMeta(archivePath);

  ensureDir(targetDir);
  await tar.extract({ file: archivePath, cwd: targetDir, filter: (p) => p !== '_clawon_meta.json' });

  return meta;
}

// ─────────────────────────────────────────────────────────────
// PostHog Tracking
// ─────────────────────────────────────────────────────────────

const POSTHOG_KEY = 'phc_LGJC4ZrED6EiK0sC1fusErOhR6gHlFCS5Qs7ou93SmV';

function telemetryDisabled(): boolean {
  return process.env.DO_NOT_TRACK === '1' || process.env.CLAWON_NO_TELEMETRY === '1';
}

function trackCliEvent(distinctId: string, event: string, properties: Record<string, unknown> = {}) {
  if (telemetryDisabled()) return;
  fetch('https://us.i.posthog.com/capture/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      distinct_id: distinctId,
      event,
      properties: { ...properties, source: 'cli' },
    }),
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// Crontab Helpers
// ─────────────────────────────────────────────────────────────

const CRON_MARKER_LOCAL = '# clawon-schedule-local';
const CRON_MARKER_CLOUD = '# clawon-schedule-cloud';
const SCHEDULE_LOG = path.join(CONFIG_DIR, 'schedule.log');

const INTERVAL_CRON: Record<string, string> = {
  '1h':  '0 * * * *',
  '6h':  '0 */6 * * *',
  '12h': '0 */12 * * *',
  '24h': '0 0 * * *',
};

const VALID_INTERVALS = Object.keys(INTERVAL_CRON);

function resolveCliCommand(args: string): string {
  const nodePath = process.execPath;
  const cliEntry = path.resolve(import.meta.dirname, 'index.js');
  return `${nodePath} ${cliEntry} ${args}`;
}

function getCurrentCrontab(): string {
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function setCrontab(content: string): void {
  const tmpFile = path.join(CONFIG_DIR, '.crontab-tmp');
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(tmpFile, content);
  try {
    execSync(`crontab ${tmpFile}`, { encoding: 'utf8' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function addCronEntry(marker: string, cronExpr: string, command: string): void {
  const current = getCurrentCrontab();
  const filtered = current.split('\n').filter((line) => !line.includes(marker)).join('\n');
  const entry = `${cronExpr} ${command} >> ${SCHEDULE_LOG} 2>&1 ${marker}`;
  const updated = filtered.trim() ? `${filtered.trim()}\n${entry}\n` : `${entry}\n`;
  setCrontab(updated);
}

function removeCronEntry(marker: string): boolean {
  const current = getCurrentCrontab();
  const lines = current.split('\n');
  const filtered = lines.filter((line) => !line.includes(marker));
  if (filtered.length === lines.length) return false;
  setCrontab(filtered.join('\n'));
  return true;
}

function getCronEntry(marker: string): string | null {
  const current = getCurrentCrontab();
  const line = current.split('\n').find((l) => l.includes(marker));
  return line || null;
}

function assertNotWindows(): void {
  if (process.platform === 'win32') {
    console.error('✗ Scheduled backups require cron (macOS/Linux). Windows is not supported yet.');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// CLI Program
// ─────────────────────────────────────────────────────────────

const program = new Command();
program.name('clawon').description('Backup and restore your OpenClaw workspace').version('0.1.1');

// ─────────────────────────────────────────────────────────────
// clawon login
// ─────────────────────────────────────────────────────────────

program
  .command('login')
  .description('Connect to Clawon with your API key')
  .option('--api-key <key>', 'Your Clawon API key (or set CLAWON_API_KEY env var)')
  .option('--api-url <url>', 'API base URL', 'https://clawon.io')
  .action(async (opts) => {
    const apiKey = opts.apiKey || process.env.CLAWON_API_KEY;
    if (!apiKey) {
      console.error('✗ API key required. Use --api-key <key> or set CLAWON_API_KEY environment variable.');
      process.exit(1);
    }
    try {
      const connectJson = await api(opts.apiUrl, '/api/v1/profile/connect', 'POST', apiKey, {
        profileName: 'default',
        instanceName: os.hostname(),
        syncIntervalMinutes: 60,
      });

      writeConfig({
        apiKey: apiKey,
        profileId: connectJson.profileId,
        apiBaseUrl: opts.apiUrl,
        connectedAt: new Date().toISOString(),
      });

      console.log('✓ Logged in');
      console.log(`  Profile ID: ${connectJson.profileId}`);

      trackCliEvent(connectJson.profileId, 'cli_login');
    } catch (e) {
      console.error(`✗ Login failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawon backup
// ─────────────────────────────────────────────────────────────

program
  .command('backup')
  .description('Backup your OpenClaw workspace to the cloud')
  .option('--dry-run', 'Show what would be backed up without uploading')
  .option('--tag <label>', 'Add a label to this backup')
  .option('--include-memory-db', 'Include SQLite memory index')
  .option('--include-sessions', 'Include chat history (sessions)')
  .option('--scheduled', 'Internal: triggered by cron (suppresses interactive output)')
  .action(async (opts) => {
    if (opts.includeMemoryDb) {
      console.error('✗ Memory DB cloud backup requires a Pro account. Use `clawon local backup --include-memory-db` for local backups.');
      process.exit(1);
    }
    if (opts.includeSessions) {
      console.error('✗ Session backup requires a Hobby or Pro account. Use `clawon local backup --include-sessions` for local backups.');
      process.exit(1);
    }
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawon login --api-key <key>');
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
          ...(opts.tag ? { tag: opts.tag } : {}),
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

      trackCliEvent(cfg.profileId, opts.scheduled ? 'scheduled_backup_created' : 'cloud_backup_created', {
        file_count: files.length,
        total_bytes: totalSize,
        include_memory_db: !!opts.includeMemoryDb,
        include_sessions: !!opts.includeSessions,
        type: 'cloud',
        trigger: opts.scheduled ? 'scheduled' : 'manual',
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (opts.scheduled) {
        trackCliEvent(cfg.profileId, 'scheduled_backup_failed', { type: 'cloud', error: msg });
      }
      if (msg.includes('Snapshot limit')) {
        console.error('\n✗ Snapshot limit reached (2).');
        console.error('  Delete one first:  clawon delete <id>');
        console.error('  Delete oldest:     clawon delete --oldest');
        console.error('  List snapshots:    clawon list');
      } else {
        console.error(`\n✗ Backup failed: ${msg}`);
      }
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawon restore
// ─────────────────────────────────────────────────────────────

program
  .command('restore')
  .description('Restore your OpenClaw workspace from the cloud')
  .option('--snapshot <id>', 'Specific snapshot ID to restore (default: latest)')
  .option('--dry-run', 'Show what would be restored without extracting')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawon login --api-key <key>');
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

      // Mark snapshot as applied + log restore event
      await api(cfg.apiBaseUrl, '/api/v1/snapshots/restore', 'POST', cfg.apiKey, {
        profileId: cfg.profileId,
        snapshotId: snapshot.id,
      });

      console.log('\n✓ Restore complete!');
      console.log(`  Restored to: ${OPENCLAW_DIR}`);
      console.log(`  Files: ${files.length}`);

      trackCliEvent(cfg.profileId, 'cloud_backup_restored', {
        file_count: files.length,
      });
    } catch (e) {
      console.error(`\n✗ Restore failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawon list
// ─────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List your backups')
  .option('--limit <n>', 'Number of backups to show', '10')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawon login --api-key <key>');
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
        console.log('No backups yet. Run: clawon backup');
        return;
      }

      console.log('Your backups:\n');
      console.log('ID                                   | Date                 | Files | Size     | Tag');
      console.log('─'.repeat(100));

      for (const s of snapshots) {
        const date = new Date(s.created_at).toLocaleString();
        const size = s.size_bytes ? `${(s.size_bytes / 1024).toFixed(1)} KB` : 'N/A';
        const files = s.changed_files_count || 'N/A';
        const tag = s.tag || '';
        console.log(`${s.id} | ${date.padEnd(20)} | ${String(files).padEnd(5)} | ${String(size).padEnd(8)} | ${tag}`);
      }

      console.log(`\nTotal: ${snapshots.length} backup(s)`);

      trackCliEvent(cfg.profileId, 'cli_list_viewed', { count: snapshots.length });
    } catch (e) {
      console.error(`✗ Failed to list backups: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawon activity
// ─────────────────────────────────────────────────────────────

const ACTIVITY_LABELS: Record<string, string> = {
  BACKUP_CREATED: 'Backup created',
  SNAPSHOT_CREATED: 'Snapshot created',
  SNAPSHOT_DELETED: 'Snapshot deleted',
  SNAPSHOT_RESTORED: 'Snapshot restored',
  BACKUP_DOWNLOADED: 'Backup downloaded',
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
};

function formatEventLabel(type: string): string {
  return ACTIVITY_LABELS[type] || type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
}

function formatEventDetails(payload: any): string {
  if (!payload || typeof payload !== 'object') return '';
  const parts: string[] = [];
  if (payload.fileCount != null || payload.changedFilesCount != null) {
    parts.push(`${payload.fileCount ?? payload.changedFilesCount} files`);
  }
  if (payload.snapshotId) {
    parts.push(payload.snapshotId);
  }
  if (payload.instanceName) {
    parts.push(payload.instanceName);
  }
  return parts.join(' · ');
}

program
  .command('activity')
  .description('Show recent activity')
  .option('--limit <n>', 'Number of events to show', '10')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawon login --api-key <key>');
      process.exit(1);
    }

    try {
      const { events } = await api(
        cfg.apiBaseUrl,
        `/api/v1/events/list?profileId=${cfg.profileId}&limit=${opts.limit}`,
        'GET',
        cfg.apiKey
      );

      if (!events?.length) {
        console.log('No activity yet. Run: clawon backup');
        return;
      }

      console.log('Recent activity:\n');
      console.log('Date                 | Event              | Details');
      console.log('─'.repeat(80));

      for (const ev of events) {
        const date = new Date(ev.created_at).toLocaleString();
        const label = formatEventLabel(ev.type);
        const details = formatEventDetails(ev.payload);
        console.log(`${date.padEnd(20)} | ${label.padEnd(18)} | ${details}`);
      }

      trackCliEvent(cfg.profileId, 'cli_activity_viewed');
    } catch (e) {
      console.error(`✗ Failed to load activity: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawon delete
// ─────────────────────────────────────────────────────────────

program
  .command('delete [id]')
  .description('Delete a snapshot')
  .option('--oldest', 'Delete the oldest ready snapshot')
  .action(async (id, opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawon login --api-key <key>');
      process.exit(1);
    }

    if (!id && !opts.oldest) {
      console.error('✗ Provide a snapshot ID or use --oldest');
      console.error('  Usage:  clawon delete <id>');
      console.error('          clawon delete --oldest');
      process.exit(1);
    }

    try {
      let snapshotId = id;

      if (opts.oldest) {
        const { snapshots } = await api(
          cfg.apiBaseUrl,
          `/api/v1/snapshots/list?profileId=${cfg.profileId}&limit=50`,
          'GET',
          cfg.apiKey
        );

        const readySnapshots = (snapshots || []).filter((s: any) => s.status === 'ready');
        if (readySnapshots.length === 0) {
          console.error('✗ No ready snapshots to delete');
          process.exit(1);
        }

        // Oldest = last in the list (sorted newest-first)
        snapshotId = readySnapshots[readySnapshots.length - 1].id;
        console.log(`Oldest ready snapshot: ${snapshotId}`);
      }

      await api(cfg.apiBaseUrl, '/api/v1/snapshots/delete', 'POST', cfg.apiKey, {
        profileId: cfg.profileId,
        snapshotId,
      });

      console.log(`✓ Deleted snapshot ${snapshotId}`);

      trackCliEvent(cfg.profileId, 'cloud_backup_deleted');
    } catch (e) {
      console.error(`✗ Delete failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawon discover
// ─────────────────────────────────────────────────────────────

program
  .command('discover')
  .description('Preview which files would be included in a backup')
  .option('--include-memory-db', 'Include SQLite memory index')
  .option('--include-sessions', 'Include chat history (sessions)')
  .action(async (opts) => {
    if (!fs.existsSync(OPENCLAW_DIR)) {
      console.error(`✗ OpenClaw directory not found: ${OPENCLAW_DIR}`);
      process.exit(1);
    }

    const files = discoverFiles(OPENCLAW_DIR, !!opts.includeMemoryDb, !!opts.includeSessions);

    if (files.length === 0) {
      console.log('No files matched the include patterns.');
      return;
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    // Group by directory
    const tree: Record<string, FileInfo[]> = {};
    for (const f of files) {
      const dir = path.dirname(f.path);
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push(f);
    }

    console.log(`Files that would be backed up:\n`);
    for (const dir of Object.keys(tree).sort()) {
      console.log(`📁 ${dir}/`);
      for (const f of tree[dir]) {
        const name = path.basename(f.path);
        console.log(`   📄 ${name} (${f.size} bytes)`);
      }
    }

    console.log(`\nTotal: ${files.length} files (${(totalSize / 1024).toFixed(1)} KB)`);
    console.log(`Source: ${OPENCLAW_DIR}`);

    const cfg = readConfig();
    trackCliEvent(cfg?.profileId || 'anonymous', 'cli_discover', { file_count: files.length, include_memory_db: !!opts.includeMemoryDb, include_sessions: !!opts.includeSessions });
  });

// ─────────────────────────────────────────────────────────────
// clawon schedule (cloud)
// ─────────────────────────────────────────────────────────────

const schedule = program
  .command('schedule')
  .description('Manage scheduled cloud backups');

schedule
  .command('on')
  .description('Enable scheduled cloud backups via cron')
  .option('--every <interval>', 'Backup interval: 1h, 6h, 12h, 24h', '12h')
  .action(async (opts) => {
    assertNotWindows();

    // Gate: no tier exists yet
    const cfg = readConfig();
    trackCliEvent(cfg?.profileId || 'anonymous', 'schedule_enabled_attempted', {
      type: 'cloud',
      interval_hours: parseInt(opts.every),
      gated: true,
    });
    console.error('✗ Scheduled cloud backups require a Hobby or Pro account. Use `clawon local schedule on` for local scheduled backups.');
    process.exit(1);
  });

schedule
  .command('off')
  .description('Disable scheduled cloud backups')
  .action(async () => {
    assertNotWindows();

    const removed = removeCronEntry(CRON_MARKER_CLOUD);
    if (!removed) {
      console.log('No cloud schedule was active.');
      return;
    }

    updateConfig({
      schedule: {
        cloud: { enabled: false, intervalHours: 0 },
      },
    });

    console.log('✓ Scheduled cloud backup disabled');

    const cfg = readConfig();
    trackCliEvent(cfg?.profileId || 'anonymous', 'schedule_disabled', { type: 'cloud' });
  });

schedule
  .command('status')
  .description('Show schedule status')
  .action(async () => {
    const cfg = readConfig();
    const localEntry = getCronEntry(CRON_MARKER_LOCAL);
    const cloudEntry = getCronEntry(CRON_MARKER_CLOUD);

    console.log('Schedule Status\n');

    if (localEntry) {
      const localCfg = cfg?.schedule?.local;
      console.log('✓ Local schedule: active');
      if (localCfg?.intervalHours) console.log(`  Interval: every ${localCfg.intervalHours}h`);
      if (localCfg?.maxSnapshots) console.log(`  Max snapshots: ${localCfg.maxSnapshots}`);
      if (localCfg?.includeMemoryDb) console.log(`  Memory DB: included`);
      if (localCfg?.includeSessions) console.log(`  Sessions: included`);
      console.log(`  Cron: ${localEntry.trim()}`);
    } else {
      console.log('✗ Local schedule: inactive');
      console.log('  Enable: clawon local schedule on');
    }

    console.log('');

    if (cloudEntry) {
      const cloudCfg = cfg?.schedule?.cloud;
      console.log('✓ Cloud schedule: active');
      if (cloudCfg?.intervalHours) console.log(`  Interval: every ${cloudCfg.intervalHours}h`);
      console.log(`  Cron: ${cloudEntry.trim()}`);
    } else {
      console.log('✗ Cloud schedule: inactive');
      console.log('  Enable: clawon schedule on (requires Hobby or Pro)');
    }

    console.log(`\nLog: ${SCHEDULE_LOG}`);

    trackCliEvent(cfg?.profileId || 'anonymous', 'schedule_status_viewed', {
      local_enabled: !!localEntry,
      cloud_enabled: !!cloudEntry,
      local_interval_hours: cfg?.schedule?.local?.intervalHours || null,
      cloud_interval_hours: cfg?.schedule?.cloud?.intervalHours || null,
    });
  });

// ─────────────────────────────────────────────────────────────
// clawon files
// ─────────────────────────────────────────────────────────────

program
  .command('files')
  .description('List files in a backup')
  .option('--snapshot <id>', 'Snapshot ID (default: latest)')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg) {
      console.error('✗ Not logged in. Run: clawon login --api-key <key>');
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

      trackCliEvent(cfg.profileId, 'cli_files_viewed', { file_count: files.length });
    } catch (e) {
      console.error(`✗ Failed to list files: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawon local (backup / list / restore)
// ─────────────────────────────────────────────────────────────

const local = program
  .command('local')
  .description('Local backup and restore (no cloud required)');

// ── clawon local schedule ──

const localSchedule = local
  .command('schedule')
  .description('Manage scheduled local backups');

localSchedule
  .command('on')
  .description('Enable scheduled local backups via cron')
  .option('--every <interval>', 'Backup interval: 1h, 6h, 12h, 24h', '12h')
  .option('--max-snapshots <n>', 'Keep only the N most recent local backups')
  .option('--include-memory-db', 'Include SQLite memory index')
  .option('--include-sessions', 'Include chat history (sessions)')
  .action(async (opts) => {
    assertNotWindows();

    const interval = opts.every;
    if (!VALID_INTERVALS.includes(interval)) {
      console.error(`✗ Invalid interval: ${interval}. Valid options: ${VALID_INTERVALS.join(', ')}`);
      process.exit(1);
    }

    // Check existing state BEFORE writing config (for isUpdate detection)
    const cfg = readConfig();
    const wasEnabled = cfg?.schedule?.local?.enabled;

    const cronExpr = INTERVAL_CRON[interval];
    const args = 'local backup --scheduled' +
      (opts.includeMemoryDb ? ' --include-memory-db' : '') +
      (opts.includeSessions ? ' --include-sessions' : '') +
      (opts.maxSnapshots ? ` --max-snapshots ${opts.maxSnapshots}` : '');
    const command = resolveCliCommand(args);

    addCronEntry(CRON_MARKER_LOCAL, cronExpr, command);

    // Persist to config
    const maxSnapshots = opts.maxSnapshots ? parseInt(opts.maxSnapshots, 10) : null;
    updateConfig({
      schedule: {
        local: {
          enabled: true,
          intervalHours: parseInt(interval),
          ...(maxSnapshots ? { maxSnapshots } : {}),
          ...(opts.includeMemoryDb ? { includeMemoryDb: true } : {}),
          ...(opts.includeSessions ? { includeSessions: true } : {}),
        },
      },
    });

    console.log(`✓ Scheduled local backup enabled`);
    console.log(`  Interval: every ${interval}`);
    if (maxSnapshots) console.log(`  Max snapshots: ${maxSnapshots}`);
    if (opts.includeMemoryDb) console.log(`  Memory DB: included`);
    if (opts.includeSessions) console.log(`  Sessions: included`);
    console.log(`  Log: ${SCHEDULE_LOG}`);

    // Run first backup immediately (without --scheduled so user sees output)
    const firstRunArgs = 'local backup' +
      (opts.includeMemoryDb ? ' --include-memory-db' : '') +
      (opts.includeSessions ? ' --include-sessions' : '') +
      (opts.maxSnapshots ? ` --max-snapshots ${opts.maxSnapshots}` : '');
    console.log('\nRunning first backup now...\n');
    try {
      execSync(resolveCliCommand(firstRunArgs), { stdio: 'inherit' });
    } catch {
      console.error('⚠ First backup failed — schedule is still active and will retry at next interval.');
    }

    trackCliEvent(cfg?.profileId || 'anonymous', wasEnabled ? 'schedule_updated' : 'schedule_enabled', {
      type: 'local',
      interval_hours: parseInt(interval),
      max_snapshots: maxSnapshots,
      include_memory_db: !!opts.includeMemoryDb,
      include_sessions: !!opts.includeSessions,
    });
  });

localSchedule
  .command('off')
  .description('Disable scheduled local backups')
  .action(async () => {
    assertNotWindows();

    const removed = removeCronEntry(CRON_MARKER_LOCAL);
    if (!removed) {
      console.log('No local schedule was active.');
      return;
    }

    updateConfig({
      schedule: {
        local: { enabled: false, intervalHours: 0 },
      },
    });

    console.log('✓ Scheduled local backup disabled');

    const cfg = readConfig();
    trackCliEvent(cfg?.profileId || 'anonymous', 'schedule_disabled', { type: 'local' });
  });

// ── clawon local backup ──

local
  .command('backup')
  .description('Save a local backup of your OpenClaw workspace')
  .option('--tag <label>', 'Add a label to this backup')
  .option('--include-memory-db', 'Include SQLite memory index')
  .option('--include-sessions', 'Include chat history (sessions)')
  .option('--scheduled', 'Internal: triggered by cron (suppresses interactive output)')
  .option('--max-snapshots <n>', 'Keep only the N most recent local backups')
  .action(async (opts) => {
    if (!fs.existsSync(OPENCLAW_DIR)) {
      console.error(`✗ OpenClaw directory not found: ${OPENCLAW_DIR}`);
      process.exit(1);
    }

    try {
      if (!opts.scheduled) console.log('Discovering files...');
      const files = discoverFiles(OPENCLAW_DIR, !!opts.includeMemoryDb, !!opts.includeSessions);

      if (files.length === 0) {
        console.error('✗ No files found to backup');
        process.exit(1);
      }

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (!opts.scheduled) console.log(`Found ${files.length} files (${(totalSize / 1024).toFixed(1)} KB)`);

      ensureDir(BACKUPS_DIR);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', 'T').slice(0, 15);
      const filename = `backup-${timestamp}.tar.gz`;
      const filePath = path.join(BACKUPS_DIR, filename);

      if (!opts.scheduled) console.log('Creating archive...');
      await createLocalArchive(files, OPENCLAW_DIR, filePath, opts.tag, opts.includeMemoryDb, opts.includeSessions, opts.scheduled ? 'scheduled' : 'manual');

      const archiveSize = fs.statSync(filePath).size;
      if (!opts.scheduled) {
        console.log(`\n✓ Local backup saved!`);
        console.log(`  File: ${filePath}`);
        console.log(`  Files: ${files.length}`);
        console.log(`  Size: ${(archiveSize / 1024).toFixed(1)} KB (compressed)`);
        if (opts.tag) console.log(`  Tag: ${opts.tag}`);
      }

      // Rotate old backups if --max-snapshots is set
      const maxSnapshots = opts.maxSnapshots ? parseInt(opts.maxSnapshots, 10) : null;
      let rotatedCount = 0;
      if (maxSnapshots && maxSnapshots > 0) {
        const allBackups = fs.readdirSync(BACKUPS_DIR)
          .filter((f) => f.endsWith('.tar.gz'))
          .sort()
          .reverse(); // newest first

        if (allBackups.length > maxSnapshots) {
          const toDelete = allBackups.slice(maxSnapshots);
          for (const old of toDelete) {
            fs.unlinkSync(path.join(BACKUPS_DIR, old));
            rotatedCount++;
          }
          if (!opts.scheduled) {
            console.log(`  Rotated: deleted ${rotatedCount} old backup(s)`);
          }
        }
      }

      const cfg = readConfig();
      trackCliEvent(cfg?.profileId || 'anonymous', opts.scheduled ? 'scheduled_backup_created' : 'local_backup_created', {
        file_count: files.length,
        total_bytes: totalSize,
        include_memory_db: !!opts.includeMemoryDb,
        include_sessions: !!opts.includeSessions,
        type: 'local',
        trigger: opts.scheduled ? 'scheduled' : 'manual',
        rotated_count: rotatedCount,
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (opts.scheduled) {
        const cfg = readConfig();
        trackCliEvent(cfg?.profileId || 'anonymous', 'scheduled_backup_failed', { type: 'local', error: msg });
      }
      console.error(`\n✗ Local backup failed: ${msg}`);
      process.exit(1);
    }
  });

local
  .command('list')
  .description('List local backups')
  .action(async () => {
    if (!fs.existsSync(BACKUPS_DIR)) {
      console.log('No local backups yet. Run: clawon local backup');
      return;
    }

    const entries = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => f.endsWith('.tar.gz'))
      .sort()
      .reverse();

    if (entries.length === 0) {
      console.log('No local backups yet. Run: clawon local backup');
      return;
    }

    console.log('Local backups:\n');
    console.log('#  | Date                      | Files | Size     | Tag                  | Path');
    console.log('─'.repeat(120));

    for (let i = 0; i < entries.length; i++) {
      const filePath = path.join(BACKUPS_DIR, entries[i]);
      try {
        const meta = await readArchiveMeta(filePath);
        const date = new Date(meta.created).toLocaleString();
        const archiveSize = fs.statSync(filePath).size;
        const sizeStr = `${(archiveSize / 1024).toFixed(1)} KB`;
        const tagStr = (meta.tag || '').padEnd(20);
        console.log(
          `${String(i + 1).padStart(2)} | ${date.padEnd(25)} | ${String(meta.file_count).padEnd(5)} | ${sizeStr.padEnd(10)} | ${tagStr} | ${filePath}`
        );
      } catch {
        console.log(`${String(i + 1).padStart(2)} | ${entries[i].padEnd(25)} | ???   | ???        |                      | ${filePath}`);
      }
    }

    console.log(`\nTotal: ${entries.length} backup(s)`);

    const cfg = readConfig();
    trackCliEvent(cfg?.profileId || 'anonymous', 'local_list_viewed', { count: entries.length });

    console.log(`\nRestore a backup:`);
    console.log(`  clawon local restore              Restore the latest backup (#1)`);
    console.log(`  clawon local restore --pick 2     Restore backup #2 from this list`);
    console.log(`  clawon local restore --file <path> Restore from an external file`);
  });

local
  .command('restore')
  .description('Restore from a local backup')
  .option('--file <path>', 'Path to an external backup file')
  .option('--pick <n>', 'Restore backup #n from "clawon local list"')
  .action(async (opts) => {
    let archivePath: string;

    if (opts.file) {
      archivePath = path.resolve(opts.file);
      if (!fs.existsSync(archivePath)) {
        console.error(`✗ File not found: ${archivePath}`);
        process.exit(1);
      }
    } else {
      if (!fs.existsSync(BACKUPS_DIR)) {
        console.error('✗ No local backups found. Run: clawon local backup');
        process.exit(1);
      }

      const entries = fs.readdirSync(BACKUPS_DIR)
        .filter((f) => f.endsWith('.tar.gz'))
        .sort()
        .reverse();

      if (entries.length === 0) {
        console.error('✗ No local backups found. Run: clawon local backup');
        process.exit(1);
      }

      if (opts.pick) {
        const idx = parseInt(opts.pick, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= entries.length) {
          console.error(`✗ Invalid pick: #${opts.pick}. Run "clawon local list" to see available backups (1-${entries.length}).`);
          process.exit(1);
        }
        archivePath = path.join(BACKUPS_DIR, entries[idx]);
      } else {
        archivePath = path.join(BACKUPS_DIR, entries[0]);
      }
    }

    console.log(`Restoring from: ${archivePath}`);

    try {
      const meta = await readArchiveMeta(archivePath);
      console.log(`Backup date: ${new Date(meta.created).toLocaleString()}`);
      console.log(`Files: ${meta.file_count}`);
      if (meta.tag) console.log(`Tag: ${meta.tag}`);

      console.log('\nExtracting...');
      await extractLocalArchive(archivePath, OPENCLAW_DIR);

      console.log(`\n✓ Restore complete!`);
      console.log(`  Restored to: ${OPENCLAW_DIR}`);
      console.log(`  Files: ${meta.file_count}`);

      const cfg = readConfig();
      trackCliEvent(cfg?.profileId || 'anonymous', 'local_backup_restored', {
        file_count: meta.file_count,
        source: opts.file ? 'file' : 'local',
      });
    } catch (e) {
      console.error(`\n✗ Restore failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────
// clawon status
// ─────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show current status')
  .action(async () => {
    const cfg = readConfig();

    console.log('Clawon Status\n');

    if (cfg) {
      console.log(`✓ Logged in`);
      console.log(`  Profile ID: ${cfg.profileId}`);
      console.log(`  API: ${cfg.apiBaseUrl}`);
    } else {
      console.log(`✗ Not logged in`);
      console.log(`  Run: clawon login --api-key <key>`);
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

    console.log('');
    const localEntry = getCronEntry(CRON_MARKER_LOCAL);
    const cloudEntry = getCronEntry(CRON_MARKER_CLOUD);
    if (localEntry || cloudEntry) {
      console.log('✓ Schedule active');
      if (localEntry) console.log('  Local: ' + (cfg?.schedule?.local?.intervalHours || '?') + 'h interval');
      if (cloudEntry) console.log('  Cloud: ' + (cfg?.schedule?.cloud?.intervalHours || '?') + 'h interval');
    } else {
      console.log('✗ No schedule configured');
      console.log('  Run: clawon local schedule on');
    }

    trackCliEvent(cfg?.profileId || 'anonymous', 'cli_status_viewed');
  });

// ─────────────────────────────────────────────────────────────
// clawon logout
// ─────────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Remove local credentials')
  .action(() => {
    const cfg = readConfig();
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
      console.log('✓ Logged out');
      trackCliEvent(cfg?.profileId || 'anonymous', 'cli_logout');
    } else {
      console.log('Already logged out');
    }
  });

program.parseAsync(process.argv);
