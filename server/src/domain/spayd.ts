import { formatAmount2dp, type Money } from "./money.js";

/**
 * Build a SPAYD ("QR Platba", Czech Banking Association) string.
 * Format: SPD*1.0*ACC:<IBAN>*AM:<amount.2dp>*CC:CZK*X-VS:<vs>*MSG:<name>
 *
 * SPAYD field values must not contain '*' (the field separator). The MSG value
 * is sanitized: '*' stripped, and per spec MSG is limited to 60 chars.
 */
export interface SpaydInput {
  iban: string;
  amount: Money;
  vs: string;
  message: string;
  currency?: string;
}

export function buildSpayd(input: SpaydInput): string {
  const currency = input.currency ?? "CZK";
  const msg = sanitizeMessage(input.message);
  const parts = [
    "SPD",
    "1.0",
    `ACC:${input.iban}`,
    `AM:${formatAmount2dp(input.amount)}`,
    `CC:${currency}`,
    `X-VS:${input.vs}`,
    `MSG:${msg}`,
  ];
  return parts.join("*");
}

function sanitizeMessage(message: string): string {
  // Remove field separators and control chars; SPAYD MSG max length is 60.
  return message
    .replace(/\*/g, " ")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 60);
}
