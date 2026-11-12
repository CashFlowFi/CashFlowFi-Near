// Merchant-side helpers: pool terms preview (mirrors contracts/cashflow-core `terms`) and invoice validation.
import type { Tier } from "./types.ts";

const BPS = BigInt(10_000);
const LTV_BPS: Record<Tier, bigint> = { A: BigInt(8500), B: BigInt(8000), C: BigInt(7000), D: BigInt(6000) };
const FEE_BPS = BigInt(100); // 1% of the advance
const FINANCING_BPS = BigInt(625); // 6.25% of the advance
const SENIOR_BPS = BigInt(7500);

export interface Terms {
  receivable: bigint;
  advance: bigint;
  fee: bigint;
  merchant_net: bigint;
  claim: bigint;
  senior_face: bigint;
  junior_face: bigint;
  senior_target: bigint;
  junior_target: bigint;
}

export function poolTerms(receivable: bigint, tier: Tier): Terms | null {
  if (receivable <= BigInt(0)) return null;
  const advance = (receivable * LTV_BPS[tier]) / BPS;
  const fee = (advance * FEE_BPS) / BPS;
  const claim = advance + (advance * FINANCING_BPS) / BPS;
  const senior_face = (claim * SENIOR_BPS) / BPS;
  const senior_target = (advance * SENIOR_BPS) / BPS;
  return {
    receivable, advance, fee, merchant_net: advance - fee, claim,
    senior_face, junior_face: claim - senior_face, senior_target, junior_target: advance - senior_target,
  };
}

export const INVOICE_NO = /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,63}$/;
export const CURRENCY = /^[A-Z]{3,5}$/;
export const MAX_AMOUNT = BigInt(100_000) * BigInt(1_000_000);
const DAY_MS = 86_400_000;

export interface InvoiceDraft {
  amount: bigint | null;
  currency: string;
  invoiceNo: string;
  /** Due date as epoch milliseconds. */
  dueMs: number | null;
  customerRef: string;
}

/** Field → message for every rule the contract or the underwriter's hard rules would apply. */
export function checkInvoice(d: InvoiceDraft, nowMs: number): Partial<Record<keyof InvoiceDraft, string>> {
  const e: Partial<Record<keyof InvoiceDraft, string>> = {};
  if (d.amount === null || d.amount <= BigInt(0)) e.amount = "Enter an amount above zero, up to 6 decimals.";
  else if (d.amount > MAX_AMOUNT) e.amount = "Up to 100,000 USDC per invoice.";
  if (!CURRENCY.test(d.currency)) e.currency = "Use 3 to 5 capital letters, e.g. USDC.";
  if (!INVOICE_NO.test(d.invoiceNo)) e.invoiceNo = "Letters, digits and . _ / # -, starting with a letter or digit, up to 64.";
  if (d.dueMs === null || d.dueMs <= nowMs) e.dueMs = "Pick a due date in the future.";
  else if (d.dueMs - nowMs > 180 * DAY_MS) e.dueMs = "Pick a due date within 180 days.";
  if (!d.customerRef.trim()) e.customerRef = "Enter a customer reference, e.g. their email.";
  return e;
}

/** Due date (epoch ms) to the contract's nanosecond string. */
export const msToNs = (ms: number) => (BigInt(Math.floor(ms)) * BigInt(1_000_000)).toString();
