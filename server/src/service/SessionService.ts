import { randomUUID } from "node:crypto";
import {
  isConfigured,
  configToDTO,
  configToDisplayDTO,
  validateConfig,
  type ConfigDTO,
  type DisplayConfigDTO,
  type MerchantConfig,
  type MerchantConfigInput,
} from "../domain/config.js";
import { parseAmount, type Money } from "../domain/money.js";
import {
  isOpen,
  type PaymentSession,
  type SessionStatus,
} from "../domain/session.js";
import { buildSpayd } from "../domain/spayd.js";
import type { SessionFilter, SessionRepository } from "../persistence/types.js";
import { EventBus } from "./EventBus.js";
import { generateVs } from "./vs.js";

export class NotConfiguredError extends Error {
  override readonly name = "NotConfiguredError";
}
export class NotLicensedError extends Error {
  override readonly name = "NotLicensedError";
}
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}
export class InvalidStateError extends Error {
  override readonly name = "InvalidStateError";
}

export interface CreateSessionInput {
  amount: unknown;
  note?: unknown;
}

export class SessionService {
  constructor(
    private readonly repo: SessionRepository,
    private readonly events: EventBus,
    private readonly ttlMs: number,
  ) {}

  // ---- config ----

  async getConfigDTO(): Promise<ConfigDTO> {
    return configToDTO(await this.repo.getConfig());
  }

  /** Public display info (name + logo) — no secrets, served without a PIN. */
  async getDisplayConfigDTO(): Promise<DisplayConfigDTO> {
    return configToDisplayDTO(await this.repo.getConfig());
  }

  async setConfig(input: MerchantConfigInput): Promise<ConfigDTO> {
    const cfg = validateConfig(input);
    await this.repo.setConfig(cfg);
    return configToDTO(cfg);
  }

  /** Factory reset: clear config, sessions and transactions (back to first run). */
  async reset(): Promise<void> {
    await this.repo.reset();
  }

  // ---- sessions ----

  async createSession(input: CreateSessionInput): Promise<PaymentSession> {
    const config = await this.repo.getConfig();
    if (!isConfigured(config)) {
      throw new NotConfiguredError(
        "Obchodník není nakonfigurován (vyžadován název a IBAN/číslo účtu).",
      );
    }

    const amount: Money = parseAmount(input.amount);
    const note = this.parseNote(input.note);

    const taken = await this.repo.openVsSet();
    const vs = generateVs(taken);

    const now = new Date();
    const spayd = buildSpayd({
      iban: (config as MerchantConfig).iban,
      amount,
      vs,
      message: buildSpaydMessage((config as MerchantConfig).name, note),
      currency: "CZK",
    });

    const session: PaymentSession = {
      id: randomUUID(),
      amount,
      currency: "CZK",
      vs,
      spayd,
      status: "PENDING",
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
      paidAt: null,
      matchedTxId: null,
      note,
      overpaid: false,
      receivedAmount: null,
    };

    await this.repo.createSession(session);
    this.events.publishSessionChange(session);
    return session;
  }

  async getSession(id: string): Promise<PaymentSession> {
    const s = await this.repo.getSession(id);
    if (!s) throw new NotFoundError(`session ${id} not found`);
    return s;
  }

  async cancelSession(id: string): Promise<PaymentSession> {
    const s = await this.repo.getSession(id);
    if (!s) throw new NotFoundError(`session ${id} not found`);
    if (!isOpen(s.status)) {
      throw new InvalidStateError(`session ${id} is ${s.status} and cannot be cancelled`);
    }
    s.status = "CANCELLED";
    await this.repo.updateSession(s);
    this.events.publishSessionChange(s);
    return s;
  }

  /** Force an open session to EXPIRED now (used by the simulator's "customer did
   *  not pay" scenario; mirrors a real timeout without waiting for the TTL). */
  async expireSession(id: string): Promise<PaymentSession> {
    const s = await this.repo.getSession(id);
    if (!s) throw new NotFoundError(`session ${id} not found`);
    if (!isOpen(s.status)) {
      throw new InvalidStateError(`session ${id} is ${s.status} and cannot be expired`);
    }
    s.status = "EXPIRED";
    await this.repo.updateSession(s);
    this.events.publishSessionChange(s);
    return s;
  }

  async listSessions(filter?: SessionFilter): Promise<PaymentSession[]> {
    return this.repo.listSessions(filter);
  }

  /** The most recently created session (used by sim convenience endpoints). */
  async latestSession(): Promise<PaymentSession | null> {
    const all = await this.repo.listSessions();
    return all[0] ?? null;
  }

  /** The most recent open session, preferred target for sim scenarios. */
  async latestOpenSession(): Promise<PaymentSession | null> {
    const all = await this.repo.listSessions();
    return all.find((s) => isOpen(s.status)) ?? null;
  }

  // ---- helpers ----

  private parseNote(note: unknown): string | null {
    if (note === undefined || note === null) return null;
    if (typeof note !== "string") {
      throw new InvalidStateError("note must be a string");
    }
    const trimmed = note.trim();
    return trimmed.length === 0 ? null : trimmed.slice(0, 200);
  }
}

/**
 * SPAYD MSG value: operator note combined with the company name, hyphen-joined,
 * note first, lowercased. With no note it is just the lowercased company name.
 *   name "Boldgym", note "musli" -> "musli-boldgym"
 *   name "Boldgym", note null    -> "boldgym"
 * SPAYD field sanitization (no '*', length cap) is still applied by buildSpayd().
 */
export function buildSpaydMessage(name: string, note: string | null): string {
  const n = note?.trim();
  return n ? `${n.toLowerCase()}-${name.trim().toLowerCase()}` : name.trim().toLowerCase();
}

export type { SessionStatus };
