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
import { readConfig } from './lib/config.js';
import { prompt, promptYesNo, pickFromList } from './lib/prompt.js';
import { pushWorkflow, pullWorkflow, readSettings, extractMcpServers, countMemoryTopics } from './lib/workflow.js';
import { createRcloneBackend } from './backends/rclone.js';
import { createManualBackend } from './backends/manual.js';
import { createBaidupcsBackend } from './backends/baidupcs.js';
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

async function runInit(config) {
  console.log('╔══════════════════════════════════╗');
  console.log('║   claude-sync — interactive init ║');
  console.log('╚══════════════════════════════════╝');
  console.log();

  // 1. Choose backend (with descriptions in prompt, names only in list for clean picking)
  const BACKEND_OPTIONS = ['rclone', 'baidupcs', 'manual', 'custom'];
  console.log('Available backends:');
  console.log('  rclone    — 40+ cloud drives (Dropbox/GDrive/OneDrive/S3/WebDAV...)');
  console.log('  baidupcs  — Baidu Netdisk (China users)');
  console.log('  manual    — No CLI needed, handle files yourself (iCloud)');
  console.log('  custom    — Your own upload/download commands');
  console.log();
  const backend = await pickFromList('Pick a backend (number or name):', BACKEND_OPTIONS, config.BACKEND || 'rclone');
  const finalConfig = { ...config, BACKEND: backend };

  // 2. Configure REMOTE per backend
  if (backend === 'rclone') {
    console.log();
    console.log('Checking rclone remotes...');
    try {
      const rcloneBackend = createRcloneBackend();
      const remotes = await rcloneBackend.listRemotes();
      if (remotes.length > 0) {
        const remoteName = await pickFromList(
          `Found ${remotes.length} remote(s):`,
          remotes,
          remotes[0]
        );
        const folder = await prompt('Folder path on remote [claude-sync/]: ');
        finalConfig.REMOTE = `${remoteName}:${folder.trim() || 'claude-sync/'}`;
      } else {
        console.log('  No remotes configured. Run: rclone config');
        const manualRemote = await prompt('Or enter REMOTE manually (e.g. gdrive:claude-sync/): ');
        if (manualRemote.trim()) finalConfig.REMOTE = manualRemote.trim();
      }
    } catch {
      console.log('  rclone not found. Install: https://rclone.org/install/');
      const manualRemote = await prompt('Enter REMOTE manually: ');
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
    const path = await prompt('Remote folder path [/claude-sync]: ');
    finalConfig.REMOTE = path.trim() || '/claude-sync';
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
  }

  // 3. Machine ID
  console.log();
  const hostname = os.hostname();
  if (/^(MacBook|Mac|iMac|Macmini|MacPro|MacStudio)/.test(hostname) || hostname === 'localhost') {
    console.log(`Detected common hostname: "${hostname}" — recommend custom name to avoid conflicts.`);
    const customName = await prompt(`Machine ID [${hostname}]: `);
    if (customName.trim()) finalConfig.MACHINE_ID = customName.trim();
  }

  // 4. Secrets mode
  console.log();
  console.log('Secrets mode — how to handle API keys & tokens:');
  console.log('  keep   — transmit as-is (safe for private cloud storage)');
  console.log('  strip  — replace values with *** (paranoid / untrusted storage)');
  console.log();
  finalConfig.SECRETS = await pickFromList('Choose:', ['keep', 'strip'], config.SECRETS || 'keep');

  // 5. Detect CLAUDE.md location
  const homeClaudeMd = path.join(path.dirname(finalConfig.CLAUDE_DIR), 'CLAUDE.md');
  const claudeDirMd = path.join(finalConfig.CLAUDE_DIR, 'CLAUDE.md');
  console.log();
  if (fs.existsSync(homeClaudeMd)) console.log(`  Found: ~/CLAUDE.md`);
  if (fs.existsSync(claudeDirMd)) console.log(`  Found: ~/.claude/CLAUDE.md`);

  // 6. Save config
  const configPath = path.join((config.HOME || os.homedir()), '.claude-sync.json');
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
      await backend.download(`${config.REMOTE}/manifest.json`, tmpManifest);
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
          await backend.download(`${config.REMOTE}/bundle.tar.gz`, tmpBundle);
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

function runRestore(flags, config) {
  // Use home derived from CLAUDE_DIR (consistent with pull backup location)
  const home = (config.HOME || os.homedir());

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
      runRestore(flags, config);
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
