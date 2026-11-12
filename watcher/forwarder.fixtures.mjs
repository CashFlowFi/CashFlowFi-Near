// Shared fakes for the forwarder and API tests: NEAR tx shapes as EXPERIMENTAL_tx_status returns them.
import { forwardQuoteRequest } from './tidepool.mjs';

export const CONTRACT = 'cashflow.cfi.testnet';
export const FWD = 'payments.cfi.testnet';
export const TOKEN = 'usdc.tidepool-sandbox.testnet';
export const VERIFIER = 'verifier.tidepool-sandbox.testnet';
export const DEPOSIT = '0x0e54Cf33cEBBB71c4531C762f14E27bC29753428';
export const REFUND = '0x1903bddf6f73ee4aa8f66d170e7590d28cd3f8b9';
export const DELIVERY_TX = '93tnePQQPVsRDV4xFiQ4eeEYFUZWbQEr1YQXANatCVYC';
export const DELIVERY_RECEIPT = 'HHGCoYE7FtLRd9r84trjHMUNnj8gCPQwxfL2ULpb8qoT';
export const FORWARD_TX = 'DFvKz6CHpUqpWTHftyFQdsuECE3pDew8Wcy7quQ1fYFy';
export const NOW = 1_800_000_000;
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
const ev = (standard, event, data) => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data })}`;

/** The NEAR tx Tidepool produced for a delivery: the token logs ft_transfer from -> to. */
export function deliveryTx({ from = VERIFIER, to = FWD, amount = '595000000', executor = TOKEN, receiptId = DELIVERY_RECEIPT } = {}) {
  return { receipts: [], receipts_outcome: [
    { id: 'Cx1T37MXP1DBNHRdf9E2Z2h2HG1gG9gsXYsp63sBPWYB', outcome: { executor_id: VERIFIER, logs: [], status: { SuccessValue: '' } } },
    { id: receiptId, outcome: { executor_id: executor, logs: [ev('nep141', 'ft_transfer', [{ old_owner_id: from, new_owner_id: to, amount }])], status: { SuccessValue: '' } } },
  ] };
}

/** The forwarder's ft_transfer_call into the contract, with payment_applied and an optional surplus refund. */
export function forwardTx({ sender = FWD, orderId = 7, amount = '595000000', applied = amount, refund = '0', msgOrder = orderId, onTransferOk = true } = {}) {
  const msg = JSON.stringify({ pay: { order_id: msgOrder } });
  const contractLogs = BigInt(applied) > 0n
    ? [ev('cashflow', 'payment_applied', [{ pool_id: 1, order_id: orderId, amount: applied, senior: applied, junior: '0', merchant: '0', insurance_refill: '0' }])] : [];
  const resolveLogs = BigInt(refund) > 0n ? [ev('nep141', 'ft_transfer', [{ old_owner_id: CONTRACT, new_owner_id: sender, amount: refund, memo: 'refund' }])] : [];
  return {
    receipts: [
      { receipt_id: 'R1', predecessor_id: sender, receiver_id: TOKEN, receipt: { Action: { actions: [{ FunctionCall: {
        method_name: 'ft_transfer_call', args: b64({ receiver_id: CONTRACT, amount, msg }) } }] } } },
      { receipt_id: 'R2', predecessor_id: TOKEN, receiver_id: CONTRACT, receipt: { Action: { actions: [{ FunctionCall: {
        method_name: 'ft_on_transfer', args: b64({ sender_id: sender, amount, msg }) } }] } } },
    ],
    receipts_outcome: [
      { id: 'R1', outcome: { executor_id: TOKEN, logs: [], status: { SuccessReceiptId: 'R3' } } },
      { id: 'R2', outcome: { executor_id: CONTRACT, logs: contractLogs, status: onTransferOk ? { SuccessValue: b64(`"${refund}"`) } : { Failure: {} } } },
      { id: 'R3', outcome: { executor_id: TOKEN, logs: resolveLogs, status: { SuccessValue: b64(`"${BigInt(amount) - BigInt(refund)}"`) } } },
    ],
  };
}

export function binding(over = {}) {
  const request = forwardQuoteRequest({ forwarder: FWD, amount: '600000000', refundTo: REFUND, dry: false, now: NOW });
  return { order_id: 7, depositAddress: DEPOSIT, amountIn: '600000000', minAmountOut: '594000000', request, saved_at: new Date(NOW * 1000).toISOString(), ...over };
}

export const providerStatus = (status = 'SUCCESS', hashes = [{ hash: '0x' + 'ab'.repeat(32) }, { hash: DELIVERY_TX }]) =>
  ({ status, swapDetails: { originChainTxHashes: [{ hash: '0x' + 'cd'.repeat(32) }], destinationChainTxHashes: hashes } });

