import { describe, it, expect } from 'vitest';
import { visibleLen, blockHeight } from '../lib/prompt.js';

// Regression for the duplicated-list-render bug: pickFromList used to redraw
// via cursor save/restore (ESC[s/ESC[u), which some Windows terminals silently
// ignore — each arrow key *appended* a fresh copy of the list. The fix redraws
// with CSI cursor-up + erase-below, whose line count comes from blockHeight().
// These tests pin the height math so a long/wrapped item can't desync it.

describe('visibleLen', () => {
  it('strips ANSI styling for visible width', () => {
    expect(visibleLen('\x1b[7mhello\x1b[0m')).toBe(5);
  });

  it('counts plain text as-is', () => {
    expect(visibleLen('What would you like to do?')).toBe(26);
  });

  it('empty line has zero width', () => {
    expect(visibleLen('')).toBe(0);
  });
});

describe('blockHeight', () => {
  it('counts one terminal line per rendered line', () => {
    expect(blockHeight(['What would you like to do?', '', '    1) a', '    2) b', ''], 80)).toBe(5);
  });

  it('blank lines still occupy one terminal line', () => {
    expect(blockHeight([''], 80)).toBe(1);
  });

  it('counts wrapped lines for over-wide content', () => {
    // 45 chars at width 20 → 3 terminal lines
    expect(blockHeight(['x'.repeat(45)], 20)).toBe(3);
  });

  it('strips ANSI codes before measuring width', () => {
    // styled long line: visible 45 chars at width 10 → 5 lines
    expect(blockHeight([`\x1b[7m${'x'.repeat(45)}\x1b[0m`], 10)).toBe(5);
  });
});
