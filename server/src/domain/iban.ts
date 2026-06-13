/**
 * IBAN validation: structural check + ISO 7064 mod-97 checksum.
 * Generic for any country, but length is sanity-checked against the
 * IBAN registry for a few common ones (CZ is 24).
 */

const COUNTRY_LENGTHS: Record<string, number> = {
  CZ: 24,
  SK: 24,
  DE: 22,
  AT: 20,
  PL: 28,
  GB: 22,
};

export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isValidIban(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const iban = normalizeIban(raw);

  // Basic shape: 2 letters, 2 check digits, then alphanumerics. Length 15..34.
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return false;
  }

  const country = iban.slice(0, 2);
  const expectedLen = COUNTRY_LENGTHS[country];
  if (expectedLen !== undefined && iban.length !== expectedLen) {
    return false;
  }

  return mod97(iban) === 1;
}

/**
 * ISO 7064 mod-97-10. Move first 4 chars to the end, map letters to numbers
 * (A=10 .. Z=35), then compute the big integer mod 97 in chunks.
 */
function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  let buffer = "";
  for (const ch of rearranged) {
    if (ch >= "A" && ch <= "Z") {
      buffer += (ch.charCodeAt(0) - 55).toString(); // A->10 ... Z->35
    } else {
      buffer += ch;
    }
    // Process in chunks to stay within safe integer range.
    while (buffer.length >= 7) {
      remainder = Number(remainder.toString() + buffer.slice(0, 7)) % 97;
      buffer = buffer.slice(7);
    }
  }
  if (buffer.length > 0) {
    remainder = Number(remainder.toString() + buffer) % 97;
  }
  return remainder;
}
