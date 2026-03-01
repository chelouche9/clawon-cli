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

const program = new Command();
program
  .name('clawport')
  .description('ClawPort CLI skeleton (local-only until backend is ready)')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize local config interactively (skeleton)')
  .option('--api-base-url <url>', 'API base URL', 'https://api.clawport.ai')
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
  .description('Connect this host to a profile (local skeleton)')
  .requiredOption('--api-key <key>', 'Org API key')
  .requiredOption('--profile <name>', 'Profile name')
  .requiredOption('--instance-name <name>', 'Instance name')
  .option('--interval <interval>', 'Sync interval', '30m')
  .option('--api-base-url <url>', 'API base URL', 'https://api.clawport.ai')
  .action((opts) => {
    const schema = z.object({
      apiKey: z.string().min(3),
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

    const cfg: ClawportConfig = {
      apiKey: parsed.data.apiKey,
      profile: parsed.data.profile,
      instanceName: parsed.data.instanceName,
      interval: parsed.data.interval,
      apiBaseUrl: parsed.data.apiBaseUrl,
      connectedAt: new Date().toISOString(),
    };
    writeConfig(cfg);

    console.log('✅ Connected (skeleton mode, local config only)');
    console.log(`Profile: ${cfg.profile}`);
    console.log(`Instance: ${cfg.instanceName}`);
    console.log(`Interval: ${cfg.interval}`);
    console.log(`Config: ${CONFIG_PATH}`);
  });

program
  .command('status')
  .description('Show local connection status')
  .action(() => {
    const cfg = readConfig();
    if (!cfg) {
      console.log('Not connected. Run: clawport connect --api-key ... --profile ... --instance-name ...');
      return;
    }
    console.log('ClawPort status (skeleton):');
    console.log(`- API Base URL: ${cfg.apiBaseUrl}`);
    console.log(`- Profile: ${cfg.profile}`);
    console.log(`- Instance: ${cfg.instanceName}`);
    console.log(`- Interval: ${cfg.interval}`);
    console.log(`- Connected At: ${cfg.connectedAt || 'n/a'}`);
    console.log(`- Config Path: ${CONFIG_PATH}`);
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
  .description('Snapshot commands (skeleton)')
  .command('create')
  .description('Create snapshot (placeholder)')
  .action(() => {
    console.log('Snapshot create: placeholder (backend/API not wired yet).');
  });

program
  .command('sync')
  .description('Sync commands (skeleton)')
  .command('run')
  .description('Run one sync cycle (placeholder)')
  .action(() => {
    console.log('Sync run: placeholder (backend/API not wired yet).');
  });

program.parseAsync(process.argv);
