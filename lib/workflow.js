/**
 * Push/pull workflow orchestrator for claude-sync.
 * Wires together all lib modules for the full sync flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import spawn from 'cross-spawn';

// On Windows, npm-global CLIs (claude/npm/npx) are .cmd shims that execFileSync
// can't launch directly (ENOENT — the classic Windows npm-bin trap). Routing
// them through the shell with shell:true is worse: execFileSync joins args with
// spaces without quoting, so a path with a space splits into two args and `&`/`|`/`%`
// get interpreted by cmd.exe (command injection). cross-spawn resolves .cmd shims
// AND quotes args correctly, so use it for the win32 branch only; macOS/Linux keep
// the direct-exec path (no shell, faster, no shell-quoting surprises).
//
// Preserves execFileSync semantics: returns stdout (string when `encoding` is
// set), throws on non-zero exit (err.status set) or spawn error.
//
// `platform` is an injectable override (deps-object form, matching
// detectCloudDirs / runShell) so tests can force the win32 branch on any OS.
export function execCli(cmd, args, opts = {}, { platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return execFileSync(cmd, args, opts);
  }
  const { error, status, stdout, stderr } = spawn.sync(cmd, args, opts);
  if (error) {
    // Match execFileSync's spawn-error contract (err.status null, not
    // undefined) so callers branching on status behave the same on both
    // platforms.
    error.status = error.status ?? null;
    throw error;
  }
  if (status !== 0) {
    const err = new Error(
      `Command failed: ${cmd} ${args.join(' ')}` +
      (stderr ? `\n${stderr}` : '')
    );
    // Match execFileSync's non-zero-exit error shape: numeric status plus
    // stdout/stderr carried for diagnostics. (execFileSync does NOT set a
    // string `code` on non-zero exit — only on spawn failure like ENOENT — so
    // leaving code undefined keeps both branches identical.)
    err.status = status;
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  return stdout;
}
import { readConfig, remotePath } from './config.js';
import { prompt, promptYesNo, pickFromList } from './prompt.js';
import { createManifest, buildBundle, extractBundle, readManifest, writeManifest, hashFile, readPluginVersions, readPluginInstalls, pluginNameFromKey, pluginMarketplaceFromKey, indexPluginsByBareName, cacheSatisfiesVersion, alignRegistryToLocalCache } from './sync.js';
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
    const out = execCli('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
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
    execCli('npm', ['install', '-g', pkg], { stdio: 'inherit', timeout: 120000 });
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

export async function pullWorkflow(config, backend, { strategy = 'cover', pluginExec, pluginScriptDir } = {}) {
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
      if (doPlugins) await handlePlugins(manifest.plugins, claudeDir, { exec: pluginExec, scriptDir: pluginScriptDir });
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

export async function promptMemoryGlobalization(claudeDir, userHome, extractDir, memInfo, strategy = 'keep') {
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
    // Only grow the existing settings — never rebuild from {} which would wipe
    // every other key (env, model, statusLine, ...). If the local settings.json
    // is missing or unreadable, fall back to the bundle's copy so the file
    // written here keeps the full remote config plus autoMemoryDirectory.
    let base = settings;
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
      const bundleSettingsPath = path.join(extractDir, 'settings.json');
      try {
        if (fs.existsSync(bundleSettingsPath)) {
          base = JSON.parse(fs.readFileSync(bundleSettingsPath, 'utf-8'));
        }
      } catch {
        base = null;
      }
    }
    const updatedSettings = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
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

/**
 * Recursively replace home-prefix paths inside a parsed JSON value.
 * JSON strings are replaced at the value level so the written file stays
 * valid: on Windows targets the replacement path contains backslashes
 * (e.g. C:\Users\alice) which would otherwise corrupt the JSON string
 * escapes if we did a raw text substitution.
 */
function replacePathsInJson(value, sourceHome, targetHome) {
  if (typeof value === 'string') return replaceUserPath(value, sourceHome, targetHome);
  if (Array.isArray(value)) return value.map(v => replacePathsInJson(v, sourceHome, targetHome));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replacePathsInJson(v, sourceHome, targetHome);
    return out;
  }
  return value;
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
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (entry.name.endsWith('.json')) {
            // Parse first so backslashes in the target home cannot break the
            // JSON string escapes; a file that fails to parse is left untouched.
            const parsed = JSON.parse(content);
            const replaced = replacePathsInJson(parsed, sourceHome, targetHome);
            const out = JSON.stringify(replaced, null, 2);
            if (out !== content) {
              fs.writeFileSync(fullPath, out);
              log('verbose', `Path replaced in: ${path.relative(dir, fullPath)}`);
            }
          } else {
            const newContent = replaceUserPath(content, sourceHome, targetHome);
            if (newContent !== content) {
              fs.writeFileSync(fullPath, newContent);
              log('verbose', `Path replaced in: ${path.relative(dir, fullPath)}`);
            }
          }
        } catch {
          // bad JSON or binary/unreadable — skip unchanged
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

/**
 * keep-strategy merge: local values win, remote keys that are absent locally
 * are added. Nested plain objects recurse; arrays and scalars are left to the
 * local side. This makes "keep" a true fill-the-gaps merge for JSON config
 * files (settings.json, keybindings.json, ...) instead of skipping an existing
 * file entirely — which is how a stale settings.json survived every pull.
 */
function mergeJsonKeep(local, remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return local;
  for (const [k, v] of Object.entries(remote)) {
    if (!(k in local)) {
      local[k] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v) &&
               local[k] && typeof local[k] === 'object' && !Array.isArray(local[k])) {
      mergeJsonKeep(local[k], v);
    }
  }
  return local;
}

export function copyIfMissing(src, dest) {
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
    } else if (entry.name.endsWith('.json')) {
      // Existing JSON: field-level fill-the-gaps merge, never a blind skip.
      try {
        const local = JSON.parse(fs.readFileSync(destPath, 'utf-8'));
        const remote = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
        if (local && typeof local === 'object' && !Array.isArray(local) &&
            remote && typeof remote === 'object' && !Array.isArray(remote)) {
          const before = JSON.stringify(local);
          mergeJsonKeep(local, remote);
          if (JSON.stringify(local) !== before) {
            fs.writeFileSync(destPath, JSON.stringify(local, null, 2));
          }
        }
      } catch {
        // unparseable on either side — leave the local file untouched
      }
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
  // Manifest keys are "name@marketplace"; match local installs by bare name.
  const localByBare = indexPluginsByBareName(readPluginInstalls(path.join(claudeDir, 'plugins')));
  for (const [key, ver] of Object.entries(manifest.plugins || {})) {
    const local = localByBare[pluginNameFromKey(key)];
    const localVer = local?.version;
    if (!localVer) items.push(`plugin ${key} v${ver} (new)`);
    else if (local.cached === false) items.push(`plugin ${key} v${ver}: recorded but cache missing (pull will attempt reinstall)`);
    else if (localVer !== ver) items.push(`plugin ${key}: local v${localVer} → remote v${ver} (pull will not reinstall)`);
    else if (local.key !== key) items.push(`plugin ${key}: local ${local.key} remote ${key} (same version, different/no marketplace)`);
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
          execCli('git', ['clone', skill.remote, dest], { stdio: 'pipe', timeout: 60000 });
          if (skill.commit) {
            try { execCli('git', ['checkout', skill.commit], { cwd: dest, stdio: 'pipe', timeout: 10000 }); } catch {}
          }
          if (skill.hasPackageJson && fs.existsSync(path.join(dest, 'package.json'))) {
            try { execCli('npm', ['install'], { cwd: dest, stdio: 'pipe', timeout: 120000 }); } catch {}
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
        const localCommit = execCli('git', ['rev-parse', 'HEAD'], {
          cwd: dest, encoding: 'utf-8', timeout: 5000
        }).trim();
        if (localCommit !== skill.commit && strategy === 'cover') {
          log('info', `Updating git skill '${skill.name}' to commit ${skill.commit.substring(0, 8)}...`);
          try { execCli('git', ['fetch', 'origin'], { cwd: dest, stdio: 'pipe', timeout: 30000 }); } catch {}
          try { execCli('git', ['checkout', skill.commit], { cwd: dest, stdio: 'pipe', timeout: 10000 }); } catch {}
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
        execCli('npx', ['skills', 'add', skill.source], { stdio: 'pipe', timeout: 60000 });
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

/** How long a failed-claim attempt stays blocking before the next pull retries. */
const INSTALL_ATTEMPTS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Read the recorded-unreachable reinstall claims for this machine, or {} when none. */
function readInstallAttempts(installAttemptsPath) {
  try {
    return JSON.parse(fs.readFileSync(installAttemptsPath, 'utf-8')) || {};
  } catch {
    return {};
  }
}

/** Persist the reinstall-attempt map. Failures are logged, never thrown. */
function writeInstallAttempts(installAttemptsPath, attempts) {
  try {
    const next = JSON.stringify(attempts, null, 2);
    let prev = null;
    try { prev = fs.readFileSync(installAttemptsPath, 'utf-8'); } catch {}
    if (prev === next) return; // nothing changed — don't touch the file
    fs.writeFileSync(installAttemptsPath, next);
  } catch (e) {
    log('info', `Could not write reinstall-attempt state (${e.message}) — a cache-missing plugin may reinstall on the next pull.`);
  }
}

export async function handlePlugins(plugins, claudeDir, { exec = execCli, scriptDir = path.join(os.homedir(), '.claude-sync-bundle') } = {}) {
  // Claude Code cannot pin a plugin version (`@` separates plugin@marketplace,
  // not version), so a version mismatch is only reported, never reinstalled —
  // reinstalling would silently upgrade the local plugin to whatever the
  // marketplace catalog currently points at.
  const pluginsDir = path.join(claudeDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
  const localPluginsPath = path.join(pluginsDir, 'installed_plugins.json');

  // Reinstall attempts that could not reach the claimed version. A cover pull
  // restores the source's registry record every time, so if this machine's
  // marketplace catalog can't supply the claimed version (the source's catalog
  // is newer), a naive reinstall would loop on every pull. Record the failed
  // claim here and cool down before retrying. The file lives in claudeDir (not
  // plugins/) and push only stages listed files/dirs, so it never leaks into a
  // bundle — it is local machine state, like the cache it describes. Deliberately
  // has NO `.json` suffix: runStatus treats every `*.json` in claudeDir as a
  // tracked file, and an attempts file with a suffix would show up as a permanent
  // "local only" difference.
  const installAttemptsPath = path.join(claudeDir, '.claude-sync-install-attempts');
  const installAttempts = readInstallAttempts(installAttemptsPath);

  // Local installed set, keyed by bare plugin name. Manifest keys are
  // "name@marketplace"; match locally by the stripped name. Uses install
  // records so a registry entry whose cached files are gone (restore dropped
  // the cache dir) is not treated as installed.
  const localPlugins = indexPluginsByBareName(readPluginInstalls(pluginsDir));

  const toInstall = [];
  const hints = [];

  for (const [key, version] of Object.entries(plugins)) {
    const bare = pluginNameFromKey(key);
    const hasMarketplace = pluginMarketplaceFromKey(key) !== null;
    const localVer = localPlugins[bare]?.version;

    // A genuinely-present install clears any recorded unreachable claim, so a
    // later cache drop can retry instead of being blocked by stale state (a
    // manual install that satisfied the claim must not leave a veto behind).
    if (installAttempts[key] && localPlugins[bare]?.cached === true) {
      delete installAttempts[key];
    }

    if (!hasMarketplace) {
      // Legacy manifest: no marketplace recorded. A bare `claude plugin install
      // <name>` lets CC resolve the default marketplace, which is where most
      // legacy-bundle plugins came from — so try it rather than punting. A
      // failed default-marketplace install lands in the fallback script.
      if (localVer !== undefined) {
        hints.push(`plugin '${key}' already installed (v${localVer}); legacy manifest records no marketplace — skipping`);
      } else {
        log('info', `  ${key}: not installed; legacy manifest records no marketplace — attempting default-marketplace install`);
        toInstall.push({ key, version, installTarget: bare });
      }
      continue;
    }

    if (localVer === undefined) {
      toInstall.push({ key, version });
    } else if (localPlugins[bare]?.cached === false) {
      // Registry records the plugin but its files are gone — a restore that
      // dropped the cache directory, or a partial install. Leaving it alone
      // would keep the plugin permanently broken while status/diff claim it is
      // in sync, so treat it as not installed and reinstall it.
      if (installAttempts[key]?.version === version) {
        // A previous pull tried to reach this claim and the catalog couldn't
        // supply it (recorded post-install below). Retrying would reinstall on
        // every cover pull, so cool down — but not forever: if the catalog later
        // catches up, the TTL expiry lets this pull retry and converge.
        const triedAt = Date.parse(installAttempts[key].at);
        const now = Date.now();
        // A future timestamp (clock skew, hand-edited file) must not extend the
        // cooldown — treat it as expired so the plugin can be retried.
        const cooling = !Number.isNaN(triedAt) && triedAt <= now && now - triedAt < INSTALL_ATTEMPTS_TTL_MS;
        if (cooling) {
          hints.push(`plugin '${key}' recorded but cache missing; already tried v${version} within the past 7 days and the marketplace cannot satisfy it — skipping (install it manually)`);
        } else {
          log('info', `  ${key}: recorded locally but cache missing (${localPlugins[bare].installPath}) — reinstalling (earlier attempt expired)`);
          toInstall.push({ key, version });
        }
      } else {
        log('info', `  ${key}: recorded locally but cache missing (${localPlugins[bare].installPath}) — reinstalling`);
        toInstall.push({ key, version });
      }
    } else if (localVer !== version) {
      // Version differs but the plugin is already installed — leave it alone.
      // Reinstalling would fetch the marketplace's current version, not the
      // manifest's.
      hints.push(`plugin '${key}' version differs: local v${localVer} vs manifest v${version} — skipped (reinstall would fetch the marketplace's current version)`);
    } else if (localPlugins[bare]?.key !== key) {
      // Same name and version, but installed from a different marketplace. The
      // plugin is present, so never reinstall — but surface the divergence or
      // the wrong-marketplace install silently persists (and re-pushes it).
      hints.push(`plugin '${bare}' already installed as '${localPlugins[bare].key}' but manifest records '${key}' — skipped (same version, different marketplace)`);
    }
    // localVer === version && same marketplace → nothing to do
  }

  const failedOps = [];
  // Successful installs only — failed ones must NOT be recorded in
  // installed_plugins.json, or the next sync would think the target version is
  // already in place and never retry. (A failed op is surfaced via the fallback
  // script + log; the file stays truthful about what is actually installed.)
  const applied = [];

  if (toInstall.length > 0) {
    log('info', `Installing ${toInstall.length} plugin(s)...`);
    for (const { key, version, installTarget } of toInstall) {
      const target = installTarget || key;
      try {
        log('info', `  Installing ${key} (manifest v${version})...`);
        // Normally "name@marketplace" — pass it through verbatim. Claude Code's
        // `@` separates the plugin name from the marketplace, NOT a version.
        // Legacy bare keys carry installTarget (the bare name) so CC resolves
        // the default marketplace itself.
        exec('claude', ['plugin', 'install', target], { stdio: 'pipe', timeout: 60000 });
        log('info', `  ✓ ${key} installed`);
        // installTarget survives into `applied` so the reinstall-attempt sweep
        // can skip bare (default-marketplace) installs, which sit outside the
        // semver-claim mechanism.
        applied.push({ key, version, installTarget });
      } catch (e) {
        log('info', `  ✗ ${key} install failed: ${e.message}.`);
        failedOps.push(`claude plugin install ${target}`);
      }
    }
  }

  // Record which claims the marketplace could not satisfy, so the next cover
  // pull doesn't reinstall them (the source's registry is restored each time,
  // recreating the cache-miss verdict). Claims that converged are cleared.
  // Bare (legacy, default-marketplace) installs sit outside the semver-claim
  // mechanism — they are retried normally on each pull, never blocked.
  for (const { key, version, installTarget } of applied) {
    if (installTarget) continue;
    if (cacheSatisfiesVersion(pluginsDir, key, version, localPlugins[pluginNameFromKey(key)]?.installPath)) {
      delete installAttempts[key];
    } else {
      installAttempts[key] = { version, at: new Date().toISOString() };
    }
  }
  writeInstallAttempts(installAttemptsPath, installAttempts);

  for (const hint of hints) log('info', hint);

  // Generate fallback script for failed operations
  if (failedOps.length > 0) {
    // Use BUNDLE_DIR rather than deriving from claudeDir
    if (!fs.existsSync(scriptDir)) fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'install-plugins.sh');
    const scriptContent = `#!/bin/sh\n# Generated by claude-sync — run to install failed plugins\n\n${failedOps.join('\n')}\n`;
    fs.writeFileSync(scriptPath, scriptContent);
    try { fs.chmodSync(scriptPath, 0o755); } catch {}
    log('info', `Generated plugin install script: ${scriptPath}`);
    log('info', `Run it manually to complete ${failedOps.length} failed operation(s).`);
  }

  // Update installed_plugins.json preserving CC format. Re-read the file AFTER
  // the install loop: `claude plugin install` rewrites this file itself
  // (name@marketplace keys), so the pre-loop snapshot would clobber those fresh
  // writes with stale data. Read the current content, then merge only the
  // entries this run installed.
  let currentPluginsData = { version: 2, plugins: {} };
  if (fs.existsSync(localPluginsPath)) {
    try { currentPluginsData = JSON.parse(fs.readFileSync(localPluginsPath, 'utf-8')); } catch {}
  }
  if (currentPluginsData && currentPluginsData.plugins && typeof currentPluginsData.plugins === 'object') {
    // CC format: { version: 2, plugins: { "name@marketplace": [...] } }
    // applied keys are already "name@marketplace". `claude plugin install` also
    // rewrites this file itself with the REAL installed record (actual version,
    // scope, lastUpdated). If it already wrote an entry for a key we installed,
    // keep that record — overwriting it with the manifest version would drop
    // scope/lastUpdated and blind version hints to real catalog drift. Only fill
    // in keys the CLI didn't write (e.g. a mocked/absent claude).
    for (const { key, version } of applied) {
      // Match by bare name, not exact key: a legacy bare install makes CC write
      // the resolved "name@marketplace" record itself. Without the bare-name
      // match, this run would append a second, non-standard bare key alongside
      // it — one plugin, two records, both re-pushed and re-installed downstream.
      const existing = Object.keys(currentPluginsData.plugins)
        .find(k => pluginNameFromKey(k) === pluginNameFromKey(key));
      if (!existing) {
        currentPluginsData.plugins[key] = [{ version, installedAt: new Date().toISOString() }];
      }
    }
    fs.writeFileSync(localPluginsPath, JSON.stringify(currentPluginsData, null, 2));
  } else {
    // Legacy flat format: merge over the current content and write flat,
    // keeping the full key so the marketplace survives into the next push.
    // currentPluginsData already holds the file content (or {} for a null/
    // missing file), so reuse it instead of re-reading.
    let merged = (typeof currentPluginsData === 'object' && currentPluginsData !== null && !Array.isArray(currentPluginsData))
      ? currentPluginsData : {};
    for (const { key, version } of applied) merged[key] = version;
    fs.writeFileSync(localPluginsPath, JSON.stringify(merged, null, 2));
  }

  // A cover pull restores the source's registry record verbatim (claimed
  // version + source installPath). Plugins that were NOT reinstalled this run —
  // already present at a drifted version, SHA-cached, or a TTL-cooled claim —
  // keep that record with a dangling installPath, and CC's panel then reports
  // "not cached at <claimed version>" even though the plugin is installed and
  // usable. Point such records at the actual cached dir/version so the panel
  // resolves and status reports the true local version (review finding: the
  // first pull "worked" only because a reinstall made the CLI rewrite the
  // record; every subsequent cover pull re-broke it).
  alignRegistryToLocalCache(pluginsDir);
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
