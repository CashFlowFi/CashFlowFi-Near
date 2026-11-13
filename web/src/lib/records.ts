// Track records from chain data, computed exactly like the underwriter agent (agent/run.mjs).
import type { Order, Pool } from "./types.ts";

export interface CustomerRecord { paid: number; defaults: number; open: number; outstanding: bigint }
export interface MerchantRecord { repaidPools: number; defaults: number }

/** Customer: paid in full (Paid), defaulted (in a Defaulted pool), open (Pooled otherwise). Optionally excludes one order. */
export function customerRecord(orders: Order[], pools: Pool[], customer: string, excludeOrderId?: number): CustomerRecord {
  const poolStatus = new Map(pools.map((p) => [p.id, p.status]));
  const r = { paid: 0, defaults: 0, open: 0, outstanding: BigInt(0) };
  for (const o of orders) {
    if (o.customer !== customer || o.id === excludeOrderId) continue;
    const ps = o.pool_id === null ? null : poolStatus.get(o.pool_id);
    if (o.status === "Paid") r.paid++;
    else if (ps === "Defaulted") r.defaults++;
    else if (o.status === "Pooled") r.open++;
    const approvedOpen = (o.status === "Attested" && o.verdict === "Approve") || (o.status === "Pooled" && ps !== "Defaulted");
    if (approvedOpen) r.outstanding += BigInt(o.amount) - BigInt(o.paid ?? "0");
  }
  return r;
}

export function merchantRecord(pools: Pool[], merchant: string): MerchantRecord {
  const r = { repaidPools: 0, defaults: 0 };
  for (const p of pools) {
    if (p.merchant !== merchant) continue;
    if (p.status === "Repaid") r.repaidPools++;
    if (p.status === "Defaulted") r.defaults++;
  }
  return r;
}

/** Same limits as agent/underwriter.mjs. */
export const NEW_CUSTOMER_LIMIT = BigInt(20) * BigInt(1_000_000);
export const CUSTOMER_EXPOSURE_CAP = BigInt(100_000) * BigInt(1_000_000);

/** Same rule as agent/underwriter.mjs habitualDefaulter. */
export const habitualDefaulter = (r: CustomerRecord) => r.defaults >= 2 && r.defaults > r.paid;

/** Share of closed invoices that defaulted, in whole percent; null when nothing has closed yet. */
export function defaultRate(r: CustomerRecord): number | null {
  const closed = r.paid + r.defaults;
  return closed === 0 ? null : Math.round((r.defaults * 100) / closed);
}
