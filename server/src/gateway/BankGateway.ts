import type { Money } from "../domain/money.js";

export interface BankTransaction {
  externalId: string; // bank's transaction id — used for idempotence
  amount: Money;
  currency: string; // "CZK"
  vs: string | null; // variable symbol
  receivedAt: Date;
}

/**
 * The single seam between our matching logic and any bank.
 * Swapping SimulatorGateway -> FioGateway must not change matching, session
 * states, or the API (AC-0.2).
 */
export interface BankGateway {
  /** New incoming transactions since the last checkpoint. */
  fetchNewTransactions(): Promise<BankTransaction[]>;
  /** Connectivity probe — drives UNKNOWN / "cannot verify" handling. */
  isAvailable(): Promise<boolean>;
}
