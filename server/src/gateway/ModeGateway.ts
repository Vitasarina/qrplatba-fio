import { isOpen } from "../domain/session.js";
import type { SessionRepository } from "../persistence/types.js";
import type { BankGateway, BankTransaction } from "./BankGateway.js";
import { FioGateway } from "./FioGateway.js";

/**
 * Mode-routing bank gateway. Decides per poll, based on the stored config token,
 * whether to run in simulation or talk to the real Fio API — no restart needed.
 *
 *  - Token blank  -> SIMULATION: auto-confirm. For each currently OPEN session it emits
 *    one exact-amount transaction (matching vs + amount). On the next poll / manual check
 *    the matcher transitions the session to PAID. Idempotence by externalId stops a
 *    session from being paid twice. This makes the demo work hands-free, no simulator UI.
 *  - Token present -> FIO: delegate to a real FioGateway built (and cached) per token.
 *
 * Holds a reference to the repo so it can read the live config + open sessions each poll.
 */
export class ModeGateway implements BankGateway {
  private readonly fioCache = new Map<string, BankGateway>();
  private lastFioAvailable = true;

  constructor(
    private readonly repo: SessionRepository,
    private readonly fioFactory: (token: string) => BankGateway = (token) =>
      new FioGateway({ token }),
  ) {}

  async fetchNewTransactions(): Promise<BankTransaction[]> {
    const cfg = await this.repo.getConfig();
    const token = (cfg?.token ?? "").trim();
    if (token.length === 0) {
      return this.simulateAutoConfirm();
    }
    let fio = this.fioCache.get(token);
    if (!fio) {
      fio = this.fioFactory(token);
      this.fioCache.set(token, fio);
    }
    try {
      const txs = await fio.fetchNewTransactions();
      this.lastFioAvailable = true;
      return txs;
    } catch (e) {
      this.lastFioAvailable = false;
      throw e;
    }
  }

  /** isAvailable(): always true in simulation; in Fio mode reflects the last fetch. */
  async isAvailable(): Promise<boolean> {
    const cfg = await this.repo.getConfig();
    const token = (cfg?.token ?? "").trim();
    return token.length === 0 ? true : this.lastFioAvailable;
  }

  /**
   * For each open session, emit a deterministic exact-amount transaction. The externalId
   * is derived from the session id so re-emitting across polls is idempotent (the matcher
   * skips already-processed externalIds; once PAID the session is no longer open).
   */
  private async simulateAutoConfirm(): Promise<BankTransaction[]> {
    const now = new Date();
    const all = await this.repo.listSessions();
    return all
      .filter((s) => isOpen(s.status))
      .map((s) => ({
        externalId: `sim-${s.id}`,
        amount: s.amount,
        currency: s.currency,
        vs: s.vs,
        receivedAt: now,
      }));
  }
}
