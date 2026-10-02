import path from 'node:path';
import { readText, realpath } from './fsutil.js';

export interface ImportedFile {
  path: string;
  parent: string;
  depth: number;
  text: string;
}

export const MAX_IMPORT_DEPTH = 5;

/**
 * Extract `@path` import references (Claude Code / Gemini CLI memory syntax).
 * Ignores fenced code blocks, inline code spans and e-mail-like tokens.
 */
export function extractImports(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.replace(/`[^`]*`/g, ' ');
    const re = /(^|\s)@((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9_.\-][^\s]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      let ref = m[2]!.replace(/[),.;:!?\]]+$/, '');
      if (!ref || ref.includes('@')) continue;
      // Require something path-like: a slash or a file extension.
      if (!ref.includes('/') && !/\.[A-Za-z0-9]+$/.test(ref)) continue;
      out.push(ref);
    }
  }
  return out;
}

function resolveRef(ref: string, fromFile: string, home: string): string {
  if (ref.startsWith('~/')) return path.join(home, ref.slice(2));
  if (path.isAbsolute(ref)) return ref;
  return path.resolve(path.dirname(fromFile), ref);
}

/**
 * Recursively resolve imports of `rootFile` (whose contents are `rootText`).
 * Cycles and already-seen files are skipped; depth is capped at MAX_IMPORT_DEPTH.
 * `seen` is shared so a file imported twice is only counted once.
 */
export function resolveImports(
  rootFile: string,
  rootText: string,
  home: string,
  seen: Set<string> = new Set(),
): ImportedFile[] {
  const out: ImportedFile[] = [];
  seen.add(realpath(rootFile));
  const visit = (file: string, text: string, depth: number) => {
    if (depth >= MAX_IMPORT_DEPTH) return;
    for (const ref of extractImports(text)) {
      const abs = resolveRef(ref, file, home);
      const real = realpath(abs);
      if (seen.has(real)) continue;
      const child = readText(abs);
      if (child == null) continue;
      seen.add(real);
      out.push({ path: abs, parent: file, depth: depth + 1, text: child });
      visit(abs, child, depth + 1);
    }
  };
  visit(rootFile, rootText, 0);
  return out;
}
