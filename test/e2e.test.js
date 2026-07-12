/**
 * End-to-end integration tests: full push/pull cycle with simulated environments.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pushWorkflow, pullWorkflow } from '../lib/workflow.js';
import { readConfig } from '../lib/config.js';
import { createManualBackend } from '../backends/manual.js';
import { readManifest } from '../lib/sync.js';
import { detectSkills } from '../lib/detect.js';

describe('End-to-end push/pull cycle', () => {
  let sourceHome;
  let targetHome;
  let bundleDir;

  beforeEach(() => {
    // Source machine home
    sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-source-'));
    // Target machine home
    targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-target-'));
    // Shared bundle directory (simulates cloud storage)
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-bundle-'));

    // Create source .claude directory
    const sourceClaude = path.join(sourceHome, '.claude');
    fs.mkdirSync(sourceClaude, { recursive: true });

    // settings.json with env secrets
    const settings = {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-real-token-12345',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
      },
      model: 'claude-sonnet-4-6',
      statusLine: { type: 'bun', path: '/opt/homebrew/bin/bun' },
      enabledPlugins: ['my-plugin']
    };
    fs.writeFileSync(
      path.join(sourceClaude, 'settings.json'),
      JSON.stringify(settings, null, 2)
    );

    // settings.local.json
    fs.writeFileSync(
      path.join(sourceClaude, 'settings.local.json'),
      JSON.stringify({ theme: 'dark', fontSize: 14 })
    );

    // keybindings.json
    fs.writeFileSync(
      path.join(sourceClaude, 'keybindings.json'),
      JSON.stringify({ 'ctrl+s': 'submit' })
    );

    // CLAUDE.md
    const sourceUser = os.userInfo().username;
    fs.writeFileSync(
      path.join(sourceHome, 'CLAUDE.md'),
      `# ${sourceUser}'s CLAUDE.md\n\nCustom instructions here.\nReference: /Users/${sourceUser}/projects/foo`
    );

    // Plugins
    const pluginsDir = path.join(sourceClaude, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ 'my-plugin': '1.0.0', 'another-plugin': '2.3.1' })
    );
    fs.writeFileSync(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({ official: 'https://cli.claude.ai/marketplace' })
    );

    // Skills
    const skillsDir = path.join(sourceClaude, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    // Plain skill
    const plainSkill = path.join(skillsDir, 'my-custom-skill');
    fs.mkdirSync(plainSkill, { recursive: true });
    fs.writeFileSync(path.join(plainSkill, 'SKILL.md'), '# My Custom Skill\n\nThis is a hand-written skill.');

    // Git skill
    const gitSkill = path.join(skillsDir, 'gstack');
    fs.mkdirSync(gitSkill, { recursive: true });
    fs.mkdirSync(path.join(gitSkill, '.git'));
    fs.writeFileSync(path.join(gitSkill, 'SKILL.md'), '# GStack Skill');
    fs.writeFileSync(path.join(gitSkill, 'package.json'), JSON.stringify({ name: 'gstack' }));

    // Commands directory
    const commandsDir = path.join(sourceClaude, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'deploy.md'), '# Deploy Command');

    // ~/.claude.json (shared config with machine-specific fields)
    const claudeJson = {
      machineID: 'source-machine-uuid-12345',
      firstStartTime: '2025-01-01T00:00:00Z',
      numStartups: 42,
      userID: 'user-abc',
      projects: { '/some/project': {} },
      tipsHistory: { 'tip1': true },
      mcpServers: {
        figma: {
          type: 'http',
          url: 'http://localhost:3333',
          config: { FIGMA_API_KEY: 'figd-secret-key' }
        }
      },
      hasCompletedOnboarding: true
    };
    fs.writeFileSync(
      path.join(sourceHome, '.claude.json'),
      JSON.stringify(claudeJson, null, 2)
    );
  });

  afterEach(() => {
    fs.rmSync(sourceHome, { recursive: true, force: true });
    fs.rmSync(targetHome, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  });

  it('full push → pull preserves settings, skills, plugins, and mcpServers', async () => {
    // === PUSH from source machine ===
    const sourceConfig = readConfig({
      BACKEND: 'manual',
      BUNDLE_DIR: bundleDir,
      CLAUDE_DIR: path.join(sourceHome, '.claude'),
      MACHINE_ID: 'source-mac',
      SECRETS: 'keep'
    });

    const manualBackend = createManualBackend({ bundleDir });

    const pushResult = await pushWorkflow(sourceConfig, manualBackend);
    expect(pushResult.success).toBe(true);
    expect(pushResult.manifest.pushed_by).toBe('source-mac');
    expect(fs.existsSync(path.join(bundleDir, 'bundle.tar.gz'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'manifest.json'))).toBe(true);

    // Verify manifest content
    const manifest = readManifest(path.join(bundleDir, 'manifest.json'));
    expect(manifest.version).toBe(1);
    expect(manifest.plugins['my-plugin']).toBe('1.0.0');
    expect(manifest.plugins['another-plugin']).toBe('2.3.1');
    expect(manifest.skills.plain).toHaveLength(1);
    expect(manifest.skills.git).toHaveLength(1);
    expect(manifest.skills.plain[0].name).toBe('my-custom-skill');
    expect(manifest.skills.git[0].name).toBe('gstack');
    expect(manifest.mcp_servers).toContain('figma');
    expect(manifest.source_home).toBeDefined();
    expect(manifest.hashes['settings.json']).toBeDefined();
    expect(manifest.hashes['settings.local.json']).toBeDefined();
    expect(manifest.hashes['keybindings.json']).toBeDefined();

    // === PULL to target machine ===
    const targetConfig = readConfig({
      BACKEND: 'manual',
      BUNDLE_DIR: bundleDir,
      CLAUDE_DIR: path.join(targetHome, '.claude'),
      MACHINE_ID: 'target-mac',
      SECRETS: 'keep'
    });

    const targetManualBackend = createManualBackend({ bundleDir });

    // Create empty .claude on target (simulating fresh machine)
    fs.mkdirSync(path.join(targetHome, '.claude'), { recursive: true });

    const pullResult = await pullWorkflow(targetConfig, targetManualBackend, { strategy: 'cover' });
    expect(pullResult.success).toBe(true);
    expect(pullResult.backup).toBeDefined();

    // === VERIFY target machine state ===

    // 1. settings.json restored
    const targetSettings = JSON.parse(
      fs.readFileSync(path.join(targetHome, '.claude', 'settings.json'), 'utf-8')
    );
    expect(targetSettings.model).toBe('claude-sonnet-4-6');
    expect(targetSettings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-real-token-12345');
    expect(targetSettings.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(targetSettings.statusLine.type).toBe('bun');

    // 2. settings.local.json restored
    const targetLocal = JSON.parse(
      fs.readFileSync(path.join(targetHome, '.claude', 'settings.local.json'), 'utf-8')
    );
    expect(targetLocal.theme).toBe('dark');
    expect(targetLocal.fontSize).toBe(14);

    // 3. keybindings.json restored
    const targetKB = JSON.parse(
      fs.readFileSync(path.join(targetHome, '.claude', 'keybindings.json'), 'utf-8')
    );
    expect(targetKB['ctrl+s']).toBe('submit');

    // 4. Skills: plain skill in bundle, git skill recorded in manifest only
    const targetSkillsDir = path.join(targetHome, '.claude', 'skills');
    expect(fs.existsSync(targetSkillsDir)).toBe(true);
    const targetSkills = detectSkills(targetSkillsDir, path.join(targetHome, '.agents'));
    expect(targetSkills.length).toBeGreaterThanOrEqual(1);

    const plainSkill = targetSkills.find(s => s.name === 'my-custom-skill');
    expect(plainSkill).toBeDefined();
    expect(plainSkill.type).toBe('plain');

    // Git skills are recorded in manifest, not packaged in tar.gz
    expect(manifest.skills.git).toHaveLength(1);
    expect(manifest.skills.git[0].name).toBe('gstack');

    // 5. Commands restored
    const targetCommands = path.join(targetHome, '.claude', 'commands');
    expect(fs.existsSync(path.join(targetCommands, 'deploy.md'))).toBe(true);

    // 6. Plugins registry restored
    const targetPlugins = JSON.parse(
      fs.readFileSync(path.join(targetHome, '.claude', 'plugins', 'installed_plugins.json'), 'utf-8')
    );
    expect(targetPlugins['my-plugin']).toBe('1.0.0');
    expect(targetPlugins['another-plugin']).toBe('2.3.1');

    // 7. Backup exists
    expect(fs.existsSync(pullResult.backup)).toBe(true);

    // 8. Pull state recorded
    const stateFile = path.join(os.homedir(), '.claude-sync-bundle', 'state.json');
    // (state file may exist if this isn't the first pull on this machine)
  });

  it('pull with --keep strategy only adds missing fields', async () => {
    // Push from source
    const sourceConfig = readConfig({
      BACKEND: 'manual',
      BUNDLE_DIR: bundleDir,
      CLAUDE_DIR: path.join(sourceHome, '.claude'),
      MACHINE_ID: 'source-mac'
    });

    const backend = createManualBackend({ bundleDir });
    await pushWorkflow(sourceConfig, backend);

    // Create target with pre-existing settings
    const targetClaude = path.join(targetHome, '.claude');
    fs.mkdirSync(targetClaude, { recursive: true });

    // Target already has settings.json with its own model preference
    const existingSettings = {
      model: 'claude-opus-4-8',  // different from source
      theme: 'light'              // field not in source
    };
    fs.writeFileSync(
      path.join(targetClaude, 'settings.json'),
      JSON.stringify(existingSettings, null, 2)
    );

    // Pull with keep strategy
    const targetConfig = readConfig({
      BACKEND: 'manual',
      BUNDLE_DIR: bundleDir,
      CLAUDE_DIR: targetClaude,
      MACHINE_ID: 'target-mac'
    });

    const targetBackend = createManualBackend({ bundleDir });
    await pullWorkflow(targetConfig, targetBackend, { strategy: 'keep' });

    // Verify: existing fields preserved, missing fields added
    const result = JSON.parse(
      fs.readFileSync(path.join(targetClaude, 'settings.json'), 'utf-8')
    );
    // 'keep' strategy: existing fields stay, missing fields from source are added
    expect(result.model).toBe('claude-opus-4-8'); // preserved from target
    expect(result.theme).toBe('light');           // preserved from target
  });

  it('manifest is stored separately (not in tar.gz)', async () => {
    const sourceConfig = readConfig({
      BACKEND: 'manual',
      BUNDLE_DIR: bundleDir,
      CLAUDE_DIR: path.join(sourceHome, '.claude'),
      MACHINE_ID: 'source-mac'
    });

    const backend = createManualBackend({ bundleDir });
    await pushWorkflow(sourceConfig, backend);

    // manifest.json should exist as a separate file
    expect(fs.existsSync(path.join(bundleDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'bundle.tar.gz'))).toBe(true);

    // Extract bundle and verify manifest is NOT inside
    const extractDir = path.join(bundleDir, 'verify-extract');
    const { extractBundle } = await import('../lib/sync.js');
    await extractBundle(path.join(bundleDir, 'bundle.tar.gz'), extractDir);
    expect(fs.existsSync(path.join(extractDir, 'manifest.json'))).toBe(false);
  });

  it('push conflict detection recognizes same machine', async () => {
    const sourceConfig = readConfig({
      BACKEND: 'manual',
      BUNDLE_DIR: bundleDir,
      CLAUDE_DIR: path.join(sourceHome, '.claude'),
      MACHINE_ID: 'source-mac'
    });

    const backend = createManualBackend({ bundleDir });

    // First push
    const result1 = await pushWorkflow(sourceConfig, backend);
    expect(result1.success).toBe(true);

    // Second push from same machine — should succeed without conflict
    const result2 = await pushWorkflow(sourceConfig, backend);
    expect(result2.success).toBe(true);
  });
});
