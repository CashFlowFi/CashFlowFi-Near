// Accountant-friendly CSV of a merchant's invoices, built from chain data only.
import { formatUsdc, nsToDate, remaining } from "./amount.ts";
import type { Order } from "./types.ts";

/** RFC 4180 quoting, plus a guard so spreadsheet apps never run a cell as a formula. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const plain = (base: string) => formatUsdc(base).replace(/,/g, "");
const day = (ns: string) => nsToDate(ns).toISOString().slice(0, 10);

export const INVOICE_COLUMNS = [
  "Invoice ID", "Invoice number", "Status", "Currency", "Amount", "Paid", "Outstanding",
  "Issued (UTC)", "Due (UTC)", "Customer account", "Pool", "AI verdict", "AI score",
];

export function invoicesCsv(orders: Order[]): string {
  const rows = [...orders].sort((a, b) => a.id - b.id).map((o) => [
    o.id, o.invoice_no, o.status, o.currency, plain(o.amount), plain(o.paid), plain(remaining(o.amount, o.paid).toString()),
    day(o.created_at), day(o.due_date), o.customer ?? "", o.pool_id ?? "", o.verdict ?? "", o.score ?? "",
  ]);
  return toCsv([INVOICE_COLUMNS, ...rows]);
}
