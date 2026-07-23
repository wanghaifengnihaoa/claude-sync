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
});
