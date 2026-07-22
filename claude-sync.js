#!/usr/bin/env node

/**
 * claude-sync — cross-machine sync for Claude Code configurations
 *
 * Usage:
 *   claude-sync init              # interactive setup
 *   claude-sync push [--force]    # upload config from this machine
 *   claude-sync pull [--cover|--keep|--dry-run]  # download & merge config
 *   claude-sync status            # show diff summary (read-only)
 *   claude-sync diff              # show detailed content diff
 *   claude-sync restore --backup <timestamp>  # rollback to backup
 *   claude-sync restore --list    # list available backups
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readConfig, remotePath, expandTilde } from './lib/config.js';
import { spawnSync } from 'node:child_process';
import { prompt, promptYesNo, pickFromList } from './lib/prompt.js';
import { pushWorkflow, pullWorkflow, readSettings, extractMcpServers, countMemoryTopics } from './lib/workflow.js';
import { createRcloneBackend } from './backends/rclone.js';
import { createManualBackend } from './backends/manual.js';
import { createCustomBackend } from './backends/custom.js';
import { readManifest, hashFile, readPluginVersions } from './lib/sync.js';
import { detectSkills } from './lib/detect.js';

const KNOWN_COMMANDS = ['push', 'pull', 'init', 'status', 'diff', 'restore', 'help'];

/**
 * Parse command-line arguments into a command and flags.
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const flags = {};

  // Handle top-level -v / --version before any command
  for (const arg of args) {
    if (arg === '-v' || arg === '--version') {
      flags.version = true;
      return { command, flags };
    }
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      return { command, flags };
    }
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        flags[key] = nextArg;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

function getVersion() {
  try {
    const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelp() {
  console.log(`claude-sync — cross-machine sync for Claude Code configurations

Usage:
  claude-sync init                Interactive setup (choose backend + remote)
  claude-sync push [--force]      Upload config from this machine
  claude-sync pull [--cover|--keep|--interactive|--dry-run]
                                  Download & merge config to this machine
  claude-sync status              Show summary of local vs remote differences
  claude-sync diff                Show detailed content differences
  claude-sync restore --backup <timestamp>
                                  Rollback to a pull backup
  claude-sync restore --list      List available backups
  claude-sync restore --cleanup <timestamp>
                                  Remove a specific backup
  claude-sync restore --cleanup-all
                                  Remove all backups

Flags:
  -v, --version                   Print version
  -h, --help                      Print this help

Backends: rclone (default), manual, custom
Config:   ~/.claude-sync.conf (JSON) or ~/.claude-sync.json
`);
}

function loadUserConfig() {
  const configPaths = [
    path.join(os.homedir(), '.claude-sync.conf'),
    path.join(os.homedir(), '.claude-sync.json')
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // try next path
    }
  }

  return {};
}

function createBackend(config) {
  switch (config.BACKEND) {
    case 'rclone':
      return createRcloneBackend();
    case 'manual':
      return createManualBackend({ bundleDir: config.BUNDLE_DIR });
    case 'custom':
      return createCustomBackend(config);
    default:
      return createRcloneBackend();
  }
}

/**
 * Initialize the rclone backend REMOTE configuration.
 *
 * Extracted as a testable unit — all side effects (spawn, prompts) are
 * injected so tests can mock them.
 *
 * @param {object} config - the accumulating finalConfig object (mutated in place)
 * @param {object} deps - injectable dependencies
 * @param {object} deps.backend - rclone backend instance (must have listRemotes)
 * @param {function} deps.spawnFn - function like child_process.spawnSync
 * @param {function} deps.askYesNo - promptYesNo equivalent
 * @param {function} deps.askText - text prompt equivalent
 * @param {function} deps.askPick - list picker equivalent
 * @returns {Promise<{success: boolean, remote?: string, reason?: string}>}
 */
export async function initRcloneRemote(config, {
  spawnFn = spawnSync,
  listRemotesFn,
  askText = prompt,
  askPick = pickFromList
} = {}) {
  // ── Phase 1: Check rclone CLI is installed ──
  const check = spawnFn('rclone', ['version'], { stdio: 'pipe' });
  if (check.error) {
    return {
      success: false,
      reason: 'user_back',
      message: [
        '✗ rclone not found. Install it first, or pick another backend:',
        '  macOS:  brew install rclone',
        '  Linux:  curl https://rclone.org/install.sh | sudo bash',
        '  Windows: scoop install rclone',
        '  Docs: https://rclone.org/install/'
      ]
    };
  }

  // ── Phase 2: Wait for user to configure remotes ──
  while (true) {
    let remotes;
    let errorMsg = null;
    try {
      remotes = await listRemotesFn();
    } catch {
      errorMsg = '⚠ rclone error while listing remotes. Is rclone installed correctly?';
    }

    if (errorMsg) {
      const choice = await askPick(
        `Checking rclone remotes...\n${errorMsg}`,
        ['Retry', 'Back'],
        'Retry',
        ['✓ rclone found']
      );
      if (choice === 'Back') return { success: false, reason: 'user_back' };
      continue;
    }

    if (remotes.length > 0) {
      const remoteName = await askPick(
        `Found ${remotes.length} remote(s):`,
        remotes,
        remotes[0],
        ['✓ rclone found']
      );
      // REMOTE is just the rclone remote name — folder path is set at push time
      config.REMOTE = `${remoteName}:`;
      return { success: true, remote: config.REMOTE };
    }

    // No remotes — user must configure rclone themselves
    const choice = await askPick(
      'No remotes configured.',
      ['Retry', 'Back'],
      'Retry',
      [
        '✓ rclone found',
        'Please run "rclone config" to set up a cloud drive,',
        'then come back here to continue.'
      ]
    );
    if (choice === 'Back') return { success: false, reason: 'user_back' };
    // Retry — loop back and re-check
  }
}

/**
 * Detect known cloud-sync folders that actually exist on this machine.
 *
 * Pure/injectable: takes home + existsSync + readdirSync + platform so tests
 * can simulate any OS layout. Returns only directories that exist, each as
 * {label, dir}. We probe the *sync root*; the caller appends a claude-sync
 * subfolder.
 *
 * macOS note: OneDrive and Google Drive live under ~/Library/CloudStorage with
 * a DYNAMIC suffix — OneDrive-Personal / OneDrive-<Company> and
 * GoogleDrive-<email>. So we list CloudStorage and prefix-match rather than
 * probing fixed names. (Verified against Microsoft/Google docs, 2026-07.)
 *
 * @param {object} deps
 * @param {string} deps.home - user home directory
 * @param {function} deps.existsSync - fs.existsSync-like predicate
 * @param {function} [deps.readdirSync] - fs.readdirSync-like (for CloudStorage scan)
 * @param {string} [deps.platform] - process.platform ('darwin' | 'win32' | ...)
 * @returns {Array<{label: string, dir: string}>}
 */
export function detectCloudDirs({ home, existsSync, readdirSync, platform = process.platform } = {}) {
  const found = [];
  const add = (label, dir) => { if (dir && existsSync(dir)) found.push({ label, dir }); };

  if (platform === 'darwin') {
    add('iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));

    // Library/CloudStorage entries carry a dynamic suffix (account/company/email).
    // List the dir and prefix-match instead of guessing exact names.
    const cloudStorage = path.join(home, 'Library', 'CloudStorage');
    if (readdirSync && existsSync(cloudStorage)) {
      let entries = [];
      try { entries = readdirSync(cloudStorage); } catch { entries = []; }
      for (const entry of entries) {
        let label = null;
        if (entry.startsWith('OneDrive')) label = 'OneDrive';       // OneDrive-Personal / OneDrive-<Company>
        else if (entry.startsWith('GoogleDrive')) label = 'Google Drive'; // GoogleDrive-<email>
        else if (entry.startsWith('Dropbox')) label = 'Dropbox';    // Dropbox (newer macOS)
        if (label) {
          const suffix = entry.includes('-') ? ` (${entry.slice(entry.indexOf('-') + 1)})` : '';
          found.push({ label: `${label}${suffix}`, dir: path.join(cloudStorage, entry) });
        }
      }
    }
  } else if (platform === 'win32') {
    add('OneDrive', path.join(home, 'OneDrive'));
    // iCloud for Windows: official name has a space; older variant has none.
    add('iCloud Drive', path.join(home, 'iCloud Drive'));
    add('iCloud Drive', path.join(home, 'iCloudDrive'));
  }
  // Dropbox lives in ~/Dropbox on every platform (still the mainstream default).
  add('Dropbox', path.join(home, 'Dropbox'));

  return found;
}

/**
 * Resolve the manual-backend bundle directory during init.
 *
 * Pure/injectable: no console. If cloud folders are detected on this machine,
 * offers them (via pickList) alongside the local default and a "Custom..."
 * escape hatch. Otherwise falls back to a plain text prompt. Leading ~ is
 * expanded; empty input keeps the platform/config default.
 *
 * @param {object} config - config (reads BUNDLE_DIR / HOME for defaults)
 * @param {object} deps
 * @param {function} deps.askText - prompt(question) => Promise<string>
 * @param {function} [deps.pickList] - pickFromList-like (question, items, default) => Promise<string>
 * @param {function} [deps.existsSync] - fs.existsSync-like (for cloud detection)
 * @param {function} [deps.readdirSync] - fs.readdirSync-like (for CloudStorage scan)
 * @param {string} [deps.platform] - process.platform override for tests
 * @param {string} [deps.home] - home dir for ~ expansion / detection
 * @returns {Promise<string>} the resolved absolute bundle directory
 */
export async function resolveManualBundleDir(config, { askText, pickList, existsSync, readdirSync, platform, home } = {}) {
  const h = home || config.HOME || os.homedir();
  const defaultBundle = config.BUNDLE_DIR || path.join(h, '.claude-sync-bundle');

  // Offer detected cloud folders as ready-made choices when we can probe the FS.
  const clouds = (pickList && existsSync)
    ? detectCloudDirs({ home: h, existsSync, readdirSync, platform })
    : [];

  if (clouds.length > 0) {
    const CUSTOM = 'Custom path...';
    const LOCAL = `Local only (${defaultBundle})`;
    // Each cloud gets a claude-sync/ subfolder so the sync root stays clean.
    const cloudChoices = clouds.map(c => ({ label: `${c.label} — ${path.join(c.dir, 'claude-sync')}`, dir: path.join(c.dir, 'claude-sync') }));
    const items = [...cloudChoices.map(c => c.label), LOCAL, CUSTOM];
    const chosen = await pickList('Where should the bundle live?', items, cloudChoices[0].label);

    if (chosen === CUSTOM) {
      const answer = await askText(`Bundle directory [${defaultBundle}]: `);
      return (answer && answer.trim()) ? expandTilde(answer.trim(), h) : defaultBundle;
    }
    if (chosen === LOCAL) return defaultBundle;
    const match = cloudChoices.find(c => c.label === chosen);
    return match ? match.dir : defaultBundle;
  }

  // No cloud detected (or FS not probeable): plain text prompt.
  const answer = await askText(`Bundle directory [${defaultBundle}]: `);
  return (answer && answer.trim())
    ? expandTilde(answer.trim(), h)
    : defaultBundle;
}

/**
 * Confirm (or override) the manual-backend bundle directory during push/pull.
 *
 * Pure/injectable: no fs, no console. Shows the current dir, lets the user press
 * Enter to keep it or type a new path (leading ~ expanded). Reports whether the
 * value changed so the caller can decide to persist.
 *
 * @param {object} config - config (reads BUNDLE_DIR / HOME)
 * @param {object} deps
 * @param {function} deps.askText - prompt(question) => Promise<string>
 * @param {string} deps.verb - shown in the prompt, e.g. 'saved to' or 'pulled from'
 * @param {string} [deps.home] - home dir for ~ expansion
 * @returns {Promise<{bundleDir: string, changed: boolean}>}
 */
export async function confirmManualBundleDir(config, { askText, verb = 'saved to', home } = {}) {
  const h = home || config.HOME || os.homedir();
  const cur = config.BUNDLE_DIR || path.join(h, '.claude-sync-bundle');
  const answer = await askText(`Bundle will be ${verb} [${cur}] (Enter to confirm, or type another path): `);
  if (answer && answer.trim() && answer.trim() !== cur) {
    return { bundleDir: expandTilde(answer.trim(), h), changed: true };
  }
  return { bundleDir: cur, changed: false };
}

/**
 * Build the config object that `claude-sync init` persists to disk.
 *
 * Rebuilt from scratch for the chosen backend, so re-running init (e.g.
 * switching backends) never leaves fields from a previous backend behind in
 * ~/.claude-sync.json. Only fields that belong to the current backend are
 * kept; anything else carried over from the previously loaded config is
 * dropped — this is what "clear the local config before writing" means in
 * practice, since writeFileSync overwrites the file wholesale.
 *
 * @param {object} finalConfig - the config accumulated during the init flow
 * @returns {object} a clean config safe to write to ~/.claude-sync.json
 */
export function buildInitConfig(finalConfig) {
  const backend = finalConfig.BACKEND;
  const toSave = {
    BACKEND: backend,
    MACHINE_ID: finalConfig.MACHINE_ID
  };
  if (backend === 'rclone') {
    if (finalConfig.REMOTE) toSave.REMOTE = finalConfig.REMOTE;
  } else if (backend === 'manual') {
    if (finalConfig.BUNDLE_DIR) toSave.BUNDLE_DIR = finalConfig.BUNDLE_DIR;
  } else if (backend === 'custom') {
    if (finalConfig.UPLOAD_CMD) toSave.UPLOAD_CMD = finalConfig.UPLOAD_CMD;
    if (finalConfig.DOWNLOAD_CMD) toSave.DOWNLOAD_CMD = finalConfig.DOWNLOAD_CMD;
  }
  return toSave;
}

async function runInit(config) {
  console.log('╔══════════════════════════════════╗');
  console.log('║   claude-sync — interactive init ║');
  console.log('╚══════════════════════════════════╝');
  console.log();

  // 1. Choose backend (loops back on 'user_back' from rclone init)
  const BACKEND_OPTIONS = ['rclone', 'manual', 'custom'];
  let backend;
  let statusMsg = null;
  const finalConfig = { ...config };

  // DEC save/restore cursor (ESC 7 / ESC 8) — independent of ANSI ESC[s used by pickFromList
  process.stdout.write('\x1b7');

  while (true) {
    // Return to saved position and clear below, so each iteration overwrites previous render
    process.stdout.write('\x1b8\x1b[J');
    backend = await pickFromList(
      'Pick a backend:',
      BACKEND_OPTIONS,
      config.BACKEND || 'rclone',
      [
        'Available backends:',
        '  rclone    — 40+ cloud drives (Dropbox/GDrive/OneDrive/S3/WebDAV...)',
        '  manual    — No CLI needed, handle files yourself (iCloud)',
        '  custom    — Your own upload/download commands'
      ],
      statusMsg  // footer — error messages shown at the bottom
    );
    statusMsg = null; // clear after display
    finalConfig.BACKEND = backend;

    // 2. Configure REMOTE per backend
    if (backend === 'rclone') {
      const rcloneBackend = createRcloneBackend();
      const rcloneResult = await initRcloneRemote(finalConfig, {
        spawnFn: spawnSync,
        listRemotesFn: () => rcloneBackend.listRemotes(),
        askText: prompt,
        askPick: pickFromList
      });
      if (rcloneResult.message) {
        statusMsg = rcloneResult.message;
      }
      if (rcloneResult.reason === 'user_back') {
        continue;
      }
      break;
    } else if (backend === 'custom') {
      console.log();
      console.log('Custom backend — define your own upload/download shell commands.');
      console.log('Use {file} for the local file path and {remote} for the remote path.');
      console.log();
      console.log('Examples:');
      console.log('  rsync {file} user@nas:/backup/{remote}');
      console.log('  aws s3 cp {file} s3://my-bucket/claude-sync/{remote}');
      console.log('  scp {file} my-server:/data/claude-sync/bundle.tar.gz');
      console.log();
      const upCmd = await prompt('Upload command: ');
      if (upCmd.trim()) finalConfig.UPLOAD_CMD = upCmd.trim();
      const downCmd = await prompt('Download command: ');
      if (downCmd.trim()) finalConfig.DOWNLOAD_CMD = downCmd.trim();
    } else if (backend === 'manual') {
      console.log();
      console.log('Manual backend — claude-sync only packs/unpacks; you move the bundle yourself.');
      console.log('Point the bundle dir at any folder: an iCloud/OneDrive sync folder, a USB');
      console.log('stick, or anywhere you like. claude-sync does not care what is behind it.');
      console.log();
      finalConfig.BUNDLE_DIR = await resolveManualBundleDir(config, {
        askText: prompt,
        pickList: pickFromList,
        existsSync: fs.existsSync,
        readdirSync: fs.readdirSync
      });
    }
    // Non-rclone backends: configured, exit the selection loop
    break;
  }

  // 3. Machine ID
  console.log();
  const hostname = os.hostname();
  if (/^(MacBook|Mac|iMac|Macmini|MacPro|MacStudio)/.test(hostname) || hostname === 'localhost') {
    console.log(`Detected common hostname: "${hostname}" — recommend custom name to avoid conflicts.`);
    const customName = await prompt(`Machine ID [${hostname}]: `);
    if (customName.trim()) finalConfig.MACHINE_ID = customName.trim();
  }

  // 4. Detect CLAUDE.md location
  const homeClaudeMd = path.join(path.dirname(finalConfig.CLAUDE_DIR), 'CLAUDE.md');
  const claudeDirMd = path.join(finalConfig.CLAUDE_DIR, 'CLAUDE.md');
  console.log();
  if (fs.existsSync(homeClaudeMd)) console.log(`  Found: ~/CLAUDE.md`);
  if (fs.existsSync(claudeDirMd)) console.log(`  Found: ~/.claude/CLAUDE.md`);

  // 5. Save config — rebuilt from scratch for the chosen backend (see
  // buildInitConfig) so switching backends never leaves stale fields behind.
  const configPath = path.join((config.HOME || os.homedir()), '.claude-sync.json');
  const toSave = buildInitConfig(finalConfig);
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2));
  console.log();
  console.log(`✓ Configuration saved to ${configPath}`);
  console.log();
  console.log('Next steps:');
  console.log('  claude-sync push    (on source machine — memory globalization will be asked on first push)');
  console.log('  claude-sync pull    (on target machine after init)');
}

async function runPush(config, backend, flags) {
  // Ask folder path and secrets mode every push
  const configPath = path.join((config.HOME || os.homedir()), '.claude-sync.json');

  // Remote folder only matters for backends that write to a shared remote.
  // manual writes straight into BUNDLE_DIR, so skip this prompt for it.
  if (config.BACKEND !== 'manual') {
    const folder = await pickFromList(
      'Folder path on remote:',
      ['claude-sync/', 'Custom...'],
      config.REMOTE_FOLDER || 'claude-sync/'
    );
    config.REMOTE_FOLDER = (folder === 'Custom...')
      ? ((await prompt('Enter folder path: ')).trim() || 'claude-sync/')
      : folder;
  }

  config.SECRETS = await pickFromList(
    'Secrets mode:',
    ['keep', 'strip'],
    config.SECRETS || 'keep',
    [
      'How to handle API keys & tokens:',
      '  keep   — transmit as-is (safe for private cloud storage)',
      '  strip  — replace values with *** (untrusted storage)'
    ]
  );

  // Manual backend: confirm/override the bundle directory each push
  if (config.BACKEND === 'manual') {
    const { bundleDir } = await confirmManualBundleDir(config, { askText: prompt, verb: 'saved to' });
    config.BUNDLE_DIR = bundleDir;
  }

  // Persist choices (single read-modify-write)
  try {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    existing.SECRETS = config.SECRETS;
    if (config.BACKEND === 'manual') existing.BUNDLE_DIR = config.BUNDLE_DIR;
    else existing.REMOTE_FOLDER = config.REMOTE_FOLDER;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
  } catch { /* config file not found, skip save */ }

  console.log('Pushing configuration to remote...');
  const result = await pushWorkflow(config, backend, { force: flags.force });

  if (result.success) {
    console.log('✓ Push complete!');
    console.log(`  Machine: ${result.manifest.pushed_by}`);
    console.log(`  Time: ${result.manifest.pushed_at}`);
    if (result.manifest.memory) {
      console.log(`  Memory topics: ${result.manifest.memory.topic_count}`);
    }
  } else {
    console.log('✗ Push aborted:', result.reason);
  }
}

async function runPull(config, backend, flags) {
  let strategy = 'cover';
  if (flags.cover) strategy = 'cover';
  if (flags.keep) strategy = 'keep';
  if (flags.interactive) strategy = 'interactive';
  if (flags['dry-run']) strategy = 'dry-run';

  // Ask which folder to pull from (avoid pulling from wrong one when multiple exist)
  const configPath = path.join((config.HOME || os.homedir()), '.claude-sync.json');

  // Remote folder prompt only applies to backends that read from a shared remote.
  // manual reads straight from BUNDLE_DIR, so skip entirely for it.
  if (config.BACKEND !== 'manual') {
    let folderOptions = ['claude-sync/', 'Custom...'];
    let defaultFolder = config.REMOTE_FOLDER || 'claude-sync/';

    // Try to list folders from the remote
    if (config.BACKEND === 'rclone' && config.REMOTE) {
      try {
        const remoteName = config.REMOTE.replace(/:$/, '');
        const remoteFolders = await backend.listFolders(remoteName);
        if (remoteFolders.length > 0) {
          folderOptions = [...remoteFolders, 'Custom...'];
          if (remoteFolders.includes(defaultFolder)) {
            // Keep defaultFolder as-is (it exists on remote)
          } else if (remoteFolders.length > 0) {
            defaultFolder = remoteFolders[0];
          }
        }
      } catch { /* backend doesn't support listFolders, use defaults */ }
    }

    const folder = await pickFromList(
      'Pull from folder:',
      folderOptions,
      defaultFolder
    );
    config.REMOTE_FOLDER = (folder === 'Custom...')
      ? ((await prompt('Enter folder path: ')).trim() || 'claude-sync/')
      : folder;
  }

  // Manual backend: confirm where the bundle lives (you must have placed it there)
  if (config.BACKEND === 'manual') {
    const { bundleDir } = await confirmManualBundleDir(config, { askText: prompt, verb: 'pulled from' });
    config.BUNDLE_DIR = bundleDir;
  }

  // Persist choices (single read-modify-write)
  try {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.BACKEND === 'manual') existing.BUNDLE_DIR = config.BUNDLE_DIR;
    else existing.REMOTE_FOLDER = config.REMOTE_FOLDER;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
  } catch { /* skip */ }

  console.log('Pulling configuration from remote...');
  const result = await pullWorkflow(config, backend, { strategy });

  if (result.success) {
    console.log('✓ Pull complete!');
    console.log(`  Backup saved to: ${result.backup}`);
    console.log(`  Source machine: ${result.manifest.pushed_by}`);
    if (flags['dry-run']) {
      console.log('  (Dry run — no changes applied)');
    }
  }
}

async function runStatus(config, backend) {
  console.log('Status: comparing local config with remote...');
  console.log();

  try {
    if (config.BACKEND === 'manual') {
      console.log('Manual backend: cannot auto-fetch remote manifest.');
      console.log(`Place the remote manifest.json in ${config.BUNDLE_DIR} and run again.`);
      return;
    }

    const tmpManifest = path.join(config.BUNDLE_DIR, 'status-manifest.json');
    await backend.download(remotePath(config, 'manifest.json'), tmpManifest);
    const manifest = readManifest(tmpManifest);

    if (!manifest) {
      console.log('No remote data found. Push first from your source machine.');
      return;
    }

    console.log(`Remote pushed by: ${manifest.pushed_by}`);
    console.log(`Remote pushed at: ${manifest.pushed_at}`);
    console.log(`Source user: ${manifest.source_user}`);
    console.log();

    // === File comparison ===
    console.log('── Files ──');
    const allFileNames = new Set([
      ...Object.keys(manifest.hashes || {}),
      // Check local files that match manifest patterns
    ]);

    for (const [file, remoteHash] of Object.entries(manifest.hashes || {})) {
      // Map CLAUDE manifest names back to local paths
      let localPath;
      if (file === 'CLAUDE_home.md') {
        localPath = path.join((config.HOME || os.homedir()), 'CLAUDE.md');
      } else if (file === 'CLAUDE_claude.md') {
        localPath = path.join(config.CLAUDE_DIR, 'CLAUDE.md');
      } else {
        localPath = path.join(config.CLAUDE_DIR, file);
      }

      if (fs.existsSync(localPath)) {
        const localHash = hashFile(localPath);
        const status = localHash === remoteHash ? '  ' : '~ ';
        console.log(`${status}${file}`);
      } else {
        console.log(`+  ${file} (remote only)`);
      }
    }

    // Check for files present locally but not in manifest
    for (const localFile of ['settings.json', 'settings.local.json', 'keybindings.json']) {
      if (manifest.hashes && !manifest.hashes[localFile]) {
        const localPath = path.join(config.CLAUDE_DIR, localFile);
        if (fs.existsSync(localPath)) {
          console.log(`-  ${localFile} (local only)`);
        }
      }
    }

    if (Object.keys(manifest.hashes || {}).length === 0) {
      console.log('  (no files tracked)');
    }

    // === Plugin comparison ===
    console.log();
    console.log('── Plugins ──');
    const localPlugins = readPluginVersions(path.join(config.CLAUDE_DIR, 'plugins'));
    const allPluginNames = new Set([
      ...Object.keys(manifest.plugins || {}),
      ...Object.keys(localPlugins)
    ]);

    if (allPluginNames.size === 0) {
      console.log('  (no plugins)');
    } else {
      for (const name of [...allPluginNames].sort()) {
        const localVer = localPlugins[name];
        const remoteVer = manifest.plugins?.[name];
        if (!localVer) {
          console.log(`+  ${name}@${remoteVer} (remote only)`);
        } else if (!remoteVer) {
          console.log(`-  ${name}@${localVer} (local only)`);
        } else if (localVer === remoteVer) {
          console.log(`   ${name}@${localVer}`);
        } else {
          console.log(`~  ${name}: local=${localVer} remote=${remoteVer}`);
        }
      }
    }

    // === Skill comparison ===
    console.log();
    console.log('── Skills ──');
    const localSkills = detectSkills(path.join(config.CLAUDE_DIR, 'skills'), path.join(config.HOME || os.homedir(), '.agents'));
    const allSkillTypes = ['skills_sh', 'git', 'symlink', 'child_symlink', 'plain'];

    let skillCount = 0;
    for (const type of allSkillTypes) {
      for (const skill of (manifest.skills?.[type] || [])) {
        skillCount++;
        const localSkill = localSkills.find(s =>
          s.name === skill.name && typeOfSkill(s) === type
        );
        if (!localSkill) {
          console.log(`+  ${skill.name} (${type}, remote only)`);
        } else {
          // Check if content differs
          let changed = false;
          if (type === 'git' && localSkill.commit !== skill.commit) changed = true;
          if (type === 'skills_sh' && localSkill.folderHash !== skill.folderHash) changed = true;
          if (type === 'plain' && localSkill.hash !== skill.hash) changed = true;
          console.log(`${changed ? '~ ' : '  '}${skill.name} (${type})${changed ? ' — changed' : ''}`);
        }
      }
    }
    // Show locally-only skills
    for (const localSkill of localSkills) {
      const type = typeOfSkill(localSkill);
      const inManifest = (manifest.skills?.[type] || []).some(s => s.name === localSkill.name);
      if (!inManifest) {
        console.log(`-  ${localSkill.name} (${type}, local only)`);
        skillCount++;
      }
    }
    if (skillCount === 0) console.log('  (no skills)');

    // === mcpServers comparison ===
    console.log();
    console.log('── MCP Servers ──');
    const localMcp = extractMcpServers(config.HOME || os.homedir()).names;
    const remoteMcp = manifest.mcp_servers || [];
    const allMcp = new Set([...localMcp, ...remoteMcp]);

    if (allMcp.size === 0) {
      console.log('  (no mcpServers)');
    } else {
      for (const name of [...allMcp].sort()) {
        if (!localMcp.includes(name)) {
          console.log(`+  ${name} (remote only)`);
        } else if (!remoteMcp.includes(name)) {
          console.log(`-  ${name} (local only)`);
        } else {
          console.log(`   ${name}`);
        }
      }
    }

    // === Memory comparison ===
    console.log();
    console.log('── Memory ──');
    if (manifest.memory) {
      const settings = readSettings(config.CLAUDE_DIR);
      const localAutoMemDir = settings?.autoMemoryDirectory;
      const localTopics = localAutoMemDir
        ? countMemoryTopics(localAutoMemDir.replace(/^~/, (config.HOME || os.homedir())))
        : null;

      if (localTopics !== null) {
        const diff = manifest.memory.topic_count - localTopics;
        const status = diff === 0 ? '  ' : '~ ';
        console.log(`${status}auto memory: ${manifest.memory.auto_memory_directory}`);
        console.log(`   remote: ${manifest.memory.topic_count} topics, local: ${localTopics} topics`);
      } else {
        console.log(`+  auto memory: ${manifest.memory.auto_memory_directory} (remote only)`);
        console.log(`   ${manifest.memory.topic_count} topics (not enabled locally)`);
      }
    } else {
      const settings = readSettings(config.CLAUDE_DIR);
      const localAutoMemDir = settings?.autoMemoryDirectory;
      if (localAutoMemDir) {
        const localTopics = countMemoryTopics(localAutoMemDir.replace(/^~/, (config.HOME || os.homedir())));
        console.log(`-  auto memory: ${localAutoMemDir} (local only, ${localTopics} topics)`);
      } else {
        console.log('  (no memory configured)');
      }
    }

    // Clean up temp file
    try { fs.unlinkSync(tmpManifest); } catch {}

  } catch (e) {
    console.log('Cannot connect to remote:', e.message);
    console.log('Check your REMOTE setting and backend configuration.');
  }
}

function typeOfSkill(skill) {
  return skill.type || 'plain';
}

async function runDiff(config, backend) {
  console.log('Diff: detailed comparison with remote...');
  console.log();

  try {
    const bundleDir = config.BUNDLE_DIR;
    if (!fs.existsSync(bundleDir)) fs.mkdirSync(bundleDir, { recursive: true });

    let manifest;

    if (config.BACKEND === 'manual') {
      // Read manifest directly from BUNDLE_DIR (user places files there)
      const localManifest = path.join(bundleDir, 'manifest.json');
      if (!fs.existsSync(localManifest)) {
        console.log(`Manual backend: place manifest.json (and optionally bundle.tar.gz) in ${bundleDir}`);
        console.log('Then run diff again.');
        return;
      }
      manifest = readManifest(localManifest);
    } else {
      // Download manifest from remote
      const tmpManifest = path.join(bundleDir, 'diff-manifest.json');
      await backend.download(remotePath(config, 'manifest.json'), tmpManifest);
      manifest = readManifest(tmpManifest);
      try { fs.unlinkSync(tmpManifest); } catch {}
    }

    if (!manifest) {
      console.log('No remote data found. Push first from source machine.');
      return;
    }

    // Download the full bundle (needed for extracting individual files for diff)
    let bundleDownloaded = false;
    let tmpBundle, tmpExtract;
    const neededForDiff = Object.entries(manifest.hashes || {}).some(([file, remoteHash]) => {
      const localPath = mapManifestFileToLocal(file, config);
      return fs.existsSync(localPath);
    });

    if (neededForDiff) {
      tmpBundle = config.BACKEND === 'manual'
        ? path.join(bundleDir, 'bundle.tar.gz')
        : path.join(bundleDir, 'diff-bundle.tar.gz');
      tmpExtract = path.join(bundleDir, 'diff-extract');
      try {
        if (config.BACKEND !== 'manual') {
          await backend.download(remotePath(config, 'bundle.tar.gz'), tmpBundle);
        }
        const { extractBundle } = await import('./lib/sync.js');
        if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });
        fs.mkdirSync(tmpExtract, { recursive: true });
        await extractBundle(tmpBundle, tmpExtract);
        bundleDownloaded = true;
      } catch {
        console.log('(Could not download bundle for line-by-line diff; showing hash comparisons only)');
        console.log();
      }
    }

    // Compare each file hash
    for (const [file, remoteHash] of Object.entries(manifest.hashes || {})) {
      const localPath = mapManifestFileToLocal(file, config);
      const exists = fs.existsSync(localPath);

      if (!exists) {
        console.log(`--- ${file} (only on remote) ---`);
        continue;
      }

      const localHash = hashFile(localPath);
      if (localHash !== remoteHash) {
        console.log(`--- ${displayNameForManifestFile(file)} (diff) ---`);

        // For JSON files, show field-level diff
        if (file.endsWith('.json')) {
          try {
            const localData = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
            if (bundleDownloaded) {
              const remotePath = path.join(tmpExtract, file);
              if (fs.existsSync(remotePath)) {
                const remoteData = JSON.parse(fs.readFileSync(remotePath, 'utf-8'));
                diffJson(localData, remoteData, '', config.SECRETS);
              } else {
                console.log(`  <remote file not in bundle>`);
              }
            } else {
              console.log(`  JSON differs: local=${localHash.substring(0, 8)} remote=${remoteHash.substring(0, 8)}`);
            }
          } catch {
            console.log(`  <unparseable — hash differs: local=${localHash.substring(0,8)} remote=${remoteHash.substring(0,8)}>`);
          }
        } else if (file.endsWith('.md')) {
          // For markdown/text files, show line-by-line diff
          try {
            const localLines = fs.readFileSync(localPath, 'utf-8').split('\n');
            let remoteLines = [];
            if (bundleDownloaded) {
              const remotePath = path.join(tmpExtract, file);
              if (fs.existsSync(remotePath)) {
                remoteLines = fs.readFileSync(remotePath, 'utf-8').split('\n');
              }
            }
            if (remoteLines.length > 0) {
              diffLines(localLines, remoteLines);
            } else {
              console.log(`  Content differs: local=${localHash.substring(0, 8)} remote=${remoteHash.substring(0, 8)}`);
            }
          } catch {
            console.log(`  <unreadable — hash differs: local=${localHash.substring(0,8)} remote=${remoteHash.substring(0,8)}>`);
          }
        } else {
          console.log(`  Content differs: local=${localHash.substring(0,8)} remote=${remoteHash.substring(0,8)}`);
        }
      }
    }

    // Show skill differences
    if (manifest.skills) {
      console.log();
      console.log('--- Skills ---');
      const localSkills = detectSkills(path.join(config.CLAUDE_DIR, 'skills'), path.join(config.HOME || os.homedir(), '.agents'));
      const allTypes = ['skills_sh', 'git', 'symlink', 'child_symlink', 'plain'];
      for (const type of allTypes) {
        for (const skill of (manifest.skills[type] || [])) {
          const local = localSkills.find(s => s.name === skill.name && typeOfSkill(s) === type);
          if (!local) {
            console.log(`  + ${type}: ${skill.name} (remote only)`);
          } else {
            let changed = false;
            if (type === 'git' && local.commit !== skill.commit) changed = true;
            if (type === 'skills_sh' && local.folderHash !== skill.folderHash) changed = true;
            console.log(`  ${changed ? '~' : ' '} ${type}: ${skill.name}${changed ? ' (changed)' : ''}`);
          }
        }
      }
      for (const localSkill of localSkills) {
        const type = typeOfSkill(localSkill);
        const inManifest = (manifest.skills?.[type] || []).some(s => s.name === localSkill.name);
        if (!inManifest) {
          console.log(`  - ${type}: ${localSkill.name} (local only)`);
        }
      }
    }

    // Plugin differences
    if (manifest.plugins && Object.keys(manifest.plugins).length > 0) {
      console.log();
      console.log('--- Plugins ---');
      const localPlugins = readPluginVersions(path.join(config.CLAUDE_DIR, 'plugins'));
      for (const [name, ver] of Object.entries(manifest.plugins)) {
        const localVer = localPlugins[name];
        if (!localVer) {
          console.log(`  + ${name}@${ver} (remote only)`);
        } else if (localVer !== ver) {
          console.log(`  ~ ${name}: local=${localVer} remote=${ver}`);
        } else {
          console.log(`    ${name}@${ver}`);
        }
      }
      for (const [name, ver] of Object.entries(localPlugins)) {
        if (!manifest.plugins[name]) {
          console.log(`  - ${name}@${ver} (local only)`);
        }
      }
    }

    // Clean up temp files (don't delete user-placed files in manual mode)
    if (bundleDownloaded) {
      try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch {}
      if (config.BACKEND !== 'manual') {
        try { fs.unlinkSync(tmpBundle); } catch {}
      }
    }

  } catch (e) {
    console.log('Cannot connect to remote:', e.message);
  }
}

function mapManifestFileToLocal(file, config) {
  if (file === 'CLAUDE_home.md') {
    return path.join((config.HOME || os.homedir()), 'CLAUDE.md');
  }
  if (file === 'CLAUDE_claude.md') {
    return path.join(config.CLAUDE_DIR, 'CLAUDE.md');
  }
  return path.join(config.CLAUDE_DIR, file);
}

function displayNameForManifestFile(file) {
  if (file === 'CLAUDE_home.md') return '~/CLAUDE.md';
  if (file === 'CLAUDE_claude.md') return '~/.claude/CLAUDE.md';
  return file;
}

function diffLines(localLines, remoteLines) {
  const maxLen = Math.max(localLines.length, remoteLines.length);
  // Simple unified-diff-style output
  let contextLines = 0;
  let inDiff = false;

  for (let i = 0; i < maxLen; i++) {
    const l = i < localLines.length ? localLines[i] : undefined;
    const r = i < remoteLines.length ? remoteLines[i] : undefined;

    if (l === r) {
      contextLines++;
      if (inDiff && contextLines <= 2) {
        console.log(`    ${l || ''}`);
      } else if (contextLines > 2) {
        inDiff = false;
      }
    } else {
      if (!inDiff) {
        if (contextLines > 0) console.log('    ...');
        contextLines = 0;
        inDiff = true;
      }
      if (l !== undefined && r !== undefined) {
        console.log(`  - ${l}`);
        console.log(`  + ${r}`);
      } else if (r !== undefined) {
        console.log(`  + ${r}`);
      } else if (l !== undefined) {
        console.log(`  - ${l}`);
      }
    }
  }
}

function diffJson(local, remote, prefix, secretsMode = 'keep') {
  const allKeys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const key of allKeys) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const lv = local?.[key];
    const rv = remote?.[key];

    if (lv === undefined) {
      console.log(`  + ${keyPath}: ${JSON.stringify(rv)}`);
    } else if (rv === undefined) {
      console.log(`  - ${keyPath}: ${JSON.stringify(lv)}`);
    } else if (typeof lv === 'object' && typeof rv === 'object' && lv !== null && rv !== null) {
      diffJson(lv, rv, keyPath, secretsMode);
    } else if (JSON.stringify(lv) !== JSON.stringify(rv)) {
      const shouldMask = secretsMode === 'strip';
      const lvDisplay = shouldMask && typeof lv === 'string' && (lv.length > 40 || lv.includes('sk-')) ? '***' : JSON.stringify(lv);
      const rvDisplay = shouldMask && typeof rv === 'string' && (rv.length > 40 || rv.includes('sk-')) ? '***' : JSON.stringify(rv);
      console.log(`  ~ ${keyPath}: local=${lvDisplay} remote=${rvDisplay}`);
    }
  }
}

async function runRestore(flags, config) {
  const home = (config.HOME || os.homedir());

  // Helper: list backup timestamps (sorted newest first)
  const listBackups = () => {
    try {
      return fs.readdirSync(home)
        .filter(f => f.startsWith('.claude.backup.'))
        .map(f => f.replace('.claude.backup.', ''))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };

  if (flags.list) {
    const backups = listBackups();
    console.log('Available backups:');
    if (backups.length === 0) {
      console.log('  (none)');
    } else {
      backups.forEach(b => console.log(`  ${b}`));
    }
    return;
  }

  if (flags['cleanup-all']) {
    console.log('Removing all backups...');
    try {
      const entries = fs.readdirSync(home).filter(f => f.startsWith('.claude.backup.'));
      entries.forEach(e => {
        fs.rmSync(path.join(home, e), { recursive: true, force: true });
        console.log(`  Removed: ${e}`);
      });
      console.log(`  ${entries.length} backup(s) removed.`);
    } catch (e) {
      console.log('  Error:', e.message);
    }
    return;
  }

  if (flags.cleanup) {
    const backups = listBackups();
    if (backups.length === 0) {
      console.log('No backups to clean up.');
      return;
    }
    const target = await pickFromList('Pick a backup to remove:', backups, backups[0]);
    const backupPath = path.join(home, `.claude.backup.${target}`);
    if (fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { recursive: true, force: true });
      console.log(`Removed backup: .claude.backup.${target}`);
    }
    return;
  }

  // Resolve backup timestamp: from flag, or interactive pick
  let timestamp = flags.backup;

  if (!timestamp) {
    const backups = listBackups();
    if (backups.length === 0) {
      console.log('No backups found.');
      return;
    }
    // Interactive: pick a backup to restore
    timestamp = await pickFromList(
      `Found ${backups.length} backup(s). Pick one to restore:`,
      backups,
      backups[0]
    );
  }

  // Perform restore
  const backupPath = path.join(home, `.claude.backup.${timestamp}`);
  if (!fs.existsSync(backupPath)) {
    console.log(`Backup not found: .claude.backup.${timestamp}`);
    return;
  }

  const claudeDir = path.join(home, '.claude');
  console.log(`Restoring from backup: .claude.backup.${timestamp}`);

  if (fs.existsSync(claudeDir)) {
    const safetyBackup = path.join(home, `.claude.before-restore.${Date.now()}`);
    fs.cpSync(claudeDir, safetyBackup, { recursive: true });
    console.log(`  Safety backup saved to: ${path.basename(safetyBackup)}`);

    // Delete current .claude — use atomic rename trick to avoid ENOTEMPTY issues
    // that can happen with deeply nested dirs (e.g. git repos with many objects).
    const oldDir = path.join(home, `.claude.old.${Date.now()}`);
    try {
      fs.renameSync(claudeDir, oldDir);
    } catch {
      // rename failed, try direct removal
      try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch {
        // last resort: shell fallback for stubborn files
        spawnSync('rm', ['-rf', claudeDir]);
      }
    }
    // Clean up the renamed old dir in background
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* ok, will be cleaned up later */ }
  }

  fs.cpSync(backupPath, claudeDir, { recursive: true });
  console.log('✓ Restore complete!');
}

/**
 * Main entry point.
 */
export async function main(argv) {
  const { command, flags } = parseArgs(argv);

  if (flags.version) {
    console.log(getVersion());
    return;
  }

  if (command === 'help' || flags.help || !KNOWN_COMMANDS.includes(command)) {
    printHelp();
    return;
  }

  const userConfig = loadUserConfig();
  const config = readConfig(userConfig);

  // Apply --verbose globally
  if (flags.verbose) {
    const { setLogLevel } = await import('./lib/retry.js');
    setLogLevel('verbose');
  }

  const backend = createBackend(config);

  switch (command) {
    case 'init':
      await runInit(config);
      break;
    case 'push':
      await runPush(config, backend, flags);
      break;
    case 'pull':
      await runPull(config, backend, flags);
      break;
    case 'status':
      await runStatus(config, backend);
      break;
    case 'diff':
      await runDiff(config, backend);
      break;
    case 'restore':
      await runRestore(flags, config);
      break;
  }
}

/**
 * Check whether this module is being run as the main entry point.
 * Handles both direct execution and global npm installs (symlinks).
 */
export function isMainCheck(argv1, metaUrl) {
  if (!argv1) return false;
  // Global npm install creates a symlink: process.argv[1] ends with 'claude-sync'
  if (path.basename(argv1) === 'claude-sync') return true;
  try {
    // Resolve both paths to their real locations for symlink-aware comparison
    const realArgv = fs.realpathSync(argv1);
    const realSelf = fs.realpathSync(fileURLToPath(metaUrl));
    return realArgv === realSelf;
  } catch {
    // Fallback: compare basenames
    return path.basename(argv1) === path.basename(fileURLToPath(metaUrl));
  }
}

// Run if called directly (also works when installed globally via npm)
if (isMainCheck(process.argv[1], import.meta.url)) {
  main(process.argv).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
