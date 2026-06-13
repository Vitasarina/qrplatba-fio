import type { BankGateway, BankTransaction } from "./BankGateway.js";

/**
 * Fio Bank gateway — STUB for the MVP simulator phase. It exists only to prove
 * the BankGateway seam: switching from SimulatorGateway to FioGateway must not
 * touch matching logic, session states, or the API (AC-0.2).
 *
 * Real implementation (post-MVP):
 *   - GET https://fioapi.fio.cz/v1/rest/last/{token}/transactions.json
 *       -> transactions since the server-side bookmark ("zarážka"). Incremental.
 *   - GET https://fioapi.fio.cz/v1/rest/set-last-id/{token}/{id}/
 *       -> move the bookmark forward after processing.
 *   - GET https://fioapi.fio.cz/v1/rest/periods/{token}/{from}/{to}/transactions.json
 *       -> date-range fallback.
 *   Rate limit: 1 request per token per 30s -> detection latency up to ~30s.
 *   Poll only while a PENDING session is open to respect the limit.
 *   Map Fio JSON columns (column22 = VS, column1 = amount, column14 = currency,
 *   column0 = date, column17/column22 ids) to BankTransaction.
 *   Connection must be HTTPS; token is read-only and never sent to the browser.
 */
export class FioGateway implements BankGateway {
  constructor(_opts: { token: string; baseUrl?: string }) {
    // token retained by the real implementation; unused in the stub.
  }

  async fetchNewTransactions(): Promise<BankTransaction[]> {
    throw new Error("FioGateway.fetchNewTransactions: not implemented for MVP");
  }

  async isAvailable(): Promise<boolean> {
    throw new Error("FioGateway.isAvailable: not implemented for MVP");
  }
}
