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

/** Czech account number: optional "prefix-", base, "/bankcode". Spaces ignored. */
const CZ_ACCOUNT = /^(?:([0-9]{1,6})-)?([0-9]{1,10})\/([0-9]{1,4})$/;

/**
 * If `raw` is a Czech account number (e.g. "2400123456/2010" or "19-2000145399/0800"),
 * convert it to the normalized IBAN; otherwise return null.
 */
export function czechAccountToIban(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/\s+/g, "");
  const m = CZ_ACCOUNT.exec(cleaned);
  if (!m) return null;
  const prefix = m[1] ?? null;
  const base = m[2]!;
  const bank = m[3]!;
  return fromCzechAccount(prefix && prefix.length > 0 ? prefix : null, base, bank);
}

/**
 * Czech account number -> IBAN.
 *
 * BBAN layout for CZ is bank(4) + prefix(6, zero-padded) + base(10, zero-padded) = 20 digits.
 * The two IBAN check digits are derived with the standard ISO 7064 mod-97 algorithm:
 * 98 - (mod97 of BBAN + "CZ00" rearranged), where "CZ" maps to "1235".
 *
 * Throws IbanError on malformed components.
 */
export function fromCzechAccount(
  prefix: string | null,
  number: string,
  bankCode: string,
): string {
  const bank = bankCode.trim();
  const pfx = (prefix ?? "").trim() || "0";
  const base = number.trim();
  if (!/^[0-9]{1,4}$/.test(bank)) throw new IbanError("kód banky musí být 1–4 číslice");
  if (!/^[0-9]{1,6}$/.test(pfx)) throw new IbanError("předčíslí musí mít nejvýše 6 číslic");
  if (!/^[0-9]{1,10}$/.test(base)) throw new IbanError("číslo účtu musí mít nejvýše 10 číslic");

  const bban = bank.padStart(4, "0") + pfx.padStart(6, "0") + base.padStart(10, "0");
  // Check string: BBAN + country code as digits ("CZ" -> 1235) + "00".
  const checkSource = bban + "123500";
  const checkDigits = String(98 - mod97Digits(checkSource)).padStart(2, "0");
  return `CZ${checkDigits}${bban}`;
}

export class IbanError extends Error {
  override readonly name = "IbanError";
}

/** mod-97 over a pure-digit string, chunked to stay within safe integer range. */
function mod97Digits(digits: string): number {
  let remainder = 0;
  let i = 0;
  while (i < digits.length) {
    const end = Math.min(i + 7, digits.length);
    const chunk = remainder.toString() + digits.slice(i, end);
    remainder = Number(chunk) % 97;
    i = end;
  }
  return remainder;
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
