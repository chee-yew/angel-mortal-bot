export type Pair = [angel: string, mortal: string];

export interface ParseResult {
  pairs: Pair[];
  errors: string[];
  warnings: string[];
}

const USERNAME = /^[a-z0-9_]{4,32}$/;

/** Whether an already-normalised handle could be a Telegram username. */
export const isValidHandle = (handle: string) => USERNAME.test(handle);

export function normaliseHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Parses "angel,mortal" lines (comma, tab, semicolon or space separated).
 * Errors block the upload; warnings are reported but allowed.
 */
export function parsePairings(text: string): ParseResult {
  const pairs: Pair[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/[,\t;\s]+/).map(normaliseHandle).filter(Boolean);
    if (/^angel/.test(parts[0] ?? "") && /^mortal/.test(parts[1] ?? "")) return; // header row
    if (parts.length !== 2) {
      errors.push(`Line ${i + 1}: expected "angel,mortal" but got "${line}"`);
      return;
    }
    const [angel, mortal] = parts;
    for (const h of [angel, mortal]) {
      if (!isValidHandle(h)) errors.push(`Line ${i + 1}: "@${h}" is not a valid Telegram username`);
    }
    if (angel === mortal) errors.push(`Line ${i + 1}: @${angel} is paired with themselves`);
    pairs.push([angel, mortal]);
  });

  if (pairs.length === 0 && errors.length === 0) errors.push("No pairings found.");

  const angels = new Set<string>();
  const mortals = new Set<string>();
  for (const [a, m] of pairs) {
    if (angels.has(a)) errors.push(`@${a} is listed as an angel more than once`);
    if (mortals.has(m)) errors.push(`@${m} is listed as a mortal more than once`);
    angels.add(a);
    mortals.add(m);
  }

  for (const h of angels) if (!mortals.has(h)) warnings.push(`@${h} has a mortal but no angel`);
  for (const h of mortals) if (!angels.has(h)) warnings.push(`@${h} has an angel but no mortal`);

  const pairSet = new Set(pairs.map(([a, m]) => `${a}>${m}`));
  for (const [a, m] of pairs) {
    if (a < m && pairSet.has(`${m}>${a}`)) {
      warnings.push(`@${a} and @${m} are each other's angel AND mortal, so they can work out who their angel is`);
    }
  }

  return { pairs, errors, warnings };
}
