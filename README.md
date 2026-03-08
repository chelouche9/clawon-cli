# Clawon

Backup and restore your [OpenClaw](https://openclaw.ai) workspace. Move your memory, skills, and config between machines in one command.

## Quick Start

```bash
# No install needed — runs with npx
npx clawon discover          # Preview what will be backed up
npx clawon local backup      # Save a local backup
npx clawon local restore     # Restore from latest backup
```

## Commands

### Local Backups (no account needed)

Local backups are stored in `~/.clawon/backups/` as standard `.tar.gz` archives. You can inspect them with `tar tzf` or extract manually with `tar xzf`.

```bash
# Create a backup
npx clawon local backup
npx clawon local backup --tag "before migration"
npx clawon local backup --include-memory-db  # Include SQLite memory index
npx clawon local backup --include-sessions   # Include chat history
npx clawon local backup --max-snapshots 10   # Keep only 10 most recent

# List all local backups
npx clawon local list

# Restore
npx clawon local restore                # Latest backup
npx clawon local restore --pick 2       # Backup #2 from list
npx clawon local restore --file path.tar.gz  # External file
```

### Scheduled Backups

Set up automatic backups via cron (macOS/Linux only).

```bash
# Schedule local backups every 12 hours (default)
npx clawon local schedule on
npx clawon local schedule on --every 6h --max-snapshots 10
npx clawon local schedule on --include-memory-db
npx clawon local schedule on --include-sessions

# Disable local schedule
npx clawon local schedule off

# Schedule cloud backups (requires Hobby or Pro account)
npx clawon schedule on
npx clawon schedule off

# Check schedule status
npx clawon schedule status
```

### Cloud Backups (requires account)

Cloud backups sync your workspace to Clawon's servers for cross-machine access.

```bash
# Authenticate (env var recommended to avoid shell history)
export CLAWON_API_KEY=<your-key>
npx clawon login

# Or inline (key may appear in shell history)
npx clawon login --api-key <your-key>

# Create a cloud backup
npx clawon backup
npx clawon backup --tag "stable config"
npx clawon backup --dry-run             # Preview without uploading
npx clawon backup --include-memory-db   # Requires Pro account
npx clawon backup --include-sessions    # Requires Hobby or Pro

# List cloud backups
npx clawon list

# Restore from cloud
npx clawon restore
npx clawon restore --snapshot <id>      # Specific snapshot
npx clawon restore --dry-run            # Preview without extracting

# Manage snapshots
npx clawon delete <id>
npx clawon delete --oldest
npx clawon files                        # List files in a cloud backup
npx clawon activity                     # Recent events
```

### Other Commands

```bash
npx clawon discover    # Show exactly which files would be backed up
npx clawon discover --include-memory-db  # Include SQLite memory index
npx clawon discover --include-sessions   # Include chat history
npx clawon schedule status  # Show active schedules
npx clawon status      # Connection status and file count
npx clawon logout      # Remove local credentials
```

## What Gets Backed Up

Clawon uses an **allowlist** — only files matching these patterns are included:

| Pattern | What it captures |
|---------|-----------------|
| `workspace/*.md` | Workspace markdown (memory, notes, identity) |
| `workspace/memory/*.md` | Daily memory files |
| `workspace/memory/**/*.md` | Nested memory (projects, workflows, experiments) |
| `workspace/skills/**` | Custom skills |
| `workspace/canvas/**` | Canvas data |
| `skills/**` | Top-level skills |
| `agents/*/config.json` | Agent configurations |
| `agents/*/models.json` | Model preferences |
| `agents/*/agent/**` | Agent config data |
| `cron/runs/*.jsonl` | Cron run logs |

Run `npx clawon discover` to see the exact file list for your instance.

## What's Excluded

These are **always excluded**, even if they match an include pattern:

| Pattern | Why |
|---------|-----|
| `credentials/**` | API keys, tokens, auth files |
| `openclaw.json` | May contain credentials |
| `agents/*/auth.json` | Authentication data |
| `agents/*/auth-profiles.json` | Auth profiles |
| `agents/*/sessions/**` | Chat history (large, use `--include-sessions` to include) |
| `memory/lancedb/**` | Vector database (binary, large) |
| `memory/*.sqlite` | SQLite databases (use `--include-memory-db` to include) |
| `*.lock`, `*.wal`, `*.shm` | Database lock files |
| `node_modules/**` | Dependencies |

**Credentials never leave your machine.** The entire `credentials/` directory and `openclaw.json` are excluded by default. You can verify this by running `npx clawon discover` before any backup.

## Archive Format

Local backups are standard gzip-compressed tar archives (`.tar.gz`). You can inspect and extract them with standard tools:

```bash
# List contents
tar tzf ~/.clawon/backups/backup-2026-03-05T1030.tar.gz

# Extract manually
tar xzf ~/.clawon/backups/backup-2026-03-05T1030.tar.gz -C /tmp/inspect

# View metadata
tar xzf backup.tar.gz _clawon_meta.json -O | cat
```

Each archive contains:
- `_clawon_meta.json` — metadata (version, date, tag, file count)
- Your workspace files in their original directory structure

## Data Storage

| | Local | Cloud |
|---|---|---|
| **Location** | `~/.clawon/backups/` | Clawon servers (Supabase Storage) |
| **Format** | `.tar.gz` | Individual files with signed URLs |
| **Limit** | Unlimited | 2 snapshots (Starter), more on paid plans |
| **Account required** | No | Yes |
| **Cross-machine** | No (manual file transfer) | Yes |

## Configuration

Config is stored at `~/.clawon/config.json` after running `clawon login`. Contains your API key, profile ID, and API URL. Run `clawon logout` to remove it.

## Telemetry

Clawon collects anonymous usage events (e.g. "backup created", "restore completed") to understand which features are used. No file contents, filenames, or personal data are sent.

**To opt out**, set either environment variable:

```bash
# Standard convention (https://consoledonottrack.com)
export DO_NOT_TRACK=1

# Or Clawon-specific
export CLAWON_NO_TELEMETRY=1
```

Telemetry is powered by [PostHog](https://posthog.com). The public project key is visible in the source code.

## Requirements

- Node.js 18+
- An OpenClaw installation at `~/.openclaw/`
