import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapLimit, measureAll, measureServer, redactUrl, serverKey, toolTokens } from '../src/mcp.js';
import type { McpServerConfig } from '../src/types.js';
import { FIXTURES, testEnv } from './helpers.js';
// @ts-expect-error plain .mjs fixture without types
import { TOOLS } from './fixtures/mcp-server.mjs';

function stdio(script: string, env?: Record<string, string>, name = 'fixture'): McpServerConfig {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(FIXTURES, script)],
    env,
    configPath: 'test',
    scope: 'user',
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('measureServer (real stdio MCP server)', () => {
  it('counts tools, prompts and resources', async () => {
    const r = await measureServer(stdio('mcp-server.mjs'), { env: testEnv(), timeoutMs: 15_000 });
    expect(r.status, r.error).toBe('ok');
    expect(r.serverName).toBe('fixture-server');
    expect(r.serverVersion).toBe('1.2.3');
    expect(r.toolCount).toBe(3);
    const expected = (TOOLS as { name: string; description: string; inputSchema: unknown }[]).reduce(
      (n, t) => n + toolTokens(t),
      0,
    );
    expect(r.toolTokens).toBe(expected);
    expect(r.tools[0]!.name).toBe('search_issues'); // heaviest first
    expect(r.promptCount).toBe(1);
    expect(r.promptTokens).toBeGreaterThan(0);
    expect(r.resourceCount).toBe(2);
    expect(r.tokens).toBe(r.toolTokens + r.promptTokens); // resources are not counted
  });

  it('follows tools/list pagination', async () => {
    const r = await measureServer(stdio('mcp-server.mjs', { FIXTURE_PAGE_SIZE: '2', FIXTURE_TOOLS: '5' }), {
      env: testEnv(),
    });
    expect(r.status, r.error).toBe('ok');
    expect(r.toolCount).toBe(8);
  });

  it('times out on a hanging server and kills it', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-hang-')), 'pid');
    const started = Date.now();
    const r = await measureServer(stdio('hang-server.mjs', { FIXTURE_PID_FILE: pidFile }), {
      env: testEnv(),
      timeoutMs: 1500,
    });
    expect(r.status).toBe('timeout');
    expect(r.error).toMatch(/no response within/);
    expect(Date.now() - started).toBeLessThan(6000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(false);
  });

  it('reports crashes with stderr context instead of throwing', async () => {
    const r = await measureServer(stdio('crash-server.mjs'), { env: testEnv(), timeoutMs: 10_000 });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/missing API token|Connection closed/);
  });

  it('reports a missing command', async () => {
    const r = await measureServer(
      { ...stdio('x'), command: 'context-diet-no-such-binary-xyz', args: [] },
      { env: testEnv(), timeoutMs: 5000 },
    );
    expect(['error', 'timeout']).toContain(r.status);
    expect(r.tokens).toBe(0);
  });

  it('does not launch disabled servers or ones needing interactive input', async () => {
    expect((await measureServer({ ...stdio('mcp-server.mjs'), disabled: true })).status).toBe('disabled');
    const r = await measureServer({ ...stdio('mcp-server.mjs'), unresolved: ['${input:token}'] });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/interactive input/);
  });

  it('fails fast for an unreachable HTTP server', async () => {
    const r = await measureServer(
      { name: 'remote', transport: 'http', url: 'http://127.0.0.1:9/mcp', configPath: 't', scope: 'user', guessTransport: true },
      { env: testEnv(), timeoutMs: 5000 },
    );
    expect(['error', 'timeout']).toContain(r.status);
  });
});

describe('measureAll', () => {
  it('measures identical configs once and records every agent using them', async () => {
    const cfg = stdio('mcp-server.mjs');
    const results = await measureAll(
      [
        { agent: 'claude', config: cfg },
        { agent: 'codex', config: { ...cfg, name: 'same-but-renamed' } },
        { agent: 'cursor', config: stdio('mcp-server.mjs', { FIXTURE_TOOLS: '1' }) },
      ],
      { measure: true, env: testEnv() },
    );
    expect(results.size).toBe(2);
    const shared = results.get(serverKey(cfg))!;
    expect(shared.usedBy.sort()).toEqual(['claude', 'codex']);
    expect(shared.status).toBe('ok');
  });

  it('skips launching with measure=false', async () => {
    const results = await measureAll([{ agent: 'claude', config: stdio('mcp-server.mjs') }], { measure: false });
    expect([...results.values()][0]!.status).toBe('skipped');
  });
});

describe('helpers', () => {
  it('redacts credentials in URLs', () => {
    expect(redactUrl('https://u:p@x.dev/mcp?api_key=s3cret&x=1')).toBe('https://***@x.dev/mcp?api_key=***&x=1');
  });
  it('limits concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    expect(peak).toBe(3);
  });
});
