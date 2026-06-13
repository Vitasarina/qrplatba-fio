import { join } from "node:path";
import { DEFAULT_PIN } from "./domain/config.js";
import { resolveDataDir, resolveWebDir } from "./paths.js";

/** Runtime configuration from environment variables / CLI. */
export interface AppConfig {
  port: number;
  host: string;
  /** Bootstrap PIN used until the merchant sets a custom one (see effectivePin). */
  pin: string;
  pollIntervalMs: number;
  sessionTtlMs: number;
  dataFile: string | null; // null disables file persistence (used in tests)
  /** Directory of the built web UI to serve, or null to skip static serving. */
  webDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Allow a port via the first CLI arg too (e.g. `qr-payments.exe 9090`).
  const argPort = process.argv?.[2];

  const dataFileEnv = env.DATA_FILE;
  let dataFile: string | null;
  if (dataFileEnv !== undefined) {
    dataFile = dataFileEnv === "" ? null : dataFileEnv;
  } else {
    dataFile = join(resolveDataDir(env), "state.json");
  }

  const webDir = env.WEB_DIR === "" ? null : resolveWebDir(env);

  return {
    port: intEnv(env.PORT ?? argPort, 8080),
    host: env.HOST ?? "0.0.0.0",
    pin: env.PIN ?? DEFAULT_PIN,
    pollIntervalMs: intEnv(env.POLL_INTERVAL_MS, 30000),
    sessionTtlMs: intEnv(env.SESSION_TTL_MS, 5 * 60 * 1000),
    dataFile,
    webDir,
  };
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
