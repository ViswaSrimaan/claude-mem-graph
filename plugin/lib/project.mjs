// Maps a working directory to a stable project name. Git worktrees resolve
// to the main repository so memory is shared across branches.
import fs from 'node:fs';
import path from 'node:path';

export function projectRoot(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function mainRepoOfWorktree(root) {
  try {
    const gitPath = path.join(root, '.git');
    if (!fs.statSync(gitPath).isFile()) return root;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'));
    if (!m) return root;
    const gitdir = path.resolve(root, m[1].trim());
    const idx = gitdir.replace(/\\/g, '/').lastIndexOf('/.git/worktrees/');
    if (idx === -1) return root;
    return gitdir.slice(0, idx);
  } catch {
    return root;
  }
}

export function projectName(cwd) {
  if (!cwd) return 'default';
  const root = projectRoot(cwd);
  const base = root ? mainRepoOfWorktree(root) : path.resolve(cwd);
  const name = path.basename(base);
  return name || 'default';
}
