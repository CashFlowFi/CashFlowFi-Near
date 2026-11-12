// Shape agent evidence files (evidence/tiers, evidence/collections) for the /agents page.
// "teeVerified" is true only for text the model wrote inside a verified TEE.

interface Privacy { verified_private?: boolean; model?: string | null }

export interface TierChange {
  merchant: string;
  old_tier: string;
  new_tier: string;
  repaid_pools: number | null;
  defaults: number | null;
  reason: string;
  tx_hash: string | null;
  timestamp: string | null;
  teeVerified: boolean;
  file: string;
}

export interface Reminder {
  order_id: number;
  pool_id: number | null;
  invoice_no: string;
  customer: string | null;
  amount_due: string;
  subject: string;
  body: string;
  reminded_at: string | null;
  teeVerified: boolean;
  model: string | null;
  file: string;
}

const teeWritten = (source: unknown, privacy: Privacy | undefined) => source === "model" && privacy?.verified_private === true;

export function toTierChange(d: Record<string, unknown>, file: string): TierChange | null {
  if (typeof d.merchant !== "string" || typeof d.new_tier !== "string") return null;
  return {
    merchant: d.merchant,
    old_tier: String(d.old_tier ?? ""),
    new_tier: d.new_tier,
    repaid_pools: typeof d.repaid_pools === "number" ? d.repaid_pools : null,
    defaults: typeof d.defaults === "number" ? d.defaults : null,
    reason: String(d.reason ?? ""),
    tx_hash: typeof d.tx_hash === "string" ? d.tx_hash : null,
    timestamp: typeof d.timestamp === "string" ? d.timestamp : null,
    teeVerified: teeWritten(d.source, d.privacy as Privacy | undefined),
    file,
  };
}

export function toReminder(d: Record<string, unknown>, file: string): Reminder | null {
  const m = d.message as { subject?: string; body?: string; source?: string; privacy?: Privacy } | undefined;
  if (!Number.isInteger(d.order_id) || !m?.subject || !m.body) return null;
  return {
    order_id: d.order_id as number,
    pool_id: Number.isInteger(d.pool_id) ? (d.pool_id as number) : null,
    invoice_no: String(d.invoice_no ?? ""),
    customer: typeof d.customer === "string" ? d.customer : null,
    amount_due: /^\d+$/.test(String(d.amount_due)) ? String(d.amount_due) : "0",
    subject: m.subject,
    body: m.body,
    reminded_at: typeof d.reminded_at === "string" ? d.reminded_at : null,
    teeVerified: teeWritten(m.source, m.privacy),
    model: m.privacy?.model ?? null,
    file,
  };
}
