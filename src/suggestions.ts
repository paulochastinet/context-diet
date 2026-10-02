import { createHash } from 'node:crypto';
import { countTokens, formatTokens } from './tokens.js';
import type { AgentId, AgentReport, McpServerResult, Severity, Source, Suggestion } from './types.js';

export const THRESHOLDS = {
  mcpServer: 10_000,
  mcpServerHigh: 20_000,
  instructionFile: 5_000,
  skillDescription: 150,
  skillsTotal: 3_000,
  windowPercent: 25,
  duplicateTokens: 100,
  crossAgentOverlap: 0.5,
};

const MCP_HINT: Record<AgentId, string> = {
  claude:
    'disable it where you don\'t need it (`/mcp`, or move it from user to project scope), or enable MCP tool search (ENABLE_TOOL_SEARCH) so schemas load on demand',
  codex: 'limit it with `enabled_tools = [...]` or set `enabled = false` under [mcp_servers.<name>] in ~/.codex/config.toml',
  gemini: 'trim it with `includeTools` / `excludeTools` for that server in settings.json',
  cursor: 'toggle off unused tools (or the whole server) in Cursor Settings → MCP',
  vscode: 'deselect unused tools in the Copilot Chat tool picker, or remove the server from .vscode/mcp.json',
};

function paragraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 60);
}

function hash(s: string): string {
  return createHash('sha1').update(s.toLowerCase()).digest('hex');
}

const isInstruction = (s: Source) =>
  (s.kind === 'instructions' || s.kind === 'import' || s.kind === 'rule') && s.loading === 'always' && !!s.text;

export function buildSuggestions(
  agents: AgentReport[],
  servers: McpServerResult[],
  opts: { window: number },
): Suggestion[] {
  const out: Suggestion[] = [];
  const byKey = new Map(servers.map((s) => [s.key, s]));

  for (const a of agents) {
    if (!a.detected && a.totalTokens === 0) continue;

    if (a.windowPercent >= THRESHOLDS.windowPercent) {
      out.push({
        id: 'context-heavy',
        severity: 'high',
        agent: a.id,
        tokens: a.totalTokens,
        message: `${a.name} spends ≈${formatTokens(a.totalTokens)} tokens (${a.windowPercent}% of a ${formatTokens(opts.window)} window) before you type anything.`,
      });
    }

    for (const s of a.sources) {
      if (s.kind === 'mcp' && s.tokens > THRESHOLDS.mcpServer) {
        const server = s.serverKey ? byKey.get(s.serverKey) : undefined;
        const isGithub = /github/i.test(`${s.name} ${server?.target ?? ''}`);
        const cli = isGithub
          ? 'For GitHub, the `gh` CLI covers most of it at zero idle cost (or restrict toolsets via GITHUB_TOOLSETS).'
          : 'If a CLI exists for the same service, the agent can call it instead at zero idle cost.';
        out.push({
          id: 'mcp-heavy',
          severity: s.tokens > THRESHOLDS.mcpServerHigh ? 'high' : 'medium',
          agent: a.id,
          target: s.name,
          tokens: s.tokens,
          message: `MCP server "${s.name}" costs ≈${formatTokens(s.tokens)} tokens in ${a.name} (${server?.toolCount ?? '?'} tools): ${MCP_HINT[a.id]}. ${cli}`,
        });
      }
      if (isInstruction(s) && s.tokens > THRESHOLDS.instructionFile) {
        out.push({
          id: 'instructions-large',
          severity: 'medium',
          agent: a.id,
          target: s.displayPath,
          tokens: s.tokens,
          message: `${s.displayPath} is ≈${formatTokens(s.tokens)} tokens and loads on every request in ${a.name}. Move rarely-needed sections into skills (loaded on demand) or reference docs by path instead of @-importing them.`,
        });
      }
    }

    const longSkills = a.sources
      .filter((s) => s.kind === 'skill' && s.tokens > THRESHOLDS.skillDescription)
      .sort((x, y) => y.tokens - x.tokens);
    if (longSkills.length) {
      const names = longSkills.slice(0, 3).map((s) => `${s.name} (${s.tokens})`).join(', ');
      const more = longSkills.length > 3 ? ` and ${longSkills.length - 3} more` : '';
      out.push({
        id: 'skill-description-long',
        severity: 'low',
        agent: a.id,
        target: longSkills.map((s) => s.name).join(','),
        tokens: longSkills.reduce((n, s) => n + s.tokens, 0),
        message: `${longSkills.length} skill description${longSkills.length === 1 ? ' is' : 's are'} over ${THRESHOLDS.skillDescription} tokens and always loaded in ${a.name}: ${names}${more}. One or two sentences on *when* to use a skill are enough.`,
      });
    }

    const skills = a.sources.filter((s) => s.kind === 'skill');
    const skillTokens = skills.reduce((n, s) => n + s.tokens, 0);
    if (skillTokens > THRESHOLDS.skillsTotal) {
      out.push({
        id: 'skills-many',
        severity: 'low',
        agent: a.id,
        tokens: skillTokens,
        message: `${skills.length} skills add ≈${formatTokens(skillTokens)} tokens of metadata to every ${a.name} request. Remove the ones you never use.`,
      });
    }

    // Duplicated paragraphs across always-loaded files of the same agent: paid twice.
    const seen = new Map<string, { file: string; text: string }>();
    let dupTokens = 0;
    const dupFiles = new Set<string>();
    for (const s of a.sources.filter(isInstruction)) {
      for (const p of paragraphs(s.text!)) {
        const h = hash(p);
        const prev = seen.get(h);
        if (prev && prev.file !== s.displayPath) {
          dupTokens += countTokens(p);
          dupFiles.add(prev.file).add(s.displayPath ?? s.name);
        } else if (!prev) seen.set(h, { file: s.displayPath ?? s.name, text: p });
      }
    }
    if (dupTokens > THRESHOLDS.duplicateTokens) {
      out.push({
        id: 'duplicate-instructions',
        severity: 'medium',
        agent: a.id,
        tokens: dupTokens,
        message: `≈${formatTokens(dupTokens)} tokens of identical paragraphs are loaded twice in ${a.name} (${[...dupFiles].join(', ')}). Keep them in one file.`,
      });
    }
  }

  // Same content maintained in several agent files (CLAUDE.md vs AGENTS.md vs GEMINI.md ...)
  const files = new Map<string, { agent: AgentId; display: string; paras: Set<string>; chars: number }>();
  for (const a of agents) {
    for (const s of a.sources) {
      if (s.kind !== 'instructions' || !s.text || !s.path || files.has(s.path)) continue;
      const ps = paragraphs(s.text);
      files.set(s.path, {
        agent: a.id,
        display: s.displayPath ?? s.name,
        paras: new Set(ps.map(hash)),
        chars: ps.reduce((n, p) => n + p.length, 0),
      });
    }
  }
  const list = [...files.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const x = list[i]!;
      const y = list[j]!;
      if (x.agent === y.agent || !x.paras.size || !y.paras.size) continue;
      let shared = 0;
      for (const h of x.paras) if (y.paras.has(h)) shared++;
      const ratio = shared / Math.min(x.paras.size, y.paras.size);
      if (ratio >= THRESHOLDS.crossAgentOverlap) {
        out.push({
          id: 'duplicate-across-agents',
          severity: 'low',
          target: `${x.display} ↔ ${y.display}`,
          message: `${x.display} and ${y.display} share ${Math.round(ratio * 100)}% of their content. Keep one source of truth: symlink one to the other, or put \`@AGENTS.md\` in CLAUDE.md / GEMINI.md.`,
        });
      }
    }
  }

  const failed = servers.filter((s) => s.status === 'error' || s.status === 'timeout');
  if (failed.length) {
    const hasTimeout = failed.some((f) => f.status === 'timeout');
    out.push({
      id: 'mcp-unmeasured',
      severity: 'low',
      message: `${failed.length} MCP server(s) could not be measured (${failed
        .map((f) => `${f.name}: ${f.status}`)
        .join(', ')}); totals are a lower bound. --verbose shows the errors${hasTimeout ? '; --timeout raises the limit' : ''}.`,
    });
  }
  const auth = servers.filter((s) => s.status === 'auth');
  if (auth.length) {
    out.push({
      id: 'mcp-auth',
      severity: 'low',
      message: `${auth.length} remote MCP server(s) need authentication that only the agent holds (${auth
        .map((f) => f.name)
        .join(', ')}), so their tools are not counted. Totals are a lower bound.`,
    });
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.tokens ?? 0) - (a.tokens ?? 0));
}
