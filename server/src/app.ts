import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { AmountError } from "./domain/money.js";
import { ConfigError } from "./domain/config.js";
import { sessionToDTO, isOpen } from "./domain/session.js";
import { SimulatorGateway, type ScenarioType } from "./gateway/SimulatorGateway.js";
import type { BankGateway } from "./gateway/BankGateway.js";
import { JsonSessionRepository } from "./persistence/JsonSessionRepository.js";
import type { SessionRepository } from "./persistence/types.js";
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

export interface BuiltApp {
  fastify: FastifyInstance;
  repo: JsonSessionRepository;
  gateway: BankGateway;
  simulator: SimulatorGateway | null;
  sessions: SessionService;
  matching: MatchingService;
  events: EventBus;
}

export interface BuildOptions {
  config: AppConfig;
  /** Override the gateway (tests inject their own SimulatorGateway). */
  gateway?: BankGateway;
  /** Override the repository (tests may pass an in-memory one with no file). */
  repo?: JsonSessionRepository;
  /** Start the background poller. Tests usually drive matching.tick() manually. */
  autoStartPoller?: boolean;
}

/**
 * Build (but do not listen) the full application graph. Returns handles so tests
 * can drive the simulator and the matching service directly.
 */
export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { config } = opts;

  const repo = opts.repo ?? new JsonSessionRepository(config.dataFile);
  await repo.load();

  const simulator = opts.gateway
    ? opts.gateway instanceof SimulatorGateway
      ? opts.gateway
      : null
    : new SimulatorGateway();
  const gateway: BankGateway = opts.gateway ?? simulator!;

  const events = new EventBus();
  const sessions = new SessionService(repo, events, config.sessionTtlMs);
  const matching = new MatchingService(repo, gateway, events, config.pollIntervalMs);

  const fastify = Fastify({ logger: false });

  registerRoutes(fastify, {
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

function registerRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
  const { config, simulator, sessions, events } = deps;

  // PIN guard for operator endpoints. The PIN is supplied via the `x-pin` header
  // or the `pin` cookie. Public endpoints (qr, events, display) are left open so a
  // customer-facing display and SSE work without the operator PIN.
  function requirePin(req: FastifyRequest, reply: FastifyReply): boolean {
    const headerPin = req.headers["x-pin"];
    const cookiePin = parseCookie(req.headers["cookie"])["pin"];
    const supplied = (Array.isArray(headerPin) ? headerPin[0] : headerPin) ?? cookiePin;
    if (supplied !== config.pin) {
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

  // ---- config ----
  fastify.get("/api/config", async (req, reply) => {
    if (!requirePin(req, reply)) return;
    return sessions.getConfigDTO();
  });

  fastify.post("/api/config", async (req, reply) => {
    if (!requirePin(req, reply)) return;
    try {
      return await sessions.setConfig((req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- sessions ----
  fastify.post("/api/sessions", async (req, reply) => {
    if (!requirePin(req, reply)) return;
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
    if (!requirePin(req, reply)) return;
    const q = req.query as { status?: string; from?: string; to?: string };
    const list = await sessions.listSessions({
      status: q.status,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    return list.map(sessionToDTO);
  });

  fastify.get("/api/sessions/export.csv", async (req, reply) => {
    if (!requirePin(req, reply)) return;
    const list = await sessions.listSessions();
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="sessions.csv"');
    return sessionsToCsv(list);
  });

  // Public (no PIN): display info (shop name + logo URL) for the customer-facing
  // screen, including the idle screensaver. Contains no secrets.
  fastify.get("/api/display-config", async () => {
    return sessions.getDisplayConfigDTO();
  });

  // Public (no PIN): newest open session, for the customer-facing display on the
  // tablet. Returns null when nothing is active. Exposes only the current payment,
  // never the history, so it is safe without auth.
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
    if (!requirePin(req, reply)) return;
    const { id } = req.params as { id: string };
    try {
      const s = await sessions.cancelSession(id);
      return sessionToDTO(s);
    } catch (err) {
      return sendError(reply, err);
    }
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

    // Initial snapshot, then push on every change.
    write(current);
    const unsubscribe = events.onSessionChange(id, (s) => write(s));

    // Heartbeat keeps the connection alive through proxies.
    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
    }, 15000);
    heartbeat.unref?.();

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Keep the handler open; Fastify won't finalize because we wrote to raw.
    return reply;
  });

  // ---- QR PNG (public) ----
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

  // ---- minimal display placeholder (public) ----
  fastify.get("/display", async (_req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Display</title></head>
<body><h1>QR Platba — display</h1><p>Customer-facing display. The web UI lives in /web.</p></body></html>`;
  });

  // ---- Simulator control (dev only) ----
  if (config.simEnabled && simulator) {
    registerSimRoutes(fastify, deps, simulator);
  }

  // health
  fastify.get("/api/health", async () => ({ ok: true }));
}

function registerSimRoutes(
  fastify: FastifyInstance,
  deps: RouteDeps,
  simulator: SimulatorGateway,
): void {
  const { sessions } = deps;

  // POST /api/sim/pay { vs?, amount, scenario? } — enqueue an arbitrary payment.
  fastify.post("/api/sim/pay", async (req, reply) => {
    const body = (req.body ?? {}) as {
      vs?: string;
      amount?: string | number;
      scenario?: ScenarioType;
      currency?: string;
    };
    if (body.amount === undefined) {
      reply.code(400);
      return { error: "bad_request", message: "amount is required" };
    }
    // If a scenario + no vs, target the latest open session.
    let vs = body.vs ?? null;
    if (!vs) {
      const s = await sessions.latestOpenSession();
      vs = s?.vs ?? null;
    }
    const tx = simulator.enqueue({
      amount: body.amount,
      vs,
      currency: body.currency ?? "CZK",
    });
    return { enqueued: { externalId: tx.externalId, vs: tx.vs, amount: tx.amount.toFixed(2) } };
  });

  // POST /api/sim/scenario/:type — operate on current/last active session.
  fastify.post("/api/sim/scenario/:type", async (req, reply) => {
    const { type } = req.params as { type: ScenarioType | "abandon" };
    if (type === "unavailable") {
      simulator.setAvailable(false);
      return { ok: true, unavailable: true };
    }
    // "abandon" is not a bank transaction — the customer simply never pays, so the
    // session times out. Force the active session to EXPIRED immediately.
    if (type === "abandon") {
      const open = await sessions.latestOpenSession();
      if (!open) {
        reply.code(409);
        return { error: "no_active_session", message: "no open session to target" };
      }
      const s = await sessions.expireSession(open.id);
      return { ok: true, scenario: "abandon", target: s.id, enqueued: [] };
    }
    // "late": the payment arrives only AFTER the session has timed out. Expire the
    // session first, then enqueue a payment for its VS — the poller will find no
    // open session and record it as an unmatched (late) deposit.
    if (type === "late") {
      const open = await sessions.latestOpenSession();
      if (!open) {
        reply.code(409);
        return { error: "no_active_session", message: "no open session to target" };
      }
      await sessions.expireSession(open.id);
      const tx = simulator.enqueue({ amount: open.amount, vs: open.vs });
      return {
        ok: true,
        scenario: "late",
        target: open.id,
        enqueued: [{ externalId: tx.externalId, amount: tx.amount.toFixed(2) }],
      };
    }
    const target = await sessions.latestOpenSession();
    if (!target && type !== "none") {
      reply.code(409);
      return { error: "no_active_session", message: "no open session to target" };
    }
    const txs = target
      ? simulator.scenario(type, { vs: target.vs, amount: target.amount })
      : [];
    return {
      ok: true,
      scenario: type,
      target: target?.id ?? null,
      enqueued: txs.map((t) => ({ externalId: t.externalId, amount: t.amount.toFixed(2) })),
    };
  });

  // POST /api/sim/unavailable { available?: boolean } — toggle the error condition.
  fastify.post("/api/sim/unavailable", async (req) => {
    const body = (req.body ?? {}) as { available?: boolean };
    const available = body.available === true; // default -> unavailable
    simulator.setAvailable(available);
    return { ok: true, available };
  });

  // GET /api/sim/state — current simulator state, so the UI can show whether the
  // bank is "down" and offer a restore action (the unavailable toggle has no auto-recovery).
  fastify.get("/api/sim/state", async () => {
    return { available: await simulator.isAvailable() };
  });
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
