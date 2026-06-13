import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config, autoStartPoller: true });

  // Resolve any sessions left dangling across a restart (AC-11.3): expire what
  // should be expired, and resume matching for the rest.
  await app.matching.expireStale();

  await app.fastify.listen({ port: config.port, host: config.host });

  // eslint-disable-next-line no-console
  console.log(
    `QR payments server (simulator) listening on http://${config.host}:${config.port}\n` +
      `  PIN=${config.pin}  POLL_INTERVAL_MS=${config.pollIntervalMs}  SESSION_TTL_MS=${config.sessionTtlMs}\n` +
      `  data file: ${config.dataFile ?? "(in-memory only)"}  sim endpoints: ${config.simEnabled ? "on" : "off"}`,
  );

  const shutdown = async () => {
    app.matching.stop();
    await app.repo.flushNow();
    await app.fastify.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
