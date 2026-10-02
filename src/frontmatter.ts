export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  raw: string;
}

const FM_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Parse the YAML frontmatter used by SKILL.md / agents / rules.
 * This is a deliberately small subset of YAML (no dependency, never throws):
 * `key: value`, quoted strings, booleans, numbers, inline `[a, b]` lists,
 * `- item` block lists and `|` / `>` block scalars.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text, raw: '' };
  const raw = m[1] ?? '';
  return { data: parseYamlSubset(raw), body: text.slice(m[0].length), raw };
}

function scalar(v: string): unknown {
  const s = v.trim();
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2)) {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => scalar(x))
      .filter((x) => x !== '');
  }
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^(null|~)$/i.test(s)) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // strip trailing comment
  return s.replace(/\s+#.*$/, '');
}

export function parseYamlSubset(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rest = (m[2] ?? '').trim();
    const block = /^([|>])[+-]?\d*$/.exec(rest);
    if (block) {
      const collected: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) {
        collected.push(lines[++i]!);
      }
      const indent = Math.min(...collected.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length), 1e9);
      const body = collected.map((l) => l.slice(Math.min(indent, l.length)));
      out[key] = block[1] === '|' ? body.join('\n').trim() : body.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    if (rest === '') {
      const items: unknown[] = [];
      const cont: string[] = [];
      while (i + 1 < lines.length && /^\s+\S|^-\s/.test(lines[i + 1]!)) {
        const next = lines[++i]!;
        const item = /^\s*-\s+(.*)$/.exec(next);
        if (item) items.push(scalar(item[1]!));
        else cont.push(next.trim());
      }
      out[key] = items.length ? items : cont.length ? cont.join(' ') : '';
      continue;
    }
    // plain multi-line scalar continuation (indented lines)
    let value = rest;
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && !/^\s*-\s/.test(lines[i + 1]!)) {
      value += ` ${lines[++i]!.trim()}`;
    }
    out[key] = scalar(value);
  }
  return out;
}

export function fmString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(String).join(', ');
  return undefined;
}

export function fmBool(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true;
}
