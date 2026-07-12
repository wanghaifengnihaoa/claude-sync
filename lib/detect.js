/**
 * Skill detection and classification for claude-sync.
 * Detects 5 types: skills_sh, git, symlink, child_symlink, plain.
 * Detection order: skills.sh lock → git → symlink → child_symlink → plain.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// execFileSync used only for 'git rev-parse' and 'git remote get-url' with
// fixed string arguments (no user input interpolated into the command).

/**
 * Classify a single skill by its directory path.
 */
export function classifySkill(name, skillPath, skillsLock) {
  // 1. Check skills.sh lock first (highest priority)
  const lockEntry = findInSkillsLock(name, skillsLock);
  if (lockEntry) {
    // Extract hash from the lock entry (field name varies: skillFolderHash, folderHash, hash)
    const folderHash = lockEntry.skillFolderHash || lockEntry.folderHash || lockEntry.hash || '';
    return { type: 'skills_sh', name, source: lockEntry.source, folderHash };
  }

  // 2. Check if git repository (has .git file or directory)
  if (isGitRepo(skillPath)) {
    const gitInfo = getGitInfo(skillPath);
    return { type: 'git', name, ...gitInfo };
  }

  // 3. Check if the skill directory itself is a symlink
  try {
    const lstat = fs.lstatSync(skillPath);
    if (lstat.isSymbolicLink()) {
      return { type: 'symlink', name, target: fs.readlinkSync(skillPath) };
    }
  } catch {
    // path doesn't exist — handled by caller
  }

  // 4. Check if SKILL.md inside is a symlink (child symlink)
  const skillMdPath = path.join(skillPath, 'SKILL.md');
  try {
    const mdStat = fs.lstatSync(skillMdPath);
    if (mdStat.isSymbolicLink()) {
      return { type: 'child_symlink', name, skillMdTarget: fs.readlinkSync(skillMdPath) };
    }
  } catch {
    // no SKILL.md symlink — fall through
  }

  // 5. Plain skill (regular directory)
  return { type: 'plain', name };
}

/**
 * Detect and classify all skills in a skills directory.
 * Returns an array of skill classifications.
 */
export function detectSkills(skillsDir, agentsDir) {
  const results = [];

  // Read skills.sh lock file if it exists
  let skillsLock = { skills: [] };
  try {
    const lockPath = path.join(agentsDir, '.skill-lock.json');
    if (fs.existsSync(lockPath)) {
      skillsLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    }
  } catch {
    // Lock file unreadable — treat as empty
  }

  // Check if skills directory exists
  if (!fs.existsSync(skillsDir)) {
    return results;
  }

  let entries;
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry);
    try {
      const stat = fs.statSync(skillPath);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        const classification = classifySkill(entry, skillPath, skillsLock);
        results.push(classification);
      }
    } catch {
      // skip unreadable entries
    }
  }

  return results;
}

function findInSkillsLock(name, skillsLock) {
  if (!skillsLock || !Array.isArray(skillsLock.skills)) {
    return null;
  }
  return skillsLock.skills.find(s => s.name === name) || null;
}

function isGitRepo(dirPath) {
  const gitPath = path.join(dirPath, '.git');
  try {
    return fs.existsSync(gitPath);
  } catch {
    return false;
  }
}

function getGitInfo(dirPath) {
  try {
    const opts = { cwd: dirPath, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 };
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], opts).trim();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
    const hasPackageJson = fs.existsSync(path.join(dirPath, 'package.json'));
    return { remote, commit, branch, hasPackageJson };
  } catch {
    return { remote: '', commit: '', branch: '', hasPackageJson: false };
  }
}
