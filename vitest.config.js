import { defineConfig } from "vitest/config";

/**
 * Vite (used by Vitest) does not strip shebangs when transforming ESM modules
 * for tests. Importing claude-sync.js — which starts with `#!/usr/bin/env node` —
 * throws `SyntaxError: Invalid or unexpected token` in Vitest on some platforms
 * (notably Windows). This plugin strips the shebang before esbuild transforms,
 * so tests can import the CLI entry module directly.
 */
function stripShebang() {
  return {
    name: 'strip-shebang',
    enforce: 'pre',
    transform(code) {
      if (code.startsWith('#!')) {
        return code.replace(/^#![^\r\n]*\r?\n?/, '');
      }
      return null;
    }
  };
}

export default defineConfig({
  plugins: [stripShebang()],
  test: { testTimeout: 30000 }
});
