import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  copyDirContents
} from '../lib/workflow.js';

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
