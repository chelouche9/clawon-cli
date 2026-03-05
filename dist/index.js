#!/usr/bin/env node

// src/index.ts
import { Command } from "commander";
import fs from "fs";
import path from "path";
import os from "os";
import zlib from "zlib";
var CONFIG_DIR = path.join(os.homedir(), ".clawon");
var CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
var OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
var BACKUPS_DIR = path.join(CONFIG_DIR, "backups");
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function writeConfig(cfg) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
async function api(baseUrl, endpoint, method, apiKey, body) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-clawon-api-key": apiKey
    },
    body: body ? JSON.stringify(body) : void 0
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || json.message || `HTTP ${res.status}`);
  return json;
}
var INCLUDE_PATTERNS = [
  "workspace/*.md",
  "workspace/memory/*.md",
  "workspace/memory/**/*.md",
  "workspace/skills/**",
  "workspace/canvas/**",
  "skills/**",
  "agents/*/config.json"
];
var EXCLUDE_PATTERNS = [
  "credentials/**",
  "agents/*/sessions/**",
  "memory/lancedb/**",
  "memory/*.sqlite",
  "*.lock",
  "*.wal",
  "*.shm",
  "node_modules/**",
  ".git/**",
  ".DS_Store",
  "Thumbs.db"
];
function matchGlob(filePath, pattern) {
  let regexPattern = pattern.replace(/\./g, "\\.").replace(/\*\*\//g, "(.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${regexPattern}$`).test(filePath);
}
function shouldInclude(relativePath) {
  for (const pattern of EXCLUDE_PATTERNS) {
    if (matchGlob(relativePath, pattern)) return false;
  }
  for (const pattern of INCLUDE_PATTERNS) {
    if (matchGlob(relativePath, pattern)) return true;
  }
  return false;
}
function discoverFiles(baseDir) {
  const files = [];
  function walk(dir, relativePath = "") {
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
            size: stats.size
          });
        }
      }
    }
  }
  walk(baseDir);
  return files;
}
function createLocalArchive(files, openclawDir) {
  const archiveFiles = files.map((f) => {
    const fullPath = path.join(openclawDir, f.path);
    const content = fs.readFileSync(fullPath).toString("base64");
    return { path: f.path, size: f.size, content };
  });
  const archive = {
    version: 1,
    created: (/* @__PURE__ */ new Date()).toISOString(),
    files: archiveFiles
  };
  return zlib.gzipSync(JSON.stringify(archive));
}
function extractLocalArchive(archivePath) {
  const compressed = fs.readFileSync(archivePath);
  const json = zlib.gunzipSync(compressed).toString("utf8");
  const archive = JSON.parse(json);
  return { created: archive.created, files: archive.files };
}
var POSTHOG_KEY = "phc_LGJC4ZrED6EiK0sC1fusErOhR6gHlFCS5Qs7ou93SmV";
function trackCliEvent(distinctId, event, properties = {}) {
  fetch("https://us.i.posthog.com/capture/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      distinct_id: distinctId,
      event,
      properties: { ...properties, source: "cli" }
    })
  }).catch(() => {
  });
}
var program = new Command();
program.name("clawon").description("Backup and restore your OpenClaw workspace").version("0.1.1");
program.command("login").description("Connect to Clawon with your API key").requiredOption("--api-key <key>", "Your Clawon API key").option("--api-url <url>", "API base URL", "https://clawon.io").action(async (opts) => {
  try {
    const connectJson = await api(opts.apiUrl, "/api/v1/profile/connect", "POST", opts.apiKey, {
      profileName: "default",
      instanceName: os.hostname(),
      syncIntervalMinutes: 60
    });
    writeConfig({
      apiKey: opts.apiKey,
      profileId: connectJson.profileId,
      apiBaseUrl: opts.apiUrl,
      connectedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    console.log("\u2713 Logged in");
    console.log(`  Profile ID: ${connectJson.profileId}`);
  } catch (e) {
    console.error(`\u2717 Login failed: ${e.message}`);
    process.exit(1);
  }
});
program.command("backup").description("Backup your OpenClaw workspace to the cloud").option("--dry-run", "Show what would be backed up without uploading").action(async (opts) => {
  const cfg = readConfig();
  if (!cfg) {
    console.error("\u2717 Not logged in. Run: clawon login --api-key <key>");
    process.exit(1);
  }
  if (!fs.existsSync(OPENCLAW_DIR)) {
    console.error(`\u2717 OpenClaw directory not found: ${OPENCLAW_DIR}`);
    process.exit(1);
  }
  console.log("Discovering files...");
  const files = discoverFiles(OPENCLAW_DIR);
  if (files.length === 0) {
    console.error("\u2717 No files found to backup");
    process.exit(1);
  }
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const categories = {
    workspace: files.filter((f) => f.path.startsWith("workspace/")),
    skills: files.filter((f) => f.path.startsWith("skills/")),
    agents: files.filter((f) => f.path.startsWith("agents/"))
  };
  console.log(`Found ${files.length} files (${(totalSize / 1024).toFixed(1)} KB):`);
  if (categories.workspace.length) console.log(`  \u2022 workspace: ${categories.workspace.length} files`);
  if (categories.skills.length) console.log(`  \u2022 skills: ${categories.skills.length} files`);
  if (categories.agents.length) console.log(`  \u2022 agents: ${categories.agents.length} files`);
  if (opts.dryRun) {
    console.log("\n[Dry run] Files that would be backed up:");
    files.forEach((f) => console.log(`  ${f.path} (${f.size} bytes)`));
    return;
  }
  try {
    console.log("\nCreating backup...");
    const { snapshotId, uploadUrls } = await api(
      cfg.apiBaseUrl,
      "/api/v1/backups/prepare",
      "POST",
      cfg.apiKey,
      {
        profileId: cfg.profileId,
        files: files.map((f) => ({ path: f.path, size: f.size }))
      }
    );
    console.log(`Uploading ${files.length} files...`);
    let uploaded = 0;
    for (const file of files) {
      const fullPath = path.join(OPENCLAW_DIR, file.path);
      const content = fs.readFileSync(fullPath);
      const uploadRes = await fetch(uploadUrls[file.path], {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: content
      });
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Failed to upload ${file.path}: ${uploadRes.status} ${errText}`);
      }
      uploaded++;
      process.stdout.write(`\r  Uploaded: ${uploaded}/${files.length}`);
    }
    console.log("");
    await api(cfg.apiBaseUrl, "/api/v1/backups/confirm", "POST", cfg.apiKey, {
      snapshotId,
      profileId: cfg.profileId
    });
    console.log("\n\u2713 Backup complete!");
    console.log(`  Snapshot ID: ${snapshotId}`);
    console.log(`  Files: ${files.length}`);
    console.log(`  Size: ${(totalSize / 1024).toFixed(1)} KB`);
    trackCliEvent(cfg.profileId, "cloud_backup_created", {
      file_count: files.length,
      total_bytes: totalSize
    });
  } catch (e) {
    const msg = e.message;
    if (msg.includes("Snapshot limit")) {
      console.error("\n\u2717 Snapshot limit reached (2).");
      console.error("  Delete one first:  clawon delete <id>");
      console.error("  Delete oldest:     clawon delete --oldest");
      console.error("  List snapshots:    clawon list");
    } else {
      console.error(`
\u2717 Backup failed: ${msg}`);
    }
    process.exit(1);
  }
});
program.command("restore").description("Restore your OpenClaw workspace from the cloud").option("--snapshot <id>", "Specific snapshot ID to restore (default: latest)").option("--dry-run", "Show what would be restored without extracting").action(async (opts) => {
  const cfg = readConfig();
  if (!cfg) {
    console.error("\u2717 Not logged in. Run: clawon login --api-key <key>");
    process.exit(1);
  }
  try {
    console.log("Fetching backup...");
    const { snapshot, files, downloadUrls } = await api(
      cfg.apiBaseUrl,
      "/api/v1/backups/download",
      "POST",
      cfg.apiKey,
      {
        profileId: cfg.profileId,
        snapshotId: opts.snapshot || null
      }
    );
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    console.log(`Found backup from ${new Date(snapshot.created_at).toLocaleString()}`);
    console.log(`  Files: ${files.length}`);
    console.log(`  Size: ${(totalSize / 1024).toFixed(1)} KB`);
    if (opts.dryRun) {
      console.log("\n[Dry run] Files that would be restored:");
      files.forEach((f) => console.log(`  ${f.path}`));
      return;
    }
    console.log("\nDownloading files...");
    let downloaded = 0;
    for (const file of files) {
      const res = await fetch(downloadUrls[file.path]);
      if (!res.ok) {
        throw new Error(`Failed to download ${file.path}: ${res.status}`);
      }
      const content = Buffer.from(await res.arrayBuffer());
      const targetPath = path.join(OPENCLAW_DIR, file.path);
      ensureDir(path.dirname(targetPath));
      fs.writeFileSync(targetPath, content);
      downloaded++;
      process.stdout.write(`\r  Downloaded: ${downloaded}/${files.length}`);
    }
    console.log("");
    await api(cfg.apiBaseUrl, "/api/v1/snapshots/restore", "POST", cfg.apiKey, {
      profileId: cfg.profileId,
      snapshotId: snapshot.id
    });
    console.log("\n\u2713 Restore complete!");
    console.log(`  Restored to: ${OPENCLAW_DIR}`);
    console.log(`  Files: ${files.length}`);
    trackCliEvent(cfg.profileId, "cloud_backup_restored", {
      file_count: files.length
    });
  } catch (e) {
    console.error(`
\u2717 Restore failed: ${e.message}`);
    process.exit(1);
  }
});
program.command("list").description("List your backups").option("--limit <n>", "Number of backups to show", "10").action(async (opts) => {
  const cfg = readConfig();
  if (!cfg) {
    console.error("\u2717 Not logged in. Run: clawon login --api-key <key>");
    process.exit(1);
  }
  try {
    const { snapshots } = await api(
      cfg.apiBaseUrl,
      `/api/v1/snapshots/list?profileId=${cfg.profileId}&limit=${opts.limit}`,
      "GET",
      cfg.apiKey
    );
    if (!snapshots?.length) {
      console.log("No backups yet. Run: clawon backup");
      return;
    }
    console.log("Your backups:\n");
    console.log("ID                                   | Date                 | Files | Size");
    console.log("\u2500".repeat(80));
    for (const s of snapshots) {
      const date = new Date(s.created_at).toLocaleString();
      const size = s.size_bytes ? `${(s.size_bytes / 1024).toFixed(1)} KB` : "N/A";
      const files = s.changed_files_count || "N/A";
      console.log(`${s.id} | ${date.padEnd(20)} | ${String(files).padEnd(5)} | ${size}`);
    }
    console.log(`
Total: ${snapshots.length} backup(s)`);
  } catch (e) {
    console.error(`\u2717 Failed to list backups: ${e.message}`);
    process.exit(1);
  }
});
var ACTIVITY_LABELS = {
  BACKUP_CREATED: "Backup created",
  SNAPSHOT_CREATED: "Snapshot created",
  SNAPSHOT_DELETED: "Snapshot deleted",
  SNAPSHOT_RESTORED: "Snapshot restored",
  BACKUP_DOWNLOADED: "Backup downloaded",
  CONNECTED: "Connected",
  DISCONNECTED: "Disconnected"
};
function formatEventLabel(type) {
  return ACTIVITY_LABELS[type] || type.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
function formatEventDetails(payload) {
  if (!payload || typeof payload !== "object") return "";
  const parts = [];
  if (payload.fileCount != null || payload.changedFilesCount != null) {
    parts.push(`${payload.fileCount ?? payload.changedFilesCount} files`);
  }
  if (payload.snapshotId) {
    parts.push(payload.snapshotId);
  }
  if (payload.instanceName) {
    parts.push(payload.instanceName);
  }
  return parts.join(" \xB7 ");
}
program.command("activity").description("Show recent activity").option("--limit <n>", "Number of events to show", "10").action(async (opts) => {
  const cfg = readConfig();
  if (!cfg) {
    console.error("\u2717 Not logged in. Run: clawon login --api-key <key>");
    process.exit(1);
  }
  try {
    const { events } = await api(
      cfg.apiBaseUrl,
      `/api/v1/events/list?profileId=${cfg.profileId}&limit=${opts.limit}`,
      "GET",
      cfg.apiKey
    );
    if (!events?.length) {
      console.log("No activity yet. Run: clawon backup");
      return;
    }
    console.log("Recent activity:\n");
    console.log("Date                 | Event              | Details");
    console.log("\u2500".repeat(80));
    for (const ev of events) {
      const date = new Date(ev.created_at).toLocaleString();
      const label = formatEventLabel(ev.type);
      const details = formatEventDetails(ev.payload);
      console.log(`${date.padEnd(20)} | ${label.padEnd(18)} | ${details}`);
    }
  } catch (e) {
    console.error(`\u2717 Failed to load activity: ${e.message}`);
    process.exit(1);
  }
});
program.command("delete [id]").description("Delete a snapshot").option("--oldest", "Delete the oldest ready snapshot").action(async (id, opts) => {
  const cfg = readConfig();
  if (!cfg) {
    console.error("\u2717 Not logged in. Run: clawon login --api-key <key>");
    process.exit(1);
  }
  if (!id && !opts.oldest) {
    console.error("\u2717 Provide a snapshot ID or use --oldest");
    console.error("  Usage:  clawon delete <id>");
    console.error("          clawon delete --oldest");
    process.exit(1);
  }
  try {
    let snapshotId = id;
    if (opts.oldest) {
      const { snapshots } = await api(
        cfg.apiBaseUrl,
        `/api/v1/snapshots/list?profileId=${cfg.profileId}&limit=50`,
        "GET",
        cfg.apiKey
      );
      const readySnapshots = (snapshots || []).filter((s) => s.status === "ready");
      if (readySnapshots.length === 0) {
        console.error("\u2717 No ready snapshots to delete");
        process.exit(1);
      }
      snapshotId = readySnapshots[readySnapshots.length - 1].id;
      console.log(`Oldest ready snapshot: ${snapshotId}`);
    }
    await api(cfg.apiBaseUrl, "/api/v1/snapshots/delete", "POST", cfg.apiKey, {
      profileId: cfg.profileId,
      snapshotId
    });
    console.log(`\u2713 Deleted snapshot ${snapshotId}`);
  } catch (e) {
    console.error(`\u2717 Delete failed: ${e.message}`);
    process.exit(1);
  }
});
program.command("files").description("List files in a backup").option("--snapshot <id>", "Snapshot ID (default: latest)").action(async (opts) => {
  const cfg = readConfig();
  if (!cfg) {
    console.error("\u2717 Not logged in. Run: clawon login --api-key <key>");
    process.exit(1);
  }
  try {
    const { snapshot, files } = await api(
      cfg.apiBaseUrl,
      "/api/v1/backups/files",
      "POST",
      cfg.apiKey,
      {
        profileId: cfg.profileId,
        snapshotId: opts.snapshot || null
      }
    );
    console.log(`Backup: ${snapshot.id}`);
    console.log(`Date: ${new Date(snapshot.created_at).toLocaleString()}
`);
    const tree = {};
    for (const f of files) {
      const dir = path.dirname(f.path);
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push(f);
    }
    for (const dir of Object.keys(tree).sort()) {
      console.log(`\u{1F4C1} ${dir}/`);
      for (const f of tree[dir]) {
        const name = path.basename(f.path);
        console.log(`   \u{1F4C4} ${name} (${f.size} bytes)`);
      }
    }
    console.log(`
Total: ${files.length} files`);
  } catch (e) {
    console.error(`\u2717 Failed to list files: ${e.message}`);
    process.exit(1);
  }
});
var local = program.command("local").description("Local backup and restore (no cloud required)");
local.command("backup").description("Save a local backup of your OpenClaw workspace").action(async () => {
  if (!fs.existsSync(OPENCLAW_DIR)) {
    console.error(`\u2717 OpenClaw directory not found: ${OPENCLAW_DIR}`);
    process.exit(1);
  }
  console.log("Discovering files...");
  const files = discoverFiles(OPENCLAW_DIR);
  if (files.length === 0) {
    console.error("\u2717 No files found to backup");
    process.exit(1);
  }
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`Found ${files.length} files (${(totalSize / 1024).toFixed(1)} KB)`);
  console.log("Creating archive...");
  const archive = createLocalArchive(files, OPENCLAW_DIR);
  ensureDir(BACKUPS_DIR);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "").replace("T", "T").slice(0, 15);
  const filename = `backup-${timestamp}.tar.gz`;
  const filePath = path.join(BACKUPS_DIR, filename);
  fs.writeFileSync(filePath, archive);
  console.log(`
\u2713 Local backup saved!`);
  console.log(`  File: ${filePath}`);
  console.log(`  Files: ${files.length}`);
  console.log(`  Size: ${(archive.length / 1024).toFixed(1)} KB (compressed)`);
  const cfg = readConfig();
  trackCliEvent(cfg?.profileId || "anonymous", "local_backup_created", {
    file_count: files.length,
    total_bytes: totalSize
  });
});
local.command("list").description("List local backups").action(async () => {
  if (!fs.existsSync(BACKUPS_DIR)) {
    console.log("No local backups yet. Run: clawon local backup");
    return;
  }
  const entries = fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith(".tar.gz")).sort().reverse();
  if (entries.length === 0) {
    console.log("No local backups yet. Run: clawon local backup");
    return;
  }
  console.log("Local backups:\n");
  console.log("#  | Date                      | Files | Size     | Path");
  console.log("\u2500".repeat(100));
  for (let i = 0; i < entries.length; i++) {
    const filePath = path.join(BACKUPS_DIR, entries[i]);
    try {
      const { created, files } = extractLocalArchive(filePath);
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      const date = new Date(created).toLocaleString();
      console.log(
        `${String(i + 1).padStart(2)} | ${date.padEnd(25)} | ${String(files.length).padEnd(5)} | ${(totalSize / 1024).toFixed(1).padEnd(8)} KB | ${filePath}`
      );
    } catch {
      console.log(`${String(i + 1).padStart(2)} | ${entries[i].padEnd(25)} | ???   | ???        | ${filePath}`);
    }
  }
  console.log(`
Total: ${entries.length} backup(s)`);
  console.log(`
Restore a backup:`);
  console.log(`  clawon local restore              Restore the latest backup (#1)`);
  console.log(`  clawon local restore --pick 2     Restore backup #2 from this list`);
  console.log(`  clawon local restore --file <path> Restore from an external file`);
});
local.command("restore").description("Restore from a local backup").option("--file <path>", "Path to an external backup file").option("--pick <n>", 'Restore backup #n from "clawon local list"').action(async (opts) => {
  let archivePath;
  if (opts.file) {
    archivePath = path.resolve(opts.file);
    if (!fs.existsSync(archivePath)) {
      console.error(`\u2717 File not found: ${archivePath}`);
      process.exit(1);
    }
  } else {
    if (!fs.existsSync(BACKUPS_DIR)) {
      console.error("\u2717 No local backups found. Run: clawon local backup");
      process.exit(1);
    }
    const entries = fs.readdirSync(BACKUPS_DIR).filter((f) => f.endsWith(".tar.gz")).sort().reverse();
    if (entries.length === 0) {
      console.error("\u2717 No local backups found. Run: clawon local backup");
      process.exit(1);
    }
    if (opts.pick) {
      const idx = parseInt(opts.pick, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= entries.length) {
        console.error(`\u2717 Invalid pick: #${opts.pick}. Run "clawon local list" to see available backups (1-${entries.length}).`);
        process.exit(1);
      }
      archivePath = path.join(BACKUPS_DIR, entries[idx]);
    } else {
      archivePath = path.join(BACKUPS_DIR, entries[0]);
    }
  }
  console.log(`Restoring from: ${archivePath}`);
  try {
    const { created, files } = extractLocalArchive(archivePath);
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    console.log(`Backup date: ${new Date(created).toLocaleString()}`);
    console.log(`Files: ${files.length} (${(totalSize / 1024).toFixed(1)} KB)`);
    let restored = 0;
    for (const file of files) {
      const targetPath = path.join(OPENCLAW_DIR, file.path);
      ensureDir(path.dirname(targetPath));
      fs.writeFileSync(targetPath, Buffer.from(file.content, "base64"));
      restored++;
      process.stdout.write(`\r  Restored: ${restored}/${files.length}`);
    }
    console.log("");
    console.log(`
\u2713 Restore complete!`);
    console.log(`  Restored to: ${OPENCLAW_DIR}`);
    console.log(`  Files: ${files.length}`);
    const cfg = readConfig();
    trackCliEvent(cfg?.profileId || "anonymous", "local_backup_restored", {
      file_count: files.length,
      source: opts.file ? "file" : "local"
    });
  } catch (e) {
    console.error(`
\u2717 Restore failed: ${e.message}`);
    process.exit(1);
  }
});
program.command("status").description("Show current status").action(async () => {
  const cfg = readConfig();
  console.log("Clawon Status\n");
  if (cfg) {
    console.log(`\u2713 Logged in`);
    console.log(`  Profile ID: ${cfg.profileId}`);
    console.log(`  API: ${cfg.apiBaseUrl}`);
  } else {
    console.log(`\u2717 Not logged in`);
    console.log(`  Run: clawon login --api-key <key>`);
  }
  console.log("");
  if (fs.existsSync(OPENCLAW_DIR)) {
    const files = discoverFiles(OPENCLAW_DIR);
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    console.log(`\u2713 OpenClaw found: ${OPENCLAW_DIR}`);
    console.log(`  Backupable files: ${files.length} (${(totalSize / 1024).toFixed(1)} KB)`);
  } else {
    console.log(`\u2717 OpenClaw not found: ${OPENCLAW_DIR}`);
  }
});
program.command("logout").description("Remove local credentials").action(() => {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
    console.log("\u2713 Logged out");
  } else {
    console.log("Already logged out");
  }
});
program.parseAsync(process.argv);
