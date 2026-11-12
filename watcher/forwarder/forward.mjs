// Forward one verified delivery into the contract:
//   sign ft_transfer_call(contract, delivered amount, {"pay":{"order_id":N}}), reserve the delivery by claiming the
//   signed tx's hash (exclusive create) BEFORE broadcast, broadcast, then confirm payment_applied from the tx itself.
// A claim without a result is resolved only by looking up that exact hash; it is never re-signed.

import { forwardResultFromTx } from '../../api/near.mjs';
import { TIDEPOOL, nearDestinationHashes, TERMINAL } from '../tidepool.mjs';
import { bindingInfo, findDelivery, payMsg, readLinkedTxs } from './verify.mjs';

export const FINAL_STAGES = new Set(['delivered', 'failed', 'refunded', 'held']);
const iso = (s) => new Date(s * 1000).toISOString();

/**
 * deps:
 *   config      { contractId, forwarder, tokenId? }
 *   store       createFileStore(...) or a fake with the same methods
 *   fetchStatus(depositAddress) -> Tidepool status
 *   txStatus(hash, senderId)    -> EXPERIMENTAL_tx_status result; lookupTx(hash, senderId) -> same, or null if unknown
 *   viewOrder(id), ftBalance(accountId) -> string
 *   signForward({ amount, msg }) -> { hash, signedBase64, send() }   (send broadcasts the exact signed tx)
 *   now() -> unix seconds, log(msg)
 * opts.forward=false: read-only assessment (the API uses this); nothing is written or sent.
 * opts.reverify=true: a recorded 'delivered' is re-checked on chain before it is reported.
 */
export async function processDeposit(binding, deps, { forward = true, reverify = false } = {}) {
  const { store } = deps;
  const b = bindingInfo(binding, deps.config);
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);

  // 1. Our own claim decides first: a delivery in flight is never re-assessed into a second send.
  const claim = await store.findClaimByDeposit(b.deposit);
  if (claim) {
    if (claim.stage === 'forwarding') return forward ? finalize(claim, deps, now) : { outcome: 'forwarding', record: claim };
    if (claim.stage === 'delivered' && reverify) return reverifyDelivered(claim, deps);
    return { outcome: claim.stage, record: claim };
  }
  const entry = await store.findEntry(b.orderId, b.deposit);
  if (entry && FINAL_STAGES.has(entry.stage)) return { outcome: entry.stage, record: entry };

  const a = await assessDeposit(b, deps, { now, forward });
  if (!a.delivery) return a;
  if (!forward) return { outcome: 'ready', record: a.record };
  return forwardDelivery(b, a, deps, now);
}

/** Record a final stage for this deposit (only when writing is allowed) and report it. */
async function settle(deps, b, ctx, stage, extra, { now, write }) {
  const record = { ...ctx, stage, ...extra, updated_at: iso(now) };
  if (write) await deps.store.upsertEntry(b.orderId, record);
  return { outcome: stage, record };
}

/** Steps 2-3: provider status is a pointer; a SUCCESS counts only once our NEAR receipts show the delivery. */
async function assessDeposit(b, deps, { now, forward }) {
  const { config, store } = deps;
  const tokenId = config.tokenId ?? TIDEPOOL.destinationToken;
  const st = await deps.fetchStatus(b.depositAddress);
  const providerStatus = st?.status ?? 'unknown';
  const originTx = b.originTx ?? (st?.swapDetails?.originChainTxHashes ?? []).map((x) => (typeof x === 'string' ? x : x?.hash)).find((h) => typeof h === 'string') ?? null;
  const ctx = { order_id: b.orderId, deposit_address: b.depositAddress, origin_tx: originTx, min_amount_out: b.minAmountOut, provider_status: providerStatus };
  const hashes = nearDestinationHashes(st);
  const opts = { now, write: forward };
  if (!TERMINAL.includes(providerStatus)) return { outcome: 'pending', record: { ...ctx, evidence: 'provider-claim-only' } };
  if (providerStatus === 'REFUNDED') return settle(deps, b, ctx, 'refunded', { evidence: 'provider-claim-only', refund_reason: st.refundReason ?? null }, opts);
  if (providerStatus === 'FAILED') return settle(deps, b, ctx, 'failed', { evidence: 'provider-claim-only' }, opts);

  // SUCCESS: find the delivery in our own NEAR receipts.
  const txs = await readLinkedTxs(hashes, deps);
  const taken = await store.claimedDeliveries();
  const found = findDelivery(txs, { forwarder: config.forwarder, minAmountOut: b.minAmountOut, tokenId, taken: (id) => taken.has(id) });
  if (found.status === 'short') return { outcome: 'ambiguous', record: { ...ctx, destination_hashes: hashes, reason: `DELIVERY_BELOW_MIN: ${found.amount} < ${b.minAmountOut}` } };
  if (found.status === 'none') {
    if (txs.length === 0) return { outcome: 'pending', record: { ...ctx, destination_hashes: hashes, evidence: 'provider-claim-only' } };
    return { outcome: 'ambiguous', record: { ...ctx, destination_hashes: hashes, reason: 'NO_VERIFIER_TO_FORWARDER_TRANSFER' } };
  }
  const d = found.delivery;
  const ready = { ...ctx, delivery_id: d.id, delivery_tx: d.txHash, delivery_receipt: d.receiptId, delivered_amount: d.amount, evidence: 'provider-linked-near-receipt' };
  return { ctx, record: ready, delivery: d };
}

/** Step 4. Preconditions that would only waste the transfer are checked first; nothing is claimed if they fail. */
async function forwardDelivery(b, { ctx, record: ready, delivery: d }, deps, now) {
  const { config, store } = deps;
  const order = await deps.viewOrder(b.orderId);
  if (order?.status !== 'Pooled') return settle(deps, b, ctx, 'held', { ...ready, reason: `ORDER_NOT_PAYABLE: ${order?.status ?? 'missing'}; funds stay with the forwarder` }, { now, write: true });
  const balance = BigInt(await deps.ftBalance(config.forwarder));
  if (balance < BigInt(d.amount)) return { outcome: 'ambiguous', record: { ...ready, reason: `FORWARDER_BALANCE_LOW: ${balance} < ${d.amount}` } };

  const signed = await deps.signForward({ amount: d.amount, msg: payMsg(b.orderId) });
  const marker = { ...ready, stage: 'forwarding', forward_tx: signed.hash, forward_signed_tx: signed.signedBase64, contract: config.contractId, forwarder: config.forwarder, claimed_at: iso(now) };
  if (!(await store.createClaim(d.id, marker))) return { outcome: 'forwarding', record: { ...ready, reason: 'CLAIMED_BY_ANOTHER_RUN' } };
  await store.upsertEntry(b.orderId, marker);
  deps.log?.(`order ${b.orderId}: forwarding ${d.amount} from delivery ${d.txHash} in ${signed.hash}`);
  try { await signed.send(); } catch (e) {
    // The tx may or may not have executed. The claim stays; finalize looks the hash up.
    marker.broadcast_error = String(e?.message ?? e).slice(0, 300);
    await store.saveClaim(d.id, marker);
  }
  return finalize(marker, deps, now);
}

/** What the forward tx actually did for this claim: payment_applied amount, surplus refund, events. */
const forwardResult = (tx, claim, config) => forwardResultFromTx(tx, { contractId: claim.contract ?? config.contractId,
  tokenId: config.tokenId ?? TIDEPOOL.destinationToken, forwarder: config.forwarder, orderId: claim.order_id, amount: claim.delivered_amount });

/** Resolve a 'forwarding' claim from its recorded tx hash only. Unknown hash: stays 'forwarding' for a human. */
async function finalize(claim, deps, now) {
  const { config, store } = deps;
  let tx = null; let lookupError = null;
  try { tx = await deps.lookupTx(claim.forward_tx, config.forwarder); } catch (e) { lookupError = String(e?.message ?? e).slice(0, 200); }
  if (!tx) {
    const reason = `FORWARD_TX_NOT_FOUND: ${claim.forward_tx}${lookupError ? ` (${lookupError})` : ''}. Check the forwarder's tx history and order.paid before any manual resend.`;
    return { outcome: 'forwarding', record: { ...claim, reason } };
  }
  const r = forwardResult(tx, claim, config);
  const done = {
    ...claim, stage: r.ok ? 'delivered' : 'failed', applied_amount: r.applied, surplus_refunded_to_forwarder: r.refunded,
    events: r.events, ft_on_transfer_receipt: r.onTransferReceiptId ?? null,
    forward_explorer: `https://testnet.nearblocks.io/txns/${claim.forward_tx}`, finished_at: iso(now),
    ...(r.ok ? {} : { reason: `FORWARD_${r.reason}; funds are with the forwarder or the contract, check before acting` }),
  };
  delete done.broadcast_error;
  await store.saveClaim(claim.delivery_id, done);
  await store.upsertEntry(claim.order_id, done);
  if (r.ok) {
    await store.appendLedger({ recorded_at: iso(now), order_id: claim.order_id, amount: r.applied, deposit_address: claim.deposit_address,
      origin_tx: claim.origin_tx ?? null, near_tx: claim.forward_tx, evidence: claim.evidence });
  }
  deps.log?.(`order ${claim.order_id}: ${done.stage} (applied ${r.applied}, surplus back to forwarder ${r.refunded}) ${claim.forward_tx}`);
  return { outcome: done.stage, record: done };
}

async function reverifyDelivered(claim, deps) {
  const { config } = deps;
  const tx = await deps.lookupTx(claim.forward_tx, config.forwarder).catch(() => null);
  const r = tx && forwardResult(tx, claim, config);
  if (r?.ok) return { outcome: 'delivered', record: claim };
  return { outcome: 'ambiguous', record: { ...claim, reason: tx ? `RECORDED_DELIVERY_NOT_ON_CHAIN: ${r.reason}` : 'FORWARD_TX_UNREADABLE' } };
}
