// Shapes from docs/INTERFACE.md (v0.2).

export type OrderStatus = "Pending" | "CustomerApproved" | "Attested" | "Rejected" | "Pooled" | "Paid";
export type Verdict = "Approve" | "Flag" | "Reject";
export type PoolStatus = "Funding" | "Active" | "Repaid" | "Defaulted";
export type Tranche = "Senior" | "Junior";
export type Tier = "A" | "B" | "C" | "D";

export interface Order {
  id: number;
  merchant: string;
  customer: string | null;
  amount: string;
  currency: string;
  due_date: string;
  invoice_no: string;
  customer_hash: string;
  status: OrderStatus;
  verdict: Verdict | null;
  score: number | null;
  reason_hash: string | null;
  paid: string;
  pool_id: number | null;
  created_at: string;
}

export interface Pool {
  id: number;
  merchant: string;
  order_ids: number[];
  tier: Tier;
  receivable: string;
  advance: string;
  fee: string;
  claim: string;
  senior_face: string;
  junior_face: string;
  senior_target: string;
  junior_target: string;
  senior_funded: string;
  junior_funded: string;
  senior_repaid: string;
  junior_repaid: string;
  residual_paid: string;
  insurance_paid: string;
  insurance_refilled: string;
  pending_cover: string;
  status: PoolStatus;
  due_date: string;
  created_at: string;
}

export interface Position {
  token_id: string;
  pool_id: number;
  tranche: Tranche;
  amount: string;
  claimed: string;
  claimable: string;
  owner: string;
}

export interface Config {
  token_id: string;
  positions_id: string;
  agent_id: string;
  dao_id: string;
  grace_ns: string;
  dao_threshold: string;
  paused: boolean;
}

export const TIER_LTV: Record<Tier, number> = { A: 85, B: 80, C: 70, D: 60 };
