import { money, type Money } from "../domain/money.js";
import type { BankGateway, BankTransaction } from "./BankGateway.js";

export type ScenarioType =
  | "exact"
  | "under"
  | "over"
  | "none"
  | "late"
  | "duplicate"
  | "wrongvs"
  | "unavailable";

let txCounter = 0;
function nextExternalId(): string {
  txCounter += 1;
  return `sim-${Date.now()}-${txCounter}`;
}

/**
 * In-memory bank simulator. Tests/dev enqueue transactions; the poller drains
 * them via fetchNewTransactions(). Implements the same BankGateway contract as
 * the real Fio gateway, so the rest of the app is unaware which one is wired.
 */
export class SimulatorGateway implements BankGateway {
  private queue: BankTransaction[] = [];
  private available = true;
  /** Optional artificial latency (ms) to mimic Fio's ~30s detection lag. Default off. */
  private latencyMs: number;

  constructor(opts: { latencyMs?: number } = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
  }

  // ---- BankGateway ----

  async fetchNewTransactions(): Promise<BankTransaction[]> {
    if (!this.available) {
      // Mimic a failing bank call. The poller must treat this as "cannot verify".
      throw new Error("simulator: bank unavailable");
    }
    if (this.latencyMs > 0) {
      await delay(this.latencyMs);
      if (!this.available) throw new Error("simulator: bank unavailable");
    }
    const batch = this.queue;
    this.queue = [];
    return batch;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  // ---- Control surface (dev/test only) ----

  /** Toggle the unavailability/error condition. */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  setLatency(ms: number): void {
    this.latencyMs = Math.max(0, ms);
  }

  /** Enqueue a raw transaction. */
  enqueue(tx: {
    amount: Money | string | number;
    vs: string | null;
    currency?: string;
    externalId?: string;
    receivedAt?: Date;
  }): BankTransaction {
    const t: BankTransaction = {
      externalId: tx.externalId ?? nextExternalId(),
      amount: money(tx.amount as string),
      currency: tx.currency ?? "CZK",
      vs: tx.vs,
      receivedAt: tx.receivedAt ?? new Date(),
    };
    this.queue.push(t);
    return t;
  }

  /**
   * Enqueue a scenario for a given target (vs + required amount).
   * Returns the transaction(s) generated. "none" generates nothing,
   * "unavailable" toggles the error condition.
   */
  scenario(
    type: ScenarioType,
    target: { vs: string; amount: Money | string | number; currency?: string },
  ): BankTransaction[] {
    const required = money(target.amount as string);
    const currency = target.currency ?? "CZK";
    switch (type) {
      case "exact":
        return [this.enqueue({ amount: required, vs: target.vs, currency })];
      case "under":
        return [
          this.enqueue({ amount: required.minus("1.00"), vs: target.vs, currency }),
        ];
      case "over":
        return [
          this.enqueue({ amount: required.plus("1.00"), vs: target.vs, currency }),
        ];
      case "late":
        // Same as exact; "lateness" is determined by when the poller runs vs expiry.
        return [this.enqueue({ amount: required, vs: target.vs, currency })];
      case "duplicate":
        return [
          this.enqueue({ amount: required, vs: target.vs, currency }),
          this.enqueue({ amount: required, vs: target.vs, currency }),
        ];
      case "wrongvs":
        // Customer paid the right amount but with a wrong/typo'd reference: the VS
        // matches no open session (leading zero never matches a generated VS), so
        // the deposit is recorded as unmatched and the session stays open.
        return [this.enqueue({ amount: required, vs: "0404040404", currency })];
      case "none":
        return [];
      case "unavailable":
        this.setAvailable(false);
        return [];
      default: {
        const _exhaustive: never = type;
        throw new Error(`unknown scenario: ${String(_exhaustive)}`);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
