import path from 'node:path';
import { scanClaude } from './agents/claude.js';
import { scanCodex } from './agents/codex.js';
import { scanCursor } from './agents/cursor.js';
import { scanGemini } from './agents/gemini.js';
import { scanVscode } from './agents/vscode.js';
import { findRepoRoot, realpath } from './fsutil.js';
import { DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS, describeTarget, measureAll, serverKey } from './mcp.js';
import { buildSuggestions } from './suggestions.js';
import {
  AGENT_IDS,
  AGENT_NAMES,
  type AgentId,
  type AgentReport,
  type AgentScan,
  type ProfileOptions,
  type Report,
  type ScanContext,
  type Source,
} from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_WINDOW = 200_000;

const SCANNERS: Record<AgentId, (ctx: ScanContext) => AgentScan> = {
  claude: scanClaude,
  codex: scanCodex,
  gemini: scanGemini,
  cursor: scanCursor,
  vscode: scanVscode,
};

export function makeContext(opts: Pick<ProfileOptions, 'cwd' | 'home' | 'ceiling' | 'env'>): ScanContext {
  const cwd = realpath(path.resolve(opts.cwd));
  const home = realpath(path.resolve(opts.home));
  const ceiling = opts.ceiling ? realpath(path.resolve(opts.ceiling)) : undefined;
  return { cwd, home, ceiling, repoRoot: findRepoRoot(cwd, ceiling), env: opts.env ?? process.env };
}

/** Scan configuration files only (no MCP processes are started). */
export function scanAgents(ctx: ScanContext, agents: AgentId[] = [...AGENT_IDS]): AgentScan[] {
  return agents.map((id) => SCANNERS[id](ctx));
}

export async function profile(opts: ProfileOptions): Promise<Report> {
  const ctx = makeContext(opts);
  const window = opts.window ?? DEFAULT_WINDOW;
  const maxTokens = opts.maxTokens ?? null;
  const measure = opts.mcp ?? true;
  const selected = opts.agents?.length ? opts.agents : [...AGENT_IDS];
  const scans = scanAgents(ctx, selected);

  const results = await measureAll(
    scans.flatMap((s) => s.mcp.map((config) => ({ agent: s.id, config }))),
    {
      measure,
      env: ctx.env,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
      onProgress: opts.onMcpProgress,
    },
  );

  const agents: AgentReport[] = scans.map((scan) => {
    const sources: Source[] = [...scan.sources];
    for (const cfg of scan.mcp) {
      const key = serverKey(cfg);
      const r = results.get(key)!;
      sources.push({
        kind: 'mcp',
        name: cfg.name,
        displayPath: cfg.configPath,
        tokens: r.status === 'ok' ? r.tokens : 0,
        loading: 'always',
        serverKey: key,
        note: describeTarget(cfg),
      });
    }
    sources.sort((a, b) => b.tokens - a.tokens);
    const always = sources.filter((s) => s.loading === 'always');
    const totalTokens = always.reduce((n, s) => n + s.tokens, 0);
    const conditionalTokens = sources.filter((s) => s.loading === 'conditional').reduce((n, s) => n + s.tokens, 0);
    const onDemandTokens = sources.reduce((n, s) => n + (s.onDemandTokens ?? 0), 0);
    const notes = [...scan.notes];
    const unmeasured = scan.mcp.filter((c) => {
      const st = results.get(serverKey(c))?.status;
      return st && st !== 'ok' && st !== 'disabled';
    }).length;
    if (unmeasured && measure) {
      notes.push(`${unmeasured} MCP server(s) could not be measured; the total is a lower bound.`);
    }
    if (!measure && scan.mcp.some((c) => !c.disabled)) {
      notes.push('MCP servers were not launched (--no-mcp); their tool schemas are not counted.');
    }
    return {
      id: scan.id,
      name: AGENT_NAMES[scan.id],
      detected: scan.detected,
      totalTokens,
      conditionalTokens,
      onDemandTokens,
      windowPercent: Math.round((totalTokens / window) * 1000) / 10,
      overBudget: maxTokens != null && totalTokens > maxTokens,
      sources,
      notes,
    };
  });

  const mcpServers = [...results.values()].sort((a, b) => b.tokens - a.tokens);
  const suggestions = buildSuggestions(agents, mcpServers, { window });

  return {
    schemaVersion: 1,
    tool: { name: 'context-diet', version: VERSION },
    generatedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    home: ctx.home,
    tokenizer: 'o200k_base',
    window,
    mcpMeasured: measure,
    agents,
    mcpServers,
    suggestions,
    budget: {
      maxTokens,
      exceeded: agents.filter((a) => a.overBudget).map((a) => a.id),
    },
  };
}

/** JSON-safe copy of a report (drops raw file text). */
export function toJson(report: Report): unknown {
  return {
    ...report,
    agents: report.agents.map((a) => ({
      ...a,
      sources: a.sources.map(({ text: _text, ...rest }) => rest),
    })),
  };
}
