import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { replaceUserPath, normalizeHomeDir } from '../lib/paths.js';

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

describe('normalizeHomeDir', () => {
  const home = os.homedir();

  it('converts home path to ~', () => {
    expect(normalizeHomeDir(home + '/projects/foo', home)).toBe('~/projects/foo');
  });

  it('returns path unchanged if it does not start with home', () => {
    expect(normalizeHomeDir('/opt/homebrew/bin/bun', home)).toBe('/opt/homebrew/bin/bun');
  });
});
