import { buildApp, type BuiltApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SimulatorGateway } from "../src/gateway/SimulatorGateway.js";
import { JsonSessionRepository } from "../src/persistence/JsonSessionRepository.js";

export const VALID_IBAN = "CZ6508000000192000145399";
export const TEST_PIN = "1234";

/**
 * Build a test app: in-memory repo (no file unless given), simulator gateway,
 * poller NOT auto-started (tests drive matching.tick() deterministically).
 */
export async function makeApp(
  overrides: { dataFile?: string | null; ttlMs?: number; gateway?: SimulatorGateway } = {},
): Promise<BuiltApp> {
  const config = loadConfig({
    PIN: TEST_PIN,
    DATA_FILE: "",
    SIM_ENABLED: "true",
    POLL_INTERVAL_MS: "100000",
    SESSION_TTL_MS: String(overrides.ttlMs ?? 5 * 60 * 1000),
  });
  // loadConfig turns "" DATA_FILE into "" — coerce to provided value or null.
  config.dataFile = overrides.dataFile ?? null;

  const repo = new JsonSessionRepository(config.dataFile);
  const gateway = overrides.gateway ?? new SimulatorGateway();
  const app = await buildApp({ config, repo, gateway, autoStartPoller: false });
  return app;
}

/** Configure a valid, licensed merchant so sessions can be created. */
export async function configure(app: BuiltApp): Promise<void> {
  await app.sessions.setConfig({
    name: "Test Shop",
    iban: VALID_IBAN,
    token: "secret-token-abcdef",
    licenseKey: "LIC-12345",
  });
}

export function pinHeaders(): Record<string, string> {
  return { "x-pin": TEST_PIN };
}
