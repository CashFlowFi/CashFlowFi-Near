// Which role a signed-in account plays on a pool, and the one primary action for a role.
import { remaining, sum, toBig } from "./amount.ts";
import type { Order, Pool, Position } from "./types.ts";

export type Role = "observer" | "merchant" | "customer" | "investor";
export type ActionKey = "invest" | "claim" | "pay" | "retry_advance";

export function defaultRole(accountId: string | null, pool: Pool, orders: Order[], positions: Position[] | null): Role {
  if (!accountId) return "observer";
  if (accountId === pool.merchant) return "merchant";
  if (orders.some((o) => o.customer === accountId)) return "customer";
  if (positions?.some((p) => p.owner === accountId) || pool.status === "Funding") return "investor";
  return "observer";
}

/**
 * The action for a role. When signed in, Claim needs a claimable position the account holds;
 * when signed out, any claimable position shows the action (sign-in comes first).
 */
export function roleAction(role: Role, pool: Pool, orders: Order[], positions: Position[] | null, accountId: string | null): ActionKey | null {
  const zero = BigInt(0);
  if (role === "investor") {
    if (pool.status === "Funding") {
      const room = remaining(pool.senior_target, pool.senior_funded) + remaining(pool.junior_target, pool.junior_funded);
      return room > zero ? "invest" : null;
    }
    const claimable = (positions ?? []).filter((p) => toBig(p.claimable) > zero && (!accountId || p.owner === accountId));
    return claimable.length > 0 ? "claim" : null;
  }
  if (role === "customer") {
    const owed = remaining(sum(...orders.map((o) => o.amount)), sum(...orders.map((o) => o.paid)));
    return pool.status === "Active" && owed > zero && orders.some((o) => o.status === "Pooled") ? "pay" : null;
  }
  if (role === "merchant") {
    const full = toBig(pool.senior_funded) >= toBig(pool.senior_target) && toBig(pool.junior_funded) >= toBig(pool.junior_target);
    return pool.status === "Funding" && full ? "retry_advance" : null;
  }
  return null;
}
