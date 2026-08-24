import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { replaceUserPath, normalizeHomeDir } from '../lib/paths.js';
import { applyPathReplacement } from '../lib/workflow.js';

describe('replaceUserPath', () => {
  const srcHome = '/Users/alice';
  const tgtHome = '/Users/bob';
  const srcWindows = 'C:\\Users\\alice';
  const tgtWindows = 'C:\\Users\\bob';

  it('replaces source home with target home in path strings', () => {
    expect(replaceUserPath('/Users/alice/.claude/settings.json', srcHome, tgtHome))
      .toBe('/Users/bob/.claude/settings.json');
  });

  it('replaces multiple occurrences', () => {
    expect(replaceUserPath('/Users/alice/.claude/ /Users/alice/projects', srcHome, tgtHome))
      .toBe('/Users/bob/.claude/ /Users/bob/projects');
  });

  it('leaves string unchanged when source home not found', () => {
    expect(replaceUserPath('/Users/charlie/.claude/settings.json', srcHome, tgtHome))
      .toBe('/Users/charlie/.claude/settings.json');
  });

  it('does not match substring (alice vs alice2)', () => {
    expect(replaceUserPath('/Users/alice2/.claude/settings.json', srcHome, tgtHome))
      .toBe('/Users/alice2/.claude/settings.json');
  });

  it('handles Windows paths', () => {
    expect(replaceUserPath('C:\\Users\\alice\\.claude\\settings.json', srcWindows, tgtWindows))
      .toBe('C:\\Users\\bob\\.claude\\settings.json');
  });

  it('cross-platform: macOS source → Windows target', () => {
    expect(replaceUserPath('/Users/alice/.claude/settings.json', '/Users/alice', 'C:\\Users\\bob'))
      .toBe('C:\\Users\\bob/.claude/settings.json');
  });
});

// Regression for the known_marketplaces.json corruption bug: applyPathReplacement
// used to raw-replace the source home in every .json/.md file. On Mac→Windows
// pulls the target home "C:\Users\whf" was written with unescaped backslashes,
// which is invalid JSON — Claude Code then failed to load ANY marketplace and
// every `claude plugin install` died with "Invalid escape character U".
// The fix parses JSON, replaces string leaves, and re-stringifies (escaping
// backslashes). These tests pin that contract.
describe('applyPathReplacement JSON safety', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-path-'));

  it('replaces the source home inside JSON strings, keeping the file valid JSON', () => {
    const dir = path.join(tmpBase, 'case1');
    fs.mkdirSync(path.join(dir, 'plugins', 'marketplaces'), { recursive: true });
    const kmp = path.join(dir, 'plugins', 'known_marketplaces.json');
    fs.writeFileSync(kmp, JSON.stringify({
      'claude-plugins-official': {
        installLocation: '/Users/alice/.claude/plugins/marketplaces/claude-plugins-official',
      },
    }, null, 2));

    applyPathReplacement(dir, '/Users/alice', 'C:\\Users\\bob');

    const raw = fs.readFileSync(kmp, 'utf8');
    // Backslashes must be escaped in the raw text, or JSON.parse below throws.
    expect(raw).toContain('C:\\\\Users\\\\bob');
    const parsed = JSON.parse(raw);
    expect(parsed['claude-plugins-official'].installLocation)
      .toBe('C:\\Users\\bob/.claude/plugins/marketplaces/claude-plugins-official');
  });

  it('replaces inside nested arrays and objects', () => {
    const dir = path.join(tmpBase, 'case2');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    const f = path.join(dir, 'sub', 'list.json');
    fs.writeFileSync(f, JSON.stringify({ hooks: ['/Users/alice/a.sh', '/Users/alice/b.sh'] }));

    applyPathReplacement(dir, '/Users/alice', 'C:\\Users\\bob');

    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(parsed.hooks).toEqual(['C:\\Users\\bob/a.sh', 'C:\\Users\\bob/b.sh']);
  });

  it('leaves JSON untouched (and its formatting intact) when the source home is absent', () => {
    const dir = path.join(tmpBase, 'case3');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'plain.json');
    const orig = JSON.stringify({ a: 1, nested: { b: 'no-path-here' } }, null, 2);
    fs.writeFileSync(f, orig);

    applyPathReplacement(dir, '/Users/alice', 'C:\\Users\\bob');

    expect(fs.readFileSync(f, 'utf8')).toBe(orig);
  });

  it('skips an unparseable .json instead of corrupting it with raw replacement', () => {
    const dir = path.join(tmpBase, 'case4');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'broken.json');
    const orig = '{ this is not json, home=/Users/alice }';
    fs.writeFileSync(f, orig);

    applyPathReplacement(dir, '/Users/alice', 'C:\\Users\\bob');

    // Previously the raw replace would inject C:\Users\bob and the file would
    // still be invalid; now we leave unparseable JSON alone entirely.
    expect(fs.readFileSync(f, 'utf8')).toBe(orig);
  });

  it('still raw-replaces markdown files', () => {
    const dir = path.join(tmpBase, 'case5');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'README.md');
    fs.writeFileSync(f, 'copy: /Users/alice/projects');

    applyPathReplacement(dir, '/Users/alice', 'C:\\Users\\bob');

    expect(fs.readFileSync(f, 'utf8')).toBe('copy: C:\\Users\\bob/projects');
  });
});

describe('normalizeHomeDir', () => {
  const home = os.homedir();

  it('converts home path to ~', () => {
    expect(normalizeHomeDir(home + '/projects/foo', home)).toBe('~/projects/foo');
  });

  it('returns path unchanged if it does not start with home', () => {
    expect(normalizeHomeDir('/opt/homebrew/bin/bun', home)).toBe('/opt/homebrew/bin/bun');
  });
});
