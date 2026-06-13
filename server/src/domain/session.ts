import Decimal from "decimal.js";
import { money, type Money } from "./money.js";

export type SessionStatus =
  | "PENDING"
  | "PAID"
  | "UNDERPAID"
  | "OVERPAID"
  | "EXPIRED"
  | "CANCELLED"
  | "UNKNOWN";

/** A status is terminal when the matching engine should stop acting on it. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "PAID",
  "OVERPAID",
  "EXPIRED",
  "CANCELLED",
];

export interface PaymentSession {
  id: string;
  amount: Money; // required amount, decimal-safe
  currency: string; // "CZK"
  vs: string; // numeric variable symbol, <= 10 digits
  spayd: string;
  status: SessionStatus;
  createdAt: Date;
  expiresAt: Date;
  paidAt: Date | null;
  matchedTxId: string | null;
  note: string | null;
  /** Set when status is OVERPAID-as-PAID; UI shows "overpaid" warning. */
  overpaid: boolean;
  /** Amount actually received from the matched/last applied transaction; null until a payment is applied. */
  receivedAmount: Money | null;
}

/** A session is "open" (still eligible to match) while PENDING, UNDERPAID, or UNKNOWN. */
export function isOpen(status: SessionStatus): boolean {
  return status === "PENDING" || status === "UNDERPAID" || status === "UNKNOWN";
}

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ---- Serialization to/from JSON (Money <-> string, Date <-> ISO) ----

export interface PaymentSessionJSON {
  id: string;
  amount: string;
  currency: string;
  vs: string;
  spayd: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  matchedTxId: string | null;
  note: string | null;
  overpaid: boolean;
  receivedAmount: string | null;
}

export function sessionToJSON(s: PaymentSession): PaymentSessionJSON {
  return {
    id: s.id,
    amount: s.amount.toFixed(2),
    currency: s.currency,
    vs: s.vs,
    spayd: s.spayd,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    paidAt: s.paidAt ? s.paidAt.toISOString() : null,
    matchedTxId: s.matchedTxId,
    note: s.note,
    overpaid: s.overpaid,
    receivedAmount: s.receivedAmount ? s.receivedAmount.toFixed(2) : null,
  };
}

export function sessionFromJSON(j: PaymentSessionJSON): PaymentSession {
  return {
    id: j.id,
    amount: new Decimal(j.amount),
    currency: j.currency,
    vs: j.vs,
    spayd: j.spayd,
    status: j.status,
    createdAt: new Date(j.createdAt),
    expiresAt: new Date(j.expiresAt),
    paidAt: j.paidAt ? new Date(j.paidAt) : null,
    matchedTxId: j.matchedTxId,
    note: j.note,
    overpaid: j.overpaid,
    receivedAmount: j.receivedAmount ? new Decimal(j.receivedAmount) : null,
  };
}

/** Public DTO shape returned by the API (amount as 2dp string). */
export function sessionToDTO(s: PaymentSession) {
  return {
    id: s.id,
    amount: s.amount.toFixed(2),
    currency: s.currency,
    vs: s.vs,
    spayd: s.spayd,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    paidAt: s.paidAt ? s.paidAt.toISOString() : null,
    matchedTxId: s.matchedTxId,
    note: s.note,
    overpaid: s.overpaid,
    receivedAmount: s.receivedAmount ? s.receivedAmount.toFixed(2) : null,
    qrUrl: `/api/qr/${s.id}.png`,
  };
}

export { money };
