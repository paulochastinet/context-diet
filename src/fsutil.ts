import fs from 'node:fs';
import path from 'node:path';

export function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readJson(file: string): unknown {
  const text = readText(file);
  if (text == null) return undefined;
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return undefined;
  }
}

/** Removes // and /* *\/ comments and trailing commas (JSONC, as used by VS Code / Gemini). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Dirent may be a symlink; resolve whether it points at a directory/file. */
export function direntIsDir(dir: string, d: fs.Dirent): boolean {
  if (d.isDirectory()) return true;
  if (d.isSymbolicLink()) return isDir(path.join(dir, d.name));
  return false;
}

export function direntIsFile(dir: string, d: fs.Dirent): boolean {
  if (d.isFile()) return true;
  if (d.isSymbolicLink()) {
    try {
      return fs.statSync(path.join(dir, d.name)).isFile();
    } catch {
      return false;
    }
  }
  return false;
}

/** Nearest ancestor (inclusive) containing `.git`, or null. */
export function findRepoRoot(start: string, ceiling?: string): string | null {
  for (const dir of ancestors(start, ceiling)) {
    if (exists(path.join(dir, '.git'))) return dir;
  }
  return null;
}

/** start, parent, grandparent ... up to filesystem root or ceiling (inclusive). */
export function ancestors(start: string, ceiling?: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(start);
  const stop = ceiling ? path.resolve(ceiling) : null;
  for (;;) {
    out.push(dir);
    if (stop && dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/** Directories from `root` down to `cwd` (inclusive). If cwd is not under root, just [cwd]. */
export function rootToCwd(root: string | null, cwd: string): string[] {
  if (!root) return [path.resolve(cwd)];
  const rel = path.relative(root, cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [path.resolve(cwd)];
  const parts = rel ? rel.split(path.sep) : [];
  const out = [path.resolve(root)];
  let cur = path.resolve(root);
  for (const p of parts) {
    cur = path.join(cur, p);
    out.push(cur);
  }
  return out;
}

/** Recursively find files matching `match`, with a depth limit, skipping heavy dirs. */
export function walkFiles(
  dir: string,
  match: (name: string) => boolean,
  maxDepth = 6,
  depth = 0,
): string[] {
  if (depth > maxDepth) return [];
  const out: string[] = [];
  for (const d of listDir(dir)) {
    if (d.name === 'node_modules' || d.name === '.git') continue;
    const full = path.join(dir, d.name);
    if (direntIsDir(dir, d)) out.push(...walkFiles(full, match, maxDepth, depth + 1));
    else if (direntIsFile(dir, d) && match(d.name)) out.push(full);
  }
  return out.sort();
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Friendly path: relative to cwd when inside it (or inside the same repo, as ../x),
 * `~/...` under home, otherwise absolute.
 */
export function displayPath(abs: string, cwd: string, home: string, repoRoot?: string | null): string {
  const rel = path.relative(cwd, abs);
  if (rel === '') return '.';
  if (inside(abs, cwd) || (repoRoot && inside(abs, repoRoot) && inside(cwd, repoRoot))) {
    return rel.split(path.sep).join('/');
  }
  const relHome = path.relative(home, abs);
  if (!relHome.startsWith('..') && !path.isAbsolute(relHome)) {
    return relHome ? `~/${relHome.split(path.sep).join('/')}` : '~';
  }
  return abs;
}
