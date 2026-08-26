import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createManifest, buildBundle, readManifest, extractBundle, pluginNameFromKey, pluginMarketplaceFromKey, readPluginVersions, readPluginInstalls, indexPluginsByBareName, cacheSatisfiesVersion, alignRegistryToLocalCache } from '../lib/sync.js';

describe('pluginNameFromKey', () => {
  it('strips the @marketplace suffix from a regular key', () => {
    expect(pluginNameFromKey('existing-plugin@official')).toBe('existing-plugin');
  });

  it('keeps scoped plugin names intact', () => {
    expect(pluginNameFromKey('@scope/name@official')).toBe('@scope/name');
  });

  it('passes bare names through unchanged', () => {
    expect(pluginNameFromKey('bare-name')).toBe('bare-name');
  });

  it('keeps a bare scoped name (no marketplace) unchanged', () => {
    expect(pluginNameFromKey('@scope/name')).toBe('@scope/name');
  });
});

describe('pluginMarketplaceFromKey', () => {
  it('extracts the @marketplace suffix from a regular key', () => {
    expect(pluginMarketplaceFromKey('existing-plugin@official')).toBe('official');
  });

  it('extracts the marketplace from a scoped plugin key', () => {
    expect(pluginMarketplaceFromKey('@scope/name@official')).toBe('official');
  });

  it('returns null for bare names', () => {
    expect(pluginMarketplaceFromKey('bare-name')).toBeNull();
  });

  it('returns null for a bare scoped name (no marketplace)', () => {
    expect(pluginMarketplaceFromKey('@scope/name')).toBeNull();
  });

  it('returns null for a trailing @ (empty marketplace)', () => {
    expect(pluginMarketplaceFromKey('name@')).toBeNull();
  });
});

describe('readPluginVersions', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeInstalled(data) {
    const pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(data));
  }

  it('preserves the full name@marketplace key', () => {
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }] } });
    const result = readPluginVersions(path.join(tmpDir, 'plugins'));
    expect(Object.keys(result)).toEqual(['my-plugin@official']);
    expect(result['my-plugin@official']).toBe('1.0.0');
  });

  it('prefers the user-scope record over project/local', () => {
    writeInstalled({
      version: 2,
      plugins: {
        'my-plugin@official': [
          { scope: 'project', version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' },
          { scope: 'user', version: '2.0.0', installedAt: '2026-01-01T00:00:00Z' }
        ]
      }
    });
    expect(readPluginVersions(path.join(tmpDir, 'plugins'))['my-plugin@official']).toBe('2.0.0');
  });

  it('picks the most recently updated record within a scope', () => {
    writeInstalled({
      version: 2,
      plugins: {
        'my-plugin@official': [
          { scope: 'user', version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' },
          { scope: 'user', version: '2.0.0', lastUpdated: '2026-06-01T00:00:00Z' }
        ]
      }
    });
    expect(readPluginVersions(path.join(tmpDir, 'plugins'))['my-plugin@official']).toBe('2.0.0');
  });

  it('falls back to lastUpdated when no scope is present', () => {
    writeInstalled({
      version: 2,
      plugins: {
        'my-plugin@official': [
          { version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' },
          { version: '2.0.0', lastUpdated: '2026-06-01T00:00:00Z' }
        ]
      }
    });
    expect(readPluginVersions(path.join(tmpDir, 'plugins'))['my-plugin@official']).toBe('2.0.0');
  });

  it('falls back to the last entry when nothing is dated', () => {
    writeInstalled({
      version: 2,
      plugins: {
        'my-plugin@official': [
          { version: '1.0.0' },
          { version: '2.0.0' }
        ]
      }
    });
    expect(readPluginVersions(path.join(tmpDir, 'plugins'))['my-plugin@official']).toBe('2.0.0');
  });

  it('handles a single (non-array) entries value defensively', () => {
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': { version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' } } });
    expect(readPluginVersions(path.join(tmpDir, 'plugins'))['my-plugin@official']).toBe('1.0.0');
  });

  it('reports unknown when a record has no version', () => {
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ installedAt: '2026-01-01T00:00:00Z' }] } });
    expect(readPluginVersions(path.join(tmpDir, 'plugins'))['my-plugin@official']).toBe('unknown');
  });

  it('passes legacy flat maps through unchanged', () => {
    writeInstalled({ 'my-plugin': '1.0.0' });
    expect(readPluginVersions(path.join(tmpDir, 'plugins'))).toEqual({ 'my-plugin': '1.0.0' });
  });
});

describe('readPluginInstalls', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-installs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeInstalled(data) {
    const pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(data));
  }

  it('carries installPath and reports cached=true when the path has content', () => {
    const installPath = path.join(tmpDir, 'cache', 'my-plugin', '1.0.0');
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, 'plugin.js'), '// installed');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installPath }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.version).toBe('1.0.0');
    expect(rec.installPath).toBe(installPath);
    expect(rec.cached).toBe(true);
  });

  it('reports cached=false when the recorded installPath is gone', () => {
    const installPath = path.join(tmpDir, 'cache', 'my-plugin', '1.0.0');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installPath }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.cached).toBe(false);
  });

  it('treats a record without installPath as cached (nothing to verify)', () => {
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.installPath).toBeNull();
    expect(rec.cached).toBe(true);
  });

  it('treats legacy flat maps as cached', () => {
    writeInstalled({ 'my-plugin': '1.0.0' });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin'];
    expect(rec.version).toBe('1.0.0');
    expect(rec.cached).toBe(true);
  });

  it('indexPluginsByBareName threads cached through install records', () => {
    const installPath = path.join(tmpDir, 'cache', 'my-plugin', '1.0.0');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installPath }] } });
    const indexed = indexPluginsByBareName(readPluginInstalls(path.join(tmpDir, 'plugins')));
    expect(indexed['my-plugin']).toEqual({ key: 'my-plugin@official', version: '1.0.0', cached: false, installPath });
  });

  it('reports cached=true when installPath is a foreign path but the canonical cache holds the version', () => {
    // installPath points at the SOURCE machine's path (a cover pull syncs the
    // source's installed_plugins.json verbatim). The path doesn't exist here,
    // but this machine's canonical cache holds the plugin — it must NOT be
    // reinstalled on every incremental pull.
    const installPath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', '1.0.0');
    const canonical = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', '1.0.0');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'plugin.js'), '// installed');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installPath }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.cached).toBe(true);
  });

  it('reports cached=false when the canonical version dir exists but is empty', () => {
    // An interrupted install leaves an empty version dir. Before this fix
    // cachedPluginVersions listed the dir by name alone, so claimed ≤ highest
    // read as cached=true and the plugin was never reinstalled nor aligned —
    // stuck at "not cached" with no recovery path. An empty dir is not an
    // install; it must not count as cached.
    const installPath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', '1.0.0');
    const canonicalEmpty = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', '1.0.0');
    fs.mkdirSync(canonicalEmpty, { recursive: true }); // exists but EMPTY
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installPath }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.cached).toBe(false);
  });

  it('reports cached=false when the only canonical dir is an empty SHA dir', () => {
    // Same gap for a SHA-cached plugin: an empty dir must not satisfy a SHA
    // claim (the conservative "any cache counts" branch) — the files are gone.
    const installPath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', 'abc123');
    const canonicalEmpty = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', 'def456');
    fs.mkdirSync(canonicalEmpty, { recursive: true }); // exists but EMPTY
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: 'abc123', installPath }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.cached).toBe(false);
  });

  it('reports cached=false when the claimed version is higher than what is cached', () => {
    // The claude-hud case: registry claims 0.7.1, only 0.7.0 is cached. The
    // plugin is behind the claimed version, so pull must reinstall it rather
    // than trust the record.
    const installPath = path.join(tmpDir, 'source-machine', 'cache', 'claude-hud', 'claude-hud', '0.7.1');
    const canonicalOld = path.join(tmpDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.0');
    fs.mkdirSync(canonicalOld, { recursive: true });
    writeInstalled({ version: 2, plugins: { 'claude-hud@claude-hud': [{ version: '0.7.1', installPath }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['claude-hud@claude-hud'];
    expect(rec.cached).toBe(false);
  });

  it('reports cached=true when the claimed version is at or below what is cached (converges)', () => {
    // The version-drift case: source records 2.0.0, this machine cached 3.0.0.
    // A strict equality check would reinstall on every cover pull (the source's
    // registry overwrites this machine's each time, looping forever); the local
    // install is already newer, so leave it alone.
    const installPath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', '2.0.0');
    const canonicalNew = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', '3.0.0');
    fs.mkdirSync(canonicalNew, { recursive: true });
    fs.writeFileSync(path.join(canonicalNew, 'plugin.js'), '// installed');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '2.0.0', installPath }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.cached).toBe(true);
  });

  it('reports cached=true for a non-semver claimed version (git SHA) when anything is cached', () => {
    // CC records some plugins by git SHA (skill-creator, frontend-design). SHA
    // drift is meaningless to rank and reinstalling would loop, so any cache is
    // treated as present.
    const installPath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', 'abc123');
    const canonical = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', 'def456');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'plugin.js'), '// installed');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: 'abc123', installPath }] } });
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.cached).toBe(true);
  });

  it('cacheSatisfiesVersion is false when the cached version is below the claim', () => {
    // The claude-hud reinstall case: catalog can only supply 0.7.0 but the
    // registry claims 0.7.1 — after a reinstall the claim is still unreachable.
    const canonical = path.join(tmpDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.0');
    fs.mkdirSync(canonical, { recursive: true });
    const satisfied = cacheSatisfiesVersion(path.join(tmpDir, 'plugins'), 'claude-hud@claude-hud', '0.7.1');
    expect(satisfied).toBe(false);
  });

  it('cacheSatisfiesVersion is true when the cache reaches or exceeds the claim', () => {
    // A reinstall that converges: cached 3.0.0 >= claimed 2.0.0 → satisfied.
    const canonical = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', '3.0.0');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'plugin.js'), '// installed');
    const satisfied = cacheSatisfiesVersion(path.join(tmpDir, 'plugins'), 'my-plugin@official', '2.0.0');
    expect(satisfied).toBe(true);
  });

  it('cacheSatisfiesVersion is true for a SHA claim with any cache', () => {
    // skill-creator (SHA): any cache dir counts as satisfied, matching
    // pluginCacheExists's conservative SHA read.
    const canonical = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', 'def456');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'plugin.js'), '// installed');
    const satisfied = cacheSatisfiesVersion(path.join(tmpDir, 'plugins'), 'my-plugin@official', 'abc123');
    expect(satisfied).toBe(true);
  });

  it('cacheSatisfiesVersion is false when nothing is cached at all', () => {
    const satisfied = cacheSatisfiesVersion(path.join(tmpDir, 'plugins'), 'my-plugin@official', '1.0.0');
    expect(satisfied).toBe(false);
  });
});

describe('alignRegistryToLocalCache', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-align-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeInstalled(data) {
    const pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(data));
  }

  it('re-points a dangling installPath to the highest semver dir actually cached', () => {
    // Cover pull restores the source's record verbatim (claimed 6.1.0 + source
    // path). This machine cached 6.3.0, so the plugin is present but the record
    // points nowhere local. Align to the real dir + version.
    const sourcePath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', '6.1.0');
    const canonical = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', '6.3.0');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'plugin.js'), '// installed');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '6.1.0', installPath: sourcePath }] } });

    const changed = alignRegistryToLocalCache(path.join(tmpDir, 'plugins'));
    expect(changed).toBe(true);

    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.version).toBe('6.3.0');
    expect(rec.installPath).toBe(canonical);
    expect(rec.cached).toBe(true);
  });

  it('picks the highest semver when multiple cached dirs exist', () => {
    const sourcePath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', '2.0.0');
    const old = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', '2.0.0');
    const newer = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', '3.1.0');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(path.join(old, 'plugin.js'), '// old');
    fs.writeFileSync(path.join(newer, 'plugin.js'), '// new');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '2.0.0', installPath: sourcePath }] } });

    alignRegistryToLocalCache(path.join(tmpDir, 'plugins'));
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.version).toBe('3.1.0');
    expect(rec.installPath).toBe(newer);
  });

  it('aligns a SHA claim to a SHA-cached dir', () => {
    const sourcePath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', 'abc123');
    const canonical = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', 'def456');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'plugin.js'), '// installed');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: 'abc123', installPath: sourcePath }] } });

    alignRegistryToLocalCache(path.join(tmpDir, 'plugins'));
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.version).toBe('def456');
    expect(rec.installPath).toBe(canonical);
  });

  it('leaves a valid installPath alone', () => {
    const canonical = path.join(tmpDir, 'plugins', 'cache', 'official', 'my-plugin', '1.0.0');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'plugin.js'), '// installed');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installPath: canonical }] } });

    const changed = alignRegistryToLocalCache(path.join(tmpDir, 'plugins'));
    expect(changed).toBe(false);
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.version).toBe('1.0.0');
    expect(rec.installPath).toBe(canonical);
  });

  it('leaves a dangling record alone when nothing is cached (reinstall owns it)', () => {
    const sourcePath = path.join(tmpDir, 'source-machine', 'cache', 'my-plugin', '1.0.0');
    writeInstalled({ version: 2, plugins: { 'my-plugin@official': [{ version: '1.0.0', installPath: sourcePath }] } });

    const changed = alignRegistryToLocalCache(path.join(tmpDir, 'plugins'));
    expect(changed).toBe(false);
    const rec = readPluginInstalls(path.join(tmpDir, 'plugins'))['my-plugin@official'];
    expect(rec.version).toBe('1.0.0');
    expect(rec.installPath).toBe(sourcePath);
  });

  it('is a no-op for legacy flat registries', () => {
    writeInstalled({ 'my-plugin': '1.0.0' });
    const changed = alignRegistryToLocalCache(path.join(tmpDir, 'plugins'));
    expect(changed).toBe(false);
  });
});

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
