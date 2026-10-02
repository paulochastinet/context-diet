import os from 'node:os';
import { parseArgs } from 'node:util';
import { AGENT_IDS, type AgentId } from './types.js';

export class UsageError extends Error {}

export interface CliOptions {
  cwd: string;
  home: string;
  agents: AgentId[];
  window: number;
  maxTokens: number | null;
  timeoutMs: number;
  concurrency: number;
  mcp: boolean;
  format: 'pretty' | 'json' | 'markdown';
  verbose: boolean;
  color: boolean | null;
  help: boolean;
  version: boolean;
}

const AGENT_ALIASES: Record<string, AgentId> = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  'codex-cli': 'codex',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  cursor: 'cursor',
  vscode: 'vscode',
  'vs-code': 'vscode',
  copilot: 'vscode',
};

/** Parse "200000", "200k", "1.5m", "200_000". */
export function parseCount(flag: string, raw: string): number {
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(raw.replace(/[_,]/g, '').trim());
  if (!m) throw new UsageError(`--${flag} expects a number (e.g. 50000 or 50k), got "${raw}"`);
  const mult = m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  const n = Math.round(Number(m[1]) * mult);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${flag} must be greater than 0`);
  return n;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        cwd: { type: 'string' },
        home: { type: 'string' },
        agent: { type: 'string', short: 'a', multiple: true },
        window: { type: 'string', short: 'w' },
        'max-tokens': { type: 'string' },
        timeout: { type: 'string' },
        concurrency: { type: 'string' },
        'no-mcp': { type: 'boolean' },
        json: { type: 'boolean' },
        markdown: { type: 'boolean', short: 'm' },
        verbose: { type: 'boolean', short: 'v' },
        color: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const v = parsed.values;
  if (v.json && v.markdown) throw new UsageError('--json and --markdown are mutually exclusive');

  const agents: AgentId[] = [];
  for (const chunk of v.agent ?? []) {
    for (const name of chunk.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      const id = AGENT_ALIASES[name];
      if (!id) throw new UsageError(`unknown agent "${name}" (expected one of: ${AGENT_IDS.join(', ')})`);
      if (!agents.includes(id)) agents.push(id);
    }
  }

  agents.sort((a, b) => AGENT_IDS.indexOf(a) - AGENT_IDS.indexOf(b));

  let color: boolean | null = null;
  if (v['no-color']) color = false;
  else if (v.color) color = true;

  return {
    cwd: v.cwd ?? process.cwd(),
    home: v.home ?? env.CONTEXT_DIET_HOME ?? os.homedir(),
    agents,
    window: v.window ? parseCount('window', v.window) : 200_000,
    maxTokens: v['max-tokens'] ? parseCount('max-tokens', v['max-tokens']) : null,
    timeoutMs: v.timeout ? parseCount('timeout', v.timeout) : 20_000,
    concurrency: v.concurrency ? parseCount('concurrency', v.concurrency) : 4,
    mcp: !v['no-mcp'],
    format: v.json ? 'json' : v.markdown ? 'markdown' : 'pretty',
    verbose: !!v.verbose,
    color,
    help: !!v.help,
    version: !!v.version,
  };
}

export const HELP = `context-diet — see what your AI coding agent eats before you type a word

Usage
  npx context-diet [options]

Options
  --agent, -a <list>     Only these agents: claude,codex,gemini,cursor,vscode (repeatable)
  --cwd <dir>            Project directory to profile (default: current directory)
  --home <dir>           Home directory to read user-level config from (default: ~)
  --window, -w <n>       Context window size for the % column (default: 200k)
  --max-tokens <n>       Budget: exit 1 if any selected agent exceeds n tokens
  --timeout <ms>         Per-MCP-server timeout in milliseconds (default: 20000)
  --concurrency <n>      MCP servers measured in parallel (default: 4)
  --no-mcp               Don't launch MCP servers (instruction files only)
  --json                 Machine-readable JSON (schemaVersion 1)
  --markdown, -m         Markdown (PR comments, $GITHUB_STEP_SUMMARY)
  --verbose, -v          Expand skills/subagents and the heaviest MCP tools
  --no-color             Disable colors (NO_COLOR is respected too)
  --version, -V          Print version
  --help, -h             Show this help

Numbers accept k/m suffixes (50k, 1m).
Exit codes: 0 ok · 1 over budget (--max-tokens) · 2 usage error

Note: configured MCP servers are started locally (exactly as your agent would)
to read their tool lists. Use --no-mcp to skip that.
`;
