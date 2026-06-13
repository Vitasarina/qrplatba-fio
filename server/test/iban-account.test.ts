import { describe, it, expect } from "vitest";
import { czechAccountToIban, fromCzechAccount, isValidIban } from "../src/domain/iban.js";

const VALID_IBAN = "CZ6508000000192000145399";

describe("Czech account number -> IBAN", () => {
  it("converts prefix-number/bank to the expected IBAN", () => {
    expect(fromCzechAccount("19", "2000145399", "0800")).toBe(VALID_IBAN);
    expect(czechAccountToIban("19-2000145399/0800")).toBe(VALID_IBAN);
  });

  it("handles a missing prefix (defaults to 0) and produces a valid IBAN", () => {
    const iban = fromCzechAccount(null, "2400123456", "2010");
    expect(isValidIban(iban)).toBe(true);
    expect(czechAccountToIban("2400123456/2010")).toBe(iban);
  });

  it("ignores spaces in the account string", () => {
    expect(czechAccountToIban(" 19 - 2000145399 / 0800 ")).toBe(VALID_IBAN);
  });

  it("returns null for things that are not Czech account numbers", () => {
    expect(czechAccountToIban("not-an-account")).toBeNull();
    expect(czechAccountToIban(VALID_IBAN)).toBeNull(); // an IBAN is not an account number
    expect(czechAccountToIban(null)).toBeNull();
  });

  it("throws for out-of-range components", () => {
    expect(() => fromCzechAccount("1234567", "1", "0800")).toThrow(); // prefix too long
    expect(() => fromCzechAccount(null, "12345678901", "0800")).toThrow(); // base too long
  });
});
