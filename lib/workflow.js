/**
 * Push/pull workflow orchestrator for claude-sync.
 * Wires together all lib modules for the full sync flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { readConfig, remotePath } from './config.js';
import { prompt, promptYesNo, pickFromList } from './prompt.js';
import { createManifest, buildBundle, extractBundle, readManifest, writeManifest, hashFile, readPluginVersions } from './sync.js';
import { stripSecrets, findSecretFields, isStripped } from './secrets.js';
import { replaceUserPath } from './paths.js';
import { detectSkills } from './detect.js';
import { log, initLogging } from './retry.js';

// Tracked config files — single source of truth shared by push and status/diff
export const TRACKED_CONFIG_FILES = ['settings.json', 'settings.local.json', 'keybindings.json'];
export const TRACKED_CLAUDE_FILES = ['CLAUDE_home.md', 'CLAUDE_claude.md'];

function getStateFile(bundleDir) {
  return path.join(bundleDir || path.join(os.homedir(), '.claude-sync-bundle'), 'state.json');
}
const SUPPORTED_MANIFEST_VERSION = 1;

/**
 * Get the installed Claude Code version, or null if not installed.
 */
export function getClaudeVersion() {
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : out;
  } catch {
    return null;
  }
}

/** Compare two semver strings. Returns -1/0/1 like strcmp. */
function cmpSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * Check that the local Claude Code version is compatible with the source.
 * Prompts the user to install/upgrade/downgrade if needed.
 * Returns { action: 'continue' | 'cancel' }.
 */
async function ensureClaudeVersion(sourceVersion) {
  if (!sourceVersion) {
    log('verbose', 'No Claude version in manifest — skipping version check');
    return { action: 'continue' };
  }

  const localVersion = getClaudeVersion();

  // ── Not installed ──
  if (!localVersion) {
    console.log();
    console.log('⚠  Claude Code is not installed on this machine.');
    console.log(`   Source machine uses v${sourceVersion}.`);
    console.log();

    const choice = await pickFromList(
      'What would you like to do?',
      [`Install Claude v${sourceVersion}`, 'Continue without Claude', 'Cancel pull'],
      `Install Claude v${sourceVersion}`
    );

    if (choice.startsWith('Install')) {
      await installClaude(sourceVersion);
      return { action: 'continue' };
    }
    if (choice === 'Cancel pull') return { action: 'cancel' };
    return { action: 'continue' };
  }

  // ── Versions match ──
  if (localVersion === sourceVersion) {
    log('info', `Claude versions match (v${localVersion})`);
    return { action: 'continue' };
  }

  // ── Version mismatch ──
  const cmp = cmpSemver(sourceVersion, localVersion);
  const direction = cmp > 0 ? 'newer' : 'older';
  const verb = cmp > 0 ? 'Upgrade' : 'Downgrade';

  console.log();
  console.log('⚠  Claude version mismatch!');
  console.log(`   Source (remote):  v${sourceVersion}  ← ${direction}`);
  console.log(`   This machine:     v${localVersion}`);
  console.log();

  if (cmp < 0) {
    console.log('   Source has an older version. Downgrading is possible —');
    console.log('   your ~/.claude stays intact, but newer config fields may be lost.');
  } else {
    console.log('   Different versions may store config in incompatible formats.');
    console.log('   Syncing across versions could corrupt settings or plugins.');
  }
  console.log();

  const choice = await pickFromList(
    'What would you like to do?',
    [
      `${verb} to v${sourceVersion} (npm install -g @anthropic-ai/claude-code@${sourceVersion})`,
      'Continue anyway  (I accept the risk)',
      'Cancel pull'
    ],
    `Continue anyway  (I accept the risk)`
  );

  if (choice.startsWith(verb)) {
    await installClaude(sourceVersion);
    return { action: 'continue' };
  }
  if (choice === 'Cancel pull') return { action: 'cancel' };
  // "Continue anyway" — log warning and proceed
  log('info', `User chose to continue despite Claude version mismatch (source=${sourceVersion}, local=${localVersion})`);
  return { action: 'continue' };
}

async function installClaude(version) {
  const pkg = `@anthropic-ai/claude-code@${version}`;
  console.log();
  console.log(`Installing ${pkg}...`);
  try {
    execFileSync('npm', ['install', '-g', pkg], { stdio: 'inherit', timeout: 120000 });
    log('info', `Claude v${version} installed successfully.`);
    console.log(`✓ Claude v${version} installed.`);
  } catch (e) {
    log('error', `npm install failed: ${e.message}`);
    console.log(`✗ Automatic install failed. Run manually:`);
    console.log(`  npm install -g ${pkg}`);
    console.log();
  }
}


// ===================================================================
// PUSH WORKFLOW
// ===================================================================

export async function pushWorkflow(config, backend, { force = false } = {}) {
  const claudeDir = config.CLAUDE_DIR;
  const bundleDir = config.BUNDLE_DIR;
  const userHome = config.HOME || os.homedir();  // User's home dir for ~/CLAUDE.md, ~/.claude.json, ~/.agents/
  const secretsMode = config.SECRETS || 'keep';

  initLogging(path.join(bundleDir, 'sync.log'));
  log('info', `Push started by ${config.MACHINE_ID}`);

  if (!fs.existsSync(claudeDir)) {
    throw new Error(`Claude config directory not found: ${claudeDir}`);
  }

  // 1. Conflict detection
  if (config.BACKEND !== 'manual' && !force) {
    const tempManifest = path.join(bundleDir, 'remote-manifest.json');
    try {
      await backend.download(remotePath(config, 'manifest.json'), tempManifest);
      const remoteManifest = readManifest(tempManifest);
      try { fs.unlinkSync(tempManifest); } catch {}

      if (remoteManifest) {
        const state = readState(bundleDir);
        const lastPull = state?.last_pull_at ? new Date(state.last_pull_at) : null;
        const remoteTime = new Date(remoteManifest.pushed_at);

        if (remoteManifest.pushed_by !== config.MACHINE_ID &&
            (!lastPull || remoteTime > lastPull)) {
          log('info', `Conflict: remote pushed by ${remoteManifest.pushed_by} at ${remoteManifest.pushed_at}`);
          if (!force) {
            log('info', 'Use --force to overwrite remote.');
            return { success: false, reason: 'conflict', remoteManifest };
          }
          log('info', '--force: overwriting remote.');
        }
      }
    } catch (err) {
      // Distinguish: file-not-found = first push; other errors = real problem
      if (err.code === 'ENOENT' || err.message?.includes('not found') || err.message?.includes('404')) {
        log('verbose', 'No remote manifest found (first push)');
      } else {
        log('info', `Warning: Could not check remote for conflicts: ${err.message}`);
        log('info', 'Proceeding with push. Use --force to skip this warning next time.');
      }
    }
  } else if (config.BACKEND === 'manual') {
    log('verbose', 'Manual backend: skipping conflict detection');
  }

  // 2. Prepare staging dir with processed config files
  const stageDir = path.join(bundleDir, 'stage');
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(stageDir, { recursive: true });

  // Copy config files to staging (A: direct sync)
  const configFiles = TRACKED_CONFIG_FILES;
  for (const file of configFiles) {
    const src = path.join(claudeDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(stageDir, file));
    }
  }

  // CLAUDE.md from ~/ and ~/.claude/ (preserve both if they exist)
  const homeClaudeMd = path.join(userHome, 'CLAUDE.md');
  const claudeDirClaudeMd = path.join(claudeDir, 'CLAUDE.md');
  if (fs.existsSync(homeClaudeMd)) {
    fs.copyFileSync(homeClaudeMd, path.join(stageDir, 'CLAUDE_home.md'));
  }
  if (fs.existsSync(claudeDirClaudeMd)) {
    fs.copyFileSync(claudeDirClaudeMd, path.join(stageDir, 'CLAUDE_claude.md'));
  }

  // Copy optional dirs: commands, agents, hooks, output-styles
  for (const dir of ['commands', 'agents', 'hooks', 'output-styles']) {
    const srcDir = path.join(claudeDir, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(stageDir, dir), { recursive: true });
    }
  }

  // Copy plugin registries (E)
  const pluginsDir = path.join(claudeDir, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    const stagePlugins = path.join(stageDir, 'plugins');
    fs.mkdirSync(stagePlugins, { recursive: true });
    for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
      const src = path.join(pluginsDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stagePlugins, f));
    }
  }

  // Copy skills directory
  const skillsDir = path.join(claudeDir, 'skills');
  const agentsDir = path.join(userHome, '.agents');
  if (fs.existsSync(skillsDir)) {
    fs.cpSync(skillsDir, path.join(stageDir, 'skills'), { recursive: true });
  }

  // Copy shared-memory (with interactive prompt if not yet configured)
  const settings = readSettings(claudeDir);
  let autoMemDir = settings?.autoMemoryDirectory;

  if (!autoMemDir) {
    // Ask user if they want to enable memory globalization
    const shouldEnable = await promptYesNo(
      'Memory is currently per-project. Enable global memory sync across machines?',
      false  // default to No in non-TTY (CI/automated) mode for safety
    );
    if (shouldEnable) {
      const memDir = '~/.claude/shared-memory';
      autoMemDir = memDir;
      // Set autoMemoryDirectory in settings.json
      if (settings) {
        settings.autoMemoryDirectory = memDir;
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
        log('info', `Memory globalization enabled: ${memDir}`);
      }
      // Migrate existing per-project memory to shared-memory
      const resolvedMem = path.join(userHome, '.claude', 'shared-memory');
      if (!fs.existsSync(resolvedMem)) fs.mkdirSync(resolvedMem, { recursive: true });
      const projectsDir = path.join(claudeDir, 'projects');
      if (fs.existsSync(projectsDir)) {
        migrateMemoryToShared(projectsDir, resolvedMem);
      }
    }
  }

  if (autoMemDir) {
    const resolvedMem = autoMemDir.replace(/^~/, userHome);
    if (fs.existsSync(resolvedMem)) {
      fs.cpSync(resolvedMem, path.join(stageDir, 'shared-memory'), { recursive: true });
    }
  }

  // 3. Apply secret stripping (if strip mode) — both settings.json and settings.local.json
  if (secretsMode === 'strip') {
    for (const f of ['settings.json', 'settings.local.json']) {
      const fp = path.join(stageDir, f);
      if (fs.existsSync(fp)) {
        try {
          const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          const stripped = stripSecrets(data, 'settings');
          fs.writeFileSync(fp, JSON.stringify(stripped, null, 2));
        } catch { /* not valid JSON, skip */ }
      }
    }
    log('verbose', 'Secrets stripped from config files');
  }

  // 4. Compute hashes for manifest
  const hashes = {};
  for (const file of TRACKED_CONFIG_FILES) {
    const fp = path.join(stageDir, file);
    if (fs.existsSync(fp)) hashes[file] = hashFile(fp);
  }
  for (const f of TRACKED_CLAUDE_FILES) {
    const fp = path.join(stageDir, f);
    if (fs.existsSync(fp)) hashes[f] = hashFile(fp);
  }

  // 5. Detect skills
  const pushSkills = detectSkills(path.join(stageDir, 'skills'), agentsDir);

  // 6. Extract mcpServers (names for manifest + full config for bundle)
  const { names: mcpServers, config: mcpServerConfig } = extractMcpServers(userHome, secretsMode);
  // Write full mcpServer config to staging for bundle (so target gets real config, not just names)
  if (Object.keys(mcpServerConfig).length > 0) {
    fs.writeFileSync(path.join(stageDir, 'mcp_servers.json'), JSON.stringify(mcpServerConfig, null, 2));
  }

  // 7. Memory metadata
  let memory = null;
  if (settings?.autoMemoryDirectory) {
    const resolvedMem = settings.autoMemoryDirectory.replace(/^~/, userHome);
    memory = {
      auto_memory_directory: settings.autoMemoryDirectory,
      topic_count: countMemoryTopics(resolvedMem)
    };
  }

  // 8. Read plugin versions
  const plugins = readPluginVersions(path.join(stageDir, 'plugins'));

  // 9. Create manifest
  const manifest = createManifest(
    {
      files: hashes,
      plugins,
      skills: {
        skills_sh: pushSkills.filter(s => s.type === 'skills_sh'),
        git: pushSkills.filter(s => s.type === 'git'),
        symlink: pushSkills.filter(s => s.type === 'symlink'),
        child_symlink: pushSkills.filter(s => s.type === 'child_symlink'),
        plain: pushSkills.filter(s => s.type === 'plain')
      },
      mcp_servers: mcpServers,
      memory,
      claude_version: getClaudeVersion()
    },
    { machineId: config.MACHINE_ID, sourceUser: os.userInfo().username, sourceHome: userHome }
  );

  // 10. Resolve symlinks in staging (child_symlink SKILL.md etc. — tar preserves symlinks,
  //     but target machine won't have the original paths. Dereference to make bundle self-contained.)
  resolveSymlinksInDir(path.join(stageDir, 'skills'));

  // 11. Remove git/skills.sh skills from staging (recorded in manifest, not packaged in tar.gz)
  for (const skill of pushSkills) {
    if (skill.type === 'git' || skill.type === 'skills_sh') {
      const skillPath = path.join(stageDir, 'skills', skill.name);
      if (fs.existsSync(skillPath)) {
        fs.rmSync(skillPath, { recursive: true, force: true });
        log('verbose', `Not packaging ${skill.type} skill: ${skill.name}`);
      }
    }
  }

  // 11. Write manifest (separate from bundle)
  const manifestPath = path.join(bundleDir, 'manifest.json');
  writeManifest(manifestPath, manifest);

  // 13. Build tar.gz bundle from staging dir
  const bundlePath = path.join(bundleDir, 'bundle.tar.gz');
  await buildBundle(stageDir, bundlePath, config.EXCLUDE);

  // Clean up staging
  fs.rmSync(stageDir, { recursive: true, force: true });

  // 14. Upload
  if (config.BACKEND !== 'manual') {
    log('info', 'Uploading to remote...');
    await backend.upload(bundlePath, remotePath(config, 'bundle.tar.gz'));
    await backend.upload(manifestPath, remotePath(config, 'manifest.json'));
  } else {
    log('info', `Bundle ready: ${bundlePath}`);
    log('info', `Manifest ready: ${manifestPath}`);
    log('info', 'Manual backend: copy these files to your sync folder.');
  }

  log('info', 'Push complete!');
  return { success: true, manifest };
}

// ===================================================================
// PULL WORKFLOW
// ===================================================================

export async function pullWorkflow(config, backend, { strategy = 'cover' } = {}) {
  const claudeDir = config.CLAUDE_DIR;
  const bundleDir = config.BUNDLE_DIR;
  const userHome = config.HOME || os.homedir();  // User's home dir for ~/CLAUDE.md, ~/.claude.json, ~/.agents/
  const secretsMode = config.SECRETS || 'keep';

  initLogging(path.join(bundleDir, 'sync.log'));
  log('info', `Pull started on ${config.MACHINE_ID}`);

  // 1. Read manifest
  const localManifestPath = path.join(bundleDir, 'manifest.json');
  let manifest;

  try {
    if (config.BACKEND !== 'manual') {
      await backend.download(remotePath(config, 'manifest.json'), localManifestPath);
    }
    manifest = readManifest(localManifestPath);
  } catch {
    throw new Error('Failed to download manifest. Has the source machine pushed yet?');
  }

  if (!manifest) {
    throw new Error('Remote manifest is empty or invalid.');
  }

  // Check manifest version compatibility
  if (manifest.version && manifest.version > SUPPORTED_MANIFEST_VERSION) {
    throw new Error(
      `Manifest version ${manifest.version} is newer than supported version ${SUPPORTED_MANIFEST_VERSION}. ` +
      'Please upgrade claude-sync: npm install -g claude-sync@latest'
    );
  }

  // 1b. Check Claude Code version compatibility
  if (strategy !== 'dry-run') {
    const versionResult = await ensureClaudeVersion(manifest.claude_version);
    if (versionResult.action === 'cancel') {
      log('info', 'Pull cancelled by user (Claude version mismatch).');
      return { success: false, reason: 'cancelled' };
    }
  }

  // 2. Download bundle
  const bundlePath = path.join(bundleDir, 'bundle.tar.gz');
  try {
    if (config.BACKEND !== 'manual') {
      await backend.download(remotePath(config, 'bundle.tar.gz'), bundlePath);
    }
    if (!fs.existsSync(bundlePath)) {
      throw new Error('Bundle file not found.');
    }
  } catch {
    throw new Error('Failed to download bundle.');
  }

  // 3. Backup current .claude
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(userHome, `.claude.backup.${timestamp}`);
  if (fs.existsSync(claudeDir)) {
    fs.cpSync(claudeDir, backupPath, { recursive: true });
    log('info', `Backup created: ${backupPath}`);
  }

  // 4. Extract bundle (with auto-rollback on failure)
  const extractDir = path.join(bundleDir, 'extracted');
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await extractBundle(bundlePath, extractDir);
  } catch (extractErr) {
    log('error', `Bundle extraction failed: ${extractErr.message}`);
    log('info', 'Auto-rolling back to backup...');
    if (fs.existsSync(backupPath)) {
      if (fs.existsSync(claudeDir)) fs.rmSync(claudeDir, { recursive: true, force: true });
      fs.cpSync(backupPath, claudeDir, { recursive: true });
      log('info', 'Rollback complete. Local config restored from backup.');
    }
    throw new Error(`Pull failed during extraction: ${extractErr.message}. Local config has been restored.`);
  }

  // 5. Path replacement in extracted files (use manifest.source_home for cross-platform)
  const sourceHome = manifest.source_home || (
    manifest.source_user
      ? (process.platform === 'darwin' ? `/Users/${manifest.source_user}` : `/home/${manifest.source_user}`)
      : os.homedir()
  );
  const targetHome = userHome;
  applyPathReplacement(extractDir, sourceHome, targetHome);

  // 6. Secret restoration (strip mode — before merge, so user can input real values)
  if (secretsMode === 'strip') {
    const settingsPath = path.join(extractDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const strippedFields = findSecretFields(settings, 'settings');
      if (strippedFields.length > 0) {
        log('info', `Found ${strippedFields.length} secret field(s) with placeholders.`);
        log('info', 'Run claude-sync in interactive mode to fill in real values.');
        // In non-interactive mode: keep placeholders for manual fill-in
      }
    }
  }

  // 7. Compute diff between remote and local
  const diff = computeDiff(extractDir, claudeDir, manifest, userHome);

  if (diff.length === 0) {
    log('info', 'No differences — everything up to date.');
    console.log('  No differences — everything up to date.');
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    return { success: true, backup: null, manifest, skipped: true };
  }

  console.log(`  ${diff.length} item(s) differ from remote:`);
  for (const d of diff) {
    console.log(`    ~ ${d}`);
  }
  console.log();

  // 7a. Ask merge strategy (plain text prompt, avoids nested pickFromList ANSI cursor conflicts)
  const strategyNames = { cover: '覆盖', keep: '保留', interactive: '逐项' };
  const strategyHint = Object.entries(strategyNames)
    .map(([k, v]) => `${k}=${v}`).join(' / ');
  const currentName = strategyNames[strategy] || '覆盖';
  const answer = await prompt(
    `  Choose [${currentName}] (${strategyHint} / cancel): `
  );
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === 'cancel' || trimmed === '取消') {
    log('info', 'Pull cancelled by user.');
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    return { success: false, reason: 'cancelled' };
  }
  for (const [k, v] of Object.entries(strategyNames)) {
    if (trimmed === k || trimmed === v) { strategy = k; break; }
  }

  // 8. Merge configs
  if (strategy !== 'dry-run') {
    mergeExtractedConfig(extractDir, claudeDir, userHome, strategy, secretsMode);
  } else {
    log('info', 'Dry run — no changes applied. Showing what would change...');
    showDiff(extractDir, claudeDir, manifest);
  }

  // 7b. Memory globalization prompt (plan C: ask if not yet enabled)
  if (strategy !== 'dry-run' && manifest.memory) {
    await promptMemoryGlobalization(claudeDir, userHome, extractDir, manifest.memory, strategy);
  }

  // 8-12: All write operations — skip in dry-run mode
  if (strategy !== 'dry-run') {
    // 8. Merge mcpServers into ~/.claude.json
    if (manifest.mcp_servers && manifest.mcp_servers.length > 0) {
      const doMerge = strategy !== 'interactive' ||
        await promptYesNo(`Merge ${manifest.mcp_servers.length} MCP server(s) into .claude.json?`);
      if (doMerge) mergeMcpServers(userHome, manifest.mcp_servers, strategy, extractDir);
    }

    // 9. Restore skills
    const skillsDir = path.join(claudeDir, 'skills');
    if (manifest.skills) {
      const skillCount = (manifest.skills.plain || []).length +
        (manifest.skills.git || []).length +
        (manifest.skills.skills_sh || []).length +
        (manifest.skills.symlink || []).length +
        (manifest.skills.child_symlink || []).length;
      const doRestore = strategy !== 'interactive' ||
        await promptYesNo(`Restore ${skillCount} skill(s) from remote?`);
      if (doRestore) await restoreSkills(manifest.skills, claudeDir, skillsDir, extractDir, strategy, sourceHome, targetHome);
    }

    // 10. Handle plugins
    if (manifest.plugins) {
      const pluginCount = Object.keys(manifest.plugins).length;
      const doPlugins = strategy !== 'interactive' ||
        await promptYesNo(`Sync ${pluginCount} plugin(s) from remote?`);
      if (doPlugins) await handlePlugins(manifest.plugins, claudeDir, strategy);
    }

    // 11. statusLine path detection
    checkStatusLinePaths(claudeDir);

    // 12. Save pull state
    saveState({
      last_pull_at: new Date().toISOString(),
      last_pull_manifest: manifest
    }, bundleDir);
  } else {
    // Dry-run: show info without writing
    checkStatusLinePaths(extractDir);
    log('info', 'Dry run complete — no changes written to disk.');
  }

  // Clean up temp files (keep manifest and bundle for status/diff)
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}

  log('info', 'Pull complete!');
  log('info', `Backup saved: ${backupPath}`);

  return { success: true, backup: backupPath, manifest };
}

// ===================================================================
// HELPER FUNCTIONS
// ===================================================================

export function extractMcpServers(userHome, secretsMode = 'keep') {
  try {
    const claudeJsonPath = path.join(userHome, '.claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      if (data.mcpServers && typeof data.mcpServers === 'object') {
        const names = Object.keys(data.mcpServers);
        // Full config: strip secrets if in strip mode, otherwise keep as-is
        let config = data.mcpServers;
        if (secretsMode === 'strip') {
          config = stripSecrets(structuredClone(data.mcpServers), 'mcpServers');
          log('verbose', 'MCP server secrets stripped from bundle');
        }
        return { names, config };
      }
    }
  } catch (e) {
    log('verbose', `Could not read mcpServers: ${e.message}`);
  }
  return { names: [], config: {} };
}

export function mergeMcpServers(userHome, mcpServerNames, strategy, extractDir) {
  const claudeJsonPath = path.join(userHome, '.claude.json');

  let claudeJson = {};
  if (fs.existsSync(claudeJsonPath)) {
    try {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    } catch {
      claudeJson = {};
    }
  }

  // Read full MCP server config from bundle if available
  let bundleConfig = {};
  if (extractDir) {
    const bundleConfigPath = path.join(extractDir, 'mcp_servers.json');
    if (fs.existsSync(bundleConfigPath)) {
      try {
        bundleConfig = JSON.parse(fs.readFileSync(bundleConfigPath, 'utf-8'));
      } catch {}
    }
  }

  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
  for (const name of mcpServerNames) {
    if (!claudeJson.mcpServers[name] || strategy === 'cover') {
      // Use real config from bundle if available; otherwise create placeholder
      if (bundleConfig[name]) {
        claudeJson.mcpServers[name] = bundleConfig[name];
      } else {
        claudeJson.mcpServers[name] = { _pending: true }; // user fills in real config
      }
    }
  }

  // Preserve machine-specific fields
  fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
  log('verbose', `Merged ${mcpServerNames.length} mcpServer(s) into .claude.json`);
}

export function readSettings(claudeDir) {
  try {
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // unreadable
  }
  return null;
}


export function migrateMemoryToShared(projectsDir, sharedDir) {
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projMemDir = path.join(projectsDir, entry.name, 'memory');
        if (fs.existsSync(projMemDir)) {
          const memFiles = fs.readdirSync(projMemDir).filter(f => f.endsWith('.md'));
          for (const f of memFiles) {
            const src = path.join(projMemDir, f);
            const dest = path.join(sharedDir, f);
            if (!fs.existsSync(dest)) {
              fs.copyFileSync(src, dest);
              log('verbose', `Migrated memory: ${f}`);
            } else {
              log('verbose', `Skipped existing memory: ${f}`);
            }
          }
        }
      }
    }
    log('info', 'Memory migration complete.');
  } catch (e) {
    log('verbose', `Memory migration skipped: ${e.message}`);
  }
}

async function promptMemoryGlobalization(claudeDir, userHome, extractDir, memInfo, strategy = 'keep') {
  const settings = readSettings(claudeDir);
  const alreadyEnabled = settings?.autoMemoryDirectory;

  if (alreadyEnabled) {
    // Already enabled: merge memory topics from bundle
    const resolvedMem = alreadyEnabled.replace(/^~/, userHome);
    if (!fs.existsSync(resolvedMem)) fs.mkdirSync(resolvedMem, { recursive: true });

    const srcMem = path.join(extractDir, 'shared-memory');
    if (fs.existsSync(srcMem)) {
      mergeMemoryTopics(srcMem, resolvedMem, strategy);
      log('info', `Memory topics merged from remote (${memInfo.topic_count} topics).`);
    }
    return;
  }

  // Not yet enabled: ask user
  const shouldEnable = await promptYesNo(
    `Remote bundle contains ${memInfo.topic_count} memory topics at ${memInfo.auto_memory_directory}. ` +
    'Enable global memory sync on this machine?',
    false  // default to No in non-TTY mode for safety
  );

  if (shouldEnable) {
    const memDir = '~/.claude/shared-memory';
    // Set autoMemoryDirectory in settings.json
    const updatedSettings = settings || {};
    updatedSettings.autoMemoryDirectory = memDir;
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(updatedSettings, null, 2));
    log('info', `Memory globalization enabled: ${memDir}`);

    // Restore shared-memory from bundle
    const resolvedMem = path.join(userHome, '.claude', 'shared-memory');
    if (!fs.existsSync(resolvedMem)) fs.mkdirSync(resolvedMem, { recursive: true });

    const srcMem = path.join(extractDir, 'shared-memory');
    if (fs.existsSync(srcMem)) {
      mergeMemoryTopics(srcMem, resolvedMem, strategy);
      log('info', `Memory topics restored: ${memInfo.topic_count} topics from remote.`);
    }
  } else {
    log('info', 'Memory sync skipped. Enable later with autoMemoryDirectory in settings.json.');
  }
}

export function mergeMemoryTopics(srcDir, destDir, strategy = 'keep') {
  try {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const dest = path.join(destDir, entry.name);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(srcDir, entry.name), dest);
          log('verbose', `Memory topic restored: ${entry.name}`);
        } else if (strategy === 'cover') {
          // Overwrite existing topic with remote version
          fs.copyFileSync(path.join(srcDir, entry.name), dest);
          log('verbose', `Memory topic overwritten: ${entry.name}`);
        } else {
          log('verbose', `Memory topic already exists (kept local): ${entry.name}`);
        }
      }
    }
  } catch (e) {
    log('verbose', `Memory topic merge skipped: ${e.message}`);
  }
}

export function countMemoryTopics(memDir) {
  try {
    if (fs.existsSync(memDir)) {
      return fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').length;
    }
  } catch {
    // unreadable
  }
  return 0;
}

export function applyPathReplacement(dir, sourceHome, targetHome) {
  if (sourceHome === targetHome) return;

  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.(json|md)$/.test(entry.name)) {
        try {
          let content = fs.readFileSync(fullPath, 'utf-8');
          const newContent = replaceUserPath(content, sourceHome, targetHome);
          if (newContent !== content) {
            fs.writeFileSync(fullPath, newContent);
            log('verbose', `Path replaced in: ${path.relative(dir, fullPath)}`);
          }
        } catch {
          // skip binary/unreadable
        }
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir);
}

function mergeExtractedConfig(extractDir, claudeDir, userHome, strategy, secretsMode) {
  if (strategy === 'cover') {
    // Save local env values BEFORE overwriting (protect real secrets in strip mode)
    let savedEnv = {};
    let savedLocalEnv = {};
    const localSettingsPath = path.join(claudeDir, 'settings.json');
    const localLocalSettingsPath = path.join(claudeDir, 'settings.local.json');
    if (secretsMode === 'strip' && fs.existsSync(localSettingsPath)) {
      try {
        const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
        if (localSettings.env) savedEnv = localSettings.env;
      } catch {}
    }
    if (secretsMode === 'strip' && fs.existsSync(localLocalSettingsPath)) {
      try {
        const localLocalSettings = JSON.parse(fs.readFileSync(localLocalSettingsPath, 'utf-8'));
        if (localLocalSettings.env) savedLocalEnv = localLocalSettings.env;
      } catch {}
    }

    copyDirContents(extractDir, claudeDir);

    // Restore CLAUDE.md to original locations (from staging names)
    restoreClaudeMdFiles(extractDir, claudeDir, userHome);

    // Restore local settings.json env values where bundle has *** placeholders
    if (secretsMode === 'strip' && fs.existsSync(localSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
      if (settings.env) {
        for (const [k, v] of Object.entries(settings.env)) {
          if (isStripped(v) && savedEnv[k]) {
            settings.env[k] = savedEnv[k]; // keep real value from local
          } else if (isStripped(v)) {
            delete settings.env[k]; // no local value, remove placeholder
          }
        }
      }
      fs.writeFileSync(localSettingsPath, JSON.stringify(settings, null, 2));
    }

    // Restore local settings.local.json env values where bundle has *** placeholders
    if (secretsMode === 'strip' && fs.existsSync(localLocalSettingsPath)) {
      const localSettings = JSON.parse(fs.readFileSync(localLocalSettingsPath, 'utf-8'));
      if (localSettings.env) {
        for (const [k, v] of Object.entries(localSettings.env)) {
          if (isStripped(v) && savedLocalEnv[k]) {
            localSettings.env[k] = savedLocalEnv[k]; // keep real value from local
          } else if (isStripped(v)) {
            delete localSettings.env[k]; // no local value, remove placeholder
          }
        }
      }
      fs.writeFileSync(localLocalSettingsPath, JSON.stringify(localSettings, null, 2));
    }
    return;
  }

  if (strategy === 'interactive') {
    log('info', 'Interactive mode: config merging is simplified. Key decisions will be prompted.');
  }

  // keep strategy (and interactive fallback): only add files/fields that don't exist on target
  copyIfMissing(extractDir, claudeDir);
}

export function resolveSymlinksInDir(dir) {
  if (!fs.existsSync(dir)) return;
  // Security boundary: dereference symlinks within the original staging dir or home dir.
  // Use the INITIAL dir as root for the entire recursive walk — don't narrow as we
  // recurse into subdirectories, otherwise cross-directory symlinks (e.g.
  // child_symlink → sibling git repo) get blocked.
  const HOME = os.homedir();
  _resolveSymlinks(dir, path.resolve(dir), HOME);
}

function _resolveSymlinks(dir, ROOT_DIR, HOME) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  const ALLOWED_ROOTS = [ROOT_DIR, HOME];

  function isWithinAllowedRoots(targetPath) {
    return ALLOWED_ROOTS.some(root =>
      targetPath.startsWith(root + path.sep) || targetPath === root
    );
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath);
        // Security: validate symlink target is within an allowed root
        const resolvedTarget = path.resolve(path.dirname(fullPath), target);
        if (!isWithinAllowedRoots(resolvedTarget)) {
          log('verbose', `Skipped symlink outside allowed roots: ${entry.name} -> ${target}`);
          continue;
        }
        // Check if symlink target exists; if not (broken symlink, e.g. child_symlink
        // pointing to a git repo not yet cloned), remove it so it's not packaged.
        try { fs.statSync(fullPath); } catch {
          log('verbose', `Removing broken symlink: ${entry.name} -> ${target}`);
          fs.unlinkSync(fullPath);
          continue;
        }
        if (fs.statSync(fullPath).isDirectory()) {
          // Directory symlink: copy actual directory contents, then replace symlink with real dir
          const tmpDir = fullPath + '.tmp';
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
          fs.cpSync(fullPath, tmpDir, { recursive: true, dereference: true });
          // Atomic swap: backup → rename tmp → remove backup
          const backup = fullPath + '.bak';
          try {
            fs.renameSync(fullPath, backup);
            try {
              fs.renameSync(tmpDir, fullPath);
              fs.rmSync(backup, { recursive: true, force: true });
            } catch {
              fs.renameSync(backup, fullPath);
              log('verbose', `Rolled back symlink dereference for ${entry.name}`);
            }
          } catch {
            // rename failed, cleanup tmp
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          }
          log('verbose', `Dereferenced dir symlink: ${entry.name} -> ${target}`);
        } else {
          // File symlink: read content, unlink symlink, write real file
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath);
            fs.unlinkSync(fullPath);
            fs.writeFileSync(fullPath, content);
            log('verbose', `Dereferenced file symlink: ${entry.name}`);
          }
        }
      } else if (lstat.isDirectory()) {
        _resolveSymlinks(fullPath, ROOT_DIR, HOME);
      }
    } catch (e) {
      log('verbose', `Could not dereference ${entry.name}: ${e.message}`);
    }
  }
}

export function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  try {
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      try {
        const lstat = fs.lstatSync(srcPath);
        if (lstat.isSymbolicLink()) {
          // Dereference symlinks: copy the actual content, not the link
          try {
            if (fs.statSync(srcPath).isDirectory()) {
              fs.cpSync(srcPath, destPath, { recursive: true, dereference: true });
            } else {
              const content = fs.readFileSync(srcPath);
              fs.writeFileSync(destPath, content);
            }
          } catch (symErr) {
            // Broken symlink (target doesn't exist) — skip gracefully
            log('verbose', `Broken symlink skipped: ${entry} -> ${fs.readlinkSync(srcPath)} (${symErr.code})`);
          }
        } else if (lstat.isDirectory()) {
          if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
          copyDirContents(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      } catch (e) {
        log('verbose', `Skipped ${entry}: ${e.message}`);
      }
    }
  } catch (e) {
    log('verbose', `copyDirContents readdir failed: ${e.message}`);
  }
}

/**
 * Restore CLAUDE.md files from staging names to original locations.
 * CLAUDE_home.md → ~/CLAUDE.md
 * CLAUDE_claude.md → ~/.claude/CLAUDE.md
 */
function restoreClaudeMdFiles(extractDir, claudeDir, userHome) {
  // Restore ~/CLAUDE.md from CLAUDE_home.md
  const homeSrc = path.join(extractDir, 'CLAUDE_home.md');
  const homeDest = path.join(userHome, 'CLAUDE.md');
  if (fs.existsSync(homeSrc)) {
    try {
      fs.copyFileSync(homeSrc, homeDest);
      // Remove staging file from claudeDir (it was copied there by copyDirContents)
      const stagedInClaude = path.join(claudeDir, 'CLAUDE_home.md');
      try { fs.unlinkSync(stagedInClaude); } catch {}
      log('verbose', 'CLAUDE.md restored to home directory');
    } catch (e) {
      log('verbose', `Failed to restore CLAUDE.md to home: ${e.message}`);
    }
  }

  // Restore ~/.claude/CLAUDE.md from CLAUDE_claude.md
  const claudeSrc = path.join(extractDir, 'CLAUDE_claude.md');
  const claudeDest = path.join(claudeDir, 'CLAUDE.md');
  if (fs.existsSync(claudeSrc)) {
    try {
      fs.copyFileSync(claudeSrc, claudeDest);
      const stagedClaude = path.join(claudeDir, 'CLAUDE_claude.md');
      try { fs.unlinkSync(stagedClaude); } catch {}
      log('verbose', 'CLAUDE.md restored to .claude directory');
    } catch (e) {
      log('verbose', `Failed to restore CLAUDE.md to .claude: ${e.message}`);
    }
  }
}

function copyIfMissing(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
      copyIfMissing(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function computeDiff(extractDir, claudeDir, manifest, userHome) {
  const items = [];

  // Compare hashed files
  for (const [file, remoteHash] of Object.entries(manifest.hashes || {})) {
    let localPath;
    if (file === 'CLAUDE_home.md') localPath = path.join(userHome, 'CLAUDE.md');
    else if (file === 'CLAUDE_claude.md') localPath = path.join(claudeDir, 'CLAUDE.md');
    else localPath = path.join(claudeDir, file);

    if (!fs.existsSync(localPath)) {
      items.push(`${file} (new)`);
    } else {
      const localHash = hashFile(localPath);
      if (localHash !== remoteHash) items.push(file);
    }
  }

  // Compare plugins
  const localPlugins = readPluginVersions(path.join(claudeDir, 'plugins'));
  for (const [name, ver] of Object.entries(manifest.plugins || {})) {
    const localVer = localPlugins[name];
    if (!localVer) items.push(`plugin ${name}@${ver} (new)`);
    else if (localVer !== ver) items.push(`plugin ${name}: ${localVer} → ${ver}`);
  }

  // Compare skills — actually diff against local filesystem, don't list everything blindly
  if (manifest.skills) {
    const localSkills = detectSkills(path.join(claudeDir, 'skills'), path.join(claudeDir, '.agents'));
    const localByName = {};
    for (const s of localSkills) localByName[s.name] = s;

    for (const type of ['skills_sh', 'git', 'symlink', 'child_symlink', 'plain']) {
      for (const s of (manifest.skills[type] || [])) {
        const local = localByName[s.name];
        if (!local) {
          items.push(`skill:${type} ${s.name} (new)`);
        } else if (local.type !== type) {
          items.push(`skill:${s.name} type changed (local=${local.type}, remote=${type})`);
        } else if (type === 'git' && s.commit && local.commit !== s.commit) {
          const shortLocal = local.commit ? local.commit.substring(0, 8) : '?';
          const shortRemote = s.commit.substring(0, 8);
          items.push(`skill:git ${s.name} commit ${shortLocal} → ${shortRemote}`);
        }
        // child_symlink, symlink, plain, skills_sh: type match is enough (paths may differ by machine)
      }
    }
  }

  // Compare mcpServers
  const localMcp = extractMcpServers(userHome).names;
  const newMcp = (manifest.mcp_servers || []).filter(n => !localMcp.includes(n));
  for (const n of newMcp) items.push(`mcpServer ${n} (new)`);

  // Compare memory
  if (manifest.memory) {
    const settings = readSettings(claudeDir);
    const memDir = settings?.autoMemoryDirectory?.replace(/^~/, userHome);
    const localCount = memDir ? countMemoryTopics(memDir) : 0;
    if (localCount !== manifest.memory.topic_count) {
      items.push(`memory (${localCount} → ${manifest.memory.topic_count} topics)`);
    } else if (localCount > 0) {
      // Same count, but content may differ — check hashes
      const srcMem = path.join(extractDir, 'shared-memory');
      if (fs.existsSync(srcMem) && memDir && fs.existsSync(memDir)) {
        let memChanged = false;
        try {
          for (const f of fs.readdirSync(srcMem)) {
            if (!f.endsWith('.md')) continue;
            const localF = path.join(memDir, f);
            if (!fs.existsSync(localF) || hashFile(path.join(srcMem, f)) !== hashFile(localF)) {
              memChanged = true;
              break;
            }
          }
        } catch { /* skip */ }
        if (memChanged) items.push('memory content changed');
      }
    }
  }

  return items;
}

function showDiff(extractDir, claudeDir, manifest) {
  log('info', '--- Diff Preview ---');
  log('info', `Source machine: ${manifest.pushed_by}`);
  log('info', `Source user: ${manifest.source_user}`);
  log('info', '');

  for (const [file, hash] of Object.entries(manifest.hashes || {})) {
    const localPath = path.join(claudeDir, file);
    const exists = fs.existsSync(localPath) ? 'present' : 'missing';
    log('info', `  ${file}: remote ${hash.substring(0, 8)}... local ${exists}`);
  }

  if (manifest.skills) {
    const allSkills = [
      ...(manifest.skills.skills_sh || []).map(s => ({ ...s, kind: 'skills.sh' })),
      ...(manifest.skills.git || []).map(s => ({ ...s, kind: 'git' })),
      ...(manifest.skills.symlink || []).map(s => ({ ...s, kind: 'symlink' })),
      ...(manifest.skills.child_symlink || []).map(s => ({ ...s, kind: 'child symlink' })),
      ...(manifest.skills.plain || []).map(s => ({ ...s, kind: 'plain' }))
    ];
    log('info', `  Skills: ${allSkills.length} total`);
  }

  if (manifest.memory) {
    log('info', `  Memory: ${manifest.memory.topic_count} topics`);
  }
}

async function restoreSkills(skillsManifest, claudeDir, skillsDir, extractDir, strategy, sourceHome, targetHome) {
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Plain skills: already in extracted bundle (copyDirContents handles them)
  // Git skills: auto-clone if remote is available, or sync commits
  for (const skill of (skillsManifest.git || [])) {
    const dest = path.join(skillsDir, skill.name);
    if (!fs.existsSync(dest) || strategy === 'cover') {
      if (skill.remote) {
        try {
          log('info', `Cloning git skill '${skill.name}' from ${skill.remote}...`);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
          execFileSync('git', ['clone', skill.remote, dest], { stdio: 'pipe', timeout: 60000 });
          if (skill.commit) {
            try { execFileSync('git', ['checkout', skill.commit], { cwd: dest, stdio: 'pipe', timeout: 10000 }); } catch {}
          }
          if (skill.hasPackageJson && fs.existsSync(path.join(dest, 'package.json'))) {
            try { execFileSync('npm', ['install'], { cwd: dest, stdio: 'pipe', timeout: 120000 }); } catch {}
          }
          log('info', `Git skill '${skill.name}' cloned and ready.`);
        } catch (e) {
          log('info', `Git skill '${skill.name}' clone failed: ${e.message}. Clone manually.`);
        }
      } else {
        log('info', `Git skill '${skill.name}': no remote recorded. Clone manually.`);
      }
    } else if (skill.commit) {
      // Skill exists — check if commit matches
      try {
        const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: dest, encoding: 'utf-8', timeout: 5000
        }).trim();
        if (localCommit !== skill.commit && strategy === 'cover') {
          log('info', `Updating git skill '${skill.name}' to commit ${skill.commit.substring(0, 8)}...`);
          try { execFileSync('git', ['fetch', 'origin'], { cwd: dest, stdio: 'pipe', timeout: 30000 }); } catch {}
          try { execFileSync('git', ['checkout', skill.commit], { cwd: dest, stdio: 'pipe', timeout: 10000 }); } catch {}
          log('info', `Git skill '${skill.name}' updated.`);
        }
      } catch {
        log('verbose', `Could not check git commit for skill '${skill.name}'`);
      }
    }
  }

  // skills.sh skills: auto-restore via npx skills add
  for (const skill of (skillsManifest.skills_sh || [])) {
    if (skill.source) {
      try {
        log('info', `Restoring skills.sh skill '${skill.name}'...`);
        execFileSync('npx', ['skills', 'add', skill.source], { stdio: 'pipe', timeout: 60000 });
        log('info', `skills.sh skill '${skill.name}' restored.`);
      } catch (e) {
        log('info', `skills.sh skill '${skill.name}' restore failed: ${e.message}. Run manually: npx skills add ${skill.source}`);
      }
    }
  }

  // Symlink skills: path-replace target, then restore symlink if target exists
  for (const skill of (skillsManifest.symlink || [])) {
    const dest = path.join(skillsDir, skill.name);
    if (!fs.existsSync(dest) || strategy === 'cover') {
      const resolvedTarget = skill.target
        ? replaceUserPath(skill.target, sourceHome || '', targetHome || '')
        : null;
      if (resolvedTarget && fs.existsSync(resolvedTarget)) {
        try { fs.unlinkSync(dest); } catch {}
        fs.symlinkSync(resolvedTarget, dest);
        log('info', `Symlink skill '${skill.name}' restored: ${resolvedTarget}`);
      } else if (skill.target) {
        // Target doesn't exist after path replacement — copy from bundle as fallback
        log('info', `Symlink target for '${skill.name}' not found. Using bundled copy.`);
      }
    }
  }

  // Child symlink skills: path-replace skillMdTarget, then recreate SKILL.md symlink
  for (const skill of (skillsManifest.child_symlink || [])) {
    const skillDir = path.join(skillsDir, skill.name);
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMd) || strategy === 'cover') {
      const resolvedTarget = skill.skillMdTarget
        ? replaceUserPath(skill.skillMdTarget, sourceHome || '', targetHome || '')
        : null;
      if (resolvedTarget && fs.existsSync(resolvedTarget)) {
        if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
        try { fs.unlinkSync(skillMd); } catch {}
        fs.symlinkSync(resolvedTarget, skillMd);
        log('info', `Child symlink skill '${skill.name}' restored: SKILL.md → ${resolvedTarget}`);
      } else if (skill.skillMdTarget) {
        log('info', `Child symlink skill '${skill.name}': target '${resolvedTarget || skill.skillMdTarget}' not found. Clone parent git repo first.`);
      }
    }
  }
}

export async function handlePlugins(plugins, claudeDir, strategy) {
  const pluginsDir = path.join(claudeDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  const localPluginsPath = path.join(pluginsDir, 'installed_plugins.json');
  let localPlugins = {};
  // Preserve original CC format for writing back
  let rawPluginsData = { version: 2, plugins: {} };
  if (fs.existsSync(localPluginsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(localPluginsPath, 'utf-8'));
      rawPluginsData = raw;
      // Handle CC format { version: 2, plugins: { "name@marketplace": [...] } }
      if (raw.plugins && typeof raw.plugins === 'object') {
        for (const [key, entries] of Object.entries(raw.plugins)) {
          const name = key.split('@')[0];
          const latest = Array.isArray(entries) ? entries[entries.length - 1] : entries;
          localPlugins[name] = latest?.version || 'unknown';
        }
      } else {
        // Legacy flat format
        localPlugins = raw;
      }
    } catch {}
  }

  const toInstall = [];
  const toUpdate = [];

  for (const [name, version] of Object.entries(plugins)) {
    if (!localPlugins[name]) {
      toInstall.push({ name, version });
    } else if (localPlugins[name] !== version && strategy === 'cover') {
      toUpdate.push({ name, version, existing: localPlugins[name] });
    }
  }

  const failedOps = [];

  if (toInstall.length > 0) {
    log('info', `Installing ${toInstall.length} plugin(s)...`);
    for (const { name, version } of toInstall) {
      try {
        log('info', `  Installing ${name}@${version}...`);
        execFileSync('claude', ['plugin', 'install', `${name}@${version}`], { stdio: 'pipe', timeout: 60000 });
        log('info', `  ✓ ${name}@${version} installed`);
      } catch (e) {
        log('info', `  ✗ ${name}@${version} install failed: ${e.message}.`);
        failedOps.push(`claude plugin install ${name}@${version}`);
      }
    }
  }

  if (toUpdate.length > 0) {
    log('info', `Updating ${toUpdate.length} plugin(s)...`);
    for (const { name, version, existing } of toUpdate) {
      try {
        log('info', `  Updating ${name}: ${version}...`);
        try { execFileSync('claude', ['plugin', 'uninstall', name], { stdio: 'pipe', timeout: 30000 }); } catch {}
        execFileSync('claude', ['plugin', 'install', `${name}@${version}`], { stdio: 'pipe', timeout: 60000 });
        log('info', `  ✓ ${name} updated to ${version}`);
      } catch (e) {
        log('info', `  ✗ ${name} update failed: ${e.message}. Attempting to restore previous version ${existing}...`);
        // Try to reinstall the previous version to recover
        try {
          execFileSync('claude', ['plugin', 'install', `${name}@${existing}`], { stdio: 'pipe', timeout: 60000 });
          log('info', `  ✓ ${name} rolled back to ${existing}`);
        } catch (recoveryErr) {
          log('info', `  ✗ ${name} rollback also failed: ${recoveryErr.message}.`);
        }
        failedOps.push(`claude plugin install ${name}@${version}`);
      }
    }
  }

  // Generate fallback script for failed operations
  if (failedOps.length > 0) {
    // Use BUNDLE_DIR rather than deriving from claudeDir
    const scriptDir = path.join(os.homedir(), '.claude-sync-bundle');
    if (!fs.existsSync(scriptDir)) fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'install-plugins.sh');
    const scriptContent = `#!/bin/sh\n# Generated by claude-sync — run to install failed plugins\n\n${failedOps.join('\n')}\n`;
    fs.writeFileSync(scriptPath, scriptContent);
    try { fs.chmodSync(scriptPath, 0o755); } catch {}
    log('info', `Generated plugin install script: ${scriptPath}`);
    log('info', `Run it manually to complete ${failedOps.length} failed operation(s).`);
  }

  // Update installed_plugins.json preserving CC format
  if (rawPluginsData.plugins && typeof rawPluginsData.plugins === 'object') {
    // CC format: { version: 2, plugins: { "name@marketplace": [...] } }
    // Only update entries for plugins we installed/updated; preserve the rest as-is
    for (const { name, version } of toInstall) {
      if (!rawPluginsData.plugins[name]) rawPluginsData.plugins[name] = [];
      rawPluginsData.plugins[name] = [{ version, installedAt: new Date().toISOString() }];
    }
    for (const { name, version } of toUpdate) {
      rawPluginsData.plugins[name] = [{ version, installedAt: new Date().toISOString() }];
    }
    fs.writeFileSync(localPluginsPath, JSON.stringify(rawPluginsData, null, 2));
  } else {
    // Legacy flat format: merge and write flat
    const merged = { ...localPlugins };
    for (const { name, version } of toInstall) merged[name] = version;
    for (const { name, version } of toUpdate) merged[name] = version;
    fs.writeFileSync(localPluginsPath, JSON.stringify(merged, null, 2));
  }
}

export function checkStatusLinePaths(claudeDir) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (settings.statusLine?.path) {
      if (!fs.existsSync(settings.statusLine.path)) {
        log('info', `Warning: statusLine path '${settings.statusLine.path}' does not exist on this machine.`);
        log('info', '  Update it in settings.json if the tool is installed elsewhere.');
      }
    }
  } catch { /* ignore */ }
}

// ===================================================================
// STATE MANAGEMENT
// ===================================================================

function readState(bundleDir) {
  const stateFile = getStateFile(bundleDir);
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }
  } catch {
    // unreadable
  }
  return null;
}

function saveState(state, bundleDir) {
  const stateFile = getStateFile(bundleDir);
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const existing = readState(bundleDir) || {};
  fs.writeFileSync(stateFile, JSON.stringify({ ...existing, ...state }, null, 2));
}
