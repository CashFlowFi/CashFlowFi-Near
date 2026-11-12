// Position NFT metadata.extra → typed fields (INTERFACE.md: { pool_id, tranche, amount, claimed, claimable, pool_status }).
import type { PoolStatus, Tranche } from "./types.ts";

export interface PositionExtra {
  pool_id: number;
  tranche: Tranche;
  amount: string;
  claimed: string;
  claimable: string;
  pool_status: PoolStatus;
}

const AMOUNT = /^\d+$/;

/** Returns null unless every field has the documented shape. */
export function parseExtra(extra: string | undefined | null): PositionExtra | null {
  if (!extra) return null;
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(extra);
  } catch {
    return null;
  }
  if (!Number.isInteger(x.pool_id)) return null;
  if (x.tranche !== "Senior" && x.tranche !== "Junior") return null;
  for (const k of ["amount", "claimed", "claimable"]) if (typeof x[k] !== "string" || !AMOUNT.test(x[k] as string)) return null;
  if (!["Funding", "Active", "Repaid", "Defaulted"].includes(x.pool_status as string)) return null;
  return x as unknown as PositionExtra;
}
