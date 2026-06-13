import { EventEmitter } from "node:events";
import type { PaymentSession } from "../domain/session.js";

/**
 * Tiny pub/sub for session state changes. The SSE route subscribes per session
 * id and pushes the updated session to connected clients within ~1s of a change.
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // A session can have several listeners (operator + display + history view).
    this.emitter.setMaxListeners(0);
  }

  publishSessionChange(session: PaymentSession): void {
    this.emitter.emit(`session:${session.id}`, session);
  }

  onSessionChange(id: string, listener: (session: PaymentSession) => void): () => void {
    const event = `session:${id}`;
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }
}
