import path from 'node:path';
import { displayPath, direntIsDir, direntIsFile, listDir, readText, realpath, walkFiles } from '../fsutil.js';
import { fmString, parseFrontmatter } from '../frontmatter.js';
import { resolveImports } from '../imports.js';
import { countTokens } from '../tokens.js';
import type { McpServerConfig, ScanContext, Source, SourceKind } from '../types.js';

export function disp(ctx: ScanContext, abs: string): string {
  return displayPath(abs, ctx.cwd, ctx.home, ctx.repoRoot);
}

/**
 * An instruction file plus (optionally) its `@imports` as separate child sources.
 * Returns [] if the file doesn't exist or was already seen.
 */
export function instructionSources(
  ctx: ScanContext,
  file: string,
  seen: Set<string>,
  opts: { kind?: SourceKind; withImports?: boolean } = {},
): Source[] {
  const real = realpath(file);
  if (seen.has(real)) return [];
  const text = readText(file);
  if (text == null) return [];
  seen.add(real);
  const main: Source = {
    kind: opts.kind ?? 'instructions',
    name: path.basename(file),
    path: file,
    displayPath: disp(ctx, file),
    tokens: countTokens(text),
    loading: 'always',
    depth: 0,
    text,
  };
  const out = [main];
  if (opts.withImports) {
    for (const imp of resolveImports(file, text, ctx.home, seen)) {
      out.push({
        kind: 'import',
        name: path.basename(imp.path),
        path: imp.path,
        displayPath: disp(ctx, imp.path),
        tokens: countTokens(imp.text),
        loading: 'always',
        parent: disp(ctx, imp.parent),
        depth: imp.depth,
        text: imp.text,
      });
    }
  }
  return out;
}

/** Find SKILL.md files under a skills root. A directory containing SKILL.md is a skill (not descended into). */
export function findSkillFiles(root: string, maxDepth = 4, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const out: string[] = [];
  for (const d of listDir(root)) {
    if (!direntIsDir(root, d) || d.name === 'node_modules' || d.name === '.git') continue;
    const dir = path.join(root, d.name);
    const skill = path.join(dir, 'SKILL.md');
    if (readText(skill) != null) out.push(skill);
    else out.push(...findSkillFiles(dir, maxDepth, depth + 1));
  }
  return out.sort();
}

/**
 * Skills: only `name` + `description` from frontmatter are always in context
 * (progressive disclosure). The rest of SKILL.md is loaded on demand.
 */
export function skillSources(ctx: ScanContext, roots: string[], seen: Set<string>, notes?: string[]): Source[] {
  const out: Source[] = [];
  const names = new Set<string>();
  let dupes = 0;
  for (const root of roots) {
    for (const file of findSkillFiles(root)) {
      const real = realpath(file);
      if (seen.has(real)) continue;
      seen.add(real);
      const text = readText(file) ?? '';
      const fm = parseFrontmatter(text);
      const name = fmString(fm.data, 'name') ?? path.basename(path.dirname(file));
      const description = fmString(fm.data, 'description') ?? '';
      if (names.has(name)) {
        dupes++;
        continue;
      }
      names.add(name);
      const meta = `- ${name}: ${description}`;
      const total = countTokens(text);
      const tokens = countTokens(meta);
      out.push({
        kind: 'skill',
        name,
        path: file,
        displayPath: disp(ctx, file),
        tokens,
        onDemandTokens: Math.max(0, total - tokens),
        loading: 'always',
        text: meta,
      });
    }
  }
  if (dupes && notes) notes.push(`${dupes} skill(s) with a duplicate name were ignored (first one found wins).`);
  return out;
}

/** Markdown files with a `description` frontmatter (subagents, slash commands). */
export function describedMarkdownSources(
  ctx: ScanContext,
  dirs: string[],
  kind: SourceKind,
  seen: Set<string>,
  opts: { recursive?: boolean; prefix?: string } = {},
): Source[] {
  const out: Source[] = [];
  for (const dir of dirs) {
    const files = opts.recursive
      ? walkFiles(dir, (n) => n.endsWith('.md'), 4)
      : listDir(dir)
          .filter((d) => direntIsFile(dir, d) && d.name.endsWith('.md'))
          .map((d) => path.join(dir, d.name))
          .sort();
    for (const file of files) {
      const real = realpath(file);
      if (seen.has(real)) continue;
      seen.add(real);
      const text = readText(file) ?? '';
      const fm = parseFrontmatter(text);
      let name = fmString(fm.data, 'name');
      if (!name) {
        const rel = path.relative(dir, file).replace(/\.md$/, '');
        name = rel.split(path.sep).join(':');
      }
      let description = fmString(fm.data, 'description');
      if (!description) {
        const first = fm.body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
        description = first.trim().slice(0, 100);
      }
      const meta = `- ${opts.prefix ?? ''}${name}: ${description}`;
      out.push({
        kind,
        name: `${opts.prefix ?? ''}${name}`,
        path: file,
        displayPath: disp(ctx, file),
        tokens: countTokens(meta),
        onDemandTokens: Math.max(0, countTokens(text) - countTokens(meta)),
        loading: 'always',
        text: meta,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- MCP config

const VAR_RE = /\$\{([^}]+)\}/g;

/**
 * Expand `${VAR}`, `${VAR:-default}`, `${env:VAR}`, `${workspaceFolder}`, `${userHome}`.
 * Anything unresolvable (e.g. `${input:token}`) is left in place and reported.
 */
export function expandVars(
  value: string,
  ctx: ScanContext,
  unresolved: Set<string>,
): string {
  return value.replace(VAR_RE, (whole, expr: string) => {
    if (expr === 'workspaceFolder' || expr === 'workspaceRoot') return ctx.repoRoot ?? ctx.cwd;
    if (expr === 'userHome') return ctx.home;
    if (expr.startsWith('env:')) {
      const v = ctx.env[expr.slice(4)];
      if (v != null) return v;
      unresolved.add(whole);
      return '';
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(expr);
    if (m) {
      const v = ctx.env[m[1]!];
      if (v != null && v !== '') return v;
      if (m[2] != null) return m[2];
      unresolved.add(whole);
      return whole;
    }
    unresolved.add(whole);
    return whole;
  });
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val == null) continue;
    out[k] = String(val);
  }
  return out;
}

/**
 * Normalise one MCP server entry from any agent's config format into McpServerConfig.
 * Recognises: command/args/env/cwd, url, httpUrl (Gemini), serverUrl, type/transport, headers,
 * http_headers (Codex), disabled, enabled (Codex).
 */
export function normalizeMcpEntry(
  name: string,
  raw: unknown,
  configPath: string,
  scope: McpServerConfig['scope'],
  ctx: ScanContext,
): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const unresolved = new Set<string>();
  const x = (s: string) => expandVars(s, ctx, unresolved);

  const disabled = r.disabled === true || r.enabled === false;
  const type = String(r.type ?? r.transport ?? '').toLowerCase();
  const httpUrl = typeof r.httpUrl === 'string' ? r.httpUrl : undefined;
  const url =
    httpUrl ??
    (typeof r.url === 'string' ? r.url : typeof r.serverUrl === 'string' ? r.serverUrl : undefined);
  const headers = strRecord(r.headers ?? r.http_headers);

  let cfg: McpServerConfig;
  if (typeof r.command === 'string' && r.command) {
    const args = Array.isArray(r.args) ? r.args.map((a) => x(String(a))) : [];
    const env = strRecord(r.env);
    cfg = {
      name,
      transport: 'stdio',
      command: x(r.command),
      args,
      env: env ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, x(v)])) : undefined,
      cwd: typeof r.cwd === 'string' ? x(r.cwd) : undefined,
      configPath,
      scope,
      disabled,
    };
  } else if (url) {
    let transport: McpServerConfig['transport'] = 'http';
    let guess = false;
    if (httpUrl || type === 'http' || type === 'streamable-http' || type === 'streamablehttp') transport = 'http';
    else if (type === 'sse') transport = 'sse';
    else guess = true;
    cfg = {
      name,
      transport,
      url: x(url),
      headers: headers
        ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, x(v)]))
        : undefined,
      configPath,
      scope,
      disabled,
      guessTransport: guess,
    };
    // Codex: bearer_token_env_var
    if (typeof r.bearer_token_env_var === 'string') {
      const tok = ctx.env[r.bearer_token_env_var];
      if (tok) cfg.headers = { ...(cfg.headers ?? {}), Authorization: `Bearer ${tok}` };
    }
  } else {
    return null;
  }
  if (unresolved.size) cfg.unresolved = [...unresolved];
  return cfg;
}

export function mcpFromObject(
  obj: unknown,
  configPath: string,
  scope: McpServerConfig['scope'],
  ctx: ScanContext,
): McpServerConfig[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(obj as Record<string, unknown>)) {
    const cfg = normalizeMcpEntry(name, raw, configPath, scope, ctx);
    if (cfg) out.push(cfg);
  }
  return out;
}

/** Later entries override earlier ones with the same name (project overrides user). */
export function mergeByName(list: McpServerConfig[]): McpServerConfig[] {
  const map = new Map<string, McpServerConfig>();
  for (const s of list) map.set(s.name, s);
  return [...map.values()];
}
