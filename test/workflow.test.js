import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  extractMcpServers,
  mergeMcpServers,
  migrateMemoryToShared,
  mergeMemoryTopics,
  countMemoryTopics,
  applyPathReplacement,
  resolveSymlinksInDir,
  checkStatusLinePaths,
  copyDirContents,
  copyIfMissing,
  promptMemoryGlobalization,
  handlePlugins,
  getClaudeVersion
} from '../lib/workflow.js';
import { promptYesNo } from '../lib/prompt.js';
import { detectSkills, classifySkill } from '../lib/detect.js';

// workflow tests never exercise real interactive prompts; force the memory
// globalization prompt to answer "yes" by default (per-test can override).
vi.mock('../lib/prompt.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, promptYesNo: vi.fn().mockResolvedValue(true) };
});

// ==============================
// extractMcpServers
// ==============================
describe('extractMcpServers', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-extract-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts mcpServer names and config from .claude.json', () => {
    const claudeJson = {
      mcpServers: {
        figma: { type: 'http', url: 'http://localhost:3333', config: { FIGMA_API_KEY: 'secret' } },
        github: { type: 'stdio', command: 'gh' }
      }
    };
    fs.writeFileSync(path.join(tmpDir, '.claude.json'), JSON.stringify(claudeJson));

    const result = extractMcpServers(tmpDir, 'keep');
    expect(result.names).toEqual(['figma', 'github']);
    expect(result.config.figma.type).toBe('http');
    expect(result.config.figma.config.FIGMA_API_KEY).toBe('secret');
  });

  it('strips secrets in strip mode', () => {
    const claudeJson = {
      mcpServers: {
        figma: { type: 'http', config: { FIGMA_API_KEY: 'secret-key' } }
      }
    };
    fs.writeFileSync(path.join(tmpDir, '.claude.json'), JSON.stringify(claudeJson));

    const result = extractMcpServers(tmpDir, 'strip');
    expect(result.names).toEqual(['figma']);
    expect(result.config.figma.config.FIGMA_API_KEY).toBe('***');
  });

  it('returns empty when no .claude.json exists', () => {
    const result = extractMcpServers(tmpDir, 'keep');
    expect(result.names).toEqual([]);
    expect(result.config).toEqual({});
  });

  it('returns empty when .claude.json has no mcpServers', () => {
    fs.writeFileSync(path.join(tmpDir, '.claude.json'), JSON.stringify({ otherField: 'value' }));
    const result = extractMcpServers(tmpDir, 'keep');
    expect(result.names).toEqual([]);
  });
});

// ==============================
// mergeMcpServers
// ==============================
describe('mergeMcpServers', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-merge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds mcpServers to .claude.json when not present', () => {
    const claudeJson = { machineID: 'abc-123', numStartups: 5 };
    fs.writeFileSync(path.join(tmpDir, '.claude.json'), JSON.stringify(claudeJson));

    mergeMcpServers(tmpDir, ['figma'], 'cover', null);

    const result = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf-8'));
    expect(result.mcpServers).toBeDefined();
    expect(result.mcpServers.figma).toBeDefined();
    // machine-specific fields preserved
    expect(result.machineID).toBe('abc-123');
    expect(result.numStartups).toBe(5);
  });

  it('preserves existing mcpServers with keep strategy', () => {
    const claudeJson = {
      machineID: 'abc',
      mcpServers: {
        existing: { type: 'stdio', command: 'echo' }
      }
    };
    fs.writeFileSync(path.join(tmpDir, '.claude.json'), JSON.stringify(claudeJson));

    mergeMcpServers(tmpDir, ['figma'], 'keep', null);

    const result = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude.json'), 'utf-8'));
    expect(result.mcpServers.existing).toBeDefined();
    expect(result.mcpServers.existing.command).toBe('echo');
    expect(result.mcpServers.figma).toBeDefined();
  });
});

// ==============================
// mergeMemoryTopics
// ==============================
describe('mergeMemoryTopics', () => {
  let srcDir, destDir;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mem-'));
    srcDir = path.join(tmpDir, 'src');
    destDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    const parent = path.dirname(srcDir);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('copies new memory topics from source to destination', () => {
    fs.writeFileSync(path.join(srcDir, 'topic1.md'), '# Topic 1');
    fs.writeFileSync(path.join(srcDir, 'MEMORY.md'), '# index');

    mergeMemoryTopics(srcDir, destDir, 'keep');

    expect(fs.existsSync(path.join(destDir, 'topic1.md'))).toBe(true);
    // MEMORY.md should also be copied (it's an .md file)
  });

  it('preserves existing topics with keep strategy', () => {
    // Pre-existing topic in dest
    fs.writeFileSync(path.join(destDir, 'topic-existing.md'), '# Existing content');
    // Same topic in source with different content
    fs.writeFileSync(path.join(srcDir, 'topic-existing.md'), '# New content');

    mergeMemoryTopics(srcDir, destDir, 'keep');

    const content = fs.readFileSync(path.join(destDir, 'topic-existing.md'), 'utf-8');
    // Keep strategy: preserve local version
    expect(content).toBe('# Existing content');
  });

  it('overwrites topics with cover strategy', () => {
    fs.writeFileSync(path.join(destDir, 'topic-shared.md'), '# Old content');
    fs.writeFileSync(path.join(srcDir, 'topic-shared.md'), '# New content');

    mergeMemoryTopics(srcDir, destDir, 'cover');

    const content = fs.readFileSync(path.join(destDir, 'topic-shared.md'), 'utf-8');
    expect(content).toBe('# New content');
  });

  it('handles empty source directory gracefully', () => {
    // src is empty, dest has content
    fs.writeFileSync(path.join(destDir, 'existing.md'), '# existing');
    mergeMemoryTopics(srcDir, destDir, 'cover');
    // Should not throw and dest should be unchanged
    expect(fs.readdirSync(destDir).length).toBe(1);
  });
});

// ==============================
// countMemoryTopics
// ==============================
describe('countMemoryTopics', () => {
  let memDir;

  beforeEach(() => {
    memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-count-'));
  });

  afterEach(() => {
    fs.rmSync(memDir, { recursive: true, force: true });
  });

  it('counts markdown files excluding MEMORY.md', () => {
    fs.writeFileSync(path.join(memDir, 'topic1.md'), '# Topic 1');
    fs.writeFileSync(path.join(memDir, 'topic2.md'), '# Topic 2');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# index');

    expect(countMemoryTopics(memDir)).toBe(2);
  });

  it('returns 0 for empty directory', () => {
    expect(countMemoryTopics(memDir)).toBe(0);
  });

  it('returns 0 for non-existent directory', () => {
    expect(countMemoryTopics('/non/existent/path')).toBe(0);
  });
});

// ==============================
// applyPathReplacement
// ==============================
describe('applyPathReplacement', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-path-repl-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces source home paths in JSON and MD files', () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    // JSON file with path reference
    fs.writeFileSync(
      path.join(subDir, 'settings.json'),
      JSON.stringify({
        statusLine: { path: '/Users/alice/.bun/bin/bun' },
        someDir: '/Users/alice/projects/foo'
      })
    );
    // MD file with path reference
    fs.writeFileSync(
      path.join(subDir, 'README.md'),
      '# Path: /Users/alice/config'
    );

    applyPathReplacement(tmpDir, '/Users/alice', '/Users/bob');

    const json = JSON.parse(fs.readFileSync(path.join(subDir, 'settings.json'), 'utf-8'));
    expect(json.statusLine.path).toBe('/Users/bob/.bun/bin/bun');
    expect(json.someDir).toBe('/Users/bob/projects/foo');

    const md = fs.readFileSync(path.join(subDir, 'README.md'), 'utf-8');
    expect(md).toContain('/Users/bob/config');
    expect(md).not.toContain('/Users/alice/config');
  });

  it('skips when source and target home are the same', () => {
    const filePath = path.join(tmpDir, 'test.json');
    fs.writeFileSync(filePath, JSON.stringify({ path: '/Users/bob/config' }));

    applyPathReplacement(tmpDir, '/Users/bob', '/Users/bob');

    // File should be unchanged
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(content.path).toBe('/Users/bob/config');
  });

  it('handles non-existent directory gracefully', () => {
    // Should not throw
    expect(() => applyPathReplacement('/non/existent', '/src', '/tgt')).not.toThrow();
  });

  it('cross-platform macOS source → Windows target keeps JSON valid', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    // Realistic: a statusLine command that embeds the source home as a JSON
    // string escape (\"...) — exactly the shape that broke on Windows.
    fs.writeFileSync(filePath, JSON.stringify({
      statusLine: {
        type: 'command',
        command: `bash -c '... exec \\"/Users/alice/.bun/bin/bun\\" --env-file /dev/null \\"${'${plugin_dir}'}src/index.ts\\"'`
      },
      env: { ANTHROPIC_MODEL: 'opus' }
    }, null, 2));

    applyPathReplacement(tmpDir, '/Users/alice', 'C:\\Users\\bob');

    // Must still parse — a raw text replace would have left \U / \w escapes.
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.statusLine.command).toContain('C:\\Users\\bob/.bun/bin/bun');
    expect(parsed.statusLine.command).not.toContain('/Users/alice');
    expect(parsed.env.ANTHROPIC_MODEL).toBe('opus');
  });

  it('skips a .json file that is not valid JSON', () => {
    const filePath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(filePath, '{ this is not valid json /Users/alice');
    const before = fs.readFileSync(filePath, 'utf-8');

    expect(() => applyPathReplacement(tmpDir, '/Users/alice', 'C:\\Users\\bob')).not.toThrow();
    // File must be left byte-identical, not partially rewritten.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
  });
});

// ==============================
// resolveSymlinksInDir
// ==============================
describe('resolveSymlinksInDir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sym-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dereferences file symlinks to real files', () => {
    const realFile = path.join(tmpDir, 'real.txt');
    fs.writeFileSync(realFile, 'actual content');

    const symlink = path.join(tmpDir, 'link.txt');
    fs.symlinkSync(realFile, symlink);

    resolveSymlinksInDir(tmpDir);

    // Symlink should be replaced with a real file
    const stat = fs.lstatSync(symlink);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(symlink, 'utf-8')).toBe('actual content');
  });

  it('dereferences directory symlinks to real directories', () => {
    const realDir = path.join(tmpDir, 'real-dir');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'file.txt'), 'inside');

    const symlinkDir = path.join(tmpDir, 'link-dir');
    fs.symlinkSync(realDir, symlinkDir);

    resolveSymlinksInDir(tmpDir);

    // Symlink should be replaced with a real directory
    const stat = fs.lstatSync(symlinkDir);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(symlinkDir, 'file.txt'), 'utf-8')).toBe('inside');
  });

  it('handles non-existent directory gracefully', () => {
    expect(() => resolveSymlinksInDir('/non/existent')).not.toThrow();
  });
});

// ==============================
// checkStatusLinePaths
// ==============================
describe('checkStatusLinePaths', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns when statusLine path does not exist', () => {
    const settings = { statusLine: { type: 'bun', path: '/nonexistent/bun/bin/bun' } };
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(settings));

    // Should not throw, just log warning
    expect(() => checkStatusLinePaths(tmpDir)).not.toThrow();
  });

  it('does nothing when settings.json does not exist', () => {
    expect(() => checkStatusLinePaths(tmpDir)).not.toThrow();
  });

  it('does nothing when statusLine has no path', () => {
    const settings = { statusLine: { type: 'default' } };
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(settings));
    expect(() => checkStatusLinePaths(tmpDir)).not.toThrow();
  });
});

describe('handlePlugins', () => {
  let claudeDir;
  let execCalls;

  // Fake claude CLI: records invocations instead of running the real binary,
  // which would install from the marketplace into the real user profile — a
  // network + filesystem side effect tests must not have. Must be synchronous,
  // matching execCli's contract (handlePlugins does not await it).
  function fakeExec(cmd, args) {
    execCalls.push({ cmd, args });
    return Buffer.from('');
  }

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-plugins-'));
    execCalls = [];
  });

  afterEach(() => {
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  function writeInstalledPlugins(plugins) {
    const pluginsDir = path.join(claudeDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins })
    );
  }

  it('installs missing plugins from their marketplace and skips version-mismatched ones', async () => {
    writeInstalledPlugins({
      'existing-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
    });
    await handlePlugins(
      { 'existing-plugin@official': '2.0.0', 'new-plugin@official': '1.5.0' },
      claudeDir,
      { exec: fakeExec }
    );

    const cmds = execCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds).toContain('claude plugin install new-plugin@official');
    // local plugin exists → version mismatch is reported, never reinstalled
    expect(cmds).not.toContain('claude plugin install existing-plugin@official');
    expect(cmds).not.toContain('claude plugin uninstall existing-plugin');

    // installed_plugins.json: only the new install is recorded
    const updated = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
    expect(updated.plugins['existing-plugin@official'][0].version).toBe('1.0.0');
    expect(updated.plugins['new-plugin@official'][0].version).toBe('1.5.0');
  });

  it('preserves claude CLI writes to installed_plugins.json after install', async () => {
    writeInstalledPlugins({
      'existing-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
    });
    // Real `claude plugin install` rewrites installed_plugins.json itself with
    // name@marketplace keys. A write-back built on the pre-install snapshot
    // would clobber that fresh entry with a bare-name key; the fix re-reads the
    // file after the loop so the CLI's own key shape survives.
    const execWrites = (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'install') {
        // args[2] is "new-plugin@official" — the CLI writes that full key.
        // The installed version (1.4.0) may differ from the manifest record
        // (1.5.0): Claude Code installs the catalog's current version.
        const fullKey = args[2];
        const pluginsPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
        const raw = JSON.parse(fs.readFileSync(pluginsPath, 'utf-8'));
        raw.plugins[fullKey] = [{ scope: 'user', version: '1.4.0', installedAt: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z' }];
        fs.writeFileSync(pluginsPath, JSON.stringify(raw, null, 2));
      }
      return Buffer.from('');
    };
    await handlePlugins(
      { 'new-plugin@official': '1.5.0' },
      claudeDir,
      { exec: execWrites }
    );

    const updated = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
    // claude wrote new-plugin@official with the REAL installed record; write-back
    // must keep that key AND its actual version/scope/lastUpdated, not overwrite
    // it with the manifest's version or a bare-name entry.
    expect(updated.plugins['new-plugin@official'][0].version).toBe('1.4.0');
    expect(updated.plugins['new-plugin@official'][0].scope).toBe('user');
    expect(updated.plugins['new-plugin']).toBeUndefined();
    expect(updated.plugins['existing-plugin@official'][0].version).toBe('1.0.0');
  });

  it('tolerates a top-level null installed_plugins.json', async () => {
    const pluginsDir = path.join(claudeDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'null');
    await expect(
      handlePlugins({ 'new-plugin@official': '1.0.0' }, claudeDir, { exec: fakeExec })
    ).resolves.toBeUndefined();
    // null content falls back to the flat legacy shape rather than crashing;
    // the full name@marketplace key is kept so the marketplace survives
    const updated = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf-8'));
    expect(updated['new-plugin@official']).toBe('1.0.0');
  });

  it('re-reads the format switch from legacy flat to CC after install', async () => {
    const pluginsDir = path.join(claudeDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    // Legacy flat file to start with
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ 'existing-plugin': '1.0.0' }));
    // Real `claude plugin install` rewrites the file in CC format; the re-read
    // write-back must keep that CC shape instead of forcing flat back on it.
    const execWrites = (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'install') {
        const fullKey = args[2];
        const pluginsPath = path.join(pluginsDir, 'installed_plugins.json');
        const raw = JSON.parse(fs.readFileSync(pluginsPath, 'utf-8'));
        raw.plugins = raw.plugins || {};
        raw.plugins[fullKey] = [{ version: '1.5.0', installedAt: '2026-01-01T00:00:00Z' }];
        fs.writeFileSync(pluginsPath, JSON.stringify(raw, null, 2));
      }
      return Buffer.from('');
    };
    await handlePlugins({ 'new-plugin@official': '1.5.0' }, claudeDir, { exec: execWrites });
    const updated = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf-8'));
    expect(updated.plugins['new-plugin@official'][0].version).toBe('1.5.0');
  });

  it('does not record failed installs in installed_plugins.json', async () => {
    const pluginsDir = path.join(claudeDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
    // exec that throws for the exact install command, succeeds otherwise
    const failingInstall = (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'install' && args[2] === 'bad-plugin@official') {
        throw new Error('marketplace unreachable');
      }
      return Buffer.from('');
    };
    const tmpBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-bundle-'));
    try {
      await handlePlugins(
        { 'bad-plugin@official': '1.0.0' },
        claudeDir,
        { exec: failingInstall, scriptDir: tmpBundle }
      );
      // fallback script still generated for the failed op, with the correct syntax
      const script = fs.readFileSync(path.join(tmpBundle, 'install-plugins.sh'), 'utf-8');
      expect(script).toContain('claude plugin install bad-plugin@official');
    } finally {
      fs.rmSync(tmpBundle, { recursive: true, force: true });
    }
    // the file must NOT claim bad-plugin@official is installed, or the next sync
    // would skip it and the plugin would never get installed.
    const updated = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf-8'));
    expect(updated.plugins['bad-plugin@official']).toBeUndefined();
  });

  it('version mismatch is reported but never reinstalls', async () => {
    writeInstalledPlugins({
      'existing-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
    });
    await handlePlugins(
      { 'existing-plugin@official': '2.0.0' },
      claudeDir,
      { exec: fakeExec }
    );
    // no install/uninstall/rollback — Claude Code can't pin versions, so a
    // mismatched local plugin is left alone rather than upgraded.
    expect(execCalls).toEqual([]);
    const updated = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
    expect(updated.plugins['existing-plugin@official'][0].version).toBe('1.0.0');
  });

  it('hints when a plugin is installed from a different marketplace at the same version', async () => {
    // Same bare name + same version, but the local install came from a different
    // marketplace than the manifest records. The plugin is present, so per the
    // design decision it is never reinstalled — but the divergence must be
    // surfaced, or the wrong-marketplace install would silently persist (and the
    // next push would record the wrong marketplace in the manifest).
    writeInstalledPlugins({
      'existing-plugin@community': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
    });
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.map(String).join(' ')));
    try {
      await handlePlugins(
        { 'existing-plugin@official': '1.0.0' },
        claudeDir,
        { exec: fakeExec }
      );
    } finally {
      spy.mockRestore();
    }
    // never reinstalls a present plugin, regardless of marketplace
    expect(execCalls).toEqual([]);
    // ...but the divergence is surfaced, not silently dropped
    expect(logs.some(l => l.includes("already installed as 'existing-plugin@community' but manifest records 'existing-plugin@official'"))).toBe(true);
  });

  it('reinstalls when the registry records a plugin but its cached files are gone', async () => {
    // A restore drops the cache directory while installed_plugins.json survives.
    // The registry record points at an installPath that no longer exists — the
    // plugin is recorded but unusable, so pull must reinstall it, not trust the
    // record (otherwise the plugin stays broken while status claims it is in sync).
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'existing-plugin', '1.0.0');
    writeInstalledPlugins({
      'existing-plugin@claude-plugins-official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    await handlePlugins(
      { 'existing-plugin@claude-plugins-official': '1.0.0' },
      claudeDir,
      { exec: fakeExec }
    );
    const cmds = execCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds).toContain('claude plugin install existing-plugin@claude-plugins-official');
  });

  it('does not reinstall when the cached installPath still has content', async () => {
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'existing-plugin', '1.0.0');
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, 'plugin.js'), '// installed');
    writeInstalledPlugins({
      'existing-plugin@claude-plugins-official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    await handlePlugins(
      { 'existing-plugin@claude-plugins-official': '1.0.0' },
      claudeDir,
      { exec: fakeExec }
    );
    // present + same version + same marketplace → nothing to do
    expect(execCalls).toEqual([]);
  });

  it('aligns a dangling installPath to the actual cached version after a cover pull', async () => {
    // A cover pull restores the source's registry record verbatim — claimed
    // version 6.1.0 + the source's installPath. This machine cached 6.3.0, so
    // the plugin is present (claimed 6.1.0 ≤ cached 6.3.0 → cached=true) and
    // NOT reinstalled; without alignment the registry keeps the source's claim
    // with a dangling installPath, and CC's panel reports "not cached at 6.1.0"
    // even though the plugin is installed and usable. The first pull only
    // "worked" because a reinstall made the CLI rewrite the record — every
    // subsequent cover pull re-broke it.
    const danglingPath = path.join(claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'existing-plugin', '6.1.0');
    const cachedPath = path.join(claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'existing-plugin', '6.3.0');
    fs.mkdirSync(cachedPath, { recursive: true });
    fs.writeFileSync(path.join(cachedPath, 'plugin.js'), '// installed');
    writeInstalledPlugins({
      'existing-plugin@claude-plugins-official': [{ version: '6.1.0', installedAt: '2026-01-01T00:00:00Z', installPath: danglingPath }]
    });

    await handlePlugins(
      { 'existing-plugin@claude-plugins-official': '6.1.0' },
      claudeDir,
      { exec: fakeExec }
    );

    // present (claimed ≤ cached) → never reinstalled
    expect(execCalls).toEqual([]);
    // record aligned to the real cached version + path so CC's panel resolves
    const updated = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
    expect(updated.plugins['existing-plugin@claude-plugins-official'][0].version).toBe('6.3.0');
    expect(updated.plugins['existing-plugin@claude-plugins-official'][0].installPath).toBe(cachedPath);
  });

  it('aligns a dangling installPath to a SHA-cached dir when the claimed version is a SHA', async () => {
    // skill-creator/frontend-design-style claim: the manifest records a git SHA
    // as the version and a source installPath. The plugin is present (SHA claims
    // are always treated as cached) so it is not reinstalled; alignment must
    // point the record at the actual cached SHA dir.
    const danglingPath = path.join(claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'existing-plugin', 'd6947b6f35ad');
    const cachedPath = path.join(claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'existing-plugin', 'b819188d2eea');
    fs.mkdirSync(cachedPath, { recursive: true });
    fs.writeFileSync(path.join(cachedPath, 'plugin.js'), '// installed');
    writeInstalledPlugins({
      'existing-plugin@claude-plugins-official': [{ version: 'd6947b6f35ad', installedAt: '2026-01-01T00:00:00Z', installPath: danglingPath }]
    });

    await handlePlugins(
      { 'existing-plugin@claude-plugins-official': 'd6947b6f35ad' },
      claudeDir,
      { exec: fakeExec }
    );

    expect(execCalls).toEqual([]);
    const updated = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
    expect(updated.plugins['existing-plugin@claude-plugins-official'][0].version).toBe('b819188d2eea');
    expect(updated.plugins['existing-plugin@claude-plugins-official'][0].installPath).toBe(cachedPath);
  });

  it('does not align when the plugin is genuinely absent (nothing cached)', async () => {
    // No cache dir at all → the record stays as-is so the reinstall logic owns
    // the key; alignment must not fabricate a version/path out of thin air.
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'existing-plugin', '1.0.0');
    writeInstalledPlugins({
      'existing-plugin@claude-plugins-official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    await handlePlugins(
      { 'existing-plugin@claude-plugins-official': '1.0.0' },
      claudeDir,
      { exec: fakeExec }
    );
    // reinstalled (cache genuinely missing), record untouched by alignment
    const cmds = execCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds).toContain('claude plugin install existing-plugin@claude-plugins-official');
  });

  it('converges: reinstalls once when the cache is missing, then leaves it alone', async () => {
    // A restore drops the cache dir. First pull reinstalls and, in reality,
    // `claude plugin install` writes the cache files back. A SECOND pull must
    // not reinstall again — the installPath now has content, so the missing
    // record resolves to cached=true and the reinstall loop closes (review I3:
    // repeated pulls against a source whose registry never changes must not
    // keep reinstalling).
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'existing-plugin', '1.0.0');
    writeInstalledPlugins({
      'existing-plugin@claude-plugins-official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    const installingExec = (cmd, args) => {
      execCalls.push({ cmd, args });
      // Simulate `claude plugin install` writing the plugin files back.
      if (cmd === 'claude' && args[1] === 'install') {
        fs.mkdirSync(installPath, { recursive: true });
        fs.writeFileSync(path.join(installPath, 'plugin.js'), '// installed');
      }
      return Buffer.from('');
    };
    const plugins = { 'existing-plugin@claude-plugins-official': '1.0.0' };

    await handlePlugins(plugins, claudeDir, { exec: installingExec });
    expect(execCalls.filter(c => c.args[1] === 'install').length).toBe(1);

    await handlePlugins(plugins, claudeDir, { exec: installingExec });
    expect(execCalls.filter(c => c.args[1] === 'install').length).toBe(1);
  });

  it('does not reinstall on a second pull when the marketplace cannot reach the claimed version', async () => {
    // Source registry claims 0.7.1 but this catalog can only supply 0.7.0.
    // First pull reinstalls; the cache stays at 0.7.0 < 0.7.1, so the claim is
    // unreachable and is recorded in the reinstall-attempts state. A second
    // cover pull must NOT reinstall again — that would loop forever (review I1).
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.1');
    writeInstalledPlugins({
      'claude-hud@claude-hud': [{ version: '0.7.1', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    // The catalog only has 0.7.0: install writes 0.7.0, not the claimed 0.7.1.
    const cachedV070 = path.join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.0');
    const installingExec = (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'claude' && args[1] === 'install') {
        fs.mkdirSync(cachedV070, { recursive: true });
        fs.writeFileSync(path.join(cachedV070, 'plugin.js'), '// installed');
      }
      return Buffer.from('');
    };
    const plugins = { 'claude-hud@claude-hud': '0.7.1' };

    await handlePlugins(plugins, claudeDir, { exec: installingExec });
    expect(execCalls.filter(c => c.args[1] === 'install').length).toBe(1);

    // Second pull: the unreachable claim was recorded → skipped, no reinstall.
    await handlePlugins(plugins, claudeDir, { exec: installingExec });
    expect(execCalls.filter(c => c.args[1] === 'install').length).toBe(1);
  });

  it('retries a recorded-but-unreachable claim once its cooldown expires', async () => {
    // The catalog is assumed to have caught up. A claim recorded 8 days ago
    // (past the 7-day TTL) must be retried, not skipped forever — otherwise a
    // plugin stays permanently behind after its marketplace moves on (review
    // I1-1). The attempts file deliberately has no `.json` suffix so runStatus
    // does not treat it as a tracked file.
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.1');
    writeInstalledPlugins({
      'claude-hud@claude-hud': [{ version: '0.7.1', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    const staleAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(claudeDir, '.claude-sync-install-attempts'),
      JSON.stringify({ 'claude-hud@claude-hud': { version: '0.7.1', at: staleAt } })
    );
    const cachedV071 = path.join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.1');
    const installingExec = (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'claude' && args[1] === 'install') {
        fs.mkdirSync(cachedV071, { recursive: true });
        fs.writeFileSync(path.join(cachedV071, 'plugin.js'), '// installed');
      }
      return Buffer.from('');
    };
    await handlePlugins({ 'claude-hud@claude-hud': '0.7.1' }, claudeDir, { exec: installingExec });
    expect(execCalls.filter(c => c.args[1] === 'install').length).toBe(1);
  });

  it('treats a future-dated attempt as expired so the plugin can be retried', async () => {
    // Clock skew or a hand-edited state file must not extend the cooldown past
    // its TTL — a future `at` reads as expired and the reinstall proceeds
    // (review M-c / M1).
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.1');
    writeInstalledPlugins({
      'claude-hud@claude-hud': [{ version: '0.7.1', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    const futureAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(claudeDir, '.claude-sync-install-attempts'),
      JSON.stringify({ 'claude-hud@claude-hud': { version: '0.7.1', at: futureAt } })
    );
    const cachedV071 = path.join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.1');
    const installingExec = (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'claude' && args[1] === 'install') {
        fs.mkdirSync(cachedV071, { recursive: true });
        fs.writeFileSync(path.join(cachedV071, 'plugin.js'), '// installed');
      }
      return Buffer.from('');
    };
    await handlePlugins({ 'claude-hud@claude-hud': '0.7.1' }, claudeDir, { exec: installingExec });
    expect(execCalls.filter(c => c.args[1] === 'install').length).toBe(1);
  });

  it('clears a recorded unreachable claim once the plugin is genuinely installed', async () => {
    // A manual install satisfied the claim; the stale veto must not block a
    // future cache drop from retrying (review I1-2).
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud', '0.7.1');
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, 'plugin.js'), '// installed');
    writeInstalledPlugins({
      'claude-hud@claude-hud': [{ version: '0.7.1', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    const staleAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(claudeDir, '.claude-sync-install-attempts'),
      JSON.stringify({ 'claude-hud@claude-hud': { version: '0.7.1', at: staleAt } })
    );
    await handlePlugins({ 'claude-hud@claude-hud': '0.7.1' }, claudeDir, { exec: fakeExec });
    // present + cached → nothing to install, and the veto is gone
    expect(execCalls).toEqual([]);
    const attempts = JSON.parse(fs.readFileSync(path.join(claudeDir, '.claude-sync-install-attempts'), 'utf-8'));
    expect(attempts['claude-hud@claude-hud']).toBeUndefined();
  });

  it('does not append a bare key when a legacy install made CC write the marketplace key', async () => {
    // Real CC writes the resolved "name@marketplace" record on install. The
    // bare-name merge must recognize it instead of appending a second, bare key
    // — one plugin, two records, re-pushed and re-installed everywhere (review
    // I2-1).
    writeInstalledPlugins({});
    const installingExec = (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'claude' && args[1] === 'install') {
        writeInstalledPlugins({
          'legacy-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
        });
      }
      return Buffer.from('');
    };
    await handlePlugins({ 'legacy-plugin': '1.0.0' }, claudeDir, { exec: installingExec });
    const registry = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8'));
    expect(registry.plugins['legacy-plugin@official']).toBeDefined();
    expect(registry.plugins['legacy-plugin']).toBeUndefined();
  });

  it('installs a legacy bare-key plugin from the default marketplace when missing', async () => {
    // Old bundles recorded plugins as bare names (no @marketplace). CC's `@`
    // separates plugin@marketplace, so a bare install lets CC resolve the
    // default marketplace — restoring the pre-@key auto-install behavior that
    // the marketplace-qualified rewrite accidentally dropped (review I2).
    writeInstalledPlugins({});
    await handlePlugins(
      { 'legacy-plugin': '1.0.0' },
      claudeDir,
      { exec: fakeExec }
    );
    const cmds = execCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds).toContain('claude plugin install legacy-plugin');
  });

  it('does not install a legacy bare-key plugin that is already present', async () => {
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'legacy-plugin', 'legacy-plugin', '1.0.0');
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, 'plugin.js'), '// installed');
    writeInstalledPlugins({
      'legacy-plugin': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z', installPath }]
    });
    await handlePlugins({ 'legacy-plugin': '1.0.0' }, claudeDir, { exec: fakeExec });
    // already present → bare-key legacy plugin is never reinstalled
    expect(execCalls).toEqual([]);
  });

  it('does not reinstall when the registry record has no installPath (cannot verify)', async () => {
    // Legacy/minimal records carry no installPath; without a path to check there
    // is nothing to prove the plugin is broken, so the conservative read is to
    // treat it as installed and keep the version-mismatch hint behavior.
    writeInstalledPlugins({
      'existing-plugin@claude-plugins-official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
    });
    await handlePlugins(
      { 'existing-plugin@claude-plugins-official': '1.0.0' },
      claudeDir,
      { exec: fakeExec }
    );
    expect(execCalls).toEqual([]);
  });

  it('strategy does not affect plugins: missing installed, existing never touched', async () => {
    writeInstalledPlugins({
      'existing-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
    });
    await handlePlugins(
      { 'existing-plugin@official': '2.0.0', 'new-plugin@official': '1.5.0' },
      claudeDir,
      { exec: fakeExec }
    );

    const cmds = execCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds).toContain('claude plugin install new-plugin@official');
    expect(cmds).not.toContain('claude plugin install existing-plugin@official');
    expect(cmds).not.toContain('claude plugin uninstall existing-plugin');
  });

  it('gracefully absorbs install failures and still resolves', async () => {
    const failingExec = () => { throw new Error('claude: command not found'); };
    const tmpBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-bundle-'));
    try {
      await expect(
        handlePlugins(
          { 'missing-plugin@official': '1.0.0' },
          claudeDir,
          { exec: failingExec, scriptDir: tmpBundle }
        )
      ).resolves.toBeUndefined();
      // fallback script written into the injected dir, not the real home,
      // with the correct name@marketplace syntax
      const script = fs.readFileSync(path.join(tmpBundle, 'install-plugins.sh'), 'utf-8');
      expect(script).toContain('claude plugin install missing-plugin@official');
    } finally {
      fs.rmSync(tmpBundle, { recursive: true, force: true });
    }
  });

  it('legacy manifest: reports an already-installed plugin without reinstalling', async () => {
    writeInstalledPlugins({
      'existing-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
    });
    // Bare key (no @) = legacy manifest with no marketplace recorded
    await handlePlugins({ 'existing-plugin': '1.0.0' }, claudeDir, { exec: fakeExec });
    expect(execCalls).toEqual([]);
  });

  it('legacy manifest: tries a default-marketplace install for a missing plugin with no marketplace', async () => {
    // A bare key records no marketplace, but `claude plugin install <bare>`
    // lets CC resolve the default one (where most legacy-bundle plugins lived).
    // Guess-and-retry beats silently skipping: the wrong/missing plugin lands in
    // the fallback script either way, and an official plugin installs.
    writeInstalledPlugins({});
    await handlePlugins({ 'ghost-plugin': '1.0.0' }, claudeDir, { exec: fakeExec });
    const cmds = execCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds).toContain('claude plugin install ghost-plugin');
  });

  it('installs scoped plugins with their marketplace', async () => {
    writeInstalledPlugins({});
    await handlePlugins({ '@scope/name@official': '1.0.0' }, claudeDir, { exec: fakeExec });
    const cmds = execCalls.map(c => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds).toContain('claude plugin install @scope/name@official');
  });
});

// ==============================
// getClaudeVersion
// ==============================
describe('getClaudeVersion', () => {
  it('returns semver or null without throwing', () => {
    const v = getClaudeVersion();
    // Either null (not installed) or a valid semver
    if (v !== null) {
      expect(v).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

// ============================================================================
// INTEGRATION: resolveSymlinksInDir cross-directory symlink (child_symlink pattern)
//
// Reproduces the real-world scenario:
//   skills/
//     repo-skill/           ← git repo (has .git)
//       SKILL.md
//     wrapper-skill/  ← child_symlink skill
//       SKILL.md  →  ../repo-skill/SKILL.md   (cross-directory symlink)
//
// The symlink must be dereferenced so the tar bundle is self-contained,
// even when resolveSymlinksInDir recurses into subdirectories and the
// ALLOWED_ROOTS would normally narrow to just the child directory.
// ============================================================================
describe('resolveSymlinksInDir — child_symlink integration', () => {
  let stagingDir;

  beforeEach(() => {
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sym-integration-'));
  });

  afterEach(() => {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  it('dereferences child_symlink SKILL.md pointing to sibling git-repo skill', () => {
    const skillsDir = path.join(stagingDir, 'skills');

    // git repo skill: repo-skill/
    const gitSkillDir = path.join(skillsDir, 'repo-skill');
    fs.mkdirSync(gitSkillDir, { recursive: true });
    fs.mkdirSync(path.join(gitSkillDir, '.git'));
    fs.writeFileSync(path.join(gitSkillDir, 'SKILL.md'),
      '---\nname: repo-skill\n---\n\n# Shared skill content\n');

    // child_symlink skill: wrapper-skill/
    const childSkillDir = path.join(skillsDir, 'wrapper-skill');
    fs.mkdirSync(childSkillDir, { recursive: true });
    fs.symlinkSync(
      path.join(gitSkillDir, 'SKILL.md'),
      path.join(childSkillDir, 'SKILL.md')
    );

    // Verify setup: SKILL.md is a symlink
    expect(fs.lstatSync(path.join(childSkillDir, 'SKILL.md')).isSymbolicLink()).toBe(true);

    // Act
    resolveSymlinksInDir(skillsDir);

    // Assert: symlink is dereferenced to a real file
    const childMd = path.join(childSkillDir, 'SKILL.md');
    expect(fs.existsSync(childMd)).toBe(true);
    expect(fs.lstatSync(childMd).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(childMd, 'utf-8')).toContain('Shared skill content');

    // Assert: git skill untouched
    expect(fs.existsSync(path.join(gitSkillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(gitSkillDir, '.git'))).toBe(true);
  });

  it('dereferences multiple child_symlink skills pointing to the same git repo', () => {
    const skillsDir = path.join(stagingDir, 'skills');

    // git repo skill
    const gitDir = path.join(skillsDir, 'repo-skill');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitDir, '.git'));
    fs.writeFileSync(path.join(gitDir, 'SKILL.md'), '---\nname: repo-skill\n---\n');

    // multiple child_symlink skills
    const children = ['sub-skill-a', 'sub-skill-b', 'sub-skill-c', 'sub-skill-d'];
    for (const name of children) {
      // simulate: each child skill has its own sub-skill dir inside repo-skill
      const subDir = path.join(gitDir, name);
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);

      const childDir = path.join(skillsDir, name);
      fs.mkdirSync(childDir, { recursive: true });
      fs.symlinkSync(path.join(subDir, 'SKILL.md'), path.join(childDir, 'SKILL.md'));
    }

    // Verify all are symlinks
    for (const name of children) {
      expect(fs.lstatSync(path.join(skillsDir, name, 'SKILL.md')).isSymbolicLink()).toBe(true);
    }

    // Act
    resolveSymlinksInDir(skillsDir);

    // Assert: all dereferenced
    for (const name of children) {
      const md = path.join(skillsDir, name, 'SKILL.md');
      expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(md, 'utf-8')).toContain(`name: ${name}`);
    }
  });

  it('leaves plain (non-symlink) files untouched', () => {
    const skillsDir = path.join(stagingDir, 'skills');
    const plainDir = path.join(skillsDir, 'my-plain-skill');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'SKILL.md'), '# plain');

    resolveSymlinksInDir(skillsDir);

    expect(fs.lstatSync(path.join(plainDir, 'SKILL.md')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(plainDir, 'SKILL.md'), 'utf-8')).toBe('# plain');
  });

  it('skips symlinks pointing outside staging dir + HOME', () => {
    const skillsDir = path.join(stagingDir, 'skills');
    const skillDir = path.join(skillsDir, 'evil-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    // Symlink pointing to /etc/passwd — outside allowed roots
    fs.symlinkSync('/etc/passwd', path.join(skillDir, 'SKILL.md'));

    // Should not throw
    resolveSymlinksInDir(skillsDir);

    // Symlink should remain (not dereferenced, not removed — it's a security skip)
    const md = path.join(skillDir, 'SKILL.md');
    expect(fs.lstatSync(md).isSymbolicLink()).toBe(true);
  });

  it('removes broken symlinks (target does not exist)', () => {
    const skillsDir = path.join(stagingDir, 'skills');
    const skillDir = path.join(skillsDir, 'dead-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    // Symlink pointing to non-existent target (within allowed root)
    fs.symlinkSync(path.join(skillsDir, 'nonexistent', 'SKILL.md'), path.join(skillDir, 'SKILL.md'));

    // Should not throw
    resolveSymlinksInDir(skillsDir);

    // Broken symlink should be removed
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(false);
  });
});

// ============================================================================
// INTEGRATION: Push flow — detect → resolve symlinks → remove git skills
//
// Simulates the push pipeline: skill types are detected, symlinks dereferenced,
// git/skills_sh skills removed from staging. Verifies child_symlink skills
// remain with dereferenced content.
// ============================================================================
describe('Push pipeline — skills processing', () => {
  let stagingDir, agentsDir;

  beforeEach(() => {
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-push-pipeline-'));
    agentsDir = path.join(stagingDir, '.agents');
  });

  afterEach(() => {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  it('detectSkills classifies git, child_symlink, and plain correctly', () => {
    const skillsDir = path.join(stagingDir, 'skills');

    // git repo
    const gitDir = path.join(skillsDir, 'repo-skill');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitDir, '.git'));
    fs.writeFileSync(path.join(gitDir, 'SKILL.md'), '# repo-skill');

    // child_symlink
    const childDir = path.join(skillsDir, 'sub-skill-a');
    fs.mkdirSync(childDir, { recursive: true });
    fs.symlinkSync(path.join(gitDir, 'SKILL.md'), path.join(childDir, 'SKILL.md'));

    // plain
    const plainDir = path.join(skillsDir, 'my-custom-skill');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'SKILL.md'), '# custom');

    const results = detectSkills(skillsDir, agentsDir);

    const git = results.find(s => s.name === 'repo-skill');
    const child = results.find(s => s.name === 'sub-skill-a');
    const plain = results.find(s => s.name === 'my-custom-skill');

    expect(git.type).toBe('git');
    expect(child.type).toBe('child_symlink');
    expect(child.skillMdTarget).toBe(path.join(gitDir, 'SKILL.md'));
    expect(plain.type).toBe('plain');
  });

  it('push flow: after resolve + remove git, child_symlink has real file in staging', () => {
    const skillsDir = path.join(stagingDir, 'skills');

    // git repo with multiple sub-skills
    const gitDir = path.join(skillsDir, 'repo-skill');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitDir, '.git'));
    fs.writeFileSync(path.join(gitDir, 'SKILL.md'), '---\nname: repo-skill\n---\n');

    const subSkills = ['sub-skill-a', 'sub-skill-b', 'sub-skill-c'];
    for (const name of subSkills) {
      const subDir = path.join(gitDir, name);
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'SKILL.md'), `---\nname: ${name}\n---\n`);

      const childDir = path.join(skillsDir, name);
      fs.mkdirSync(childDir, { recursive: true });
      fs.symlinkSync(path.join(subDir, 'SKILL.md'), path.join(childDir, 'SKILL.md'));
    }

    // plain skill
    const plainDir = path.join(skillsDir, 'my-custom');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'SKILL.md'), '# custom');

    // Step 1: Detect
    const detected = detectSkills(skillsDir, agentsDir);
    const gitSkills = detected.filter(s => s.type === 'git');
    const childSkills = detected.filter(s => s.type === 'child_symlink');
    const plainSkills = detected.filter(s => s.type === 'plain');

    expect(gitSkills).toHaveLength(1);
    expect(childSkills).toHaveLength(3);
    expect(plainSkills).toHaveLength(1);

    // Step 2: Resolve symlinks
    resolveSymlinksInDir(skillsDir);

    // After resolve, child_symlink SKILL.md should be real files
    for (const name of subSkills) {
      const md = path.join(skillsDir, name, 'SKILL.md');
      expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(md, 'utf-8')).toContain(`name: ${name}`);
    }

    // Step 3: Remove git skills from staging
    for (const skill of detected) {
      if (skill.type === 'git') {
        fs.rmSync(path.join(skillsDir, skill.name), { recursive: true, force: true });
      }
    }

    // After removal: git repo gone, child_symlink + plain remain with real files
    expect(fs.existsSync(gitDir)).toBe(false);

    for (const name of subSkills) {
      expect(fs.existsSync(path.join(skillsDir, name))).toBe(true);
      const md = path.join(skillsDir, name, 'SKILL.md');
      expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
    }

    // Plain skill untouched
    expect(fs.existsSync(path.join(plainDir, 'SKILL.md'))).toBe(true);
  });

  it('edge case: child_symlink pointing to git skill that has nested sub-skill directories', () => {
    const skillsDir = path.join(stagingDir, 'skills');

    // git repo with nested structure: repo-skill/sub-skill-d/SKILL.md
    const gitDir = path.join(skillsDir, 'repo-skill');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitDir, '.git'));

    const subDir = path.join(gitDir, 'sub-skill-d');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'SKILL.md'), '---\nname: sub-skill-d\n---\n# Ship workflow\n');

    // child_symlink: sub-skill-d/SKILL.md -> ../repo-skill/sub-skill-d/SKILL.md
    const childDir = path.join(skillsDir, 'sub-skill-d');
    fs.mkdirSync(childDir, { recursive: true });
    // Using relative path to test resolution
    fs.symlinkSync('../repo-skill/sub-skill-d/SKILL.md', path.join(childDir, 'SKILL.md'));

    // Act
    resolveSymlinksInDir(skillsDir);

    // Assert: dereferenced even with relative paths through parent dirs
    const md = path.join(childDir, 'SKILL.md');
    expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(md, 'utf-8')).toBe('---\nname: sub-skill-d\n---\n# Ship workflow\n');
  });
});

// ==============================
// copyIfMissing — keep-strategy JSON fill-the-gaps
// ==============================
describe('copyIfMissing', () => {
  let srcDir, destDir;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-copy-'));
    srcDir = path.join(tmpDir, 'src');
    destDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(srcDir), { recursive: true, force: true });
  });

  it('adds remote keys to an existing local JSON, keeping local values', () => {
    fs.writeFileSync(path.join(destDir, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/.claude/shared-memory' }));
    fs.writeFileSync(path.join(srcDir, 'settings.json'), JSON.stringify({
      autoMemoryDirectory: '~/.claude/shared-memory',
      model: 'opus',
      env: { ANTHROPIC_MODEL: 'opus', ANTHROPIC_AUTH_TOKEN: 'secret' }
    }));

    copyIfMissing(srcDir, destDir);

    const merged = JSON.parse(fs.readFileSync(path.join(destDir, 'settings.json'), 'utf-8'));
    expect(merged.autoMemoryDirectory).toBe('~/.claude/shared-memory');
    expect(merged.model).toBe('opus');
    expect(merged.env.ANTHROPIC_MODEL).toBe('opus');
  });

  it('does not overwrite local values that differ from remote', () => {
    fs.writeFileSync(path.join(destDir, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    fs.writeFileSync(path.join(srcDir, 'settings.json'), JSON.stringify({ model: 'opus', tui: 'fullscreen' }));

    copyIfMissing(srcDir, destDir);

    const merged = JSON.parse(fs.readFileSync(path.join(destDir, 'settings.json'), 'utf-8'));
    expect(merged.model).toBe('sonnet');       // local wins
    expect(merged.tui).toBe('fullscreen');     // remote-only key added
  });

  it('copies a missing JSON file', () => {
    fs.writeFileSync(path.join(srcDir, 'settings.json'), JSON.stringify({ model: 'opus' }));

    copyIfMissing(srcDir, destDir);

    expect(fs.existsSync(path.join(destDir, 'settings.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(destDir, 'settings.json'), 'utf-8')).model).toBe('opus');
  });

  it('does not overwrite an existing non-JSON file', () => {
    fs.writeFileSync(path.join(destDir, 'CLAUDE.md'), 'local');
    fs.writeFileSync(path.join(srcDir, 'CLAUDE.md'), 'remote');

    copyIfMissing(srcDir, destDir);

    expect(fs.readFileSync(path.join(destDir, 'CLAUDE.md'), 'utf-8')).toBe('local');
  });

  it('leaves an unparseable local JSON untouched', () => {
    fs.writeFileSync(path.join(destDir, 'settings.json'), '{ broken');
    fs.writeFileSync(path.join(srcDir, 'settings.json'), JSON.stringify({ model: 'opus' }));

    copyIfMissing(srcDir, destDir);

    expect(fs.readFileSync(path.join(destDir, 'settings.json'), 'utf-8')).toBe('{ broken');
  });
});

// ==============================
// promptMemoryGlobalization — never wipe settings.json
// ==============================
describe('promptMemoryGlobalization', () => {
  let claudeDir, extractDir, userHome;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-memglob-'));
    claudeDir = path.join(tmpDir, 'claude');
    extractDir = path.join(tmpDir, 'extracted');
    userHome = tmpDir;
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    promptYesNo.mockClear();
    promptYesNo.mockResolvedValue(true);
  });

  afterEach(() => {
    fs.rmSync(path.dirname(claudeDir), { recursive: true, force: true });
  });

  const memInfo = { topic_count: 2, auto_memory_directory: '~/.claude/shared-memory' };

  it('restores full remote settings when local settings.json is missing', async () => {
    const bundleSettings = {
      model: 'opus',
      env: { ANTHROPIC_MODEL: 'opus', ANTHROPIC_AUTH_TOKEN: 'sk-real' },
      statusLine: { type: 'command', command: 'echo hi' }
    };
    fs.writeFileSync(path.join(extractDir, 'settings.json'), JSON.stringify(bundleSettings, null, 2));
    fs.mkdirSync(path.join(extractDir, 'shared-memory'), { recursive: true });
    fs.writeFileSync(path.join(extractDir, 'shared-memory', 't.md'), '# t');

    await promptMemoryGlobalization(claudeDir, userHome, extractDir, memInfo, 'keep');

    const written = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(written.autoMemoryDirectory).toBe('~/.claude/shared-memory');
    // Other remote keys must survive — this is the regression that wiped config.
    expect(written.model).toBe('opus');
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-real');
  });

  it('recovers full remote settings when local settings.json is corrupt JSON', async () => {
    // The original regression: applyPathReplacement's raw-text pass broke
    // settings.json with invalid escapes (e.g. "C:\Users\..." → \U), and the
    // old `settings || {}` wiped every other key. readSettings() returns null
    // on corrupt JSON, which must fall back to the bundle copy — not {}.
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ "model": "opus", "env": "broken\\U' );
    const bundleSettings = {
      model: 'opus',
      env: { ANTHROPIC_MODEL: 'opus', ANTHROPIC_AUTH_TOKEN: 'sk-real' },
      statusLine: { type: 'command', command: 'echo hi' }
    };
    fs.writeFileSync(path.join(extractDir, 'settings.json'), JSON.stringify(bundleSettings, null, 2));
    fs.mkdirSync(path.join(extractDir, 'shared-memory'), { recursive: true });
    fs.writeFileSync(path.join(extractDir, 'shared-memory', 't.md'), '# t');

    await promptMemoryGlobalization(claudeDir, userHome, extractDir, memInfo, 'keep');

    const written = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(written.autoMemoryDirectory).toBe('~/.claude/shared-memory');
    // Full remote config must be restored, not wiped to {}.
    expect(written.model).toBe('opus');
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-real');
    expect(written.statusLine.command).toBe('echo hi');
  });

  it('keeps a valid local settings.json and only adds autoMemoryDirectory', async () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    fs.writeFileSync(path.join(extractDir, 'settings.json'), JSON.stringify({ model: 'opus' }));

    await promptMemoryGlobalization(claudeDir, userHome, extractDir, memInfo, 'keep');

    const written = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(written.model).toBe('sonnet');
    expect(written.autoMemoryDirectory).toBe('~/.claude/shared-memory');
  });

  it('does not write settings.json when the user declines', async () => {
    fs.writeFileSync(path.join(extractDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
    promptYesNo.mockResolvedValueOnce(false);

    await promptMemoryGlobalization(claudeDir, userHome, extractDir, memInfo, 'keep');

    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(false);
  });
});
