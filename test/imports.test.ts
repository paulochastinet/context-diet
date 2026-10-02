import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractImports, MAX_IMPORT_DEPTH, resolveImports } from '../src/imports.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-imports-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('extractImports', () => {
  it('finds path-like @references', () => {
    const text = '@AGENTS.md\nsee @docs/a.md, and @~/x/y.md.\n@./rel.md @../up.md';
    expect(extractImports(text)).toEqual(['AGENTS.md', 'docs/a.md', '~/x/y.md', './rel.md', '../up.md']);
  });

  it('ignores code blocks, inline code, emails and handles', () => {
    const text = [
      'mail me@example.com or ping @octocat',
      '`@inline/code.md`',
      '```',
      '@in/fence.md',
      '```',
      '@real.md',
    ].join('\n');
    expect(extractImports(text)).toEqual(['real.md']);
  });
});

describe('resolveImports', () => {
  it('resolves relative and ~ imports recursively', () => {
    const root = tmp();
    const home = tmp();
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'A @b.md');
    fs.writeFileSync(path.join(root, 'docs', 'b.md'), 'B');
    fs.writeFileSync(path.join(home, 'g.md'), 'global');
    const main = path.join(root, 'CLAUDE.md');
    const text = '@docs/a.md\n@~/g.md\n@missing.md';
    fs.writeFileSync(main, text);
    const out = resolveImports(main, text, home);
    expect(out.map((o) => [path.basename(o.path), o.depth])).toEqual([
      ['a.md', 1],
      ['b.md', 2],
      ['g.md', 1],
    ]);
    expect(out[1]!.parent).toBe(path.join(root, 'docs', 'a.md'));
  });

  it('terminates on cycles and counts each file once', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.md'), 'A @b.md');
    fs.writeFileSync(path.join(root, 'b.md'), 'B @a.md @CLAUDE.md');
    const main = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(main, '@a.md @a.md');
    const out = resolveImports(main, '@a.md @a.md', root);
    expect(out.map((o) => path.basename(o.path))).toEqual(['a.md', 'b.md']);
  });

  it(`stops at depth ${MAX_IMPORT_DEPTH}`, () => {
    const root = tmp();
    for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(root, `f${i}.md`), `level ${i} @f${i + 1}.md`);
    const main = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(main, '@f1.md');
    const out = resolveImports(main, '@f1.md', root);
    expect(out).toHaveLength(MAX_IMPORT_DEPTH);
    expect(Math.max(...out.map((o) => o.depth))).toBe(MAX_IMPORT_DEPTH);
  });
});
