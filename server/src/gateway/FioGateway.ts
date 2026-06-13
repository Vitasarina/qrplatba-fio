import Decimal from "decimal.js";
import { money } from "../domain/money.js";
import type { BankGateway, BankTransaction } from "./BankGateway.js";

export class BankUnavailableError extends Error {
  override readonly name = "BankUnavailableError";
}

/**
 * Fio Bank gateway (real). Pulls incremental movements from the Fio REST API.
 *
 *   GET https://fioapi.fio.cz/v1/rest/last/{token}/transactions.json
 *
 * The `/last` endpoint returns movements since the server-side bookmark ("zarážka")
 * and advances it, so each successful call returns only new transactions.
 *
 * Fio rate limit: 1 request / token / 30 s. The poller's 30 s interval already
 * respects this; calling fetchNewTransactions() more often risks an HTTP 409/429.
 *
 * Column mapping (each transaction is { "columnN": { value, name, id } }):
 *   column0  = date (datum)            -> receivedAt
 *   column1  = amount (objem)          -> amount  (keep only incoming, amount > 0)
 *   column5  = variabilní symbol (VS)  -> vs
 *   column14 = currency (měna)         -> currency
 *   column22 = ID pohybu               -> externalId (idempotence key)
 *
 * Network/HTTP/parse failures THROW so MatchingService maps them to UNKNOWN and
 * never to PAID. HTTPS only, read-only token.
 */
export class FioGateway implements BankGateway {
  private readonly token: string;
  private readonly baseUrl: string;
  private lastOk = true;

  constructor(opts: { token: string; baseUrl?: string }) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://fioapi.fio.cz/v1/rest";
  }

  async fetchNewTransactions(): Promise<BankTransaction[]> {
    const body = await this.httpGet(
      `${this.baseUrl}/last/${encodeURIComponent(this.token)}/transactions.json`,
    );
    try {
      const txs = parseFioTransactions(body);
      this.lastOk = true;
      return txs;
    } catch (e) {
      this.lastOk = false;
      throw new BankUnavailableError(
        `fio: unparseable response: ${(e as Error).message}`,
      );
    }
  }

  /** Reflects the last fetch outcome (true until the first failure). */
  async isAvailable(): Promise<boolean> {
    return this.lastOk;
  }

  private async httpGet(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        this.lastOk = false;
        throw new BankUnavailableError(`fio: HTTP ${res.status}`);
      }
      return await res.text();
    } catch (e) {
      if (e instanceof BankUnavailableError) throw e;
      this.lastOk = false;
      throw new BankUnavailableError(`fio: network error: ${(e as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Read `columnN.value` as a string (numbers become their literal string). */
function colString(tx: Record<string, unknown>, name: string): string | null {
  const col = tx[name];
  if (!col || typeof col !== "object") return null;
  const v = (col as { value?: unknown }).value;
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Read `columnN.value` as a Decimal; tolerant of number or string form. */
function colDecimal(tx: Record<string, unknown>, name: string): Decimal | null {
  const col = tx[name];
  if (!col || typeof col !== "object") return null;
  const v = (col as { value?: unknown }).value;
  if (typeof v === "number") {
    return Number.isFinite(v) ? new Decimal(v) : null;
  }
  if (typeof v === "string") {
    try {
      return new Decimal(v.trim().replace(",", "."));
    } catch {
      return null;
    }
  }
  return null;
}

/** Fio dates look like "2026-06-13+0200"; tolerate plain ISO too. */
function parseFioDate(raw: string): Date | null {
  const datePart = raw.slice(0, 10); // yyyy-MM-dd
  const d = new Date(`${datePart}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Pure parser for a Fio "transactions.json" response. Maps incoming-only
 * (amount > 0) movements to BankTransaction. Unit-testable without the network.
 * Throws on malformed JSON (so the gateway turns it into a BankUnavailableError).
 */
export function parseFioTransactions(body: string): BankTransaction[] {
  const root = JSON.parse(body) as unknown;
  if (!root || typeof root !== "object") return [];
  const statement = (root as Record<string, unknown>).accountStatement;
  if (!statement || typeof statement !== "object") return [];
  const txList = (statement as Record<string, unknown>).transactionList;
  if (!txList || typeof txList !== "object") return [];
  const arr = (txList as Record<string, unknown>).transaction;
  if (!Array.isArray(arr)) return [];

  const out: BankTransaction[] = [];
  for (const el of arr) {
    if (!el || typeof el !== "object") continue;
    const tx = el as Record<string, unknown>;
    const amount = colDecimal(tx, "column1");
    if (!amount) continue;
    // Keep only incoming movements.
    if (amount.lessThanOrEqualTo(0)) continue;
    const externalId = colString(tx, "column22");
    if (!externalId) continue;
    const vsRaw = colString(tx, "column5");
    const vs = vsRaw && vsRaw.trim().length > 0 ? vsRaw : null;
    const currency = colString(tx, "column14") ?? "CZK";
    const dateRaw = colString(tx, "column0");
    const receivedAt = (dateRaw && parseFioDate(dateRaw)) || new Date();

    out.push({
      externalId,
      amount: money(amount),
      currency,
      vs,
      receivedAt,
    });
  }
  return out;
}
