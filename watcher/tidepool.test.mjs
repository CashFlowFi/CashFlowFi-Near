import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardQuoteRequest, payQuoteRequest, validatePayQuote, classifyPayment, nearDestinationHashes, payMessage, TIDEPOOL } from './tidepool.mjs';

const base = { contractId: 'cashflow.cfi.testnet', orderId: 7, amount: '1000000000', refundTo: '0x1903bddf6f73ee4aa8f66d170e7590d28cd3f8b9', now: 1_800_000_000 };

test('builds a NEAR-destination quote that calls ft_transfer_call with the pay message', () => {
  const r = payQuoteRequest(base);
  assert.equal(r.recipient, 'cashflow.cfi.testnet');
  assert.equal(r.recipientType, 'DESTINATION_CHAIN');
  assert.equal(r.destinationAsset, 'nep141:usdc.tidepool-sandbox.testnet');
  assert.equal(r.customRecipientMsg, '{"pay":{"order_id":7}}');
  assert.equal(r.deadline, new Date((base.now + 1800) * 1000).toISOString());
  assert.equal(r.dry, true);
});

test('rejects bad inputs', () => {
  assert.throws(() => payQuoteRequest({ ...base, contractId: 'cashflow.near' }), /PAY_CONTRACT/);
  assert.throws(() => payQuoteRequest({ ...base, refundTo: '0x' + '0'.repeat(40) }), /PAY_REFUND_ADDRESS/);
  assert.throws(() => payQuoteRequest({ ...base, amount: '0' }), /PAY_AMOUNT/);
  assert.throws(() => payQuoteRequest({ ...base, origin: 'eth-mainnet' }), /PAY_UNSUPPORTED_ORIGIN/);
  assert.throws(() => payMessage(0), /PAY_ORDER_ID/);
});

test('an unsigned or altered quote is refused', () => {
  const request = payQuoteRequest(base);
  const response = { quoteRequest: request, quote: { amountIn: base.amount, amountOut: '999000000', minAmountOut: '990000000' }, timestamp: new Date(base.now * 1000).toISOString(), signature: 'ed25519:1111' };
  assert.throws(() => validatePayQuote(response, request, { now: base.now }), /PAY_SIGNATURE/);
  const altered = { ...response, quoteRequest: { ...request, recipient: 'attacker.testnet' } };
  assert.throws(() => validatePayQuote(altered, request, { now: base.now }), /PAY_REQUEST_CHANGED/);
});

test('NEAR hashes are picked out of a mixed destination list', () => {
  const near = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  const evm = '0x' + 'ab'.repeat(32);
  assert.deepEqual(nearDestinationHashes({ swapDetails: { destinationChainTxHashes: [{ hash: evm }, { hash: near }] } }), [near]);
});

test('provider SUCCESS alone is not delivery', () => {
  const request = payQuoteRequest(base);
  assert.equal(classifyPayment({ status: { status: 'SUCCESS' }, request }).outcome, 'pending');
  assert.equal(classifyPayment({ status: { status: 'PROCESSING' }, request }).outcome, 'pending');
  assert.equal(classifyPayment({ status: { status: 'REFUNDED', refundReason: 'deadline' }, request }).outcome, 'refunded');
  assert.equal(classifyPayment({ status: { status: 'FAILED' }, request }).outcome, 'failed');
});

test('delivered only when our NEAR receipt matches exactly', () => {
  const request = payQuoteRequest(base);
  const good = {
    found: true, success: true, receiverId: TIDEPOOL.destinationToken, method: 'ft_transfer_call',
    args: { receiver_id: 'cashflow.cfi.testnet', msg: request.customRecipientMsg },
    logs: ['EVENT_JSON:{"standard":"cashflow","event":"payment_applied","data":[{}]}'],
  };
  assert.equal(classifyPayment({ status: { status: 'SUCCESS' }, request, nearReceipt: good }).outcome, 'delivered');
  const wrongMsg = { ...good, args: { ...good.args, msg: '{"pay":{"order_id":8}}' } };
  assert.equal(classifyPayment({ status: { status: 'SUCCESS' }, request, nearReceipt: wrongMsg }).outcome, 'ambiguous');
  const noEvent = { ...good, logs: [] };
  assert.equal(classifyPayment({ status: { status: 'SUCCESS' }, request, nearReceipt: noEvent }).outcome, 'ambiguous');
});

test('forwarder route: plain delivery to the forwarder, no msg; validated as purpose forward', () => {
  const r = forwardQuoteRequest({ forwarder: 'payments.cfi.testnet', amount: '1000000', refundTo: base.refundTo, now: base.now });
  assert.equal(r.recipient, 'payments.cfi.testnet');
  assert.equal('customRecipientMsg' in r, false);
  const response = { quoteRequest: r, quote: { amountIn: '1000000', amountOut: '999000', minAmountOut: '990000' }, timestamp: new Date(base.now * 1000).toISOString(), signature: 'ed25519:1111' };
  assert.throws(() => validatePayQuote(response, r, { now: base.now, purpose: 'nope' }), /PAY_PURPOSE/);
});
