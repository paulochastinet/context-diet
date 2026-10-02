import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  encoder ??= new Tiktoken(o200k_base);
  return encoder;
}

/**
 * Approximate token count using OpenAI's o200k_base BPE.
 * Claude and Gemini use different (unpublished) tokenizers, so treat this as
 * an estimate (typically within ~10-20% for English prose and JSON).
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  // disallowedSpecial = [] so text containing e.g. "<|endoftext|>" doesn't throw.
  return getEncoder().encode(text, [], []).length;
}

/** Compact number formatting: 950, 1.2k, 38k, 1.1M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
