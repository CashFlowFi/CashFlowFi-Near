// Delivery verification. Provider SUCCESS is only a pointer: a delivery counts only if OUR NEAR receipt shows a
// nep141 ft_transfer verifier -> forwarder of >= minAmountOut, in a NEAR tx the provider linked to this deposit.

import { ftTransfers } from '../../api/near.mjs';
import { TIDEPOOL } from '../tidepool.mjs';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

const fail = (code) => { throw new Error(code); };
export const payMsg = (orderId) => JSON.stringify({ pay: { order_id: orderId } });
export const deliveryId = (txHash, receiptId) => `${txHash}-${receiptId}`;

/** Normalise a saved quote binding. Throws BINDING_INVALID unless it is a forwarder-route quote for one order. */
export function bindingInfo(binding, { forwarder }) {
  const orderId = binding?.order_id;
  const depositAddress = binding?.depositAddress;
  const minAmountOut = binding?.minAmountOut ?? binding?.response?.quote?.minAmountOut;
  const r = binding?.request;
  const ok = Number.isSafeInteger(orderId) && orderId > 0 && EVM.test(depositAddress ?? '')
    && typeof minAmountOut === 'string' && UINT.test(minAmountOut) && BigInt(minAmountOut) > 0n
    && r?.recipient === forwarder && r.recipientType === 'DESTINATION_CHAIN' && r.destinationAsset === TIDEPOOL.destinationAsset
    && r.customRecipientMsg === undefined;
  if (!ok) fail('BINDING_INVALID');
  return { orderId, depositAddress, deposit: depositAddress.toLowerCase(), minAmountOut, originTx: binding.origin_tx ?? null };
}

/**
 * Find the verifier -> forwarder transfer for this deposit in the provider-linked NEAR txs.
 * `txs` = [{hash, tx}]. `taken(id)` is true when another deposit already claimed that delivery.
 */
export function findDelivery(txs, { forwarder, minAmountOut, taken = () => false, verifier = TIDEPOOL.verifier, tokenId = TIDEPOOL.destinationToken }) {
  let short = null;
  for (const { hash, tx } of txs) {
    for (const t of ftTransfers(tx, tokenId)) {
      if (t.old_owner_id !== verifier || t.new_owner_id !== forwarder) continue;
      const id = deliveryId(hash, t.receiptId);
      if (taken(id)) continue;
      if (BigInt(t.amount) >= BigInt(minAmountOut)) return { status: 'found', delivery: { id, txHash: hash, receiptId: t.receiptId, amount: t.amount } };
      short ??= t.amount;
    }
  }
  return short ? { status: 'short', amount: short } : { status: 'none' };
}

/** Fetch every provider-linked NEAR tx we can read. Unreadable hashes are skipped, never trusted. */
export async function readLinkedTxs(hashes, deps) {
  const txs = [];
  for (const h of hashes) {
    const tx = await deps.txStatus(h, TIDEPOOL.verifier).catch(() => null);
    if (tx) txs.push({ hash: h, tx });
  }
  return txs;
}
