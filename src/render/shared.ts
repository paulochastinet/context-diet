import { AGENT_NAMES, type Report } from '../types.js';

export interface Offender {
  label: string;
  kind: string;
  tokens: number;
  agents: string[];
}

/** Heaviest individual sources across all agents (shared MCP servers / files counted once). */
export function offenders(report: Report, n: number): Offender[] {
  const map = new Map<string, Offender>();
  for (const a of report.agents) {
    for (const s of a.sources) {
      if (s.loading !== 'always' || s.tokens <= 0) continue;
      let key: string;
      let label: string;
      let kind: string;
      if (s.kind === 'mcp') {
        key = `mcp:${s.serverKey}`;
        label = s.name;
        kind = 'mcp';
      } else if (s.kind === 'skill' || s.kind === 'subagent' || s.kind === 'command') {
        continue; // individually tiny; reported as groups
      } else {
        key = `file:${s.path ?? s.displayPath}`;
        label = s.displayPath ?? s.name;
        kind = s.kind === 'instructions' ? 'file' : s.kind;
      }
      const prev = map.get(key);
      if (prev) {
        if (!prev.agents.includes(AGENT_NAMES[a.id])) prev.agents.push(AGENT_NAMES[a.id]);
      } else map.set(key, { label, kind, tokens: s.tokens, agents: [AGENT_NAMES[a.id]] });
    }
  }
  return [...map.values()].sort((x, y) => y.tokens - x.tokens).slice(0, n);
}
