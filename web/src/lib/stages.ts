// Map chain state to the pool workspace stages. Pure: no fetches, no clock except `now`.
import { sum, toBig } from "./amount.ts";
import type { Order, Pool, Position } from "./types.ts";

export type StageKey =
  | "invoice"
  | "approved"
  | "underwritten"
  | "funded"
  | "paid"
  | "default"
  | "cover"
  | "claimed";

/** done: happened. current: waiting on it now. upcoming: not reached. missed: will not happen (e.g. full payment on a defaulted pool). */
export type StageState = "done" | "current" | "upcoming" | "missed";

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
}

export interface StageView {
  stages: Stage[];
  /** The stage the workspace opens on. */
  open: StageKey;
  /** True when nothing is pending: the pool is Repaid or Defaulted and every payout is claimed. */
  settled: boolean;
}

const LABELS: Record<StageKey, string> = {
  invoice: "Invoice",
  approved: "Approved",
  underwritten: "Underwritten",
  funded: "Funded",
  paid: "Paid",
  default: "Default",
  cover: "Cover",
  claimed: "Claimed",
};

const ZERO = BigInt(0);

export function deriveStages(pool: Pool, orders: Order[], positions: Position[] | null): StageView {
  const s = pool.status;
  const closed = s === "Repaid" || s === "Defaulted";
  const state: Partial<Record<StageKey, StageState>> = {};

  state.invoice = "done";
  state.approved = orders.length > 0 && orders.every((o) => o.customer !== null && o.status !== "Pending") ? "done" : "current";
  state.underwritten = orders.length > 0 && orders.every((o) => o.verdict === "Approve") ? "done" : "current";
  state.funded = s === "Funding" ? "current" : "done";

  if (s === "Repaid") state.paid = "done";
  else if (s === "Active") state.paid = "current";
  else if (s === "Defaulted") state.paid = "missed";
  else state.paid = "upcoming";

  if (s === "Defaulted") {
    state.default = "done";
    if (toBig(pool.pending_cover) > ZERO) state.cover = "current";
    else if (toBig(pool.insurance_paid) > ZERO) state.cover = "done";
    else state.cover = "missed";
  }

  // Everything paid out to tranches (repayments plus insurance cover) has been claimed.
  const owed = sum(pool.senior_repaid, pool.junior_repaid);
  const claimed = positions ? sum(...positions.map((p) => p.claimed)) : null;
  const coverPending = state.cover === "current";
  if (!closed || coverPending) state.claimed = "upcoming";
  else if (claimed !== null && positions!.length > 0 && claimed >= owed) state.claimed = "done";
  else state.claimed = "current";

  const order: StageKey[] =
    s === "Defaulted"
      ? ["invoice", "approved", "underwritten", "funded", "paid", "default", "cover", "claimed"]
      : ["invoice", "approved", "underwritten", "funded", "paid", "claimed"];
  const stages = order.map((key) => ({ key, label: LABELS[key], state: state[key]! }));

  const current = stages.find((st) => st.state === "current");
  const settled = closed && !current;
  return { stages, open: current ? current.key : "claimed", settled };
}
