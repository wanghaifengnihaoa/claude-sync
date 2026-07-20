import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createManifest, buildBundle, readManifest, extractBundle } from '../lib/sync.js';

describe('createManifest', () => {
  it('creates a manifest with required fields', () => {
    const meta = {
      files: {
        'settings.json': 'abc123hash',
        'CLAUDE.md': 'def456hash'
      },
      plugins: { 'my-plugin': '1.0.0' },
      skills: {
        skills_sh: [{ name: 'ssh-skill', source: 'github.com/u/ssh', folderHash: 'h1' }],
        git: [],
        symlink: [],
        child_symlink: [],
        plain: [{ name: 'my-skill', hash: 'sha256xyz' }]
      },
      mcp_servers: ['figma', 'github'],
      memory: { auto_memory_directory: '~/.claude/shared-memory', topic_count: 5 }
    };

    const manifest = createManifest(meta, { machineId: 'my-mac', sourceUser: 'alice' });

    expect(manifest.version).toBe(1);
    expect(manifest.pushed_by).toBe('my-mac');
    expect(manifest.source_user).toBe('alice');
    expect(manifest.source_home).toBeDefined();
    expect(manifest.pushed_at).toBeDefined();
    expect(manifest.hashes['settings.json']).toBe('abc123hash');
    expect(manifest.hashes['CLAUDE.md']).toBe('def456hash');
    expect(manifest.plugins['my-plugin']).toBe('1.0.0');
    expect(manifest.mcp_servers).toEqual(['figma', 'github']);
    expect(manifest.skills.skills_sh).toHaveLength(1);
    expect(manifest.skills.plain).toHaveLength(1);
    expect(manifest.memory.topic_count).toBe(5);
  });

  it('uses hostname when machineId not provided', () => {
    const manifest = createManifest({ files: {}, plugins: {}, skills: {}, mcp_servers: [], memory: null }, { sourceUser: 'bob' });
    expect(manifest.pushed_by).toBe(os.hostname());
  });

  it('stores claude_version when provided', () => {
    const manifest = createManifest(
      { files: {}, plugins: {}, skills: {}, mcp_servers: [], memory: null, claude_version: '1.2.3' },
      { sourceUser: 'alice' }
    );
    expect(manifest.claude_version).toBe('1.2.3');
  });

  it('claude_version is null when not provided', () => {
    const manifest = createManifest(
      { files: {}, plugins: {}, skills: {}, mcp_servers: [], memory: null },
      { sourceUser: 'bob' }
    );
    expect(manifest.claude_version).toBeNull();
  });
});

describe('buildBundle', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a tar.gz bundle from source directory', async () => {
    // Create source files
    const sourceDir = path.join(tmpDir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'settings.json'), JSON.stringify({ model: 'claude' }));
    fs.writeFileSync(path.join(sourceDir, 'CLAUDE.md'), '# My CLAUDE.md');

    const bundlePath = path.join(tmpDir, 'bundle.tar.gz');
    await buildBundle(sourceDir, bundlePath);

    expect(fs.existsSync(bundlePath)).toBe(true);
    const stat = fs.statSync(bundlePath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('excludes nested plugin caches and marketplaces', async () => {
    const sourceDir = path.join(tmpDir, 'source');
    fs.mkdirSync(path.join(sourceDir, 'plugins', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'plugins', 'marketplaces'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'settings'), { recursive: true });
    // Files that should be included
    fs.writeFileSync(path.join(sourceDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
    fs.writeFileSync(path.join(sourceDir, 'settings.json'), JSON.stringify({ model: 'claude' }));
    // Files that should be excluded (nested under plugins/)
    fs.writeFileSync(path.join(sourceDir, 'plugins', 'cache', 'cache-file'), 'cache-data');
    fs.writeFileSync(path.join(sourceDir, 'plugins', 'marketplaces', 'index.json'), 'marketplace-data');
    // Top-level excluded
    fs.writeFileSync(path.join(sourceDir, 'sessions', 'session1.json'), 'session-data');

    const bundlePath = path.join(tmpDir, 'bundle.tar.gz');
    await buildBundle(sourceDir, bundlePath);

    // Extract to verify
    const extractDir = path.join(tmpDir, 'extracted');
    await extractBundle(bundlePath, extractDir);

    // Should include these
    expect(fs.existsSync(path.join(extractDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'plugins'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'plugins', 'installed_plugins.json'))).toBe(true);

    // Should exclude these (nested caches inside plugins/)
    expect(fs.existsSync(path.join(extractDir, 'plugins', 'cache'))).toBe(false);
    expect(fs.existsSync(path.join(extractDir, 'plugins', 'marketplaces'))).toBe(false);

    // Should exclude top-level runtime dirs
    expect(fs.existsSync(path.join(extractDir, 'sessions'))).toBe(false);
  });

  it('accepts additional exclude patterns', async () => {
    const sourceDir = path.join(tmpDir, 'source');
    fs.mkdirSync(path.join(sourceDir, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'settings.json'), JSON.stringify({ model: 'claude' }));
    fs.writeFileSync(path.join(sourceDir, 'commands', 'my-cmd.md'), '# cmd');
    fs.writeFileSync(path.join(sourceDir, 'agents', 'my-agent.md'), '# agent');

    const bundlePath = path.join(tmpDir, 'bundle.tar.gz');
    await buildBundle(sourceDir, bundlePath, ['commands']);

    const extractDir = path.join(tmpDir, 'extracted');
    await extractBundle(bundlePath, extractDir);

    // Should include
    expect(fs.existsSync(path.join(extractDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'agents'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'agents', 'my-agent.md'))).toBe(true);

    // Should exclude 'commands' (additional exclude)
    expect(fs.existsSync(path.join(extractDir, 'commands'))).toBe(false);
  });
});

describe('readManifest', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a manifest.json file', () => {
    const manifestData = {
      version: 1,
      pushed_by: 'test-machine',
      pushed_at: '2026-07-12T00:00:00Z',
      source_user: 'alice',
      hashes: { 'settings.json': 'abc123' },
      mcp_servers: [],
      plugins: {},
      skills: { skills_sh: [], git: [], symlink: [], child_symlink: [], plain: [] },
      memory: null
    };
    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData));

    const result = readManifest(manifestPath);
    expect(result.version).toBe(1);
    expect(result.pushed_by).toBe('test-machine');
    expect(result.source_user).toBe('alice');
  });

  it('returns null for non-existent manifest', () => {
    const result = readManifest(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, '{invalid json');
    const result = readManifest(manifestPath);
    expect(result).toBeNull();
  });
});
