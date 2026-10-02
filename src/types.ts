export type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'vscode';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'gemini', 'cursor', 'vscode'];

export const AGENT_NAMES: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  cursor: 'Cursor',
  vscode: 'VS Code / Copilot',
};

/** What kind of thing a source is. */
export type SourceKind =
  | 'instructions' // CLAUDE.md, AGENTS.md, GEMINI.md, copilot-instructions.md, .cursorrules
  | 'import' // a file pulled in through an `@path` import
  | 'rule' // Cursor rule / Copilot path-specific instructions
  | 'skill' // SKILL.md (metadata always loaded, body on demand)
  | 'subagent' // .claude/agents/*.md
  | 'command' // custom slash command
  | 'mcp'; // an MCP server's tool list

/**
 * - always: sent with every request (counted in the total)
 * - conditional: only loaded when globs match / agent decides (shown, not counted)
 */
export type Loading = 'always' | 'conditional';

export interface Source {
  kind: SourceKind;
  /** Short human label (e.g. skill name, file name). */
  name: string;
  /** Absolute path of the backing file, if any. */
  path?: string;
  /** Display path: relative to cwd, `~`-prefixed, or absolute. */
  displayPath?: string;
  /** Approximate always-loaded tokens contributed by this source. */
  tokens: number;
  /** Extra tokens that are only loaded on demand (e.g. a skill body). */
  onDemandTokens?: number;
  loading: Loading;
  /** For imports: display path of the importing file. */
  parent?: string;
  /** Import depth (0 for top-level files). */
  depth?: number;
  /** For `mcp` sources: key into Report.mcpServers. */
  serverKey?: string;
  /** Raw text (not serialised to JSON). */
  text?: string;
  note?: string;
}

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Server is configured but turned off. */
  disabled?: boolean;
  /** Where it was configured (display path). */
  configPath: string;
  scope: 'user' | 'project' | 'local' | 'extension';
  /** If true, `url` transport is unknown and should fall back from http to sse. */
  guessTransport?: boolean;
  /** Unresolved variable placeholders (e.g. ${input:token}). */
  unresolved?: string[];
}

export type McpStatus = 'ok' | 'error' | 'timeout' | 'auth' | 'skipped' | 'disabled';

export interface McpToolInfo {
  name: string;
  tokens: number;
}

export interface McpServerResult {
  key: string;
  name: string;
  transport: McpTransport;
  /** e.g. `npx -y @modelcontextprotocol/server-github` or the URL. */
  target: string;
  status: McpStatus;
  error?: string;
  /** tools + prompts tokens (what's counted against the agent). */
  tokens: number;
  toolTokens: number;
  promptTokens: number;
  /** Resources are listed for information only and NOT counted. */
  resourceTokens: number;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  tools: McpToolInfo[];
  serverName?: string;
  serverVersion?: string;
  durationMs: number;
  usedBy: AgentId[];
}

export interface AgentScan {
  id: AgentId;
  sources: Source[];
  mcp: McpServerConfig[];
  notes: string[];
  /** True if any config / instruction file for this agent exists. */
  detected: boolean;
}

export interface AgentReport {
  id: AgentId;
  name: string;
  detected: boolean;
  totalTokens: number;
  conditionalTokens: number;
  onDemandTokens: number;
  windowPercent: number;
  overBudget: boolean;
  sources: Source[];
  notes: string[];
}

export type Severity = 'high' | 'medium' | 'low';

export interface Suggestion {
  id: string;
  severity: Severity;
  agent?: AgentId;
  target?: string;
  tokens?: number;
  message: string;
}

export interface Report {
  schemaVersion: 1;
  tool: { name: 'context-diet'; version: string };
  generatedAt: string;
  cwd: string;
  home: string;
  tokenizer: 'o200k_base';
  window: number;
  mcpMeasured: boolean;
  agents: AgentReport[];
  mcpServers: McpServerResult[];
  suggestions: Suggestion[];
  budget: { maxTokens: number | null; exceeded: AgentId[] };
}

export interface ProfileOptions {
  cwd: string;
  home: string;
  agents?: AgentId[];
  window?: number;
  maxTokens?: number | null;
  mcp?: boolean;
  timeoutMs?: number;
  concurrency?: number;
  /** Stop upward directory walks at this directory (inclusive). Mainly for tests. */
  ceiling?: string;
  /** Environment used for variable expansion and spawned servers. */
  env?: NodeJS.ProcessEnv;
  /** Progress callback for MCP measurement. */
  onMcpProgress?: (done: number, total: number, name: string) => void;
}

export interface ScanContext {
  cwd: string;
  home: string;
  repoRoot: string | null;
  ceiling?: string;
  env: NodeJS.ProcessEnv;
}
