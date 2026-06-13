import type { PaymentSession } from "../domain/session.js";

/** Serialize sessions to CSV for export (AC-8.2). */
export function sessionsToCsv(sessions: PaymentSession[]): string {
  const header = [
    "id",
    "vs",
    "amount",
    "currency",
    "status",
    "overpaid",
    "createdAt",
    "expiresAt",
    "paidAt",
    "matchedTxId",
    "note",
  ];
  const rows = sessions.map((s) =>
    [
      s.id,
      s.vs,
      s.amount.toFixed(2),
      s.currency,
      s.status,
      String(s.overpaid),
      s.createdAt.toISOString(),
      s.expiresAt.toISOString(),
      s.paidAt ? s.paidAt.toISOString() : "",
      s.matchedTxId ?? "",
      s.note ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\r\n");
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
