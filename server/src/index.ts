import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

function lanIpv4(): string | null {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** Best-effort open the operator page in the default browser (PC desktop variant). */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Headless / no browser — ignore.
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config, autoStartPoller: true });

  // Resolve any sessions left dangling across a restart: expire what should be expired.
  await app.matching.expireStale();

  await app.fastify.listen({ port: config.port, host: config.host });

  const ip = lanIpv4() ?? "127.0.0.1";
  const localUrl = `http://localhost:${config.port}`;
  const displayUrl = `http://${ip}:${config.port}/display`;

  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "  QR Platba — PC desktop server",
      "  ============================================",
      `  Operator / setup (this PC):  ${localUrl}`,
      `  Display screen (this PC):    ${localUrl}/display`,
      `  Display screen (mobile/LAN): ${displayUrl}`,
      "  ============================================",
      `  port=${config.port}  host=${config.host}  poll=${config.pollIntervalMs}ms`,
      `  data file: ${config.dataFile ?? "(in-memory only)"}`,
      `  web UI: ${config.webDir ?? "(not bundled — API only)"}`,
      "",
    ].join("\n"),
  );

  if (process.env.OPEN_BROWSER !== "false" && process.env.NO_OPEN !== "1") {
    openBrowser(localUrl);
  }

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
