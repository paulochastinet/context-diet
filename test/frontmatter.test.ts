import { describe, expect, it } from 'vitest';
import { fmBool, fmString, parseFrontmatter } from '../src/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses scalars, quotes, booleans and lists', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'name: pdf',
        'description: "Quoted: with colon"',
        "other: 'single ''quoted'''",
        'alwaysApply: true',
        'globs: [src/**/*.ts, "*.tsx"]',
        'tools:',
        '  - Read',
        '  - Grep',
        '---',
        'Body here',
      ].join('\n'),
    );
    expect(fm.data.name).toBe('pdf');
    expect(fm.data.description).toBe('Quoted: with colon');
    expect(fm.data.other).toBe("single 'quoted'");
    expect(fmBool(fm.data, 'alwaysApply')).toBe(true);
    expect(fm.data.globs).toEqual(['src/**/*.ts', '*.tsx']);
    expect(fm.data.tools).toEqual(['Read', 'Grep']);
    expect(fm.body).toBe('Body here');
  });

  it('parses folded and literal block scalars', () => {
    const fm = parseFrontmatter('---\ndescription: >\n  line one\n  line two\nliteral: |\n  a\n  b\n---\n');
    expect(fm.data.description).toBe('line one line two');
    expect(fm.data.literal).toBe('a\nb');
  });

  it('handles plain multi-line scalars and missing frontmatter', () => {
    const fm = parseFrontmatter('---\ndescription: starts here\n  and continues\n---\nx');
    expect(fmString(fm.data, 'description')).toBe('starts here and continues');
    expect(parseFrontmatter('# no frontmatter').data).toEqual({});
  });
});
