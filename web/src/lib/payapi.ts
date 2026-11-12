// Pay-from-Arbitrum helpers: quote and status shapes from /api/pay/quote and /api/pay/status (INTERFACE.md).
import { toBig } from "./amount.ts";

export const ARB_SEPOLIA_USDC = "0x38d81431b9f76d9699af7517040d5221d9dea252";
export const TIDEPOOL_SUBMIT_URL = "https://www.usetidepool.tech/v0/deposit/submit";
export const ARBISCAN = "https://sepolia.arbiscan.io";

export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
export const isEvmTxHash = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s.trim());

export interface QuoteResponse {
  depositAddress: string | null;
  amountIn: string;
  minAmountOut?: string;
  deadline: string;
  dry: boolean;
  order_id: number;
}

export type QuoteView =
  | { kind: "preview"; amountIn: bigint; deadline: string }
  | { kind: "live"; amountIn: bigint; deadline: string; depositAddress: string };

/** A quote is payable only when it is live and carries a real deposit address. Anything else is a preview. */
export function readQuote(q: QuoteResponse): QuoteView {
  const amountIn = toBig(q.amountIn);
  if (!q.dry && typeof q.depositAddress === "string" && isEvmAddress(q.depositAddress)) {
    return { kind: "live", amountIn, deadline: q.deadline, depositAddress: q.depositAddress };
  }
  return { kind: "preview", amountIn, deadline: q.deadline };
}

const QUOTE_MESSAGES: Record<string, string> = {
  ORDER_NOT_PAYABLE: "This invoice opens for payment once its pool is active.",
  POOL_NOT_ACTIVE: "This invoice opens for payment once its pool is fully funded.",
  ORDER_ALREADY_PAID: "This invoice is paid in full.",
  ORDER_NOT_FOUND: "This invoice is not on the contract.",
  PAY_REFUND_ADDRESS: "Enter the EVM address that should receive any refund.",
};

/** Friendly text for an API error body { error, detail? }. */
export function quoteMessage(body: { error?: string; detail?: unknown } | null, httpStatus: number): string {
  if (body?.error === "ORDER_NOT_PAYABLE" && body.detail === "Paid") return QUOTE_MESSAGES.ORDER_ALREADY_PAID;
  if (body?.error && QUOTE_MESSAGES[body.error]) return QUOTE_MESSAGES[body.error];
  return `The payments service answered ${body?.error ?? `HTTP ${httpStatus}`}. Try again in a moment.`;
}

export type PayStatus = "pending" | "forwarding" | "delivered" | "refunded" | "failed" | "ambiguous";

export const PAY_STEPS: { key: "pending" | "forwarding" | "delivered"; label: string }[] = [
  { key: "pending", label: "Waiting for deposit" },
  { key: "forwarding", label: "Crossing to NEAR" },
  { key: "delivered", label: "Paid on NEAR" },
];

export interface StatusView {
  /** Index into PAY_STEPS reached so far, or -1 for an outcome off the happy path. */
  step: number;
  label: string;
  /** Polling stops when true. */
  final: boolean;
  tone: "progress" | "done" | "attention";
}

export function readStatus(status: string): StatusView {
  switch (status) {
    case "pending": return { step: 0, label: "Waiting for your deposit on Arbitrum Sepolia", final: false, tone: "progress" };
    case "forwarding": return { step: 1, label: "Deposit received, crossing to NEAR", final: false, tone: "progress" };
    case "delivered": return { step: 2, label: "Paid on NEAR", final: true, tone: "done" };
    case "refunded": return { step: -1, label: "Returned to your refund address", final: true, tone: "attention" };
    case "failed": return { step: -1, label: "Closed by the provider. Details are in the receipt", final: true, tone: "attention" };
    default: return { step: -1, label: "Checking with the provider", final: false, tone: "attention" };
  }
}
