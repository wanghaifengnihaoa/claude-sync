import { describe, it, expect } from 'vitest';
import { visibleLen, blockHeight, pickFromList } from '../lib/prompt.js';

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

// Wide/fullwidth characters (CJK, Hangul, fullwidth punctuation, emoji) occupy
// TWO terminal columns but only one UTF-16 code unit. Measuring them with
// s.length undercounts the wrapped height, which desyncs the cursor-up/erase
// math and re-introduces the stacked-render bug — just triggered by wide text.

describe('visibleLen — wide characters', () => {
  it('counts CJK as two columns each', () => {
    expect(visibleLen('中文测试')).toBe(8); // 4 × 2
  });

  it('counts a mixed ASCII + CJK line by display width', () => {
    expect(visibleLen('a中b')).toBe(4); // 1 + 2 + 1
  });

  it('strips ANSI before applying wide-char width', () => {
    expect(visibleLen('\x1b[7m中文\x1b[0m')).toBe(4);
  });

  it('counts fullwidth punctuation as wide', () => {
    expect(visibleLen('（测试）')).toBe(8); // fullwidth parens + CJK = 4 × 2
  });

  it('counts Hangul syllables as wide', () => {
    expect(visibleLen('한국어')).toBe(6); // 3 × 2
  });

  it('counts Yijing hexagrams, Hangul Jamo Extended and mahjong tiles as wide', () => {
    expect(visibleLen('\u{4DC0}')).toBe(2); // Yijing hexagram #1
    expect(visibleLen('\u{A960}')).toBe(2); // Hangul Jamo Extended-A
    expect(visibleLen('\u{D7B0}')).toBe(2); // Hangul Jamo Extended-B
    expect(visibleLen('🀄')).toBe(2);       // mahjong red dragon (U+1F004)
  });

  it('counts regional indicator letters (flags) as narrow', () => {
    // U+1F1E6-1F1FF regional indicators are EAW=N; two of them form one flag
    // glyph, so a flag measures 2 columns — not 4.
    expect(visibleLen('\u{1F1E6}')).toBe(1);           // regional indicator A
    expect(visibleLen('\u{1F1E8}\u{1F1F3}')).toBe(2);  // CN flag = 2 narrow letters
  });
});

describe('blockHeight — wide characters', () => {
  it('wraps a 45-char CJK line (90 columns) to 2 lines at width 80', () => {
    expect(blockHeight(['中'.repeat(45)], 80)).toBe(2);
  });

  it('wraps a styled CJK line at a narrow width', () => {
    // visible 90 columns at width 20 → 5 terminal lines
    expect(blockHeight([`\x1b[7m${'中'.repeat(45)}\x1b[0m`], 20)).toBe(5);
  });
});

describe('visibleLen — zero-width characters', () => {
  it('counts combining marks as zero width', () => {
    expect(visibleLen('é')).toBe(1); // e + combining acute
  });

  it('counts variation selectors as zero width', () => {
    expect(visibleLen('❤️')).toBe(1); // heart + VS16
  });

  it('counts ZWJ within emoji sequences as zero width', () => {
    expect(visibleLen('\u{1F468}‍\u{1F469}‍\u{1F467}')).toBe(6); // 3 emoji × 2 columns
  });

  it('counts zero-width space, word joiner and BOM as zero width', () => {
    expect(visibleLen('a​b')).toBe(2);   // a + ZWSP + b
    expect(visibleLen('a⁠b')).toBe(2);   // a + word joiner + b
    expect(visibleLen('﻿a')).toBe(1);    // BOM + a
  });
});

// ─────────────────────────────────────────────────────────────
// clearOnDone — interactive path, exercised with a fake TTY
// ─────────────────────────────────────────────────────────────
// pickFromList only takes the interactive branch when stdin & stdout report
// isTTY. We swap in fakes, drive arrow/enter keypresses, and inspect the bytes
// written so the erase-on-finish behavior is pinned down. Regression guard for
// the retry-loop stacking bug: a loop calling pickFromList again (e.g. "Back"
// on rclone setup) must start from a clean line, not append a second copy.

// process.stdin/stdout expose only getters, so swap via defineProperty.
function setProcessIO(name, value) {
  Object.defineProperty(process, name, { value, configurable: true, writable: true });
}

function withFakeTTY() {
  const orig = { stdin: process.stdin, stdout: process.stdout };
  let dataHandler = null;
  const writes = [];
  setProcessIO('stdin', {
    isTTY: true,
    setRawMode() {},
    on(ev, fn) { if (ev === 'data') dataHandler = fn; },
    resume() {},
    pause() {},
    removeListener() {}
  });
  setProcessIO('stdout', {
    isTTY: true,
    columns: 80,
    write(s) { writes.push(s); }
  });
  return {
    writes,
    type(key) { dataHandler(Buffer.from(key)); },
    restore() { setProcessIO('stdin', orig.stdin); setProcessIO('stdout', orig.stdout); }
  };
}

describe('pickFromList clearOnDone', () => {
  it('erases its own render before resolving when clearOnDone is set', async () => {
    const tty = withFakeTTY();
    try {
      const p = pickFromList('Choose:', ['a', 'b'], 'a', undefined, undefined, true);
      tty.type('\r');
      const result = await p;
      expect(result).toBe('a');
      const out = tty.writes.join('');
      // finished with cursor-up to block top + erase-below, then show cursor
      expect(out).toMatch(/\r\x1b\[\d+A\x1b\[J\x1b\[\?25h$/);
      // never falls back to DEC save/restore or SCOSC/SCOC
      expect(out).not.toMatch(/\x1b7|\x1b8|\x1b\[s|\x1b\[u/);
    } finally {
      tty.restore();
    }
  });

  it('keeps the render on screen when clearOnDone is omitted', async () => {
    const tty = withFakeTTY();
    try {
      const p = pickFromList('Choose:', ['a', 'b'], 'a');
      tty.type('\r');
      const result = await p;
      expect(result).toBe('a');
      const out = tty.writes.join('');
      // default: newline + show cursor, no erase-back
      expect(out).toMatch(/\n\x1b\[\?25h$/);
      expect(out).not.toMatch(/\r\x1b\[/);
    } finally {
      tty.restore();
    }
  });

  it('erases on q/Escape abort too', async () => {
    const tty = withFakeTTY();
    try {
      const p = pickFromList('Choose:', ['a', 'b'], 'b', undefined, undefined, true);
      tty.type('q');
      const result = await p;
      expect(result).toBe('b');
      const out = tty.writes.join('');
      expect(out).toMatch(/\r\x1b\[\d+A\x1b\[J\x1b\[\?25h$/);
    } finally {
      tty.restore();
    }
  });

  it('each loop iteration clears the previous render (no stacking)', async () => {
    const tty = withFakeTTY();
    try {
      const p1 = pickFromList('Choose:', ['a', 'b'], 'a', undefined, undefined, true);
      tty.type('\r');
      expect(await p1).toBe('a');
      const p2 = pickFromList('Choose:', ['a', 'b'], 'a', undefined, undefined, true);
      tty.type('\r');
      expect(await p2).toBe('a');
      const out = tty.writes.join('');
      // every confirm must emit an erase-back, so renders never stack
      const erases = out.match(/\r\x1b\[\d+A\x1b\[J/g);
      expect(erases).not.toBeNull();
      expect(erases.length).toBe(2);
    } finally {
      tty.restore();
    }
  });
});
