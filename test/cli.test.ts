import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI, makeSandbox, testEnv, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error('dist/cli.js missing: run `npm run build` first');
  sb = makeSandbox();
});
afterAll(() => sb.cleanup());

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, '--cwd', sb.project, '--home', sb.home, ...args], {
    encoding: 'utf8',
    env: testEnv(env),
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('cli', () => {
  it('prints help and version', () => {
    const h = run(['--help']);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('--max-tokens');
    expect(run(['--version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 2 on usage errors', () => {
    expect(run(['--bogus']).code).toBe(2);
    const bad = run(['--agent', 'notepad']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/unknown agent "notepad"/);
    expect(run(['--max-tokens', 'lots']).code).toBe(2);
    expect(run(['--json', '--markdown']).code).toBe(2);
  });

  it('exits 1 when an agent exceeds --max-tokens, 0 otherwise', () => {
    const over = run(['--no-mcp', '--agent', 'claude', '--max-tokens', '10']);
    expect(over.code).toBe(1);
    expect(over.stdout).toMatch(/Claude Code exceeds the budget/);
    const under = run(['--no-mcp', '--agent', 'claude', '--max-tokens', '1m']);
    expect(under.code).toBe(0);
    expect(under.stdout).toMatch(/within budget/);
  });

  it('reports which agent is over budget in --json mode on stderr', () => {
    const r = run(['--no-mcp', '--json', '--agent', 'codex,claude', '--max-tokens', '10']);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(json.budget.exceeded.sort()).toEqual(['claude', 'codex']);
    expect(json.agents.map((a: { id: string }) => a.id)).toEqual(['claude', 'codex']);
    expect(r.stderr).toMatch(/over budget/);
  });

  it('produces markdown', () => {
    const r = run(['--no-mcp', '--markdown']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^## context-diet report/);
  });

  it('respects NO_COLOR / non-TTY and FORCE_COLOR', () => {
    expect(run(['--no-mcp']).stdout).not.toMatch(/\x1b\[/);
    expect(run(['--no-mcp'], { NO_COLOR: '1', FORCE_COLOR: '1' }).stdout).not.toMatch(/\x1b\[/);
    expect(run(['--no-mcp'], { FORCE_COLOR: '1' }).stdout).toMatch(/\x1b\[/);
  });

  it('launches MCP servers, prints the notice, and never crashes on failing ones', () => {
    const r = run(['--agent', 'claude,vscode', '--timeout', '15000', '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/MCP servers? locally/);
    const json = JSON.parse(r.stdout);
    const statuses = Object.fromEntries(json.mcpServers.map((s: { name: string; status: string }) => [s.name, s.status]));
    expect(statuses.fixture).toBe('ok');
    expect(statuses['vscode-fixture']).toBe('ok');
    expect(statuses['needs-input']).toBe('error');
  });
});
