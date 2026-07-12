import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createManifest, buildBundle, extractBundle, readManifest, writeManifest, hashFile, hashString } from '../lib/sync.js';
import { stripSecrets, findSecretFields } from '../lib/secrets.js';
import { replaceUserPath } from '../lib/paths.js';
import { detectSkills, classifySkill } from '../lib/detect.js';

describe('Full push workflow', () => {
  let tmpDir;
  let claudeDir;
  let bundleDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-int-'));
    claudeDir = path.join(tmpDir, '.claude');
    bundleDir = path.join(tmpDir, 'bundle');

    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(bundleDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFakeClaudeConfig() {
    // settings.json
    const settings = {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-real-token',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
      },
      model: 'claude-sonnet-4-6',
      statusLine: { type: 'bun', path: '/opt/homebrew/bin/bun' }
    };
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    // settings.local.json
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify({ theme: 'dark' }));

    // CLAUDE.md (in home)
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# User CLAUDE.md');

    // installed_plugins.json
    const pluginsDir = path.join(claudeDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      'my-plugin': '1.0.0'
    }));
    fs.writeFileSync(path.join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({
      'official': 'https://...'
    }));

    // skills directory
    const skillsDir = path.join(claudeDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    // plain skill
    const plainSkill = path.join(skillsDir, 'my-skill');
    fs.mkdirSync(plainSkill, { recursive: true });
    fs.writeFileSync(path.join(plainSkill, 'SKILL.md'), '# My Skill');

    // git skill
    const gitSkill = path.join(skillsDir, 'git-skill');
    fs.mkdirSync(gitSkill, { recursive: true });
    fs.mkdirSync(path.join(gitSkill, '.git'));
    fs.writeFileSync(path.join(gitSkill, 'SKILL.md'), '# Git Skill');

    return { settings, claudeDir, tmpDir };
  }

  it('builds a complete bundle from claude config directory', async () => {
    const { settings } = createFakeClaudeConfig();

    // Step 1: Hash files
    const hashes = {};
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      hashes['settings.json'] = hashFile(settingsPath);
    }

    // Step 2: Strip secrets (if strip mode)
    const stripped = stripSecrets(structuredClone(settings), 'settings');
    expect(stripped.env.ANTHROPIC_AUTH_TOKEN).toBe('***');
    expect(stripped.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');

    // Step 3: Detect skills
    const skillsDir = path.join(claudeDir, 'skills');
    const skills = detectSkills(skillsDir, path.join(tmpDir, '.agents'));
    expect(skills.length).toBeGreaterThanOrEqual(2);

    // Step 4: Create manifest
    const manifest = createManifest(
      {
        files: hashes,
        plugins: { 'my-plugin': '1.0.0' },
        skills: {
          skills_sh: skills.filter(s => s.type === 'skills_sh'),
          git: skills.filter(s => s.type === 'git'),
          symlink: [],
          child_symlink: [],
          plain: skills.filter(s => s.type === 'plain')
        },
        mcp_servers: [],
        memory: null
      },
      { machineId: 'test-machine', sourceUser: 'testuser' }
    );

    expect(manifest.version).toBe(1);
    expect(manifest.pushed_by).toBe('test-machine');
    expect(manifest.hashes['settings.json']).toBeDefined();
    expect(manifest.skills.plain.length).toBeGreaterThanOrEqual(1);
    expect(manifest.skills.git.length).toBeGreaterThanOrEqual(1);

    // Step 5: Write manifest
    const manifestPath = path.join(bundleDir, 'manifest.json');
    writeManifest(manifestPath, manifest);

    // Step 6: Build bundle (package directories)
    const bundlePath = path.join(bundleDir, 'bundle.tar.gz');
    await buildBundle(claudeDir, bundlePath);
    expect(fs.existsSync(bundlePath)).toBe(true);
    expect(fs.statSync(bundlePath).size).toBeGreaterThan(0);
  });

  it('full push → pull cycle preserves configuration', async () => {
    createFakeClaudeConfig();

    // === PUSH (source machine) ===

    // 1. Hash files
    const hashes = {};
    ['settings.json', 'settings.local.json', 'CLAUDE.md'].forEach(f => {
      const fp = f === 'CLAUDE.md'
        ? path.join(tmpDir, f)
        : path.join(claudeDir, f);
      if (fs.existsSync(fp)) hashes[f] = hashFile(fp);
    });

    // 2. Detect skills
    const skills = detectSkills(
      path.join(claudeDir, 'skills'),
      path.join(tmpDir, '.agents')
    );

    // 3. Create manifest
    const manifest = createManifest(
      {
        files: hashes,
        plugins: { 'my-plugin': '1.0.0' },
        skills: {
          skills_sh: skills.filter(s => s.type === 'skills_sh'),
          git: skills.filter(s => s.type === 'git'),
          symlink: [],
          child_symlink: [],
          plain: skills.filter(s => s.type === 'plain')
        },
        mcp_servers: [],
        memory: null
      },
      { machineId: 'source-mac', sourceUser: 'alice' }
    );

    // 4. Bundle
    const bundlePath = path.join(bundleDir, 'bundle.tar.gz');
    await buildBundle(claudeDir, bundlePath);

    // Write manifest separately (NOT in tar.gz)
    const manifestPath = path.join(bundleDir, 'manifest.json');
    writeManifest(manifestPath, manifest);

    // === PULL (target machine) ===
    const targetDir = path.join(tmpDir, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetClaude = path.join(targetDir, '.claude');

    // 1. Backup target (empty in this test)
    const backupDir = path.join(tmpDir, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });

    // 2. Extract bundle
    await extractBundle(bundlePath, targetClaude);

    // 3. Read manifest
    const readManifestData = readManifest(manifestPath);
    expect(readManifestData.pushed_by).toBe('source-mac');
    expect(readManifestData.source_user).toBe('alice');

    // 4. Path replacement
    const targetSettings = JSON.parse(
      fs.readFileSync(path.join(targetClaude, 'settings.json'), 'utf-8')
    );
    const replaced = replaceUserPath(
      JSON.stringify(targetSettings),
      'alice',
      'bob'
    );
    expect(replaced.includes('alice')).toBe(false);

    // 5. Secrets handling — find stripped fields
    const strippedSettings = stripSecrets(targetSettings, 'settings');
    const strippedFields = findSecretFields(strippedSettings, 'settings');
    expect(strippedFields.length).toBeGreaterThanOrEqual(1);

    // 6. Skills restored
    const targetSkills = detectSkills(
      path.join(targetClaude, 'skills'),
      path.join(targetDir, '.agents')
    );
    expect(targetSkills.length).toBeGreaterThanOrEqual(2);
    expect(targetSkills.find(s => s.type === 'plain')).toBeDefined();
    expect(targetSkills.find(s => s.type === 'git')).toBeDefined();
  });

  it('manifest is stored separately from tar.gz', async () => {
    createFakeClaudeConfig();

    const bundlePath = path.join(bundleDir, 'bundle.tar.gz');
    await buildBundle(claudeDir, bundlePath);

    const manifestPath = path.join(bundleDir, 'manifest.json');
    writeManifest(manifestPath, createManifest(
      { files: {}, plugins: {}, skills: { skills_sh: [], git: [], symlink: [], child_symlink: [], plain: [] }, mcp_servers: [], memory: null },
      { machineId: 'test', sourceUser: 'test' }
    ));

    // Verify manifest.json is NOT inside the tar.gz
    // (it's a separate file in the same directory)
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(bundlePath)).toBe(true);

    // Read manifest without extracting tar.gz
    const m = readManifest(manifestPath);
    expect(m.pushed_by).toBe('test');

    // Extract bundle and verify manifest.json is NOT inside
    const extractDir = path.join(tmpDir, 'extracted');
    await extractBundle(bundlePath, extractDir);
    expect(fs.existsSync(path.join(extractDir, 'manifest.json'))).toBe(false);
  });
});

describe('Config file roundtrip', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads and writes config preserving all fields', async () => {
    const { readConfig } = await import('../lib/config.js');

    const userConfig = {
      REMOTE: 'gdrive:claude-sync/',
      BACKEND: 'rclone',
      SECRETS: 'keep',
      MACHINE_ID: 'my-macbook-pro'
    };

    const config = readConfig(userConfig);
    expect(config.REMOTE).toBe('gdrive:claude-sync/');
    expect(config.BACKEND).toBe('rclone');
    expect(config.SECRETS).toBe('keep');
    expect(config.MACHINE_ID).toBe('my-macbook-pro');
    expect(config.BUNDLE_DIR).toContain('.claude-sync-bundle');
    expect(config.CLAUDE_DIR).toContain('.claude');
  });
});
