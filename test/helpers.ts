import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const ROOT = path.resolve(FIXTURES, '..', '..');
export const CLI = path.join(ROOT, 'dist', 'cli.js');

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  cleanup: () => void;
}

function copyDir(src: string, dest: string, replace: (s: string) => string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const name = e.name === '_git' ? '.git' : e.name;
    const s = path.join(src, e.name);
    const d = path.join(dest, name);
    if (e.isDirectory()) copyDir(s, d, replace);
    else fs.writeFileSync(d, replace(fs.readFileSync(s, 'utf8')));
  }
}

/**
 * Copy test/fixtures/{home,project} into a fresh temp dir, replacing placeholders:
 * {{NODE}} (node binary), {{FIXTURES}} (absolute fixtures dir), {{PROJECT}} (project path).
 */
export function makeSandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-diet-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const replace = (s: string) =>
    s
      .replaceAll('{{NODE}}', process.execPath.replaceAll('\\', '/'))
      .replaceAll('{{FIXTURES}}', FIXTURES.replaceAll('\\', '/'))
      .replaceAll('{{PROJECT}}', project.replaceAll('\\', '\\\\'));
  copyDir(path.join(FIXTURES, 'home'), home, replace);
  copyDir(path.join(FIXTURES, 'project'), project, replace);
  return { root, home, project, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Minimal env for spawned servers (PATH is needed for `node`). */
export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', ...extra };
}
