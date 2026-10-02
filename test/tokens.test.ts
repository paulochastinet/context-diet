import { describe, expect, it } from 'vitest';
import { countTokens, formatTokens } from '../src/tokens.js';

describe('tokens', () => {
  it('counts with o200k_base and tolerates special tokens', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('hello world')).toBe(2);
    expect(countTokens('<|endoftext|>')).toBeGreaterThan(0);
  });
  it('formats compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(38_400)).toBe('38k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });
});
