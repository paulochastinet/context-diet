import fs from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profile, toJson } from '../src/profile.js';
import { renderMarkdown } from '../src/render/markdown.js';
import { renderPretty } from '../src/render/pretty.js';
import { buildSuggestions } from '../src/suggestions.js';
import type { AgentReport, McpServerResult, Report } from '../src/types.js';
import { ROOT, makeSandbox, testEnv, type Sandbox } from './helpers.js';

let sb: Sandbox;
let report: Report;

beforeAll(async () => {
  sb = makeSandbox();
  report = await profile({
    cwd: sb.project,
    home: sb.home,
    ceiling: sb.root,
    env: testEnv(),
    timeoutMs: 15_000,
    maxTokens: 500,
  });
}, 120_000);
afterAll(() => sb.cleanup());

describe('profile()', () => {
  it('measures each unique MCP server once and shares it across agents', () => {
    const fixture = report.mcpServers.filter((s) => s.usedBy.length > 1);
    expect(fixture).toHaveLength(1);
    expect(fixture[0]!.usedBy.sort()).toEqual(['claude', 'codex', 'cursor', 'gemini']);
    expect(fixture[0]!.status).toBe('ok');
    expect(fixture[0]!.toolCount).toBe(3);
    const paged = report.mcpServers.find((s) => s.name === 'project-fixture')!;
    expect(paged.status).toBe('ok');
    const local = report.mcpServers.find((s) => s.name === 'local-only')!;
    expect(local.toolCount).toBe(5);
  });

  it('counts MCP tokens in the agent totals', () => {
    const claude = report.agents.find((a) => a.id === 'claude')!;
    const sum = claude.sources.filter((s) => s.loading === 'always').reduce((n, s) => n + s.tokens, 0);
    expect(claude.totalTokens).toBe(sum);
    const mcpTokens = claude.sources.filter((s) => s.kind === 'mcp').reduce((n, s) => n + s.tokens, 0);
    expect(mcpTokens).toBeGreaterThan(300);
    expect(claude.windowPercent).toBeCloseTo((claude.totalTokens / 200_000) * 100, 1);
    const disabled = report.mcpServers.find((s) => s.name === 'disabled-one')!;
    expect(disabled.status).toBe('disabled');
    expect(report.mcpServers.find((s) => s.name === 'remote-api')!.target).toContain('api_key=***');
  });

  it('does not count conditional Cursor rules', () => {
    const cursor = report.agents.find((a) => a.id === 'cursor')!;
    expect(cursor.conditionalTokens).toBeGreaterThan(0);
    const always = cursor.sources.filter((s) => s.loading === 'always').reduce((n, s) => n + s.tokens, 0);
    expect(cursor.totalTokens).toBe(always);
  });

  it('applies the budget', () => {
    expect(report.budget.maxTokens).toBe(500);
    expect(report.budget.exceeded).toContain('claude');
    for (const a of report.agents) expect(a.overBudget).toBe(a.totalTokens > 500);
  });

  it('suggests fixes (duplicate content, long skill description)', () => {
    const ids = report.suggestions.map((s) => s.id);
    expect(ids).toContain('skill-description-long');
    expect(ids).toContain('duplicate-across-agents'); // AGENTS.md vs GEMINI.md
    expect(ids).toContain('mcp-unmeasured');
  });

  it('produces JSON that validates against schema/report.schema.json', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'report.schema.json'), 'utf8'));
    const ajv = new Ajv({ allErrors: true });
    // ajv-formats is CJS: under NodeNext its default export is the module object.
    const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv) => void;
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const json = JSON.parse(JSON.stringify(toJson(report)));
    expect(validate(json), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(JSON.stringify(json)).not.toContain('"text"');
  });

  it('renders pretty output without color codes when color is off', () => {
    const out = renderPretty(report, { color: false, verbose: true, width: 100 });
    expect(out).not.toMatch(/\x1b\[/);
    expect(out).toContain('Claude Code');
    expect(out).toContain('search_issues');
    expect(out).toContain('Top offenders');
    expect(out).toContain('exceeds the budget');
    expect(renderPretty(report, { color: true, verbose: false })).toMatch(/\x1b\[/);
  });

  it('renders markdown tables', () => {
    const md = renderMarkdown(report);
    expect(md).toContain('## context-diet report');
    expect(md).toMatch(/\| Claude Code \| [\d.]+k? \|/);
    expect(md).toContain('<details>');
    expect(md).toContain('Budget exceeded');
  });

  it('skips spawning with mcp: false', async () => {
    const r = await profile({ cwd: sb.project, home: sb.home, ceiling: sb.root, env: testEnv(), mcp: false });
    expect(r.mcpMeasured).toBe(false);
    expect(r.mcpServers.every((s) => s.status === 'skipped' || s.status === 'disabled')).toBe(true);
  });
});

describe('suggestions', () => {
  const agent = (over: Partial<AgentReport>): AgentReport => ({
    id: 'claude',
    name: 'Claude Code',
    detected: true,
    totalTokens: 0,
    conditionalTokens: 0,
    onDemandTokens: 0,
    windowPercent: 0,
    overBudget: false,
    sources: [],
    notes: [],
    ...over,
  });
  const server = (over: Partial<McpServerResult>): McpServerResult => ({
    key: 'k1',
    name: 'github',
    transport: 'stdio',
    target: 'npx github-mcp',
    status: 'ok',
    tokens: 0,
    toolTokens: 0,
    promptTokens: 0,
    resourceTokens: 0,
    toolCount: 90,
    promptCount: 0,
    resourceCount: 0,
    tools: [],
    durationMs: 1,
    usedBy: ['claude'],
    ...over,
  });

  it('flags heavy MCP servers, big instruction files and a full window', () => {
    const big = 'word '.repeat(6000);
    const a = agent({
      totalTokens: 60_000,
      windowPercent: 30,
      sources: [
        { kind: 'mcp', name: 'github', tokens: 30_000, loading: 'always', serverKey: 'k1' },
        { kind: 'instructions', name: 'CLAUDE.md', displayPath: 'CLAUDE.md', tokens: 6000, loading: 'always', text: big },
      ],
    });
    const s = buildSuggestions([a], [server({ tokens: 30_000 })], { window: 200_000 });
    const ids = s.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['context-heavy', 'mcp-heavy', 'instructions-large']));
    const mcp = s.find((x) => x.id === 'mcp-heavy')!;
    expect(mcp.severity).toBe('high');
    expect(mcp.message).toMatch(/gh` CLI/);
    expect(s[0]!.severity).toBe('high');
  });

  it('detects content paid twice inside one agent', () => {
    const para = 'This paragraph is long enough to count as duplicated content between two always-loaded files.';
    const a = agent({
      sources: [
        { kind: 'instructions', name: 'CLAUDE.md', displayPath: 'CLAUDE.md', tokens: 300, loading: 'always', text: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `${n}. ${para}`).join('\n\n') },
        { kind: 'import', name: 'AGENTS.md', displayPath: 'AGENTS.md', tokens: 300, loading: 'always', text: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `${n}. ${para}`).join('\n\n') },
      ],
    });
    const s = buildSuggestions([a], [], { window: 200_000 });
    expect(s.map((x) => x.id)).toContain('duplicate-instructions');
  });
});
