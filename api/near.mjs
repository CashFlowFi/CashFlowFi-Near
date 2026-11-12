// Minimal NEAR JSON-RPC client (views + tx status) and the receipt check used by /api/pay/status.
// Node built-ins only. `fetchImpl` is injected so tests never touch the network.

export const DEFAULT_RPC = 'https://rpc.testnet.near.org';

const rpcError = (code, detail) => Object.assign(new Error(code), { detail });

async function rpc(method, params, { rpcUrl = DEFAULT_RPC, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cashflow-api', method, params }),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw rpcError('NEAR_RPC_UNAVAILABLE', `HTTP ${r.status}`);
  const body = await r.json();
  if (body.error) throw rpcError('NEAR_RPC_ERROR', body.error.cause?.name ?? body.error.name ?? 'unknown');
  return body.result;
}

/** Call a view method on `contractId`; returns the decoded JSON result. */
export async function viewCall(contractId, methodName, args, opts) {
  const result = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: contractId, method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  }, opts);
  if (result?.error) throw rpcError('NEAR_VIEW_FAILED', String(result.error).slice(0, 200));
  if (!Array.isArray(result?.result)) throw rpcError('NEAR_VIEW_FAILED', 'no result bytes');
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

/**
 * Full tx status with all receipts. The RPC uses sender_account_id only for routing; a probe on testnet
 * (2026-11-12) returned the same tx for three different senders, so the verifier account is passed.
 */
export function txStatus(txHash, senderId, opts) {
  return rpc('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: senderId, wait_until: 'FINAL' }, opts);
}

const decodeJson = (b64) => { try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return null; } };
const calls = (r) => (r?.receipt?.Action?.actions ?? []).map((a) => a?.FunctionCall).filter(Boolean);
const succeeded = (o) => !!o?.status && !('Failure' in o.status) && ('SuccessValue' in o.status || 'SuccessReceiptId' in o.status);

/** Cashflow `payment_applied` events for `orderId`, read only from logs our own contract emitted. */
export function paymentEvents(logs, orderId) {
  const out = [];
  for (const l of logs ?? []) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    let e; try { e = JSON.parse(l.slice('EVENT_JSON:'.length)); } catch { continue; }
    if (e?.standard !== 'cashflow' || e.event !== 'payment_applied' || !Array.isArray(e.data)) continue;
    for (const d of e.data) if (d?.order_id === orderId && /^[0-9]+$/.test(d.amount ?? '')) out.push(d);
  }
  return out;
}

/**
 * Turn an EXPERIMENTAL_tx_status result into the `nearReceipt` shape classifyPayment expects.
 * Requires BOTH: the token's ft_transfer_call to our contract, and our contract's ft_on_transfer called by
 * that token, each successful. Logs are only those executed by our contract (a look-alike log from any
 * other account does not count).
 */
export function payReceiptFromTx(tx, { contractId, tokenId }) {
  const receipts = tx?.receipts ?? [];
  const outcomes = new Map((tx?.receipts_outcome ?? []).map((o) => [o.id, o.outcome]));
  let call = null; let args = null;
  for (const r of receipts) {
    if (r.receiver_id !== tokenId) continue;
    for (const f of calls(r)) {
      const a = f.method_name === 'ft_transfer_call' ? decodeJson(f.args) : null;
      if (a?.receiver_id === contractId) { call = r; args = a; break; }
    }
    if (call) break;
  }
  if (!call) return { found: false };
  const onTransfer = receipts.find((r) => r.receiver_id === contractId && r.predecessor_id === tokenId
    && calls(r).some((f) => f.method_name === 'ft_on_transfer'));
  const onOutcome = onTransfer ? outcomes.get(onTransfer.receipt_id) : null;
  const logs = (tx.receipts_outcome ?? []).filter((o) => o.outcome?.executor_id === contractId).flatMap((o) => o.outcome.logs ?? []);
  return {
    found: true,
    success: succeeded(outcomes.get(call.receipt_id)) && !!onTransfer && succeeded(onOutcome),
    receiverId: call.receiver_id, predecessorId: call.predecessor_id, method: 'ft_transfer_call',
    args, logs, onTransferReceiptId: onTransfer?.receipt_id ?? null,
  };
}
