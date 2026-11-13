// Pure transaction specs and outcome reading. No wallet imports, so it is unit-testable.
import { USDC_DECIMALS, toBig } from "./amount.ts";
import type { Tranche } from "./types.ts";

export const TGAS = BigInt(10) ** BigInt(12);
export const ONE_YOCTO = "1";
/** NEP-145 storage_deposit for the token, 0.00125 NEAR (INTERFACE.md). */
export const STORAGE_DEPOSIT = "1250000000000000000000";

export interface CallSpec {
  method: string;
  args: object;
  gas: string; // gas units
  deposit: string; // yoctoNEAR
}
export interface TxSpec {
  receiverId: string;
  calls: CallSpec[];
}

const gas = (tgas: number) => (BigInt(tgas) * TGAS).toString();

export interface Contracts {
  cashflow: string;
  token: string;
}

function storageDeposit(accountId: string): CallSpec {
  return { method: "storage_deposit", args: { account_id: accountId, registration_only: true }, gas: gas(30), deposit: STORAGE_DEPOSIT };
}

/**
 * Money in always goes through the token's ft_transfer_call. If the sender is not registered
 * on the token, storage_deposit goes first in the same transaction (same receiver), so a refund
 * can always reach them.
 */
export function ftTransferCallTx(c: Contracts, accountId: string, amount: bigint, msg: object, registered: boolean): TxSpec {
  if (amount <= BigInt(0)) throw new Error("Amount must be positive");
  const call: CallSpec = {
    method: "ft_transfer_call",
    args: { receiver_id: c.cashflow, amount: amount.toString(), msg: JSON.stringify(msg) },
    gas: gas(150),
    deposit: ONE_YOCTO,
  };
  return { receiverId: c.token, calls: registered ? [call] : [storageDeposit(accountId), call] };
}

export const investTx = (c: Contracts, accountId: string, poolId: number, tranche: Tranche, amount: bigint, registered: boolean) =>
  ftTransferCallTx(c, accountId, amount, { invest: { pool_id: poolId, tranche } }, registered);

export const payTx = (c: Contracts, accountId: string, orderId: number, amount: bigint, registered: boolean) =>
  ftTransferCallTx(c, accountId, amount, { pay: { order_id: orderId } }, registered);

/** Claims pay out with ft_transfer, so an unregistered claimant registers first (separate tx: other receiver). */
export function claimTxs(c: Contracts, accountId: string, tokenIds: string[], registered: boolean): TxSpec[] {
  const txs: TxSpec[] = registered ? [] : [{ receiverId: c.token, calls: [storageDeposit(accountId)] }];
  for (const token_id of tokenIds) txs.push({ receiverId: c.cashflow, calls: [{ method: "claim", args: { token_id }, gas: gas(100), deposit: "0" }] });
  return txs;
}

export const approveTx = (c: Contracts, orderId: number): TxSpec => ({
  receiverId: c.cashflow,
  calls: [{ method: "approve_receipt", args: { id: orderId }, gas: gas(30), deposit: "0" }],
});

export const retryAdvanceTx = (c: Contracts, poolId: number): TxSpec => ({
  receiverId: c.cashflow,
  calls: [{ method: "retry_advance", args: { pool_id: poolId }, gas: gas(300), deposit: "0" }],
});

export function createOrderTx(c: Contracts, o: { amount: bigint; currency: string; dueNs: string; invoiceNo: string; customerHash: string }): TxSpec {
  return {
    receiverId: c.cashflow,
    calls: [{ method: "create_order", args: { amount: o.amount.toString(), currency: o.currency, due_date: o.dueNs, invoice_no: o.invoiceNo, customer_hash: o.customerHash }, gas: gas(30), deposit: "0" }],
  };
}

export function createPoolTx(c: Contracts, orderIds: number[]): TxSpec {
  if (orderIds.length < 1 || orderIds.length > 20) throw new Error("Select 1 to 20 invoices");
  return { receiverId: c.cashflow, calls: [{ method: "create_pool", args: { order_ids: orderIds }, gas: gas(50), deposit: "0" }] };
}

export const withdrawResidualTx = (c: Contracts): TxSpec => ({
  receiverId: c.cashflow,
  calls: [{ method: "withdraw_residual", args: {}, gas: gas(300), deposit: "0" }],
});

export const nftTransferTx = (c: Contracts, receiverId: string, tokenId: string): TxSpec => ({
  receiverId: c.cashflow,
  calls: [{ method: "nft_transfer", args: { receiver_id: receiverId, token_id: tokenId }, gas: gas(30), deposit: ONE_YOCTO }],
});

/** NEAR account id rules (named or 64-hex implicit). */
export const isAccountId = (s: string) => s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);

/**
 * Parse what a person typed ("1,000.5") into base units. Strict: at most `decimals` places,
 * no signs, no exponents. Returns null when the text is not a valid amount.
 */
export function parseUsdcInput(text: string, decimals = USDC_DECIMALS): bigint | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t) ?? /^()\.(\d+)$/.exec(t);
  if (!m) return null;
  const [, whole, frac = ""] = m;
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * BigInt(10) ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units back to an editable string without separators ("4.78125"). */
export function toInputString(value: string | bigint, decimals = USDC_DECIMALS): string {
  const v = toBig(value);
  const base = BigInt(10) ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

// ---------- outcomes ----------

export interface CashflowEvent {
  event: string;
  data: Record<string, unknown>[];
}

export interface TxResult {
  hash: string | null;
  ok: boolean;
  /** Friendly message when the transaction (or an inner receipt) did not complete. */
  error: string | null;
  /** For ft_transfer_call: amount sent, amount the contract kept, amount refunded. */
  transfer: { sent: bigint; used: bigint; refunded: bigint } | null;
  events: CashflowEvent[];
  /** Gas paid by the Cashflow Fi relayer (NEP-366), not the user. */
  gasless?: boolean;
}

type Status = { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown } | string;
interface Outcome {
  status: Status;
  transaction?: { hash?: string; actions?: unknown[] };
  transaction_outcome?: { id?: string };
  receipts_outcome?: { outcome: { logs: string[]; status: Status } }[];
}

const b64decode = (s: string) =>
  typeof atob === "function" ? new TextDecoder().decode(Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))) : Buffer.from(s, "base64").toString("utf8");

function failureText(f: unknown): string {
  const s = JSON.stringify(f);
  const m = /Smart contract panicked: ([^"\\]+)/.exec(s);
  if (m) return m[1];
  const exec = /"ExecutionError":"([^"\\]+)"/.exec(s);
  return exec ? exec[1] : s.slice(0, 200);
}

const FRIENDLY: [RegExp, string][] = [
  [/Merchant cannot approve own order/, "Invoices are approved from the customer's account. Sign in as the customer."],
  [/Order is not pending/, "This invoice has already been approved."],
  [/Only the position owner can claim/, "Only the current holder of this position NFT can claim it."],
  [/Nothing to claim/, "This position is fully claimed. New payouts appear here as payments arrive."],
  [/Pool not full/, "The pool is not fully funded yet."],
  [/Pool not funding/, "This pool is no longer taking investments."],
  [/Paused/, "The contract is paused."],
  [/Order not approved by underwriter/, "The underwriter has not approved this invoice."],
  [/The account .* is not registered/, "The account is not registered on the USDC token."],
  [/(Not enough balance|exceeds the balance|insufficient)/i, "Not enough USDC in this account."],
  [/User (rejected|cancelled)|userRejected|User closed/i, "You cancelled the request in your wallet."],
];

export function friendlyError(raw: string): string {
  for (const [re, msg] of FRIENDLY) if (re.test(raw)) return msg;
  return raw;
}

function sentAmount(o: Outcome): bigint | null {
  for (const a of o.transaction?.actions ?? []) {
    const fc = (a as { FunctionCall?: { method_name: string; args: string } }).FunctionCall;
    if (fc?.method_name !== "ft_transfer_call") continue;
    try {
      return toBig(JSON.parse(b64decode(fc.args)).amount);
    } catch {
      return null;
    }
  }
  return null;
}

export function readOutcome(o: Outcome): TxResult {
  const hash = o.transaction?.hash ?? o.transaction_outcome?.id ?? null;
  const events: CashflowEvent[] = [];
  let innerFailure: string | null = null;
  for (const r of o.receipts_outcome ?? []) {
    for (const log of r.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(log.slice("EVENT_JSON:".length));
        if (e.standard === "cashflow") events.push({ event: e.event, data: e.data ?? [] });
      } catch {}
    }
    const st = r.outcome.status;
    if (typeof st === "object" && st.Failure && !innerFailure) innerFailure = failureText(st.Failure);
  }

  const st = o.status;
  if (typeof st === "object" && st.Failure) {
    return { hash, ok: false, error: friendlyError(failureText(st.Failure)), transfer: null, events };
  }

  let transfer: TxResult["transfer"] = null;
  const sent = sentAmount(o);
  if (sent !== null && typeof st === "object" && typeof st.SuccessValue === "string" && st.SuccessValue) {
    const used = toBig(JSON.parse(b64decode(st.SuccessValue)));
    transfer = { sent, used, refunded: sent - used };
  }
  // ft_on_transfer refunds instead of panicking, so "success" with nothing used means nothing happened.
  if (transfer && transfer.used === BigInt(0)) {
    return { hash, ok: false, error: innerFailure ? friendlyError(innerFailure) : "The full amount was returned to your account and no change was made.", transfer, events };
  }
  return { hash, ok: true, error: null, transfer, events };
}
