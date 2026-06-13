import { networkInterfaces } from "node:os";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { AmountError } from "./domain/money.js";
import { ConfigError, effectivePin } from "./domain/config.js";
import { sessionToDTO, isOpen } from "./domain/session.js";
import { SimulatorGateway } from "./gateway/SimulatorGateway.js";
import { ModeGateway } from "./gateway/ModeGateway.js";
import type { BankGateway } from "./gateway/BankGateway.js";
import { JsonSessionRepository } from "./persistence/JsonSessionRepository.js";
import { transactionToDTO, type SessionRepository } from "./persistence/types.js";
import { EventBus } from "./service/EventBus.js";
import { MatchingService } from "./service/MatchingService.js";
import {
  InvalidStateError,
  NotConfiguredError,
  NotFoundError,
  NotLicensedError,
  SessionService,
} from "./service/SessionService.js";
import { spaydToPng } from "./api/qr.js";
import { sessionsToCsv } from "./api/csv.js";
import { registerWebStatic } from "./api/static.js";

export interface BuiltApp {
  fastify: FastifyInstance;
  repo: JsonSessionRepository;
  gateway: BankGateway;
  /** Present only when the wired gateway is a SimulatorGateway (tests). */
  simulator: SimulatorGateway | null;
  sessions: SessionService;
  matching: MatchingService;
  events: EventBus;
}

export interface BuildOptions {
  config: AppConfig;
  /** Override the gateway. Default is a ModeGateway (token-driven sim/Fio). */
  gateway?: BankGateway;
  /** Override the repository (tests may pass an in-memory one with no file). */
  repo?: JsonSessionRepository;
  /** Start the background poller. Tests usually drive matching.tick() manually. */
  autoStartPoller?: boolean;
}

/**
 * Build (but do not listen) the full application graph. Returns handles so tests
 * can drive matching directly.
 */
export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { config } = opts;

  const repo = opts.repo ?? new JsonSessionRepository(config.dataFile);
  await repo.load();

  const gateway: BankGateway = opts.gateway ?? new ModeGateway(repo);
  const simulator = gateway instanceof SimulatorGateway ? gateway : null;

  const events = new EventBus();
  const sessions = new SessionService(repo, events, config.sessionTtlMs);
  const matching = new MatchingService(repo, gateway, events, config.pollIntervalMs);

  const fastify = Fastify({ logger: false });

  await registerRoutes(fastify, {
    config,
    repo,
    gateway,
    simulator,
    sessions,
    matching,
    events,
  });

  if (opts.autoStartPoller) {
    matching.start();
  }

  return { fastify, repo, gateway, simulator, sessions, matching, events };
}

interface RouteDeps {
  config: AppConfig;
  repo: SessionRepository;
  gateway: BankGateway;
  simulator: SimulatorGateway | null;
  sessions: SessionService;
  matching: MatchingService;
  events: EventBus;
}

async function registerRoutes(fastify: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, repo, sessions, matching, events } = deps;

  /** Effective PIN: the merchant-set PIN once configured, otherwise the bootstrap default. */
  async function currentPin(): Promise<string> {
    const cfg = await repo.getConfig();
    const p = cfg?.pin?.trim();
    if (p && p.length > 0) return p;
    // Fall back to the configured bootstrap default (config.pin), then library default.
    return config.pin || effectivePin(cfg);
  }

  // PIN guard for operator endpoints. The PIN is supplied via the `x-pin` header
  // or the `pin` cookie. Public endpoints (qr, events, display, net-info, qrcode)
  // stay open so the customer-facing display works without the operator PIN.
  async function requirePin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const headerPin = req.headers["x-pin"];
    const cookiePin = parseCookie(req.headers["cookie"])["pin"];
    const supplied = (Array.isArray(headerPin) ? headerPin[0] : headerPin) ?? cookiePin;
    if (supplied !== (await currentPin())) {
      reply.code(401).send({ error: "unauthorized", message: "valid PIN required" });
      return false;
    }
    return true;
  }

  // ---- error mapping ----
  function sendError(reply: FastifyReply, err: unknown): void {
    if (err instanceof AmountError || err instanceof ConfigError || err instanceof InvalidStateError) {
      reply.code(400).send({ error: "bad_request", message: (err as Error).message });
      return;
    }
    if (err instanceof NotFoundError) {
      reply.code(404).send({ error: "not_found", message: err.message });
      return;
    }
    if (err instanceof NotConfiguredError) {
      reply.code(409).send({ error: "not_configured", message: err.message });
      return;
    }
    if (err instanceof NotLicensedError) {
      reply.code(403).send({ error: "not_licensed", message: err.message });
      return;
    }
    reply.code(500).send({ error: "internal", message: (err as Error).message ?? "error" });
  }

  // ---- auth: validate the PIN (used by the UI to gate config/operator pages) ----
  fastify.get("/api/auth", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    return { ok: true };
  });

  // ---- config ----
  fastify.get("/api/config", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    return sessions.getConfigDTO();
  });

  fastify.post("/api/config", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Token "keep" rule: the GET only returns the token masked, so the UI
      // re-sends the mask (contains '*') or omits it (null/undefined) to mean
      // "keep the current token". An explicit empty string "" clears it (-> sim).
      const rawToken = body.token;
      let token: unknown;
      if (
        rawToken === undefined ||
        rawToken === null ||
        (typeof rawToken === "string" && rawToken.includes("*"))
      ) {
        token = (await repo.getConfig())?.token ?? "";
      } else {
        token = rawToken;
      }
      return await sessions.setConfig({ ...body, token });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Factory reset: wipe config + sessions + transactions (back to first run).
  fastify.post("/api/config/reset", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    await sessions.reset();
    return { ok: true };
  });

  // PIN reset (device-only recovery; loopback origin enforced). No PIN required.
  fastify.post("/api/pin/reset", async (req, reply) => {
    if (!isLoopback(req)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }
    const cfg = await repo.getConfig();
    if (cfg) await repo.setConfig({ ...cfg, pin: "" });
    return { ok: true };
  });

  // ---- sessions ----
  fastify.post("/api/sessions", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    try {
      const body = (req.body ?? {}) as { amount?: unknown; note?: unknown };
      const s = await sessions.createSession({ amount: body.amount, note: body.note });
      reply.code(201);
      return sessionToDTO(s);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get("/api/sessions", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    const q = req.query as { status?: string; from?: string; to?: string };
    const list = await sessions.listSessions({
      status: q.status,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    return list.map(sessionToDTO);
  });

  fastify.get("/api/sessions/export.csv", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    const list = await sessions.listSessions();
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="sessions.csv"');
    return sessionsToCsv(list);
  });

  // Public (no PIN): display info (shop name + logo + mode) for the customer display.
  fastify.get("/api/display-config", async () => {
    return sessions.getDisplayConfigDTO();
  });

  // Public (no PIN): newest open session, for the customer-facing display.
  fastify.get("/api/sessions/active", async () => {
    const list = await sessions.listSessions();
    const active = list
      .filter((s) => isOpen(s.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return active ? sessionToDTO(active) : null;
  });

  fastify.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const s = await sessions.getSession(id);
      return sessionToDTO(s);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post("/api/sessions/:id/cancel", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    const { id } = req.params as { id: string };
    try {
      const s = await sessions.cancelSession(id);
      return sessionToDTO(s);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Force an immediate bank check (one poll cycle) then return the updated session.
  fastify.post("/api/sessions/:id/check", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    const { id } = req.params as { id: string };
    try {
      // 404 fast if the session doesn't exist (before doing a poll cycle).
      await sessions.getSession(id);
      await matching.tick();
      return sessionToDTO(await sessions.getSession(id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- transactions ----
  // Today's incoming bank transactions (device-local day), newest first.
  // Simulated (sim-*) payments are hidden — they aren't real bank movements.
  fastify.get("/api/transactions/today", async (req, reply) => {
    if (!(await requirePin(req, reply))) return;
    const { start, end } = todayBounds();
    const list = (await repo.listTransactions())
      .filter((t) => !t.externalId.startsWith("sim-"))
      .filter((t) => {
        const ts = new Date(t.receivedAt).getTime();
        return Number.isFinite(ts) && ts >= start && ts < end;
      })
      .map(transactionToDTO);
    return list;
  });

  // ---- SSE: live session status (public; display + operator both consume) ----
  fastify.get("/api/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    let current;
    try {
      current = await sessions.getSession(id);
    } catch (err) {
      return sendError(reply, err);
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const write = (s: { id: string }) => {
      reply.raw.write(`event: session\n`);
      reply.raw.write(`data: ${JSON.stringify(sessionToDTO(s as never))}\n\n`);
    };

    write(current);
    const unsubscribe = events.onSessionChange(id, (s) => write(s));

    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
    }, 15000);
    heartbeat.unref?.();

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    return reply;
  });

  // ---- QR PNG for a session (public) ----
  fastify.get("/api/qr/:id.png", async (req, reply) => {
    const params = req.params as { id: string };
    const id = params.id;
    try {
      const s = await sessions.getSession(id);
      const png = await spaydToPng(s.spayd);
      reply.header("content-type", "image/png");
      reply.header("cache-control", "no-store");
      return reply.send(png);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- network info + generic QR (public; for the admin/access screen) ----
  fastify.get("/api/net-info", async () => {
    const ip = lanIpv4() ?? "127.0.0.1";
    return { ip, port: config.port, baseUrl: `http://${ip}:${config.port}` };
  });

  fastify.get("/api/qrcode", async (req, reply) => {
    const data = (req.query as { data?: string }).data;
    if (!data || data.trim().length === 0) {
      reply.code(400).send({ error: "bad_request" });
      return;
    }
    const png = await spaydToPng(data);
    reply.header("content-type", "image/png");
    reply.header("cache-control", "no-store");
    return reply.send(png);
  });

  // health
  fastify.get("/api/health", async () => ({ ok: true }));

  // Any unknown /api/* route -> JSON 404 (so the SPA fallback never swallows it).
  fastify.get("/api/*", async (_req, reply) => {
    reply.code(404).send({ error: "not_found", message: "unknown route" });
  });

  // ---- static web UI + SPA fallback (same port) ----
  const served = config.webDir ? registerWebStatic(fastify, config.webDir) : false;
  if (!served) {
    // No bundled UI: keep API-only behavior. A bare GET / returns a hint, and
    // unknown non-/api routes still 404 as JSON via the default handler.
    fastify.get("/", async (_req, reply) => {
      reply.header("content-type", "text/html; charset=utf-8");
      return `<!doctype html><meta charset="utf-8"><title>QR Platba</title><p>API is running. The web UI was not bundled (webDir not found).</p>`;
    });
  }
}

// ---------- helpers ----------

/** [start, end) epoch-millis bounds of the current local calendar day. */
function todayBounds(now: number = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

/** First site-local IPv4 (e.g. 192.168.x.x) so the admin screen can show a reachable URL. */
function lanIpv4(): string | null {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

/** True when the request originates from the loopback interface (PIN-reset recovery). */
function isLoopback(req: FastifyRequest): boolean {
  const ip = req.ip || req.socket?.remoteAddress || "";
  return isLoopbackAddr(ip) || isLoopbackAddr(req.socket?.remoteAddress ?? "");
}

function isLoopbackAddr(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase().split("%")[0]!; // strip IPv6 zone id
  return (
    v === "localhost" ||
    v === "127.0.0.1" ||
    v === "::1" ||
    v === "0:0:0:0:0:0:0:1" ||
    v === "::ffff:127.0.0.1"
  );
}

function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}
