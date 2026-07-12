/**
 * Push/pull workflow orchestrator for claude-sync.
 * Wires together all lib modules for the full sync flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import * as readline from 'node:readline';
import { readConfig } from './config.js';
import { createManifest, buildBundle, extractBundle, readManifest, writeManifest, hashFile } from './sync.js';
import { stripSecrets, findSecretFields, isStripped } from './secrets.js';
import { replaceUserPath, getHomePrefix } from './paths.js';
import { detectSkills } from './detect.js';
import { log, initLogging } from './retry.js';

const STATE_FILE = path.join(os.homedir(), '.claude-sync-bundle', 'state.json');
const SUPPORTED_MANIFEST_VERSION = 1;

// --- Interactive prompt utility ---
function promptYesNo(question, defaultYes = true) {
  if (!process.stdin.isTTY) {
    log('verbose', `Non-interactive: skipping prompt "${question}" (default: ${defaultYes ? 'yes' : 'no'})`);
    return Promise.resolve(defaultYes);
  }
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  return prompt(question + suffix).then(a => {
    const lower = a.toLowerCase();
    if (lower === 'y' || lower === 'yes') return true;
    if (lower === 'n' || lower === 'no') return false;
    return defaultYes;
  });
}

function prompt(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ===================================================================
// PUSH WORKFLOW
// ===================================================================

export async function pushWorkflow(config, backend, { force = false } = {}) {
  const claudeDir = config.CLAUDE_DIR;
  const bundleDir = config.BUNDLE_DIR;
  const homeDir = path.dirname(claudeDir);
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
      await backend.download(`${config.REMOTE}/manifest.json`, tempManifest);
      const remoteManifest = readManifest(tempManifest);
      try { fs.unlinkSync(tempManifest); } catch {}

      if (remoteManifest) {
        const state = readState();
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
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // Copy config files to staging (A: direct sync)
  const configFiles = ['settings.json', 'settings.local.json', 'keybindings.json'];
  for (const file of configFiles) {
    const src = path.join(claudeDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(stageDir, file));
    }
  }

  // CLAUDE.md from ~/ and ~/.claude/ (preserve both if they exist)
  const homeClaudeMd = path.join(homeDir, 'CLAUDE.md');
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
  const agentsDir = path.join(homeDir, '.agents');
  if (fs.existsSync(skillsDir)) {
    fs.cpSync(skillsDir, path.join(stageDir, 'skills'), { recursive: true });
  }

  // Copy shared-memory (with interactive prompt if not yet configured)
  const settings = readSettings(claudeDir);
  let autoMemDir = settings?.autoMemoryDirectory;

  if (!autoMemDir) {
    // Ask user if they want to enable memory globalization
    const shouldEnable = await promptYesNo(
      'Memory is currently per-project. Enable global memory sync across machines?'
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
      const resolvedMem = path.join(homeDir, '.claude', 'shared-memory');
      if (!fs.existsSync(resolvedMem)) fs.mkdirSync(resolvedMem, { recursive: true });
      const projectsDir = path.join(claudeDir, 'projects');
      if (fs.existsSync(projectsDir)) {
        migrateMemoryToShared(projectsDir, resolvedMem);
      }
    }
  }

  if (autoMemDir) {
    const resolvedMem = autoMemDir.replace(/^~/, homeDir);
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
  for (const file of ['settings.json', 'settings.local.json', 'keybindings.json']) {
    const fp = path.join(stageDir, file);
    if (fs.existsSync(fp)) hashes[file] = hashFile(fp);
  }
  for (const f of ['CLAUDE_home.md', 'CLAUDE_claude.md']) {
    const fp = path.join(stageDir, f);
    if (fs.existsSync(fp)) hashes[f] = hashFile(fp);
  }

  // 5. Detect skills
  const pushSkills = detectSkills(path.join(stageDir, 'skills'), agentsDir);

  // 6. Extract mcpServers
  const mcpServers = extractMcpServers(homeDir);

  // 7. Memory metadata
  let memory = null;
  if (settings?.autoMemoryDirectory) {
    const resolvedMem = settings.autoMemoryDirectory.replace(/^~/, homeDir);
    memory = {
      auto_memory_directory: settings.autoMemoryDirectory,
      topic_count: countMemoryTopics(resolvedMem)
    };
  }

  // 8. Read plugin versions
  const plugins = readPluginVersions(stageDir);

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
      memory
    },
    { machineId: config.MACHINE_ID, sourceUser: os.userInfo().username, sourceHome: homeDir }
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
  await buildBundle(stageDir, bundlePath);

  // Clean up staging
  fs.rmSync(stageDir, { recursive: true, force: true });

  // 14. Upload
  if (config.BACKEND !== 'manual') {
    log('info', 'Uploading to remote...');
    await backend.upload(bundlePath, `${config.REMOTE}/bundle.tar.gz`);
    await backend.upload(manifestPath, `${config.REMOTE}/manifest.json`);
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
  const homeDir = path.dirname(claudeDir);
  const secretsMode = config.SECRETS || 'keep';

  initLogging(path.join(bundleDir, 'sync.log'));
  log('info', `Pull started on ${config.MACHINE_ID}`);

  // 1. Read manifest
  const localManifestPath = path.join(bundleDir, 'manifest.json');
  let manifest;

  try {
    if (config.BACKEND !== 'manual') {
      await backend.download(`${config.REMOTE}/manifest.json`, localManifestPath);
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

  // 2. Download bundle
  const bundlePath = path.join(bundleDir, 'bundle.tar.gz');
  try {
    if (config.BACKEND !== 'manual') {
      await backend.download(`${config.REMOTE}/bundle.tar.gz`, bundlePath);
    }
    if (!fs.existsSync(bundlePath)) {
      throw new Error('Bundle file not found.');
    }
  } catch {
    throw new Error('Failed to download bundle.');
  }

  // 3. Backup current .claude
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(homeDir, `.claude.backup.${timestamp}`);
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
  const sourceHome = manifest.source_home || getHomePrefix(`/Users/${manifest.source_user}`);
  const targetHome = homeDir;
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

  // 7. Merge configs
  if (strategy !== 'dry-run') {
    mergeExtractedConfig(extractDir, claudeDir, homeDir, strategy, secretsMode);
  } else {
    log('info', 'Dry run — no changes applied. Showing what would change...');
    showDiff(extractDir, claudeDir, manifest);
  }

  // 8-12: All write operations — skip in dry-run mode
  if (strategy !== 'dry-run') {
    // 8. Merge mcpServers into ~/.claude.json
    if (manifest.mcp_servers && manifest.mcp_servers.length > 0) {
      mergeMcpServers(homeDir, manifest.mcp_servers, strategy);
    }

    // 9. Restore skills
    const skillsDir = path.join(claudeDir, 'skills');
    if (manifest.skills) {
      await restoreSkills(manifest.skills, claudeDir, skillsDir, extractDir, strategy, sourceHome, targetHome);
    }

    // 10. Handle plugins
    if (manifest.plugins) {
      await handlePlugins(manifest.plugins, claudeDir, strategy);
    }

    // 11. statusLine path detection
    checkStatusLinePaths(claudeDir);

    // 12. Save pull state
    saveState({
      last_pull_at: new Date().toISOString(),
      last_pull_manifest: manifest
    });
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

function extractMcpServers(homeDir) {
  try {
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      return data.mcpServers ? Object.keys(data.mcpServers) : [];
    }
  } catch (e) {
    log('verbose', `Could not read mcpServers: ${e.message}`);
  }
  return [];
}

function mergeMcpServers(homeDir, mcpServerNames, strategy) {
  const claudeJsonPath = path.join(homeDir, '.claude.json');

  let claudeJson = {};
  if (fs.existsSync(claudeJsonPath)) {
    try {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    } catch {
      claudeJson = {};
    }
  }

  if (strategy === 'keep') {
    // Only add mcpServers that don't exist yet
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
    for (const name of mcpServerNames) {
      if (!claudeJson.mcpServers[name]) {
        claudeJson.mcpServers[name] = { _pending: true }; // placeholder, user fills in config
      }
    }
  } else {
    // cover: merge all from manifest
    // We only have server NAMES in the manifest (no config values for security)
    // So we can't fully restore mcpServers — just note which ones should exist
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
    for (const name of mcpServerNames) {
      if (!claudeJson.mcpServers[name]) {
        claudeJson.mcpServers[name] = { _pending: true };
      }
    }
  }

  // Preserve machine-specific fields
  fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
  log('verbose', `Merged ${mcpServerNames.length} mcpServer(s) into .claude.json`);
}

function readSettings(claudeDir) {
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

function readPluginVersions(dir) {
  try {
    const pluginsPath = path.join(dir, 'plugins', 'installed_plugins.json');
    if (fs.existsSync(pluginsPath)) {
      const raw = JSON.parse(fs.readFileSync(pluginsPath, 'utf-8'));
      // CC format: { version: 2, plugins: { "name@marketplace": [{ version, ... }] } }
      if (raw.plugins && typeof raw.plugins === 'object') {
        const result = {};
        for (const [key, entries] of Object.entries(raw.plugins)) {
          const name = key.split('@')[0];
          const latest = Array.isArray(entries) ? entries[entries.length - 1] : entries;
          result[name] = latest?.version || 'unknown';
        }
        return result;
      }
      // Legacy flat format: { "name": "version" }
      return raw;
    }
  } catch {
    // no plugins
  }
  return {};
}

function migrateMemoryToShared(projectsDir, sharedDir) {
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

function countMemoryTopics(memDir) {
  try {
    if (fs.existsSync(memDir)) {
      return fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').length;
    }
  } catch {
    // unreadable
  }
  return 0;
}

function applyPathReplacement(dir, sourceHome, targetHome) {
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

function mergeExtractedConfig(extractDir, claudeDir, homeDir, strategy, secretsMode) {
  if (strategy === 'cover') {
    // Save local env values BEFORE overwriting (protect real secrets in strip mode)
    let savedEnv = {};
    const localSettingsPath = path.join(claudeDir, 'settings.json');
    if (secretsMode === 'strip' && fs.existsSync(localSettingsPath)) {
      try {
        const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
        if (localSettings.env) savedEnv = localSettings.env;
      } catch {}
    }

    copyDirContents(extractDir, claudeDir);

    // Restore local env values where bundle has *** placeholders
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
    return;
  }

  // keep strategy: only add files/fields that don't exist on target
  copyIfMissing(extractDir, claudeDir);
}

function resolveSymlinksInDir(dir) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath);
        if (lstat.isDirectory()) {
          // Directory symlink: copy actual directory contents, then replace symlink with real dir
          const tmpDir = fullPath + '.tmp';
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
          fs.cpSync(fullPath, tmpDir, { recursive: true, dereference: true });
          fs.unlinkSync(fullPath);
          fs.renameSync(tmpDir, fullPath);
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
        resolveSymlinksInDir(fullPath);
      }
    } catch (e) {
      log('verbose', `Could not dereference ${entry.name}: ${e.message}`);
    }
  }
}

function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  try {
    // Use cpSync with dereference to handle symlinks properly
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      const lstat = fs.lstatSync(srcPath);
      if (lstat.isSymbolicLink()) {
        // Dereference symlinks: copy the actual content, not the link
        try {
          if (lstat.isDirectory()) {
            fs.cpSync(srcPath, destPath, { recursive: true, dereference: true });
          } else {
            const content = fs.readFileSync(srcPath);
            fs.writeFileSync(destPath, content);
          }
        } catch (e) {
          log('verbose', `Skipped symlink ${entry}: ${e.message}`);
        }
      } else if (lstat.isDirectory()) {
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        copyDirContents(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  } catch (e) {
    log('verbose', `copyDirContents fallback: ${e.message}`);
    // Fallback: use cpSync for the whole directory
    fs.cpSync(src, dest, { recursive: true, dereference: true, force: true });
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
  // Git skills: auto-clone if remote is available
  for (const skill of (skillsManifest.git || [])) {
    const dest = path.join(skillsDir, skill.name);
    if (!fs.existsSync(dest) || strategy === 'cover') {
      if (skill.remote) {
        try {
          log('info', `Cloning git skill '${skill.name}' from ${skill.remote}...`);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
          execSync(`git clone ${skill.remote} "${dest}"`, { stdio: 'pipe', timeout: 60000 });
          if (skill.commit) {
            try { execSync(`git checkout ${skill.commit}`, { cwd: dest, stdio: 'pipe', timeout: 10000 }); } catch {}
          }
          if (skill.hasPackageJson && fs.existsSync(path.join(dest, 'package.json'))) {
            try { execSync('npm install', { cwd: dest, stdio: 'pipe', timeout: 120000 }); } catch {}
          }
          log('info', `Git skill '${skill.name}' cloned and ready.`);
        } catch (e) {
          log('info', `Git skill '${skill.name}' clone failed: ${e.message}. Clone manually.`);
        }
      } else {
        log('info', `Git skill '${skill.name}': no remote recorded. Clone manually.`);
      }
    }
  }

  // skills.sh skills: auto-restore via npx skills add
  for (const skill of (skillsManifest.skills_sh || [])) {
    if (skill.source) {
      try {
        log('info', `Restoring skills.sh skill '${skill.name}'...`);
        execSync(`npx skills add ${skill.source}`, { stdio: 'pipe', timeout: 60000 });
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

async function handlePlugins(plugins, claudeDir, strategy) {
  const pluginsDir = path.join(claudeDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  const localPluginsPath = path.join(pluginsDir, 'installed_plugins.json');
  let localPlugins = {};
  if (fs.existsSync(localPluginsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(localPluginsPath, 'utf-8'));
      // Handle CC format { plugins: { "name@marketplace": [...] } }
      if (raw.plugins && typeof raw.plugins === 'object') {
        for (const [key, entries] of Object.entries(raw.plugins)) {
          const name = key.split('@')[0];
          const latest = Array.isArray(entries) ? entries[entries.length - 1] : entries;
          localPlugins[name] = latest?.version || 'unknown';
        }
      } else {
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

  if (toInstall.length > 0) {
    log('info', `Installing ${toInstall.length} plugin(s)...`);
    for (const { name, version } of toInstall) {
      try {
        log('info', `  Installing ${name}@${version}...`);
        execSync(`claude plugin install ${name}@${version}`, { stdio: 'pipe', timeout: 60000 });
        log('info', `  ✓ ${name}@${version} installed`);
      } catch (e) {
        log('info', `  ✗ ${name}@${version} install failed: ${e.message}. Install manually.`);
      }
    }
  }

  if (toUpdate.length > 0) {
    log('info', `Updating ${toUpdate.length} plugin(s)...`);
    for (const { name, version } of toUpdate) {
      try {
        log('info', `  Updating ${name}: ${version}...`);
        try { execSync(`claude plugin uninstall ${name}`, { stdio: 'pipe', timeout: 30000 }); } catch {}
        execSync(`claude plugin install ${name}@${version}`, { stdio: 'pipe', timeout: 60000 });
        log('info', `  ✓ ${name} updated to ${version}`);
      } catch (e) {
        log('info', `  ✗ ${name} update failed: ${e.message}. Update manually.`);
      }
    }
  }

  // Update installed_plugins.json with merged list
  const merged = { ...localPlugins };
  for (const { name, version } of toInstall) merged[name] = version;
  for (const { name, version } of toUpdate) merged[name] = version;
  fs.writeFileSync(localPluginsPath, JSON.stringify(merged, null, 2));
}

function checkStatusLinePaths(claudeDir) {
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

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // unreadable
  }
  return null;
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const existing = readState() || {};
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...existing, ...state }, null, 2));
}
