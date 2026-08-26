/**
 * Tests for the status/diff final summary line.
 *
 * Covers both verdict branches added to runStatus / runDiff:
 *   - ✓ summary when local matches remote (zero differences)
 *   - ✗ summary with a difference count when a tracked file diverges
 *
 * Uses a temp HOME + manual backend + pushWorkflow to build a baseline where
 * the local tree is identical to the remote manifest, then mutates one file
 * to flip the verdict.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runStatus, runDiff } from '../claude-sync.js';
import { readConfig } from '../lib/config.js';
import { createManualBackend } from '../backends/manual.js';
import { pushWorkflow } from '../lib/workflow.js';

// Capture everything written to console.log during `asyncFn` into one string.
async function captureLog(asyncFn) {
  const lines = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await asyncFn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

describe('status/diff summary output', () => {
  let sourceHome;
  let bundleDir;
  let sourceConfig;
  let backend;

  beforeEach(async () => {
    sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-status-src-'));
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-status-bdl-'));

    const sourceClaude = path.join(sourceHome, '.claude');
    fs.mkdirSync(sourceClaude, { recursive: true });

    fs.writeFileSync(
      path.join(sourceClaude, 'settings.json'),
      JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-real', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
        model: 'claude-sonnet-4-6'
      }, null, 2)
    );
    fs.writeFileSync(
      path.join(sourceClaude, 'settings.local.json'),
      JSON.stringify({ theme: 'dark' }, null, 2)
    );
    fs.writeFileSync(
      path.join(sourceClaude, 'keybindings.json'),
      JSON.stringify({ 'ctrl+s': 'submit' }, null, 2)
    );

    const sourceUser = os.userInfo().username;
    fs.writeFileSync(
      path.join(sourceHome, 'CLAUDE.md'),
      `# ${sourceUser}'s CLAUDE.md\n\nCustom instructions here.`
    );

    // Plugins registry
    const pluginsDir = path.join(sourceClaude, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ 'my-plugin': '1.0.0' })
    );
    fs.writeFileSync(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({ official: 'https://cli.claude.ai/marketplace' })
    );

    // Skills: one plain, one git
    const skillsDir = path.join(sourceClaude, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const plainSkill = path.join(skillsDir, 'my-custom-skill');
    fs.mkdirSync(plainSkill, { recursive: true });
    fs.writeFileSync(path.join(plainSkill, 'SKILL.md'), '# My Custom Skill');
    const gitSkill = path.join(skillsDir, 'gstack');
    fs.mkdirSync(gitSkill, { recursive: true });
    fs.mkdirSync(path.join(gitSkill, '.git'));
    fs.writeFileSync(path.join(gitSkill, 'SKILL.md'), '# GStack Skill');

    // ~/.claude.json with an mcp server
    fs.writeFileSync(
      path.join(sourceHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { figma: { type: 'http', url: 'http://localhost:3333' } }
      }, null, 2)
    );

    sourceConfig = readConfig({
      BACKEND: 'manual',
      BUNDLE_DIR: bundleDir,
      CLAUDE_DIR: sourceClaude,
      HOME: sourceHome,
      MACHINE_ID: 'source-mac',
      SECRETS: 'keep'
    });
    backend = createManualBackend({ bundleDir });

    const pushResult = await pushWorkflow(sourceConfig, backend);
    expect(pushResult.success).toBe(true);
  });

  afterEach(() => {
    fs.rmSync(sourceHome, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  });

  it('runStatus prints ✓ summary when local matches remote', async () => {
    const output = await captureLog(() => runStatus(sourceConfig, backend));
    expect(output).toMatch(/✓/);
    expect(output).not.toMatch(/✗/);
  });

  it('runStatus ignores the reinstall-attempts state file (no .json suffix)', async () => {
    // The reinstall-attempt state deliberately has NO `.json` suffix so
    // runStatus's claudeDir `*.json` scan cannot flag it as a permanent
    // "local only" difference. Without this guard the very first pull would
    // leave status showing a difference forever (review M2: a contract the
    // rename is the only thing enforcing).
    fs.writeFileSync(
      path.join(sourceHome, '.claude', '.claude-sync-install-attempts'),
      JSON.stringify({ 'my-plugin@official': { version: '1.0.0', at: '2026-01-01T00:00:00Z' } })
    );
    const output = await captureLog(() => runStatus(sourceConfig, backend));
    expect(output).toMatch(/✓/);
    expect(output).not.toMatch(/✗/);
    expect(output).not.toMatch(/claude-sync-install-attempts/);
  });

  it('runStatus says pull will attempt a default-marketplace install for a missing legacy bare-key plugin', async () => {
    // Baseline manifest carries the plugin as a bare key (from the legacy flat
    // registry in the setup). Drop the local install so it is remote-only;
    // status must say pull attempts a default-marketplace install — not the old
    // "manual install" wording that contradicted what pull actually does
    // (review F1 / M-b).
    const pluginsPath = path.join(sourceHome, '.claude', 'plugins', 'installed_plugins.json');
    fs.writeFileSync(pluginsPath, JSON.stringify({}));
    const output = await captureLog(() => runStatus(sourceConfig, backend));
    expect(output).toMatch(/no marketplace — pull will attempt default-marketplace install/);
    expect(output).toMatch(/✗/);
  });

  it('runStatus prints ✗ summary with a count when a tracked file differs', async () => {
    const settingsPath = path.join(sourceHome, '.claude', 'settings.json');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    s.model = 'claude-opus-4-8'; // mutate one tracked file
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));

    const output = await captureLog(() => runStatus(sourceConfig, backend));
    expect(output).toMatch(/✗/);
    expect(output).toMatch(/\d+ difference/);
  });

  it('runDiff prints ✓ summary when content matches remote', async () => {
    const output = await captureLog(() => runDiff(sourceConfig, backend));
    expect(output).toMatch(/✓/);
    expect(output).not.toMatch(/✗/);
  });

  it('runDiff prints ✗ summary when a tracked file differs', async () => {
    const settingsPath = path.join(sourceHome, '.claude', 'settings.json');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    s.model = 'claude-opus-4-8'; // mutate one tracked file
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));

    const output = await captureLog(() => runDiff(sourceConfig, backend));
    expect(output).toMatch(/✗/);
    expect(output).toMatch(/\d+ difference/);
  });

  it('runStatus reports a plugin version mismatch with ~ and counts a difference', async () => {
    // Baseline push left local == remote (both v1.0.0). Bump the local plugin
    // version to flip the plugin diff into a mismatch.
    const pluginsPath = path.join(sourceHome, '.claude', 'plugins', 'installed_plugins.json');
    const p = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'));
    p['my-plugin'] = '2.0.0';
    fs.writeFileSync(pluginsPath, JSON.stringify(p, null, 2));

    const output = await captureLog(() => runStatus(sourceConfig, backend));
    expect(output).toMatch(/my-plugin/);
    expect(output).toMatch(/local v2\.0\.0 remote v1\.0\.0/);
    expect(output).toMatch(/✗/);
  });

  it('runStatus shows CC marketplace-qualified keys and flags marketplace divergence', async () => {
    // Rebuild the source registry in CC format so the manifest carries
    // name@marketplace keys, then re-push.
    const pluginsPath = path.join(sourceHome, '.claude', 'plugins', 'installed_plugins.json');
    fs.writeFileSync(
      pluginsPath,
      JSON.stringify({
        version: 2,
        plugins: { 'my-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }] }
      })
    );
    const pushResult = await pushWorkflow(sourceConfig, backend);
    expect(pushResult.success).toBe(true);

    // In sync: shows the full name@marketplace key.
    let output = await captureLog(() => runStatus(sourceConfig, backend));
    expect(output).toMatch(/my-plugin@official v1\.0\.0/);
    expect(output).toMatch(/✓/);
    expect(output).not.toMatch(/✗/);

    // Flip the local install to a DIFFERENT marketplace at the SAME version —
    // status must flag the divergence instead of claiming "in sync" (the same
    // divergence pull hints at).
    const p = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'));
    p.plugins['my-plugin@community'] = [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }];
    delete p.plugins['my-plugin@official'];
    fs.writeFileSync(pluginsPath, JSON.stringify(p, null, 2));

    output = await captureLog(() => runStatus(sourceConfig, backend));
    expect(output).toMatch(/same version, different\/no marketplace/);
    expect(output).toMatch(/✗/);
  });

  it('runStatus and runDiff flag a plugin recorded but whose cached files are missing', async () => {
    // Rebuild the registry in CC format with an installPath that does not exist
    // (a restore dropped the cache dir), then re-push so the manifest records it.
    const pluginsPath = path.join(sourceHome, '.claude', 'plugins', 'installed_plugins.json');
    const missing = path.join(sourceHome, '.claude', 'plugins', 'cache', 'my-plugin', '1.0.0');
    fs.writeFileSync(
      pluginsPath,
      JSON.stringify({
        version: 2,
        plugins: { 'my-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z', installPath: missing }] }
      })
    );
    const pushResult = await pushWorkflow(sourceConfig, backend);
    expect(pushResult.success).toBe(true);

    // status must not claim "in sync" — the plugin is recorded but unusable.
    let output = await captureLog(() => runStatus(sourceConfig, backend));
    expect(output).toMatch(/my-plugin@official/);
    expect(output).toMatch(/cache missing \(pull will attempt reinstall\)/);
    expect(output).toMatch(/✗/);

    // diff surfaces the same divergence with the pull remedy.
    output = await captureLog(() => runDiff(sourceConfig, backend));
    expect(output).toMatch(/cache missing \(pull will attempt reinstall\)/);
    expect(output).toMatch(/✗/);
  });
});
