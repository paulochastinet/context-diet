import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCodexConfig } from '../src/agents/codex.js';
import { makeContext, scanAgents } from '../src/profile.js';
import type { AgentId, AgentScan } from '../src/types.js';
import { makeSandbox, testEnv, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeAll(() => {
  sb = makeSandbox();
});
afterAll(() => sb.cleanup());

function scan(id: AgentId, cwd = sb.project, env = testEnv()): AgentScan {
  const ctx = makeContext({ cwd, home: sb.home, ceiling: sb.root, env });
  return scanAgents(ctx, [id])[0]!;
}

const names = (s: AgentScan, kind?: string) =>
  s.sources.filter((x) => !kind || x.kind === kind).map((x) => x.displayPath ?? x.name);

describe('Claude Code', () => {
  it('collects memory files, imports, skills, subagents and commands', () => {
    const s = scan('claude');
    expect(s.detected).toBe(true);
    expect(names(s, 'instructions')).toEqual(['~/.claude/CLAUDE.md', 'CLAUDE.md', 'CLAUDE.local.md']);
    expect(names(s, 'import')).toEqual([
      '~/.claude/rules/style.md',
      '~/.claude/shared.md',
      'AGENTS.md',
      'docs/cycle-a.md',
      'docs/cycle-b.md',
    ]);
    const imp = s.sources.find((x) => x.displayPath === 'docs/cycle-b.md')!;
    expect(imp.parent).toBe('docs/cycle-a.md');
    expect(imp.depth).toBe(2);
    expect(s.sources.filter((x) => x.kind === 'skill').map((x) => x.name).sort()).toEqual([
      'local-skill',
      'pdf',
      'verbose-skill',
    ]);
    expect(s.sources.filter((x) => x.kind === 'subagent').map((x) => x.name)).toEqual(['reviewer']);
    expect(s.sources.filter((x) => x.kind === 'command').map((x) => x.name)).toEqual(['/git:ship']);
  });

  it('counts only skill metadata as always-loaded and the body as on-demand', () => {
    const s = scan('claude');
    const pdf = s.sources.find((x) => x.name === 'pdf')!;
    expect(pdf.loading).toBe('always');
    expect(pdf.tokens).toBeGreaterThan(5);
    expect(pdf.tokens).toBeLessThan(30);
    expect(pdf.onDemandTokens).toBeGreaterThan(40);
  });

  it('walks up from a subdirectory', () => {
    const s = scan('claude', path.join(sb.project, 'sub'));
    expect(names(s, 'instructions')).toContain('CLAUDE.md'); // sub/CLAUDE.md, relative to cwd
    expect(names(s, 'instructions')).toContain('../CLAUDE.md');
  });

  it('merges user, project and local MCP servers and honours disabled lists', () => {
    const s = scan('claude', sb.project, testEnv({ FIXTURE_TOKEN: 'tok' }));
    const byName = Object.fromEntries(s.mcp.map((m) => [m.name, m]));
    expect(Object.keys(byName).sort()).toEqual(['disabled-one', 'fixture', 'local-only', 'project-fixture', 'remote-api']);
    expect(byName['disabled-one']!.disabled).toBe(true);
    expect(byName['local-only']!.scope).toBe('local');
    expect(byName['project-fixture']!.scope).toBe('project');
    expect(byName['remote-api']!.transport).toBe('http');
    expect(byName['remote-api']!.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('notes enabled plugins', () => {
    fs.writeFileSync(
      path.join(sb.home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'vercel@market': true, 'off@market': false } }),
    );
    const s = scan('claude');
    expect(s.notes.join('\n')).toMatch(/1 plugin\(s\) enabled \(vercel\)/);
    fs.rmSync(path.join(sb.home, '.claude', 'settings.json'));
  });
});

describe('Codex CLI', () => {
  it('reads the global file and the AGENTS.md hierarchy from repo root to cwd', () => {
    const s = scan('codex', path.join(sb.project, 'sub'));
    expect(names(s, 'instructions')).toEqual(['~/.codex/AGENTS.md', '../AGENTS.md', 'AGENTS.md']);
    expect(s.sources.filter((x) => x.kind === 'skill').map((x) => x.name)).toEqual(['codex-skill']);
  });

  it('prefers AGENTS.override.md', () => {
    const override = path.join(sb.project, 'AGENTS.override.md');
    fs.writeFileSync(override, 'override');
    try {
      expect(names(scan('codex'), 'instructions')).toEqual(['~/.codex/AGENTS.md', 'AGENTS.override.md']);
    } finally {
      fs.rmSync(override);
    }
  });

  it('parses [mcp_servers.*] from config.toml', () => {
    const s = scan('codex', sb.project, testEnv({ DOCS_TOKEN: 'abc' }));
    const byName = Object.fromEntries(s.mcp.map((m) => [m.name, m]));
    expect(byName.fixture!.transport).toBe('stdio');
    expect(byName.fixture!.args![0]).toMatch(/mcp-server\.mjs$/);
    expect(byName.off!.disabled).toBe(true);
    expect(byName.docs!.url).toBe('https://docs.example.invalid/mcp');
    expect(byName.docs!.headers).toEqual({ Authorization: 'Bearer abc' });
  });

  it('reports invalid TOML instead of crashing', () => {
    const file = path.join(sb.root, 'bad.toml');
    fs.writeFileSync(file, '[mcp_servers.x\ncommand = ');
    const r = readCodexConfig(file);
    expect(r.data).toBeNull();
    expect(r.error).toBeTruthy();
    expect(readCodexConfig(path.join(sb.root, 'nope.toml'))).toEqual({ data: null });
  });

  it('warns when project docs exceed the 32 KiB limit', () => {
    const big = path.join(sb.project, 'sub', 'AGENTS.md');
    const orig = fs.readFileSync(big, 'utf8');
    fs.writeFileSync(big, 'x '.repeat(20_000));
    try {
      expect(scan('codex', path.join(sb.project, 'sub')).notes.join(' ')).toMatch(/truncates/);
    } finally {
      fs.writeFileSync(big, orig);
    }
  });
});

describe('Gemini CLI', () => {
  it('reads GEMINI.md files, extensions and JSONC settings', () => {
    const s = scan('gemini');
    expect(names(s, 'instructions')).toEqual(['~/.gemini/GEMINI.md', 'GEMINI.md', '~/.gemini/extensions/ext1/EXT.md']);
    const byName = Object.fromEntries(s.mcp.map((m) => [m.name, m]));
    expect(Object.keys(byName).sort()).toEqual(['excluded-one', 'ext-server', 'fixture']);
    expect(byName['excluded-one']!.disabled).toBe(true);
    expect(byName['ext-server']!.scope).toBe('extension');
  });

  it('honours context.fileName from settings', () => {
    const settings = path.join(sb.project, '.gemini', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ context: { fileName: ['AGENTS.md', 'GEMINI.md'] } }));
    try {
      expect(names(scan('gemini'), 'instructions')).toEqual(
        expect.arrayContaining(['AGENTS.md', 'GEMINI.md', '~/.gemini/GEMINI.md']),
      );
    } finally {
      fs.rmSync(settings);
    }
  });
});

describe('Cursor', () => {
  it('separates alwaysApply rules from conditional ones', () => {
    const s = scan('cursor');
    const always = s.sources.filter((x) => x.loading === 'always').map((x) => x.name);
    const conditional = s.sources.filter((x) => x.loading === 'conditional').map((x) => x.name);
    expect(always).toEqual(
      expect.arrayContaining(['.cursorrules', 'always.mdc', 'requested.mdc (description)', 'cursor-skill']),
    );
    expect(conditional.sort()).toEqual(['frontend/react.mdc', 'requested.mdc']);
    expect(s.mcp.map((m) => [m.name, !!m.disabled])).toEqual([
      ['cursor-fixture', false],
      ['off', true],
    ]);
  });
});

describe('VS Code / Copilot', () => {
  it('reads copilot-instructions, path instructions and .vscode/mcp.json servers', () => {
    const s = scan('vscode');
    expect(names(s, 'instructions')).toEqual(['.github/copilot-instructions.md']);
    const rule = s.sources.find((x) => x.kind === 'rule')!;
    expect(rule.loading).toBe('conditional');
    expect(rule.note).toBe('applyTo: **/*.test.ts');
    const byName = Object.fromEntries(s.mcp.map((m) => [m.name, m]));
    expect(byName['vscode-fixture']!.cwd).toBe(sb.project);
    expect(byName['needs-input']!.unresolved).toEqual(['${input:token}']);
  });
});

describe('detection', () => {
  it('reports nothing for an empty home and project', () => {
    const empty = path.join(sb.root, 'empty');
    fs.mkdirSync(path.join(empty, 'home'), { recursive: true });
    fs.mkdirSync(path.join(empty, 'proj'), { recursive: true });
    const ctx = makeContext({ cwd: path.join(empty, 'proj'), home: path.join(empty, 'home'), ceiling: empty, env: {} });
    for (const s of scanAgents(ctx)) {
      expect(s.detected, s.id).toBe(false);
      expect(s.sources).toEqual([]);
    }
  });
});
