import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { countTokens } from './tokens.js';
import type { AgentId, McpServerConfig, McpServerResult, McpToolInfo } from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_CONCURRENCY = 4;
const MAX_PAGES = 50;

/** Identity of a server for de-duplication across agents. */
export function serverKey(s: McpServerConfig): string {
  const id =
    s.transport === 'stdio'
      ? { t: 'stdio', c: s.command, a: s.args ?? [], e: sortObj(s.env), d: s.cwd ?? null }
      : { t: 'remote', u: s.url, h: sortObj(s.headers) };
  return createHash('sha1').update(JSON.stringify(id)).digest('hex').slice(0, 12);
}

function sortObj(o?: Record<string, string>): [string, string][] {
  return o ? Object.entries(o).sort(([a], [b]) => a.localeCompare(b)) : [];
}

export function describeTarget(s: McpServerConfig): string {
  if (s.transport === 'stdio') return [s.command, ...(s.args ?? [])].join(' ');
  return redactUrl(s.url ?? '');
}

/** Hide credentials that people put into URLs (query tokens, basic auth). */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    for (const k of [...u.searchParams.keys()]) {
      if (/key|token|secret|auth|password|sig/i.test(k)) u.searchParams.set(k, '***');
    }
    return u.toString().replace(/%2A%2A%2A/g, '***');
  } catch {
    return raw;
  }
}

/** Tokens for one tool, approximated as the JSON the client sends to the model. */
export function toolTokens(tool: { name: string; description?: string; inputSchema?: unknown }): number {
  return countTokens(
    JSON.stringify({ name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema ?? {} }),
  );
}

function emptyResult(s: McpServerConfig, key: string): McpServerResult {
  return {
    key,
    name: s.name,
    transport: s.transport,
    target: describeTarget(s),
    status: 'skipped',
    tokens: 0,
    toolTokens: 0,
    promptTokens: 0,
    resourceTokens: 0,
    toolCount: 0,
    promptCount: 0,
    resourceCount: 0,
    tools: [],
    durationMs: 0,
    usedBy: [],
  };
}

class TimeoutError extends Error {}

/** The SDK is heavy (zod, ajv...), so it's only loaded when a server is actually measured. */
type Sdk = {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
  SSEClientTransport: typeof import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport;
};
let sdkPromise: Promise<Sdk> | null = null;
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ]).then(([a, b, c, d]) => ({
    Client: a.Client,
    StdioClientTransport: b.StdioClientTransport,
    StreamableHTTPClientTransport: c.StreamableHTTPClientTransport,
    SSEClientTransport: d.SSEClientTransport,
  }));
  return sdkPromise;
}

function classifyError(e: unknown, stderrTail: string): { status: McpServerResult['status']; message: string } {
  const err = e as Error & { code?: unknown };
  let message = (err?.message ?? String(e)).replace(/\s+/g, ' ').trim();
  if (e instanceof TimeoutError) return { status: 'timeout', message };
  if (typeof err?.code === 'number' && err.code >= 400) {
    if (!message.includes(String(err.code))) message = `HTTP ${err.code}: ${message}`;
    if (err.code === 401 || err.code === 403) {
      return { status: 'auth', message: `needs authentication (${truncate(message, 160)})` };
    }
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid_token|oauth/i.test(message)) {
    return { status: 'auth', message: `needs authentication (${truncate(message, 120)})` };
  }
  if (err?.code === 'ENOENT' || /ENOENT/.test(message)) message = `command not found (${truncate(message, 120)})`;
  if (/Connection closed/i.test(message) && stderrTail) message = `${message}: ${stderrTail}`;
  return { status: 'error', message: truncate(message, 300) };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const livePids = new Set<number>();

/** Best-effort kill of every server process still running (called on exit). */
export function killAllServers(): void {
  for (const pid of livePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  livePids.clear();
}

function makeTransport(
  sdk: Sdk,
  s: McpServerConfig,
  env: NodeJS.ProcessEnv,
  mode: 'http' | 'sse',
  onStderr: (chunk: string) => void,
): Transport {
  if (s.transport === 'stdio') {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v != null) merged[k] = v;
    Object.assign(merged, s.env ?? {});
    const t = new sdk.StdioClientTransport({
      command: s.command!,
      args: s.args ?? [],
      env: merged,
      cwd: s.cwd,
      stderr: 'pipe',
    });
    t.stderr?.on('data', (d: Buffer) => onStderr(d.toString('utf8')));
    return t;
  }
  const url = new URL(s.url!);
  const requestInit: RequestInit = s.headers ? { headers: s.headers } : {};
  if (mode === 'sse') return new sdk.SSEClientTransport(url, { requestInit });
  return new sdk.StreamableHTTPClientTransport(url, { requestInit });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the client and make sure a spawned server is gone. We already have what we need,
 * so we don't wait the SDK's full graceful period: stdin EOF, ~400ms grace, SIGTERM, then SIGKILL.
 */
async function closeQuietly(client: Client, pid: number | null): Promise<void> {
  const closing = client.close().catch(() => undefined);
  await Promise.race([closing, new Promise((r) => setTimeout(r, 400))]);
  if (pid == null) return;
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    if (!alive(pid)) break;
    try {
      process.kill(pid, sig);
    } catch {
      /* gone */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!alive(pid)) livePids.delete(pid);
}

async function listAll(client: Client, signal: AbortSignal) {
  const caps = client.getServerCapabilities() ?? {};
  const tools: { name: string; description?: string; inputSchema?: unknown }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const prompts: { name: string; description?: string }[] = [];
  if (caps.prompts) {
    cursor = undefined;
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await client.listPrompts(cursor ? { cursor } : undefined, { signal });
        prompts.push(...page.prompts);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch {
      /* optional */
    }
  }
  const resources: { name: string; description?: string }[] = [];
  if (caps.resources) {
    cursor = undefined;
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await client.listResources(cursor ? { cursor } : undefined, { signal });
        resources.push(...page.resources);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch {
      /* optional */
    }
  }
  return { tools, prompts, resources };
}

async function attempt(
  s: McpServerConfig,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  mode: 'http' | 'sse',
  result: McpServerResult,
): Promise<void> {
  const sdk = await loadSdk();
  let stderr = '';
  const transport = makeTransport(sdk, s, env, mode, (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  const client = new sdk.Client({ name: 'context-diet', version: VERSION }, { capabilities: {} });
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`no response within ${Math.round(timeoutMs / 1000)}s`));
      ac.abort();
    }, timeoutMs);
  });
  let pid: number | null = null;
  // Capture the child pid as soon as it is spawned: the SDK forgets it when it closes the
  // transport after a failed/aborted handshake, and we must still be able to kill it.
  if (transport instanceof sdk.StdioClientTransport) {
    const start = transport.start.bind(transport);
    transport.start = async () => {
      await start();
      pid = transport.pid;
      if (pid != null) livePids.add(pid);
    };
  }
  try {
    const work = (async () => {
      await client.connect(transport, { signal: ac.signal, timeout: timeoutMs });
      return listAll(client, ac.signal);
    })();
    work.catch(() => undefined);
    const { tools, prompts, resources } = await Promise.race([work, timeout]);
    const ver = client.getServerVersion();
    result.serverName = ver?.name;
    result.serverVersion = ver?.version;
    const infos: McpToolInfo[] = tools.map((t) => ({ name: t.name, tokens: toolTokens(t) }));
    infos.sort((a, b) => b.tokens - a.tokens);
    result.tools = infos;
    result.toolCount = infos.length;
    result.toolTokens = infos.reduce((n, t) => n + t.tokens, 0);
    result.promptCount = prompts.length;
    result.promptTokens = prompts.reduce(
      (n, p) => n + countTokens(JSON.stringify({ name: p.name, description: p.description ?? '' })),
      0,
    );
    result.resourceCount = resources.length;
    result.resourceTokens = resources.reduce(
      (n, r) => n + countTokens(JSON.stringify({ name: r.name, description: r.description ?? '' })),
      0,
    );
    result.tokens = result.toolTokens + result.promptTokens;
    result.status = 'ok';
    delete result.error;
  } catch (e) {
    const tail = stderr.trim().split('\n').slice(-3).join(' | ');
    const { status, message } = classifyError(e, truncate(tail, 200));
    result.status = status;
    result.error = message;
  } finally {
    clearTimeout(timer);
    await closeQuietly(client, pid);
  }
}

export async function measureServer(
  s: McpServerConfig,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<McpServerResult> {
  const key = serverKey(s);
  const result = emptyResult(s, key);
  if (s.disabled) {
    result.status = 'disabled';
    return result;
  }
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  if (s.unresolved?.some((u) => u.startsWith('${input:'))) {
    result.status = 'error';
    result.error = `needs interactive input ${s.unresolved.join(', ')}`;
    return result;
  }
  await attempt(s, env, timeoutMs, s.transport === 'sse' ? 'sse' : 'http', result);
  // Unknown remote transport: fall back from Streamable HTTP to legacy SSE.
  if (result.status === 'error' && s.guessTransport && s.transport !== 'stdio') {
    const remaining = Math.max(1000, timeoutMs - (Date.now() - started));
    const fallback = emptyResult(s, key);
    await attempt(s, env, remaining, 'sse', fallback);
    if (fallback.status === 'ok') {
      Object.assign(result, fallback, { transport: 'sse' });
    }
  }
  result.durationMs = Date.now() - started;
  return result;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface MeasureInput {
  agent: AgentId;
  config: McpServerConfig;
}

/**
 * Measure every configured server once (dedupe identical configs across agents),
 * returning results keyed by serverKey.
 */
export async function measureAll(
  inputs: MeasureInput[],
  opts: {
    measure: boolean;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    concurrency?: number;
    onProgress?: (done: number, total: number, name: string) => void;
  },
): Promise<Map<string, McpServerResult>> {
  const unique = new Map<string, { config: McpServerConfig; usedBy: Set<AgentId> }>();
  for (const { agent, config } of inputs) {
    const key = serverKey(config);
    const entry = unique.get(key);
    if (entry) {
      entry.usedBy.add(agent);
      // An enabled config wins over a disabled duplicate.
      if (entry.config.disabled && !config.disabled) entry.config = config;
    } else unique.set(key, { config, usedBy: new Set([agent]) });
  }
  const entries = [...unique.entries()];
  const out = new Map<string, McpServerResult>();
  let done = 0;
  await mapLimit(entries, opts.concurrency ?? DEFAULT_CONCURRENCY, async ([key, { config, usedBy }]) => {
    let r: McpServerResult;
    if (!opts.measure && !config.disabled) {
      r = emptyResult(config, key);
    } else {
      r = await measureServer(config, { env: opts.env, timeoutMs: opts.timeoutMs });
    }
    r.usedBy = [...usedBy];
    out.set(key, r);
    done++;
    opts.onProgress?.(done, entries.length, config.name);
  });
  return out;
}
