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
import * as readline from 'node:readline';
import { readConfig } from './lib/config.js';
import { pushWorkflow, pullWorkflow } from './lib/workflow.js';
import { createRcloneBackend } from './backends/rclone.js';
import { createManualBackend } from './backends/manual.js';
import { createBaidupcsBackend } from './backends/baidupcs.js';
import { createCustomBackend } from './backends/custom.js';
import { readManifest, hashFile } from './lib/sync.js';

const KNOWN_COMMANDS = ['push', 'pull', 'init', 'status', 'diff', 'restore', 'help'];

/**
 * Parse command-line arguments into a command and flags.
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const flags = {};

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

Backends: rclone (default), baidupcs, manual, custom
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
    case 'baidupcs':
      return createBaidupcsBackend();
    case 'manual':
      return createManualBackend({ bundleDir: config.BUNDLE_DIR });
    case 'custom':
      return createCustomBackend(config);
    default:
      return createRcloneBackend();
  }
}

function rlPrompt(rl, question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise(resolve => rl.question(question, resolve));
}

async function runInit(config) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('╔══════════════════════════════════╗');
  console.log('║   claude-sync — interactive init ║');
  console.log('╚══════════════════════════════════╝');
  console.log();

  // 1. Choose backend
  console.log('Available backends:');
  console.log('  1. rclone    — 40+ cloud drives (Dropbox/GDrive/OneDrive/S3/WebDAV...)');
  console.log('  2. baidupcs  — Baidu Netdisk (China users)');
  console.log('  3. manual    — No CLI needed, handle files yourself (iCloud)');
  console.log('  4. custom    — Your own upload/download commands');
  const backendChoice = await rlPrompt(rl, `Backend [${config.BACKEND}]: `);
  const backend = backendChoice.trim() || config.BACKEND;
  const finalConfig = { ...config, BACKEND: backend };

  // 2. Configure REMOTE per backend
  if (backend === 'rclone') {
    console.log();
    console.log('Checking rclone remotes...');
    try {
      const rcloneBackend = createRcloneBackend();
      const remotes = await rcloneBackend.listRemotes();
      if (remotes.length > 0) {
        console.log(`  Found: ${remotes.join(', ')}`);
        const chosen = await rlPrompt(rl, `Remote name [${remotes[0]}]: `);
        const remoteName = chosen.trim() || remotes[0];
        const folder = await rlPrompt(rl, 'Folder path on remote [claude-sync/]: ');
        finalConfig.REMOTE = `${remoteName}:${folder.trim() || 'claude-sync/'}`;
      } else {
        console.log('  No remotes configured. Run: rclone config');
        const manualRemote = await rlPrompt(rl, 'Or enter REMOTE manually (e.g. gdrive:claude-sync/): ');
        if (manualRemote.trim()) finalConfig.REMOTE = manualRemote.trim();
      }
    } catch {
      console.log('  rclone not found. Install: https://rclone.org/install/');
      const manualRemote = await rlPrompt(rl, 'Enter REMOTE manually: ');
      if (manualRemote.trim()) finalConfig.REMOTE = manualRemote.trim();
    }
  } else if (backend === 'baidupcs') {
    console.log();
    console.log('Checking BaiduPCS-Go...');
    try {
      const bpBackend = createBaidupcsBackend();
      const loggedIn = await bpBackend.checkLogin();
      console.log(`  ${loggedIn ? '✓ Logged in' : '✗ Not logged in — run: BaiduPCS-Go login'}`);
    } catch {
      console.log('  BaiduPCS-Go not found. Install: https://github.com/qjfoidnh/BaiduPCS-Go');
    }
    const path = await rlPrompt(rl, 'Remote folder path [/claude-sync]: ');
    finalConfig.REMOTE = path.trim() || '/claude-sync';
  } else if (backend === 'custom') {
    const upCmd = await rlPrompt(rl, 'Upload command ({file}=local, {remote}=dest): ');
    if (upCmd.trim()) finalConfig.UPLOAD_CMD = upCmd.trim();
    const downCmd = await rlPrompt(rl, 'Download command ({remote}=source, {file}=local): ');
    if (downCmd.trim()) finalConfig.DOWNLOAD_CMD = downCmd.trim();
  }

  // 3. Machine ID
  console.log();
  const hostname = os.hostname();
  if (/^(MacBook|Mac|iMac|Macmini|MacPro|MacStudio)/.test(hostname) || hostname === 'localhost') {
    console.log(`Detected common hostname: "${hostname}" — recommend custom name to avoid conflicts.`);
    const customName = await rlPrompt(rl, `Machine ID [${hostname}]: `);
    if (customName.trim()) finalConfig.MACHINE_ID = customName.trim();
  }

  // 4. Secrets mode
  const secChoice = await rlPrompt(rl, `Secrets mode: keep (transmit as-is) or strip (replace with ***)? [${config.SECRETS}]: `);
  if (secChoice.trim() === 'strip' || secChoice.trim() === 'keep') {
    finalConfig.SECRETS = secChoice.trim();
  }

  rl.close();

  // 5. Detect CLAUDE.md location
  const homeClaudeMd = path.join(path.dirname(finalConfig.CLAUDE_DIR), 'CLAUDE.md');
  const claudeDirMd = path.join(finalConfig.CLAUDE_DIR, 'CLAUDE.md');
  console.log();
  if (fs.existsSync(homeClaudeMd)) console.log(`  Found: ~/CLAUDE.md`);
  if (fs.existsSync(claudeDirMd)) console.log(`  Found: ~/.claude/CLAUDE.md`);

  // 6. Save config
  const configPath = path.join(os.homedir(), '.claude-sync.json');
  const toSave = { REMOTE: finalConfig.REMOTE, BACKEND: finalConfig.BACKEND, SECRETS: finalConfig.SECRETS, MACHINE_ID: finalConfig.MACHINE_ID };
  if (finalConfig.UPLOAD_CMD) toSave.UPLOAD_CMD = finalConfig.UPLOAD_CMD;
  if (finalConfig.DOWNLOAD_CMD) toSave.DOWNLOAD_CMD = finalConfig.DOWNLOAD_CMD;
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2));
  console.log();
  console.log(`✓ Configuration saved to ${configPath}`);
  console.log();
  console.log('Next steps:');
  console.log('  claude-sync push    (on source machine — memory globalization will be asked on first push)');
  console.log('  claude-sync pull    (on target machine after init)');
}

async function runPush(config, backend, flags) {
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
    await backend.download(`${config.REMOTE}/manifest.json`, tmpManifest);
    const manifest = readManifest(tmpManifest);

    if (!manifest) {
      console.log('No remote data found. Push first from your source machine.');
      return;
    }

    console.log(`Remote pushed by: ${manifest.pushed_by}`);
    console.log(`Remote pushed at: ${manifest.pushed_at}`);
    console.log(`Source user: ${manifest.source_user}`);
    console.log();

    // Compare files
    console.log('Files in remote:');
    for (const [file, hash] of Object.entries(manifest.hashes || {})) {
      const localPath = path.join(config.CLAUDE_DIR, file);
      const exists = fs.existsSync(localPath) ? '✓' : '✗';
      console.log(`  ${exists} ${file}`);
    }

    // Compare plugins
    if (manifest.plugins && Object.keys(manifest.plugins).length > 0) {
      console.log();
      console.log('Plugins in remote:');
      for (const [name, version] of Object.entries(manifest.plugins)) {
        console.log(`  - ${name}@${version}`);
      }
    }

    // Compare skills
    const allSkills = [
      ...(manifest.skills?.skills_sh || []).map(s => ({ ...s, kind: 'skills.sh' })),
      ...(manifest.skills?.git || []).map(s => ({ ...s, kind: 'git' })),
      ...(manifest.skills?.symlink || []).map(s => ({ ...s, kind: 'symlink' })),
      ...(manifest.skills?.child_symlink || []).map(s => ({ ...s, kind: 'child symlink' })),
      ...(manifest.skills?.plain || []).map(s => ({ ...s, kind: 'plain' }))
    ];

    if (allSkills.length > 0) {
      console.log();
      console.log('Skills in remote:');
      for (const skill of allSkills) {
        console.log(`  - ${skill.name} (${skill.kind})`);
      }
    }

    if (manifest.memory) {
      console.log();
      console.log(`Memory: ${manifest.memory.topic_count} topics at ${manifest.memory.auto_memory_directory}`);
    }

    // Clean up temp file
    try { fs.unlinkSync(tmpManifest); } catch {}

  } catch (e) {
    console.log('Cannot connect to remote:', e.message);
    console.log('Check your REMOTE setting and backend configuration.');
  }
}

async function runDiff(config, backend) {
  console.log('Diff: detailed comparison with remote...');
  console.log();

  try {
    if (config.BACKEND === 'manual') {
      console.log('Manual backend: place manifest.json and bundle.tar.gz in', config.BUNDLE_DIR);
      return;
    }

    const bundleDir = config.BUNDLE_DIR;
    if (!fs.existsSync(bundleDir)) fs.mkdirSync(bundleDir, { recursive: true });

    // Download manifest
    const tmpManifest = path.join(bundleDir, 'diff-manifest.json');
    await backend.download(`${config.REMOTE}/manifest.json`, tmpManifest);
    const manifest = readManifest(tmpManifest);

    if (!manifest) {
      console.log('No remote data found. Push first from source machine.');
      return;
    }

    // Compare each file hash
    for (const [file, remoteHash] of Object.entries(manifest.hashes || {})) {
      const localPath = path.join(config.CLAUDE_DIR, file);
      const exists = fs.existsSync(localPath);

      if (!exists) {
        console.log(`--- ${file} (only on remote) ---`);
        continue;
      }

      const localHash = hashFile(localPath);
      if (localHash !== remoteHash) {
        console.log(`--- ${file} (diff) ---`);

        // For JSON files, show field-level diff
        if (file.endsWith('.json')) {
          try {
            const localData = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
            // Download and extract just this file from bundle for comparison
            const tmpBundle = path.join(bundleDir, 'diff-bundle.tar.gz');
            await backend.download(`${config.REMOTE}/bundle.tar.gz`, tmpBundle);

            const { extractBundle } = await import('./lib/sync.js');
            const tmpExtract = path.join(bundleDir, 'diff-extract');
            if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });
            fs.mkdirSync(tmpExtract, { recursive: true });
            await extractBundle(tmpBundle, tmpExtract);

            const remotePath = path.join(tmpExtract, file);
            if (fs.existsSync(remotePath)) {
              const remoteData = JSON.parse(fs.readFileSync(remotePath, 'utf-8'));
              diffJson(localData, remoteData, '');
            }

            try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch {}
            try { fs.unlinkSync(tmpBundle); } catch {}
          } catch {
            console.log(`  <binary or unreadable — hash differs: local=${localHash.substring(0,8)} remote=${remoteHash.substring(0,8)}>`);
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
      const allTypes = ['skills_sh', 'git', 'symlink', 'child_symlink', 'plain'];
      for (const type of allTypes) {
        for (const skill of (manifest.skills[type] || [])) {
          console.log(`  ${type}: ${skill.name} (remote)`);
        }
      }
    }

    // Plugin differences
    if (manifest.plugins && Object.keys(manifest.plugins).length > 0) {
      console.log();
      console.log('--- Plugins (remote) ---');
      for (const [name, ver] of Object.entries(manifest.plugins)) {
        const localPluginsPath = path.join(config.CLAUDE_DIR, 'plugins', 'installed_plugins.json');
        let localVer = '(not installed)';
        if (fs.existsSync(localPluginsPath)) {
          try {
            const local = JSON.parse(fs.readFileSync(localPluginsPath, 'utf-8'));
            localVer = local[name] || '(not installed)';
          } catch {}
        }
        const status = localVer === ver ? '=' : (localVer === '(not installed)' ? '+' : '~');
        console.log(`  ${status} ${name}: local=${localVer} remote=${ver}`);
      }
    }

    try { fs.unlinkSync(tmpManifest); } catch {}

  } catch (e) {
    console.log('Cannot connect to remote:', e.message);
  }
}

function diffJson(local, remote, prefix) {
  const allKeys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const lv = local?.[key];
    const rv = remote?.[key];

    if (lv === undefined) {
      console.log(`  + ${path}: ${JSON.stringify(rv)}`);
    } else if (rv === undefined) {
      console.log(`  - ${path}: ${JSON.stringify(lv)}`);
    } else if (typeof lv === 'object' && typeof rv === 'object' && lv !== null && rv !== null) {
      diffJson(lv, rv, path);
    } else if (JSON.stringify(lv) !== JSON.stringify(rv)) {
      const lvDisplay = typeof lv === 'string' && (lv.length > 40 || lv.includes('sk-')) ? '***' : JSON.stringify(lv);
      const rvDisplay = typeof rv === 'string' && (rv.length > 40 || rv.includes('sk-')) ? '***' : JSON.stringify(rv);
      console.log(`  ~ ${path}: local=${lvDisplay} remote=${rvDisplay}`);
    }
  }
}

function runRestore(flags, config) {
  // Use home derived from CLAUDE_DIR (consistent with pull backup location)
  const home = path.dirname(config?.CLAUDE_DIR || path.join(os.homedir(), '.claude'));

  if (flags.list) {
    console.log('Available backups:');
    try {
      const entries = fs.readdirSync(home).filter(f => f.startsWith('.claude.backup.'));
      if (entries.length === 0) {
        console.log('  (none)');
      } else {
        entries.forEach(e => console.log(`  ${e}`));
      }
    } catch (e) {
      console.log('  Error reading backups:', e.message);
    }
    return;
  }

  if (flags['cleanup-all']) {
    console.log('Removing all backups...');
    try {
      const entries = fs.readdirSync(home).filter(f => f.startsWith('.claude.backup.'));
      entries.forEach(e => {
        const fullPath = path.join(home, e);
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`  Removed: ${e}`);
      });
      console.log(`  ${entries.length} backup(s) removed.`);
    } catch (e) {
      console.log('  Error:', e.message);
    }
    return;
  }

  if (flags.cleanup) {
    const backupPath = path.join(home, `.claude.backup.${flags.cleanup}`);
    if (fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { recursive: true, force: true });
      console.log(`Removed backup: .claude.backup.${flags.cleanup}`);
    } else {
      console.log(`Backup not found: .claude.backup.${flags.cleanup}`);
    }
    return;
  }

  if (flags.backup) {
    const backupPath = path.join(home, `.claude.backup.${flags.backup}`);
    if (!fs.existsSync(backupPath)) {
      console.log(`Backup not found: .claude.backup.${flags.backup}`);
      return;
    }

    const claudeDir = path.join(home, '.claude');
    console.log(`Restoring from backup: .claude.backup.${flags.backup}`);

    // Copy backup back to .claude
    if (fs.existsSync(claudeDir)) {
      const safetyBackup = path.join(home, `.claude.before-restore.${Date.now()}`);
      fs.cpSync(claudeDir, safetyBackup, { recursive: true });
      console.log(`  Safety backup saved to: ${path.basename(safetyBackup)}`);
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }

    fs.cpSync(backupPath, claudeDir, { recursive: true });
    console.log('✓ Restore complete!');
    return;
  }

  console.log('Usage:');
  console.log('  claude-sync restore --list                  List all backups');
  console.log('  claude-sync restore --backup <timestamp>    Restore a backup');
  console.log('  claude-sync restore --cleanup <timestamp>   Remove a backup');
  console.log('  claude-sync restore --cleanup-all           Remove all backups');
}

/**
 * Main entry point.
 */
export async function main(argv) {
  const { command, flags } = parseArgs(argv);

  if (command === 'help' || !KNOWN_COMMANDS.includes(command)) {
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

// Run if called directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  main(process.argv).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
