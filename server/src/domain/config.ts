import { isValidIban, normalizeIban } from "./iban.js";

export interface MerchantConfig {
  name: string;
  iban: string;
  /** Bank token. Stored as-is here (simulator phase). Production: encrypt at rest. */
  token: string;
  licenseKey: string;
  /** Optional logo URL shown by the customer-facing display (idle screensaver). */
  logoUrl: string;
}

export interface MerchantConfigInput {
  name?: unknown;
  iban?: unknown;
  token?: unknown;
  licenseKey?: unknown;
  logoUrl?: unknown;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Validate and normalize a config update. Throws ConfigError on invalid input.
 */
export function validateConfig(input: MerchantConfigInput): MerchantConfig {
  const name = asString(input.name, "name");
  const ibanRaw = asString(input.iban, "iban");
  const token = asString(input.token, "token");
  const licenseKey = asString(input.licenseKey, "licenseKey");
  const logoUrl = asOptionalString(input.logoUrl, "logoUrl").trim();

  if (name.trim().length === 0) throw new ConfigError("name must not be empty");
  if (!isValidIban(ibanRaw)) throw new ConfigError("iban is invalid (format or checksum)");
  if (logoUrl.length > 0 && !/^https?:\/\//i.test(logoUrl)) {
    throw new ConfigError("logoUrl must start with http:// or https://");
  }

  return {
    name: name.trim(),
    iban: normalizeIban(ibanRaw),
    token,
    licenseKey,
    logoUrl,
  };
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ConfigError(`${field} is required and must be a string`);
  return v;
}

/** Optional string field: undefined/null -> "", otherwise must be a string. */
function asOptionalString(v: unknown, field: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new ConfigError(`${field} must be a string`);
  return v;
}

/** Mask a secret so it never leaves the server in full. */
export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 4) return "*".repeat(token.length);
  return `${"*".repeat(Math.max(0, token.length - 4))}${token.slice(-4)}`;
}

export interface ConfigDTO {
  name: string;
  iban: string;
  tokenMasked: string;
  licenseKey: string;
  logoUrl: string;
  configured: boolean;
  licensed: boolean;
}

/** Public, non-sensitive subset for the customer-facing display (no PIN). */
export interface DisplayConfigDTO {
  name: string;
  logoUrl: string;
}

export function configToDisplayDTO(c: MerchantConfig | null): DisplayConfigDTO {
  return { name: c?.name ?? "", logoUrl: c?.logoUrl ?? "" };
}

/** A config is "configured" when name, iban and token are present. */
export function isConfigured(c: MerchantConfig | null): boolean {
  return !!c && c.name.length > 0 && c.iban.length > 0 && c.token.length > 0;
}

/**
 * Licensing: simulator phase accepts any non-empty license key.
 * Production swaps this for signed-key verification with an embedded public key.
 */
export function isLicensed(c: MerchantConfig | null): boolean {
  return !!c && typeof c.licenseKey === "string" && c.licenseKey.trim().length > 0;
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
      licensed: false,
    };
  }
  return {
    name: c.name,
    iban: c.iban,
    tokenMasked: maskToken(c.token),
    licenseKey: c.licenseKey,
    logoUrl: c.logoUrl ?? "",
    configured: isConfigured(c),
    licensed: isLicensed(c),
  };
}
