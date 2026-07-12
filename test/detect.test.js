import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectSkills, classifySkill } from '../lib/detect.js';

describe('classifySkill', () => {
  it('classifies as skills.sh when skill is listed in skillsLock', () => {
    const skillsLock = {
      skills: [{ name: 'my-skill', source: 'github.com/user/my-skill' }]
    };

    const result = classifySkill('my-skill', '/fake/path/skills/my-skill', skillsLock);
    expect(result.type).toBe('skills_sh');
    expect(result.source).toBe('github.com/user/my-skill');
  });

  it('classifies as git when directory has .git subdirectory', () => {
    const skillsLock = { skills: [] };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));
    const skillDir = path.join(tmpDir, 'skills', 'my-git-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(path.join(skillDir, '.git'));

    try {
      const result = classifySkill('my-git-skill', skillDir, skillsLock);
      expect(result.type).toBe('git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('classifies as git when directory has .git file (worktree)', () => {
    const skillsLock = { skills: [] };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));
    const skillDir = path.join(tmpDir, 'skills', 'my-worktree-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.git'), 'gitdir: /some/path/.git/worktrees/xxx');

    try {
      const result = classifySkill('my-worktree-skill', skillDir, skillsLock);
      expect(result.type).toBe('git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('classifies as symlink when skills/<name> is a symlink', () => {
    const skillsLock = { skills: [] };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));
    const realDir = path.join(tmpDir, 'real-skill');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'SKILL.md'), '# My Skill');

    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const symlinkPath = path.join(skillsDir, 'my-symlink-skill');
    fs.symlinkSync(realDir, symlinkPath);

    try {
      const result = classifySkill('my-symlink-skill', symlinkPath, skillsLock);
      expect(result.type).toBe('symlink');
      expect(result.target).toBe(realDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('classifies as child_symlink when SKILL.md inside is a symlink', () => {
    const skillsLock = { skills: [] };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));
    const skillDir = path.join(tmpDir, 'skills', 'my-child-symlink-skill');
    fs.mkdirSync(skillDir, { recursive: true });

    const realSkillMd = path.join(tmpDir, 'real-repo', 'SKILL.md');
    fs.mkdirSync(path.dirname(realSkillMd), { recursive: true });
    fs.writeFileSync(realSkillMd, '# Real SKILL.md');

    fs.symlinkSync(realSkillMd, path.join(skillDir, 'SKILL.md'));

    try {
      const result = classifySkill('my-child-symlink-skill', skillDir, skillsLock);
      expect(result.type).toBe('child_symlink');
      expect(result.skillMdTarget).toBe(realSkillMd);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('classifies as plain when none of the above', () => {
    const skillsLock = { skills: [] };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));
    const skillDir = path.join(tmpDir, 'skills', 'my-plain-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Plain Skill');

    try {
      const result = classifySkill('my-plain-skill', skillDir, skillsLock);
      expect(result.type).toBe('plain');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('detectSkills', () => {
  it('detects and classifies all skills in a skills directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));

    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    // Plain skill
    const plainDir = path.join(skillsDir, 'plain-skill');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'SKILL.md'), '# Plain');

    // Git skill
    const gitDir = path.join(skillsDir, 'git-skill');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitDir, '.git'));

    // Skills.sh skill (in lock file)
    const skillsLockDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(skillsLockDir, { recursive: true });
    const skillsLock = {
      skills: [{ name: 'ssh-skill', source: 'github.com/user/ssh-skill' }]
    };
    fs.writeFileSync(path.join(skillsLockDir, '.skill-lock.json'), JSON.stringify(skillsLock));

    try {
      const result = detectSkills(skillsDir, skillsLockDir);
      expect(result).toHaveLength(2); // plain-skill + git-skill (ssh-skill not in skills dir)
      expect(result.find(s => s.name === 'plain-skill').type).toBe('plain');
      expect(result.find(s => s.name === 'git-skill').type).toBe('git');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty array for non-existent skills directory', () => {
    const result = detectSkills('/nonexistent/skills', '/nonexistent/.agents');
    expect(result).toEqual([]);
  });

  it('detection order: skills.sh lock takes priority over git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-test-'));

    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    // A skill that is both a git repo AND in skills.sh lock
    const skillDir = path.join(skillsDir, 'dual-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(path.join(skillDir, '.git'));

    const lockDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, '.skill-lock.json'), JSON.stringify({
      skills: [{ name: 'dual-skill', source: 'github.com/user/dual-skill' }]
    }));

    try {
      const result = detectSkills(skillsDir, lockDir);
      const dual = result.find(s => s.name === 'dual-skill');
      // skills.sh lock should take priority over git detection
      expect(dual.type).toBe('skills_sh');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
