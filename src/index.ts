#!/usr/bin/env node
import { Command } from 'commander';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.clawport');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

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
  if (!res.ok) {
    throw new Error(json.message || json.error || `HTTP ${res.status}`);
  }
  return json;
}

const program = new Command();
program
  .name('clawport')
  .description('ClawPort CLI (v0: connect/status wired, snapshots/sync partial)')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize local config')
  .option('--api-base-url <url>', 'API base URL', 'https://clawport-3a35.vercel.app')
  .action((opts) => {
    const existing = readConfig();
    if (existing) {
      console.log(`Config already exists at ${CONFIG_PATH}`);
      return;
    }
    const cfg: ClawportConfig = {
      apiKey: '',
      profile: 'default-profile',
      instanceName: 'default-instance',
      interval: '30m',
      apiBaseUrl: opts.apiBaseUrl,
      connectedAt: '',
    };
    writeConfig(cfg);
    console.log(`Initialized ${CONFIG_PATH}`);
  });

program
  .command('connect')
  .description('Connect this host to a profile')
  .requiredOption('--api-key <key>', 'Org API key')
  .requiredOption('--profile <name>', 'Profile name')
  .requiredOption('--instance-name <name>', 'Instance name')
  .option('--interval <interval>', 'Sync interval, e.g. 30m or 1h', '30m')
  .option('--api-base-url <url>', 'API base URL', 'https://clawport-3a35.vercel.app')
  .action(async (opts) => {
    const schema = z.object({
      apiKey: z.string().min(10),
      profile: z.string().min(1),
      instanceName: z.string().min(1),
      interval: z.string().min(2),
      apiBaseUrl: z.string().url(),
    });

    const parsed = schema.safeParse(opts);
    if (!parsed.success) {
      console.error('Invalid arguments:', parsed.error.issues.map(i => i.message).join(', '));
      process.exit(1);
    }

    const minutes = parseIntervalToMinutes(parsed.data.interval);

    try {
      const json = await apiRequest(
        parsed.data.apiBaseUrl,
        '/api/v1/profile/connect',
        'POST',
        parsed.data.apiKey,
        {
          profileName: parsed.data.profile,
          instanceName: parsed.data.instanceName,
          syncIntervalMinutes: minutes,
        }
      );

      const cfg: ClawportConfig = {
        apiKey: parsed.data.apiKey,
        profile: parsed.data.profile,
        profileId: json.profileId,
        instanceName: parsed.data.instanceName,
        interval: parsed.data.interval,
        apiBaseUrl: parsed.data.apiBaseUrl,
        connectedAt: new Date().toISOString(),
      };
      writeConfig(cfg);

      console.log('✅ Connected');
      console.log(`- Profile: ${cfg.profile}`);
      console.log(`- Profile ID: ${cfg.profileId}`);
      console.log(`- Instance: ${cfg.instanceName}`);
      console.log(`- Interval: ${cfg.interval}`);
    } catch (e) {
      console.error(`❌ Connect failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show connection status from API')
  .action(async () => {
    const cfg = readConfig();
    if (!cfg || !cfg.profileId) {
      console.log('Not connected. Run: clawport connect --api-key ... --profile ... --instance-name ...');
      return;
    }

    try {
      const json = await apiRequest(
        cfg.apiBaseUrl,
        `/api/v1/profile/status?profileId=${cfg.profileId}`,
        'GET',
        cfg.apiKey
      );

      console.log('ClawPort status:');
      console.log(`- Profile: ${json.profile?.name || cfg.profile}`);
      console.log(`- Instance: ${json.instance?.name || cfg.instanceName}`);
      console.log(`- State: ${json.instance?.status || 'unknown'}`);
      console.log(`- Last heartbeat: ${json.instance?.last_heartbeat_at || 'n/a'}`);
      console.log(`- Auth mode: ${json.authMode || 'api_key'}`);
    } catch (e) {
      console.error(`❌ Status failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('disconnect')
  .description('Remove local connection config')
  .action(() => {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
      console.log('Disconnected (local config removed).');
    } else {
      console.log('Already disconnected.');
    }
  });

program
  .command('snapshot')
  .description('Snapshot commands (placeholder)')
  .command('create')
  .description('Create snapshot (placeholder)')
  .action(() => {
    console.log('Snapshot create: placeholder (next step).');
  });

program
  .command('sync')
  .description('Sync commands (placeholder)')
  .command('run')
  .description('Run one sync cycle (placeholder)')
  .action(() => {
    console.log('Sync run: placeholder (next step).');
  });

program.parseAsync(process.argv);
