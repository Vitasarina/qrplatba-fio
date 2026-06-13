/** Runtime configuration from environment variables. */
export interface AppConfig {
  port: number;
  host: string;
  pin: string;
  pollIntervalMs: number;
  sessionTtlMs: number;
  dataFile: string | null; // null disables file persistence (used in tests)
  simEnabled: boolean; // expose /api/sim/* control endpoints
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: intEnv(env.PORT, 8080),
    host: env.HOST ?? "0.0.0.0",
    pin: env.PIN ?? "1234",
    pollIntervalMs: intEnv(env.POLL_INTERVAL_MS, 30000),
    sessionTtlMs: intEnv(env.SESSION_TTL_MS, 5 * 60 * 1000),
    dataFile: env.DATA_FILE ?? "data/state.json",
    simEnabled: env.SIM_ENABLED ? env.SIM_ENABLED !== "false" : true,
  };
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
