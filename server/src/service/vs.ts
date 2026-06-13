import { randomInt } from "node:crypto";

/**
 * Generate a numeric variable symbol, max 10 digits, unique against the set of
 * VS values currently in use by open sessions.
 *
 * Strategy: random 10-digit number (no leading zero) for high entropy and low
 * collision probability, retried until unique. Falls back to widening the
 * search space defensively (it never realistically exhausts at one-register scale).
 */
export function generateVs(taken: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = randomVs();
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("failed to generate a unique VS after 1000 attempts");
}

function randomVs(): string {
  // 10-digit, first digit 1-9 so the string length is exactly 10.
  const first = randomInt(1, 10); // 1..9
  let rest = "";
  for (let i = 0; i < 9; i++) {
    rest += randomInt(0, 10).toString();
  }
  return `${first}${rest}`;
}
