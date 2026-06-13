import { czechAccountToIban, isValidIban, normalizeIban, IbanError } from "./iban.js";

/** Default operator PIN used until the merchant sets a custom one. */
export const DEFAULT_PIN = "1234";

/** Operating mode constants. Token blank -> simulation; token present -> Fio. */
export const Mode = {
  SIMULATION: "simulace",
  FIO: "fio",
} as const;
export type ModeValue = (typeof Mode)[keyof typeof Mode];

export interface MerchantConfig {
  name: string;
  iban: string;
  /** Bank token. Stored as-is here. Empty token selects simulation mode. */
  token: string;
  licenseKey: string;
  /** Optional logo URL shown by the customer-facing display (idle screensaver). */
  logoUrl: string;
  /** Operator PIN guarding the API. Empty = not set (server falls back to DEFAULT_PIN). */
  pin: string;
}

export interface MerchantConfigInput {
  name?: unknown;
  iban?: unknown;
  token?: unknown;
  licenseKey?: unknown;
  logoUrl?: unknown;
  pin?: unknown;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Validate and normalize a config update. Throws ConfigError on invalid input.
 *
 * The `iban` field accepts EITHER a valid IBAN OR a Czech account number
 * (`[prefix-]number/bankcode`); both are normalized to and stored as the IBAN.
 * The token is optional — a blank token selects simulation mode. Licensing is
 * no longer a gate (the field is kept for back-compat).
 */
export function validateConfig(input: MerchantConfigInput): MerchantConfig {
  const name = asString(input.name, "name");
  const ibanRaw = asString(input.iban, "iban");
  // Token is optional: blank token selects simulation mode.
  const token = asOptionalString(input.token, "token").trim();
  // License is no longer required; keep the field (default "").
  const licenseKey = asOptionalString(input.licenseKey, "licenseKey").trim();
  const logoUrl = asOptionalString(input.logoUrl, "logoUrl").trim();
  const pin = asOptionalString(input.pin, "pin").trim();

  if (name.trim().length === 0) throw new ConfigError("název nesmí být prázdný");

  // Accept EITHER a valid IBAN OR a Czech account number; normalize to the IBAN.
  let normalizedIban: string;
  if (isValidIban(ibanRaw)) {
    normalizedIban = normalizeIban(ibanRaw);
  } else {
    try {
      const fromAccount = czechAccountToIban(ibanRaw);
      if (!fromAccount) {
        throw new ConfigError("neplatný IBAN nebo číslo účtu (formát nebo kontrolní součet)");
      }
      normalizedIban = fromAccount;
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      if (e instanceof IbanError) throw new ConfigError(e.message);
      throw new ConfigError("neplatné číslo účtu");
    }
  }

  if (logoUrl.length > 0 && !/^https?:\/\//i.test(logoUrl)) {
    throw new ConfigError("logoUrl musí začínat http:// nebo https://");
  }
  if (pin.length > 0 && pin.length < 4) {
    throw new ConfigError("PIN musí mít alespoň 4 znaky");
  }

  return {
    name: name.trim(),
    iban: normalizedIban,
    token,
    licenseKey,
    logoUrl,
    pin,
  };
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ConfigError(`${field} je povinný a musí být řetězec`);
  return v;
}

/** Optional string field: undefined/null -> "", otherwise must be a string. */
function asOptionalString(v: unknown, field: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new ConfigError(`${field} musí být řetězec`);
  return v;
}

/** Mask a secret so it never leaves the server in full. */
export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 4) return "*".repeat(token.length);
  return `${"*".repeat(Math.max(0, token.length - 4))}${token.slice(-4)}`;
}

/** Operating mode: token blank -> simulation, token present -> Fio. */
export function modeOf(c: MerchantConfig | null): ModeValue {
  return c && c.token.trim().length > 0 ? Mode.FIO : Mode.SIMULATION;
}

/** Effective PIN: the merchant-set PIN once configured, otherwise the bootstrap default. */
export function effectivePin(c: MerchantConfig | null): string {
  const p = c?.pin?.trim();
  return p && p.length > 0 ? p : DEFAULT_PIN;
}

export interface ConfigDTO {
  name: string;
  iban: string;
  tokenMasked: string;
  licenseKey: string;
  logoUrl: string;
  configured: boolean;
  licensed: boolean;
  /** Operating mode derived from the token: "simulace" (blank) or "fio" (token set). */
  mode: ModeValue;
  /** Whether a custom operator PIN has been set (the PIN itself is never returned). */
  hasPin: boolean;
}

/** Public, non-sensitive subset for the customer-facing display (no PIN). */
export interface DisplayConfigDTO {
  name: string;
  logoUrl: string;
  /** Operating mode so the display can indicate simulation vs. live. */
  mode: ModeValue;
}

export function configToDisplayDTO(c: MerchantConfig | null): DisplayConfigDTO {
  return { name: c?.name ?? "", logoUrl: c?.logoUrl ?? "", mode: modeOf(c) };
}

/**
 * A config is "configured" when name and a valid account/IBAN are present.
 * The token is NO LONGER required — a blank token simply selects simulation mode,
 * which still lets the operator create payments.
 */
export function isConfigured(c: MerchantConfig | null): boolean {
  return !!c && c.name.length > 0 && c.iban.length > 0;
}

/** Licensing is no longer a gate — always true (field kept for back-compat). */
export function isLicensed(_c: MerchantConfig | null): boolean {
  return true;
}

export function configToDTO(c: MerchantConfig | null): ConfigDTO {
  if (!c) {
    return {
      name: "",
      iban: "",
      tokenMasked: "",
      licenseKey: "",
      logoUrl: "",
      configured: false,
      licensed: true,
      mode: Mode.SIMULATION,
      hasPin: false,
    };
  }
  return {
    name: c.name,
    iban: c.iban,
    tokenMasked: maskToken(c.token),
    licenseKey: c.licenseKey,
    logoUrl: c.logoUrl ?? "",
    configured: isConfigured(c),
    licensed: true,
    mode: modeOf(c),
    hasPin: (c.pin ?? "").length > 0,
  };
}
