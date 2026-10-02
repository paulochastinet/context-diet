import pc from 'picocolors';
import { formatTokens } from '../tokens.js';
import type { AgentReport, McpServerResult, Report, Source, SourceKind, Suggestion } from '../types.js';
import { offenders } from './shared.js';

type Colors = ReturnType<typeof pc.createColors>;

export interface PrettyOptions {
  color: boolean;
  verbose: boolean;
  width?: number;
}

const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function bar(value: number, max: number, width: number): string {
  if (max <= 0 || value <= 0) return '';
  const cells = Math.min(width, (value / max) * width);
  let full = Math.floor(cells);
  let frac = Math.round((cells - full) * 8);
  if (frac === 8) {
    full++;
    frac = 0;
  }
  let s = '█'.repeat(full);
  if (frac > 0 && full < width) s += BLOCKS[frac];
  if (!s) s = '▏';
  return s;
}

function meter(pct: number, width: number, c: Colors): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const color = pct >= 50 ? c.red : pct >= 25 ? c.yellow : c.green;
  if (filled === 0 && pct > 0) return color('▏') + c.dim('░'.repeat(width - 1));
  return color('█'.repeat(filled)) + c.dim('░'.repeat(width - filled));
}

/** Visible width (strip ANSI). */
function vw(s: string): number {
  // eslint-disable-next-line no-control-regex
  return [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;
}

function padEnd(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - vw(s)));
}

function padStart(s: string, n: number): string {
  return ' '.repeat(Math.max(0, n - vw(s))) + s;
}

/** Truncate keeping the tail (useful for paths). */
function truncLeft(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : `…${chars.slice(chars.length - n + 1).join('')}`;
}

function truncRight(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : `${chars.slice(0, n - 1).join('')}…`;
}

const KIND_LABEL: Record<SourceKind, string> = {
  instructions: 'instructions',
  import: 'import',
  rule: 'rule',
  skill: 'skills',
  subagent: 'subagents',
  command: 'commands',
  mcp: 'mcp',
};

interface Row {
  kind: string;
  label: string;
  detail: string;
  tokens: number | null;
  /** Label is a path: truncate from the left to keep the file name. */
  isPath?: boolean;
  status?: 'error' | 'dim';
  /** Free text spanning the whole line (no columns). */
  wide?: boolean;
  children?: Row[];
}

function mcpRow(s: Source, r: McpServerResult | undefined, verbose: boolean, c: Colors): Row {
  if (!r) return { kind: 'mcp', label: s.name, detail: '', tokens: null };
  if (r.status === 'ok') {
    const parts = [`${r.toolCount} tool${r.toolCount === 1 ? '' : 's'}`];
    if (r.promptCount) parts.push(`${r.promptCount} prompt${r.promptCount === 1 ? '' : 's'}`);
    if (r.transport !== 'stdio') parts.unshift(r.transport);
    const row: Row = { kind: 'mcp', label: s.name, detail: parts.join(' · '), tokens: r.tokens };
    if (verbose && r.tools.length) {
      row.children = r.tools.slice(0, 5).map((t) => ({ kind: '', label: `  ${t.name}`, detail: '', tokens: t.tokens, status: 'dim' as const }));
      if (r.tools.length > 5) {
        const rest = r.tools.slice(5).reduce((n, t) => n + t.tokens, 0);
        row.children.push({ kind: '', label: `  … ${r.tools.length - 5} more`, detail: '', tokens: rest, status: 'dim' });
      }
    }
    return row;
  }
  if (r.status === 'disabled') return { kind: 'mcp', label: s.name, detail: 'disabled', tokens: null, status: 'dim' };
  if (r.status === 'skipped') return { kind: 'mcp', label: s.name, detail: `${r.transport} · not launched`, tokens: null, status: 'dim' };
  const msg = r.status === 'auth' ? 'needs auth' : r.status;
  const row: Row = { kind: 'mcp', label: s.name, detail: c.red(`✗ ${msg}`), tokens: null, status: 'error' };
  if (verbose && r.error) row.children = [{ kind: '', label: `  ${r.error}`, detail: '', tokens: null, status: 'dim', wide: true }];
  return row;
}

function buildRows(a: AgentReport, servers: Map<string, McpServerResult>, verbose: boolean, c: Colors): Row[] {
  const rows: Row[] = [];
  const groups = new Map<SourceKind, Source[]>();
  for (const s of a.sources) {
    if (s.loading !== 'always') continue;
    if (s.kind === 'skill' || s.kind === 'subagent' || s.kind === 'command') {
      const g = groups.get(s.kind) ?? [];
      g.push(s);
      groups.set(s.kind, g);
      continue;
    }
    if (s.kind === 'mcp') {
      rows.push(mcpRow(s, s.serverKey ? servers.get(s.serverKey) : undefined, verbose, c));
      continue;
    }
    const detail = s.kind === 'import' && s.parent ? `via ${s.parent}` : s.note ?? '';
    rows.push({ kind: KIND_LABEL[s.kind], label: s.displayPath ?? s.name, detail, tokens: s.tokens, isPath: true });
  }
  for (const [kind, list] of groups) {
    const total = list.reduce((n, s) => n + s.tokens, 0);
    const onDemand = list.reduce((n, s) => n + (s.onDemandTokens ?? 0), 0);
    const noun = kind === 'skill' ? 'skill' : kind === 'subagent' ? 'subagent' : 'command';
    const row: Row = {
      kind: KIND_LABEL[kind],
      label: `${list.length} ${noun}${list.length === 1 ? '' : 's'} (descriptions)`,
      detail: onDemand ? `+${formatTokens(onDemand)} on demand` : '',
      tokens: total,
    };
    if (verbose) {
      row.children = [...list]
        .sort((x, y) => y.tokens - x.tokens)
        .map((s) => ({ kind: '', label: `  ${s.name}`, detail: '', tokens: s.tokens, status: 'dim' as const }));
    }
    rows.push(row);
  }
  rows.sort((x, y) => (y.tokens ?? -1) - (x.tokens ?? -1));
  return rows;
}

function renderSuggestion(s: Suggestion, c: Colors, width: number): string {
  const icon = s.severity === 'high' ? c.red('●') : s.severity === 'medium' ? c.yellow('●') : c.dim('●');
  const indent = '     ';
  const words = s.message.split(' ');
  const lines: string[] = [];
  let line = '';
  const max = Math.max(40, width - indent.length - 2);
  for (const w of words) {
    if (vw(line) + vw(w) + 1 > max && line) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? `  ${icon}  ${l}` : `${indent}${l}`)).join('\n');
}

export function pctText(tokens: number, window: number): string {
  if (tokens <= 0) return '0%';
  const p = (tokens / window) * 100;
  return p < 0.1 ? '<0.1%' : `${Math.round(p * 10) / 10}%`;
}

export function renderPretty(report: Report, opts: PrettyOptions): string {
  const c = pc.createColors(opts.color);
  const width = Math.max(64, Math.min(opts.width ?? 100, 110));
  const servers = new Map(report.mcpServers.map((s) => [s.key, s]));
  const out: string[] = [];
  const home = report.home;
  const cwdDisplay = report.cwd === home ? '~' : report.cwd.startsWith(`${home}/`) ? `~${report.cwd.slice(home.length)}` : report.cwd;

  out.push('');
  out.push(`  ${c.bold(c.green('context-diet'))} ${c.dim(`v${report.tool.version}`)}  ${c.dim('what your agents eat before you type a word')}`);
  out.push(c.dim(`  ${cwdDisplay}  ·  window ${formatTokens(report.window)}  ·  ≈tokens (o200k_base)`));

  const shown = report.agents.filter((a) => a.detected || a.totalTokens > 0);
  const hidden = report.agents.filter((a) => !shown.includes(a));

  const kindW = 14;
  const tokW = 7;
  const barW = Math.max(8, Math.min(20, width - 84));
  const detailW = 22;
  const labelW = Math.max(24, width - kindW - tokW - barW - detailW - 8);

  for (const a of shown) {
    out.push('');
    const head = `  ${c.bold(a.name)}`;
    const total = `${c.bold(`≈${formatTokens(a.totalTokens)}`)} tok`;
    const pct = `${pctText(a.totalTokens, report.window)} of ${formatTokens(report.window)}`;
    const budget = a.overBudget ? `  ${c.red(c.bold('OVER BUDGET'))}` : '';
    out.push(`${padEnd(head, 22)}${padStart(total, 12)}  ${meter(a.windowPercent, 20, c)}  ${c.dim(pct)}${budget}`);
    out.push(c.dim(`  ${'─'.repeat(width - 4)}`));
    const rows = buildRows(a, servers, opts.verbose, c);
    if (!rows.length) out.push(c.dim('  nothing always-loaded found'));
    const max = Math.max(1, ...rows.map((r) => r.tokens ?? 0));
    const emit = (r: Row) => {
      if (r.wide) {
        out.push(c.dim(`  ${' '.repeat(kindW)}${truncRight(r.label, width - kindW - 4)}`));
        return;
      }
      const tokens = r.tokens == null ? c.dim('—') : formatTokens(r.tokens);
      const label = r.isPath ? truncLeft(r.label, labelW) : truncRight(r.label, labelW);
      const detail = r.status === 'error' ? truncRight(r.detail, detailW + 20) : c.dim(truncRight(r.detail, detailW));
      const b = r.tokens ? bar(r.tokens, max, barW) : '';
      const coloredBar = r.kind === 'mcp' ? c.magenta(b) : r.kind === 'instructions' || r.kind === 'import' ? c.cyan(b) : c.blue(b);
      const line = `  ${padEnd(c.dim(r.kind), kindW)}${padEnd(r.status === 'dim' ? c.dim(label) : label, labelW)}  ${padEnd(detail, detailW)}${padStart(r.status === 'dim' ? c.dim(tokens) : tokens, tokW)}  ${r.status === 'dim' ? '' : coloredBar}`;
      out.push(line.trimEnd());
    };
    for (const r of rows) {
      emit(r);
      for (const ch of r.children ?? []) emit(ch);
    }
    const cond = a.sources.filter((s) => s.loading === 'conditional');
    if (cond.length) {
      out.push(
        c.dim(`  + ${cond.length} conditional rule${cond.length === 1 ? '' : 's'} (≈${formatTokens(a.conditionalTokens)}) loaded only when relevant`),
      );
    }
    for (const n of a.notes) out.push(c.dim(`  ℹ ${n}`));
  }

  if (!shown.length) {
    out.push('');
    out.push(`  No agent configuration found for ${cwdDisplay}.`);
  }
  if (hidden.length) {
    out.push('');
    out.push(c.dim(`  Not detected: ${hidden.map((a) => a.name).join(', ')}`));
  }

  const top = offenders(report, 5);
  if (top.length > 1) {
    out.push('');
    out.push(`  ${c.bold('Top offenders')}`);
    top.forEach((o, i) => {
      const who = c.dim(o.agents.join(', '));
      out.push(`  ${c.dim(`${i + 1}.`)} ${padEnd(truncLeft(o.label, 44), 44)} ${padEnd(c.dim(o.kind), 8)} ${padStart(formatTokens(o.tokens), 6)}  ${who}`);
    });
  }

  if (report.suggestions.length) {
    out.push('');
    out.push(`  ${c.bold('Suggestions')}`);
    for (const s of report.suggestions) out.push(renderSuggestion(s, c, width));
  }

  if (report.budget.maxTokens != null) {
    out.push('');
    if (report.budget.exceeded.length) {
      for (const id of report.budget.exceeded) {
        const a = report.agents.find((x) => x.id === id)!;
        out.push(
          `  ${c.red('✗')} ${c.bold(a.name)} exceeds the budget: ≈${formatTokens(a.totalTokens)} > ${formatTokens(report.budget.maxTokens)} tokens`,
        );
      }
    } else {
      out.push(`  ${c.green('✓')} All agents within budget (${formatTokens(report.budget.maxTokens)} tokens)`);
    }
  }
  out.push('');
  return out.join('\n');
}
