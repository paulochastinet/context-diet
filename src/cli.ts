import pc from 'picocolors';
import { HELP, parseCli, UsageError, type CliOptions } from './args.js';
import { killAllServers, serverKey } from './mcp.js';
import { makeContext, profile, scanAgents, toJson } from './profile.js';
import { renderMarkdown } from './render/markdown.js';
import { renderPretty } from './render/pretty.js';
import { VERSION } from './version.js';

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!text) return resolve();
    stream.write(text, () => resolve());
  });
}

function useColor(opts: CliOptions): boolean {
  if (opts.color != null) return opts.color;
  if ('NO_COLOR' in process.env && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!process.stdout.isTTY && process.env.TERM !== 'dumb';
}

async function main(argv: string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      await write(process.stderr, `context-diet: ${e.message}\nRun "context-diet --help" for usage.\n`);
      return 2;
    }
    throw e;
  }
  if (opts.help) {
    await write(process.stdout, HELP);
    return 0;
  }
  if (opts.version) {
    await write(process.stdout, `${VERSION}\n`);
    return 0;
  }

  const ctx = makeContext({ cwd: opts.cwd, home: opts.home });
  const interactive = !!process.stderr.isTTY && opts.format === 'pretty';
  const colorErr = pc.createColors(useColor(opts) && !!process.stderr.isTTY);

  if (opts.mcp) {
    const toLaunch = new Set(
      scanAgents(ctx, opts.agents.length ? opts.agents : undefined)
        .flatMap((s) => s.mcp.filter((m) => !m.disabled))
        .map(serverKey),
    );
    if (toLaunch.size) {
      await write(
        process.stderr,
        colorErr.dim(
          `Starting ${toLaunch.size} configured MCP server${toLaunch.size === 1 ? '' : 's'} locally to read ${toLaunch.size === 1 ? 'its' : 'their'} tool lists (--no-mcp to skip)…\n`,
        ),
      );
    }
  }

  let lastLen = 0;
  const report = await profile({
    cwd: ctx.cwd,
    home: ctx.home,
    agents: opts.agents,
    window: opts.window,
    maxTokens: opts.maxTokens,
    mcp: opts.mcp,
    timeoutMs: opts.timeoutMs,
    concurrency: opts.concurrency,
    onMcpProgress: interactive
      ? (done, total, name) => {
          const msg = `  measuring MCP servers ${done}/${total} (${name})`;
          process.stderr.write(`\r${msg}${' '.repeat(Math.max(0, lastLen - msg.length))}`);
          lastLen = msg.length;
        }
      : undefined,
  });
  if (interactive && lastLen) process.stderr.write(`\r${' '.repeat(lastLen)}\r`);

  let text: string;
  if (opts.format === 'json') text = `${JSON.stringify(toJson(report), null, 2)}\n`;
  else if (opts.format === 'markdown') text = renderMarkdown(report);
  else text = renderPretty(report, { color: useColor(opts), verbose: opts.verbose, width: process.stdout.columns });
  await write(process.stdout, text);

  if (report.budget.exceeded.length) {
    if (opts.format !== 'pretty') {
      const names = report.agents.filter((a) => a.overBudget).map((a) => `${a.name} (≈${a.totalTokens})`);
      await write(process.stderr, `context-diet: over budget of ${report.budget.maxTokens} tokens: ${names.join(', ')}\n`);
    }
    return 1;
  }
  return 0;
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    killAllServers();
    process.exit(130);
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    killAllServers();
    process.exit(code);
  },
  async (e: unknown) => {
    killAllServers();
    await write(process.stderr, `context-diet: unexpected error: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(3);
  },
);
