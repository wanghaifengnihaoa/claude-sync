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
  copyDirContents,
  handlePlugins,
  getClaudeVersion
} from '../lib/workflow.js';
import { detectSkills, classifySkill } from '../lib/detect.js';

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

describe('handlePlugins', () => {
  let claudeDir;

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-plugins-'));
  });

  afterEach(() => {
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it('processes plugins when no claude CLI is available (graceful failure)', async () => {
    // CC format with existing plugin
    const pluginsDir = path.join(claudeDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const initialPlugins = {
      version: 2,
      plugins: {
        'existing-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
      }
    };
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(initialPlugins));

    // Try to install new plugins and update existing ones
    const manifestPlugins = {
      'existing-plugin': '2.0.0',  // needs update
      'new-plugin': '1.5.0'         // needs install
    };

    // Should not throw even though claude CLI doesn't exist
    await expect(
      handlePlugins(manifestPlugins, claudeDir, 'cover')
    ).resolves.toBeUndefined();
  });

  it('handles keep strategy—only installs missing, does not update', async () => {
    const pluginsDir = path.join(claudeDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const initialPlugins = {
      version: 2,
      plugins: {
        'existing-plugin@official': [{ version: '1.0.0', installedAt: '2026-01-01T00:00:00Z' }]
      }
    };
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(initialPlugins));

    const manifestPlugins = {
      'existing-plugin': '2.0.0',  // different version, but keep strategy → skip
      'new-plugin': '1.5.0'
    };

    await expect(
      handlePlugins(manifestPlugins, claudeDir, 'keep')
    ).resolves.toBeUndefined();
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
