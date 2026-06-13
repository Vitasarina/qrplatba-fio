import type { PaymentSession } from "../domain/session.js";
import type { MerchantConfig } from "../domain/config.js";

/** Mirror of an incoming bank transaction, matched or not. */
export interface StoredTransaction {
  externalId: string;
  amount: string; // 2dp string
  currency: string;
  vs: string | null;
  receivedAt: string; // ISO
  matchedSessionId: string | null;
  /** Why it was not matched, if unmatched: "no-session" | "duplicate" | "currency". */
  unmatchedReason: string | null;
}

/** Public DTO for an incoming bank transaction (operator "today's payments" view). */
export interface TransactionDTO {
  externalId: string;
  amount: string;
  vs: string | null;
  receivedAt: string;
  matched: boolean;
  matchedSessionId: string | null;
  /** Unmatched reason ("no-session" | "duplicate" | "currency"), or null when matched. */
  reason: string | null;
}

export function transactionToDTO(t: StoredTransaction): TransactionDTO {
  return {
    externalId: t.externalId,
    amount: t.amount,
    vs: t.vs,
    receivedAt: t.receivedAt,
    matched: t.matchedSessionId != null,
    matchedSessionId: t.matchedSessionId,
    reason: t.unmatchedReason,
  };
}

export interface SessionFilter {
  status?: string;
  from?: Date;
  to?: Date;
}

/**
 * Clean repository seam. The MVP ships an in-memory + JSON-file implementation.
 * Production swaps this for SQLite without touching services or the API.
 */
export interface SessionRepository {
  // sessions
  createSession(session: PaymentSession): Promise<void>;
  getSession(id: string): Promise<PaymentSession | null>;
  updateSession(session: PaymentSession): Promise<void>;
  listSessions(filter?: SessionFilter): Promise<PaymentSession[]>;
  /** Open (PENDING/UNDERPAID/UNKNOWN) sessions whose VS matches. */
  findOpenByVs(vs: string): Promise<PaymentSession[]>;
  /** All VS values that are currently in use by open sessions (uniqueness checks). */
  openVsSet(): Promise<Set<string>>;

  // idempotence / processed transactions
  hasProcessedTx(externalId: string): Promise<boolean>;
  recordTransaction(tx: StoredTransaction): Promise<void>;
  listTransactions(): Promise<StoredTransaction[]>;

  // config
  getConfig(): Promise<MerchantConfig | null>;
  setConfig(config: MerchantConfig): Promise<void>;

  /** Factory reset: wipe config, sessions and transactions (back to first run). */
  reset(): Promise<void>;
}
