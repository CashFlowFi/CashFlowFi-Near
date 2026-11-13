"use client";
// Browser side of gas-free calls: MyNearWallet's function-call key signs, our relayer pays the gas.
import { CONTRACT, RELAYER_URL } from "./config";
import { txStatus, viewAccessKey } from "./chain";
import { gaslessEligible, signDelegateBase64, type FunctionCallKey } from "./gasless";
import { friendlyError, readOutcome, type TxResult, type TxSpec } from "./tx";

const TTL_BLOCKS = BigInt(300); // well under the relayer's 600-block limit

export function readFunctionCallKey(): FunctionCallKey | null {
  try {
    const raw = localStorage.getItem("functionCallKey");
    const k = raw ? JSON.parse(raw) : null;
    return k && typeof k.privateKey === "string" && typeof k.contractId === "string" ? k : null;
  } catch {
    return null;
  }
}

/** True when every tx can go gas-free right now. */
export function canRelay(txs: TxSpec[]): boolean {
  if (!RELAYER_URL || txs.length === 0) return false;
  const key = readFunctionCallKey();
  return txs.every((t) => gaslessEligible(t, key, CONTRACT));
}

/** Thrown before anything reached the chain, so the caller may fall back to the wallet safely. */
export class RelayUnavailable extends Error {}

let relayerAccount: string | null = null;
async function relayerId(): Promise<string> {
  if (relayerAccount) return relayerAccount;
  const r = await fetch(new URL("/relay/health", RELAYER_URL).href).catch(() => null);
  if (!r?.ok) throw new RelayUnavailable("relayer unreachable");
  const h = await r.json();
  if (!h.ok || typeof h.relayer !== "string") throw new RelayUnavailable("relayer at its spend cap");
  return (relayerAccount = h.relayer);
}

export async function relayTxs(accountId: string, txs: TxSpec[]): Promise<TxResult[]> {
  const key = readFunctionCallKey()!;
  const relayer = await relayerId();
  const results: TxResult[] = [];
  for (const spec of txs) {
    const { publicKey } = await signDelegateBase64({ privateKey: key.privateKey, senderId: accountId, spec, nonce: BigInt(0), maxBlockHeight: BigInt(0) });
    const ak = await viewAccessKey(accountId, publicKey);
    const { encoded } = await signDelegateBase64({
      privateKey: key.privateKey, senderId: accountId, spec,
      nonce: BigInt(ak.nonce) + BigInt(1), maxBlockHeight: BigInt(ak.block_height) + TTL_BLOCKS,
    });
    let res: Response;
    try {
      res = await fetch(new URL("/relay", RELAYER_URL).href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedDelegate: encoded }) });
    } catch {
      if (results.length === 0) throw new RelayUnavailable("relayer unreachable");
      results.push({ hash: null, ok: false, error: "The relayer went offline mid-way. Refresh to see what landed.", transfer: null, events: [] });
      break;
    }
    const body = await res.json().catch(() => ({}));
    // 4xx = rejected by policy before submitting: nothing reached the chain.
    if (res.status >= 400 && res.status < 500 && results.length === 0) throw new RelayUnavailable(body.error ?? `HTTP ${res.status}`);
    if (!res.ok || typeof body.txHash !== "string") {
      results.push({ hash: null, ok: false, error: friendlyError(body.detail ?? body.error ?? `Relayer HTTP ${res.status}`), transfer: null, events: [] });
      break;
    }
    const outcome = await txStatus(body.txHash, relayer).catch(() => null);
    const r = outcome
      ? readOutcome(outcome as Parameters<typeof readOutcome>[0])
      : { hash: body.txHash, ok: body.status === "success", error: body.status === "success" ? null : "See the receipt for details.", transfer: null, events: [] };
    results.push({ ...r, hash: body.txHash, gasless: true });
    if (!r.ok) break;
  }
  return results;
}
