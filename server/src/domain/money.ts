import Decimal from "decimal.js";

// Money is handled with decimal.js to avoid IEEE-754 float drift on currency math.
// All amounts are CZK with exactly 2 decimal places at the boundary.
// Configure decimal.js once for the whole process.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;

export function money(value: string | number | Decimal): Money {
  return new Decimal(value);
}

/**
 * Parse an incoming amount, enforcing: finite, positive, max 2 decimal places.
 * Throws on invalid input so callers can map to a 400.
 */
export function parseAmount(value: unknown): Money {
  if (value === null || value === undefined) {
    throw new AmountError("amount is required");
  }
  let d: Decimal;
  try {
    // Reject objects/booleans; accept number or numeric string.
    if (typeof value !== "number" && typeof value !== "string") {
      throw new Error("type");
    }
    d = new Decimal(value);
  } catch {
    throw new AmountError("amount is not a valid number");
  }
  if (!d.isFinite()) {
    throw new AmountError("amount must be finite");
  }
  if (d.lessThanOrEqualTo(0)) {
    throw new AmountError("amount must be greater than 0");
  }
  if (d.decimalPlaces() > 2) {
    throw new AmountError("amount must have at most 2 decimal places");
  }
  return d;
}

export class AmountError extends Error {
  override readonly name = "AmountError";
}

/** Format with exactly 2 decimal places, e.g. "450.00" — used in SPAYD and API. */
export function formatAmount2dp(amount: Money): string {
  return amount.toFixed(2);
}

export function amountsEqual(a: Money, b: Money): boolean {
  return a.equals(b);
}
