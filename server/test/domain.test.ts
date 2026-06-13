import { describe, it, expect } from "vitest";
import { isValidIban, normalizeIban } from "../src/gateway/../domain/iban.js";
import { buildSpayd } from "../src/domain/spayd.js";
import { buildSpaydMessage } from "../src/service/SessionService.js";
import { parseAmount, money, formatAmount2dp, AmountError } from "../src/domain/money.js";
import { maskToken, validateConfig, ConfigError } from "../src/domain/config.js";
import { VALID_IBAN } from "./helpers.js";

describe("IBAN validation (AC-1.2)", () => {
  it("accepts a valid Czech IBAN", () => {
    expect(isValidIban(VALID_IBAN)).toBe(true);
  });

  it("accepts a valid IBAN with spaces", () => {
    expect(isValidIban("CZ65 0800 0000 1920 0014 5399")).toBe(true);
    expect(normalizeIban("CZ65 0800 0000 1920 0014 5399")).toBe(VALID_IBAN);
  });

  it("rejects a wrong checksum", () => {
    expect(isValidIban("CZ6608000000192000145399")).toBe(false);
  });

  it("rejects wrong length for CZ", () => {
    expect(isValidIban("CZ650800000019200014539")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isValidIban("not-an-iban")).toBe(false);
    expect(isValidIban("")).toBe(false);
  });
});

describe("SPAYD builder (AC-3.4)", () => {
  it("produces the exact documented format", () => {
    const spayd = buildSpayd({
      iban: VALID_IBAN,
      amount: money("450"),
      vs: "1234567890",
      message: "Nazev obchodu",
    });
    expect(spayd).toBe(
      "SPD*1.0*ACC:CZ6508000000192000145399*AM:450.00*CC:CZK*X-VS:1234567890*MSG:Nazev obchodu",
    );
  });

  it("formats amount to 2 decimal places", () => {
    const spayd = buildSpayd({ iban: VALID_IBAN, amount: money("9.5"), vs: "1", message: "x" });
    expect(spayd).toContain("AM:9.50");
  });

  it("strips '*' separators from the message", () => {
    const spayd = buildSpayd({ iban: VALID_IBAN, amount: money("1"), vs: "1", message: "a*b*c" });
    expect(spayd).toContain("MSG:a b c");
    // exactly the documented number of fields (no stray separators)
    expect(spayd.split("*").length).toBe(7);
  });
});

describe("SPAYD message = note + company name", () => {
  it("combines note and name, hyphen-joined, note first, lowercased", () => {
    expect(buildSpaydMessage("Boldgym", "musli")).toBe("musli-boldgym");
  });

  it("uses just the lowercased name when there is no note", () => {
    expect(buildSpaydMessage("Boldgym", null)).toBe("boldgym");
    expect(buildSpaydMessage("Boldgym", "   ")).toBe("boldgym");
  });
});

describe("money decimal correctness", () => {
  it("does not drift like float math (0.1 + 0.2)", () => {
    expect(money("0.1").plus("0.2").toFixed(2)).toBe("0.30");
  });

  it("compares amounts exactly", () => {
    expect(money("450.00").equals(money("450"))).toBe(true);
    expect(money("450.01").greaterThan(money("450.00"))).toBe(true);
    expect(money("449.99").lessThan(money("450.00"))).toBe(true);
  });

  it("formats 2dp", () => {
    expect(formatAmount2dp(money("1"))).toBe("1.00");
    expect(formatAmount2dp(money("1234.5"))).toBe("1234.50");
  });
});

describe("amount parsing/validation (AC-3.1, AC-3.2)", () => {
  it("accepts a positive 2dp amount", () => {
    expect(parseAmount("450.00").toFixed(2)).toBe("450.00");
    expect(parseAmount(12.5).toFixed(2)).toBe("12.50");
  });

  it("rejects zero and negative", () => {
    expect(() => parseAmount(0)).toThrow(AmountError);
    expect(() => parseAmount("-5")).toThrow(AmountError);
  });

  it("rejects more than 2 decimal places", () => {
    expect(() => parseAmount("1.234")).toThrow(AmountError);
  });

  it("rejects non-numeric", () => {
    expect(() => parseAmount("abc")).toThrow(AmountError);
    expect(() => parseAmount(undefined)).toThrow(AmountError);
    expect(() => parseAmount({})).toThrow(AmountError);
  });
});

describe("token masking (AC-1.3)", () => {
  it("masks all but the last 4 chars", () => {
    expect(maskToken("secret-token-abcdef")).toBe("***************cdef");
  });
  it("masks short tokens fully", () => {
    expect(maskToken("abcd")).toBe("****");
  });
});

describe("config validation", () => {
  it("rejects an invalid IBAN", () => {
    expect(() =>
      validateConfig({ name: "x", iban: "bad", token: "t", licenseKey: "l" }),
    ).toThrow(ConfigError);
  });
  it("rejects an empty name", () => {
    expect(() =>
      validateConfig({ name: "  ", iban: VALID_IBAN, token: "t", licenseKey: "l" }),
    ).toThrow(ConfigError);
  });
  it("normalizes a valid config", () => {
    const c = validateConfig({
      name: " Shop ",
      iban: "CZ65 0800 0000 1920 0014 5399",
      token: "t",
      licenseKey: "l",
    });
    expect(c.name).toBe("Shop");
    expect(c.iban).toBe(VALID_IBAN);
  });
});
