#!/usr/bin/env node
import { Command } from 'commander';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const CONFIG_DIR = path.join(os.homedir(), '.clawport');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const SYNC_LOG_PATH = path.join(LOG_DIR, 'sync.log');
const SYNC_PID_PATH = path.join(CONFIG_DIR, 'sync.pid');

type ClawportConfig = {
  apiKey: string;
  profile: string;
  profileId?: string;
  instanceName: string;
  interval: string;
  apiBaseUrl: string;
  connectedAt: string;
};

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readConfig(): ClawportConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(cfg: ClawportConfig) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function parseIntervalToMinutes(interval: string): number {
  const m = interval.trim().toLowerCase().match(/^(\d+)(m|h)$/);
  if (!m) return 30;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 60 : n;
}

function appendSyncLog(line: string) {
  ensureConfigDir();
  fs.appendFileSync(SYNC_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
}

async function apiRequest(baseUrl: string, endpoint: string, method: 'GET' | 'POST', apiKey: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-clawport-api-key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json;
}

async function runSyncCycle(cfg: ClawportConfig) {
  const heartbeat = await apiRequest(cfg.apiBaseUrl, '/api/v1/instances/heartbeat', 'POST', cfg.apiKey, {
    profileId: cfg.profileId,
    instanceName: cfg.instanceName,
  });

  const run = await apiRequest(cfg.apiBaseUrl, '/api/v1/sync/run', 'POST', cfg.apiKey, {
    profileId: cfg.profileId,
    instanceName: cfg.instanceName,
    changed: false,
    message: 'Periodic sync cycle',
  });

  appendSyncLog(`heartbeat=${heartbeat.heartbeatAt} syncRun=${run?.run?.id || 'ok'}`);
}

const program = new Command();
program.name('clawport').description('ClawPort CLI').version('0.2.0');

program
  .command('init')
  .description('Initialize local config')
  .option('--api-base-url <url>', 'API base URL', 'https://clawport-3a35.vercel.app')
  .action((opts) => {
    if (readConfig()) return console.log(`Config already exists at ${CONFIG_PATH}`);
    writeConfig({
      apiKey: '',
      profile: 'default-profile',
      instanceName: 'default-instance',
      interval: '30m',
      apiBaseUrl: opts.apiBaseUrl,
      connectedAt: '',
    });
    console.log(`Initialized ${CONFIG_PATH}`);
  });

program
  .command('connect')
  .description('Connect this host to a profile')
  .requiredOption('--api-key <key>', 'API key')
  .requiredOption('--profile <name>', 'Profile name')
  .requiredOption('--instance-name <name>', 'Instance name')
  .option('--interval <interval>', 'Sync interval, e.g. 30m or 1h', '30m')
  .option('--api-base-url <url>', 'API base URL', 'https://clawport-3a35.vercel.app')
  .action(async (opts) => {
    const parsed = z.object({
      apiKey: z.string().min(10),
      profile: z.string().min(1),
      instanceName: z.string().min(1),
      interval: z.string().min(2),
      apiBaseUrl: z.string().url(),
    }).safeParse(opts);
    if (!parsed.success) {
      console.error(parsed.error.issues.map((i) => i.message).join(', '));
      process.exit(1);
    }

    const p = parsed.data;
    const minutes = parseIntervalToMinutes(p.interval);
    const json = await apiRequest(p.apiBaseUrl, '/api/v1/profile/connect', 'POST', p.apiKey, {
      profileName: p.profile,
      instanceName: p.instanceName,
      syncIntervalMinutes: minutes,
    });

    writeConfig({
      apiKey: p.apiKey,
      profile: p.profile,
      profileId: json.profileId,
      instanceName: p.instanceName,
      interval: p.interval,
      apiBaseUrl: p.apiBaseUrl,
      connectedAt: new Date().toISOString(),
    });

    console.log('✅ Connected');
    console.log(`- Profile ID: ${json.profileId}`);
  });

program
  .command('status')
  .description('Show status')
  .action(async () => {
    const cfg = readConfig();
    if (!cfg?.profileId) return console.log('Not connected. Run clawport connect ...');
    const json = await apiRequest(cfg.apiBaseUrl, `/api/v1/profile/status?profileId=${cfg.profileId}`, 'GET', cfg.apiKey);
    console.log(`Profile: ${json.profile?.name || cfg.profile}`);
    console.log(`Instance: ${json.instance?.name || cfg.instanceName}`);
    console.log(`State: ${json.instance?.status || 'unknown'}`);
    console.log(`Last heartbeat: ${json.instance?.last_heartbeat_at || 'n/a'}`);
  });

program
  .command('disconnect')
  .description('Disconnect local instance and remove config')
  .action(async () => {
    const cfg = readConfig();
    if (!cfg?.profileId) {
      console.log('Already disconnected.');
      return;
    }

    try {
      await apiRequest(cfg.apiBaseUrl, '/api/v1/profile/disconnect', 'POST', cfg.apiKey, {
        profileId: cfg.profileId,
        instanceName: cfg.instanceName,
      });
    } catch (e) {
      console.warn(`Server disconnect warning: ${(e as Error).message}`);
    }

    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    if (fs.existsSync(SYNC_PID_PATH)) fs.unlinkSync(SYNC_PID_PATH);
    console.log('Disconnected.');
  });

const snapshot = program.command('snapshot').description('Snapshot operations');

snapshot
  .command('create')
  .description('Create snapshot')
  .option('--changed-files <n>', 'Changed files count', '0')
  .option('--size-bytes <n>', 'Snapshot size in bytes', '0')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg?.profileId) return console.log('Not connected. Run clawport connect ...');

    const json = await apiRequest(cfg.apiBaseUrl, '/api/v1/snapshots/create', 'POST', cfg.apiKey, {
      profileId: cfg.profileId,
      trigger: 'manual',
      version: 'v1',
      changedFilesCount: Number(opts.changedFiles || 0),
      sizeBytes: Number(opts.sizeBytes || 0),
    });

    console.log('✅ Snapshot created');
    console.log(`- Snapshot ID: ${json.snapshot.id}`);
    console.log(`- Status: ${json.snapshot.status}`);
  });

snapshot
  .command('list')
  .description('List snapshots')
  .option('--limit <n>', 'Limit', '10')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg?.profileId) return console.log('Not connected. Run clawport connect ...');
    const json = await apiRequest(cfg.apiBaseUrl, `/api/v1/snapshots/list?profileId=${cfg.profileId}&limit=${Number(opts.limit || 10)}`, 'GET', cfg.apiKey);
    if (!json.snapshots?.length) return console.log('No snapshots yet.');
    json.snapshots.forEach((s: any) => {
      console.log(`${s.id} | ${s.status} | ${s.created_at} | changed=${s.changed_files_count ?? 0}`);
    });
  });

snapshot
  .command('restore')
  .description('Restore snapshot by id')
  .requiredOption('--snapshot-id <id>', 'Snapshot ID')
  .action(async (opts) => {
    const cfg = readConfig();
    if (!cfg?.profileId) return console.log('Not connected. Run clawport connect ...');
    const json = await apiRequest(cfg.apiBaseUrl, '/api/v1/snapshots/restore', 'POST', cfg.apiKey, {
      profileId: cfg.profileId,
      snapshotId: opts.snapshotId,
    });
    console.log(`✅ Restored snapshot: ${json.restoredSnapshotId}`);
  });

const sync = program.command('sync').description('Sync operations');

sync
  .command('run')
  .description('Run one sync cycle now')
  .action(async () => {
    const cfg = readConfig();
    if (!cfg?.profileId) return console.log('Not connected. Run clawport connect ...');
    await runSyncCycle(cfg);
    console.log('✅ Sync cycle completed');
  });

sync
  .command('start')
  .description('Start background sync loop')
  .action(() => {
    const cfg = readConfig();
    if (!cfg?.profileId) return console.log('Not connected. Run clawport connect ...');
    if (fs.existsSync(SYNC_PID_PATH)) {
      const pid = fs.readFileSync(SYNC_PID_PATH, 'utf8').trim();
      if (pid) return console.log(`Sync loop already running (pid ${pid})`);
    }

    ensureConfigDir();
    const child = spawn(process.execPath, [process.argv[1], 'sync', 'worker'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    fs.writeFileSync(SYNC_PID_PATH, String(child.pid));
    console.log(`✅ Sync loop started (pid ${child.pid})`);
    console.log(`Log: ${SYNC_LOG_PATH}`);
  });

sync
  .command('stop')
  .description('Stop background sync loop')
  .action(() => {
    if (!fs.existsSync(SYNC_PID_PATH)) return console.log('Sync loop not running.');
    const pid = Number(fs.readFileSync(SYNC_PID_PATH, 'utf8').trim());
    if (!pid) return console.log('Invalid pid file.');
    try {
      process.kill(pid);
      fs.unlinkSync(SYNC_PID_PATH);
      console.log(`✅ Stopped sync loop (pid ${pid})`);
    } catch (e) {
      console.log(`Could not stop pid ${pid}: ${(e as Error).message}`);
    }
  });

sync
  .command('logs')
  .description('Tail sync log')
  .option('--lines <n>', 'Line count', '40')
  .action((opts) => {
    if (!fs.existsSync(SYNC_LOG_PATH)) return console.log('No sync log yet.');
    const lines = fs.readFileSync(SYNC_LOG_PATH, 'utf8').trim().split('\n');
    const n = Number(opts.lines || 40);
    console.log(lines.slice(-n).join('\n'));
  });

sync
  .command('worker')
  .description('Internal worker loop')
  .action(async () => {
    const cfg = readConfig();
    if (!cfg?.profileId) process.exit(1);

    appendSyncLog('worker started');

    try {
      await runSyncCycle(cfg);
    } catch (e) {
      appendSyncLog(`initial cycle failed: ${(e as Error).message}`);
    }

    const intervalMs = parseIntervalToMinutes(cfg.interval) * 60_000;
    setInterval(async () => {
      try {
        const fresh = readConfig();
        if (!fresh?.profileId) return;
        await runSyncCycle(fresh);
      } catch (e) {
        appendSyncLog(`cycle failed: ${(e as Error).message}`);
      }
    }, intervalMs);
  });

program.parseAsync(process.argv);
