import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, processDeposit, runOnce, findDelivery, bindingInfo } from './forwarder.mjs';
import { NOW, CONTRACT, FWD, TOKEN, VERIFIER, DELIVERY_TX, DELIVERY_RECEIPT, FORWARD_TX, deliveryTx, forwardTx, binding, providerStatus } from './forwarder.fixtures.mjs';

/** Fake chain + provider around a real file store in a temp dir. */
async function harness({ status = providerStatus(), delivery = deliveryTx(), forward = forwardTx(), order = { status: 'Pooled' },
  balance = '595000000', sendThrows = false, lookupFound = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cfi-fwd-'));
  const sent = []; const signed = [];
  const deps = {
    config: { contractId: CONTRACT, forwarder: FWD, tokenId: TOKEN },
    store: createFileStore(dir),
    fetchStatus: async () => status,
    txStatus: async (h, sender) => { assert.equal(sender, VERIFIER); if (h === DELIVERY_TX) return delivery; throw new Error('unknown'); },
    lookupTx: async (h, sender) => { assert.equal(sender, FWD); return h === FORWARD_TX && lookupFound && sent.length ? forward : null; },
    viewOrder: async () => order,
    ftBalance: async () => balance,
    signForward: async (args) => {
      signed.push(args);
      return { hash: FORWARD_TX, signedBase64: 'c2lnbmVk', send: async () => { if (sendThrows) throw new Error('timeout'); sent.push(args); } };
    },
    now: () => NOW,
  };
  return { dir, deps, sent, signed };
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('verifier -> forwarder delivery is forwarded once with the pay msg and the exact delivered amount', async () => {
  const h = await harness();
  const r = await processDeposit(binding(), h.deps);
  assert.equal(r.outcome, 'delivered');
  assert.deepEqual(h.sent, [{ amount: '595000000', msg: '{"pay":{"order_id":7}}' }]);
  assert.equal(r.record.forward_tx, FORWARD_TX);
  assert.equal(r.record.delivery_tx, DELIVERY_TX);
  assert.equal(r.record.applied_amount, '595000000');
  const pay = await readJson(join(h.dir, 'payments', '7.json'));
  assert.equal(pay.payments.length, 1);
  assert.equal(pay.payments[0].stage, 'delivered');
  assert.equal(pay.payments[0].forward_signed_tx, undefined); // signed bytes stay in the claim only
  const ledger = (await readFile(join(h.dir, 'ledger', 'payments.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((x) => [x.order_id, x.amount, x.near_tx]), [[7, '595000000', FORWARD_TX]]);
});

test('double run forwards once (second run and runOnce see the finished record)', async () => {
  const h = await harness();
  await processDeposit(binding(), h.deps);
  const again = await processDeposit(binding(), h.deps);
  assert.equal(again.outcome, 'delivered');
  await h.deps.store.saveBinding(binding());
  assert.deepEqual(await runOnce(h.deps), []);
  assert.equal(h.sent.length, 1);
  assert.equal(h.signed.length, 1);
  assert.equal((await readFile(join(h.dir, 'ledger', 'payments.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('a delivery claimed by another deposit is not forwarded again', async () => {
  const h = await harness();
  await processDeposit(binding(), h.deps);
  const other = binding({ depositAddress: '0x' + '11'.repeat(20) }); // provider points a second deposit at the same NEAR tx
  const r = await processDeposit(other, h.deps);
  assert.equal(r.outcome, 'ambiguous');
  assert.match(r.record.reason, /NO_VERIFIER_TO_FORWARDER_TRANSFER/);
  assert.equal(h.sent.length, 1);
});

test('crash after the claim: a marker without a result blocks resend; it resolves only from the recorded hash', async () => {
  const h = await harness({ sendThrows: true });
  const r = await processDeposit(binding(), h.deps);
  assert.equal(r.outcome, 'forwarding');
  assert.match(r.record.reason, /FORWARD_TX_NOT_FOUND/);
  const files = await readdir(join(h.dir, 'forwards'));
  assert.deepEqual(files, [`${DELIVERY_TX}-${DELIVERY_RECEIPT}.json`]);
  const claim = await readJson(join(h.dir, 'forwards', files[0]));
  assert.deepEqual([claim.stage, claim.forward_tx], ['forwarding', FORWARD_TX]);
  for (let i = 0; i < 3; i++) assert.equal((await processDeposit(binding(), h.deps)).outcome, 'forwarding');
  assert.equal(h.signed.length, 1); // never re-signed
  assert.equal(h.sent.length, 0);
  // The tx turns out to have landed: the next run completes from the recorded hash, still without sending.
  h.sent.push('landed-elsewhere');
  const done = await processDeposit(binding(), h.deps);
  assert.equal(done.outcome, 'delivered');
  assert.equal(h.signed.length, 1);
});

test('only verifier -> forwarder transfers emitted by the token count', async () => {
  for (const [name, delivery] of [
    ['from another account', deliveryTx({ from: 'mallory.testnet' })],
    ['to another account', deliveryTx({ to: 'mallory.testnet' })],
    ['logged by a look-alike contract', deliveryTx({ executor: 'fake-usdc.testnet' })],
  ]) {
    const h = await harness({ delivery });
    const r = await processDeposit(binding(), h.deps);
    assert.equal(r.outcome, 'ambiguous', name);
    assert.equal(h.signed.length, 0, name);
  }
});

test('delivery below minAmountOut is ambiguous and not forwarded', async () => {
  const h = await harness({ delivery: deliveryTx({ amount: '593999999' }) });
  const r = await processDeposit(binding(), h.deps);
  assert.equal(r.outcome, 'ambiguous');
  assert.match(r.record.reason, /DELIVERY_BELOW_MIN/);
  assert.equal(h.signed.length, 0);
  const exact = await harness({ delivery: deliveryTx({ amount: '594000000' }), forward: forwardTx({ amount: '594000000' }), balance: '594000000' });
  assert.equal((await processDeposit(binding(), exact.deps)).outcome, 'delivered');
});

test('forward counts only with payment_applied for that order id from the contract', async () => {
  for (const [name, forward] of [
    ['payment_applied for another order', forwardTx({ orderId: 8, msgOrder: 7 })],
    ['no payment_applied (contract refunded all)', forwardTx({ applied: '0', refund: '595000000' })],
    ['ft_on_transfer failed', forwardTx({ onTransferOk: false })],
    ['msg for another order', forwardTx({ msgOrder: 8 })],
  ]) {
    const h = await harness({ forward });
    const r = await processDeposit(binding(), h.deps);
    assert.equal(r.outcome, 'failed', name);
    await assert.rejects(readFile(join(h.dir, 'ledger', 'payments.jsonl')), { code: 'ENOENT' }, name);
  }
});

test('surplus refunded by the contract is recorded', async () => {
  const h = await harness({ forward: forwardTx({ applied: '500000000', refund: '95000000' }) });
  const r = await processDeposit(binding(), h.deps);
  assert.equal(r.outcome, 'delivered');
  assert.equal(r.record.applied_amount, '500000000');
  assert.equal(r.record.surplus_refunded_to_forwarder, '95000000');
});

test('provider states, order not payable, low forwarder balance, read-only mode', async () => {
  const pend = await harness({ status: providerStatus('PROCESSING') });
  assert.equal((await processDeposit(binding(), pend.deps)).outcome, 'pending');
  const refunded = await harness({ status: providerStatus('REFUNDED') });
  assert.equal((await processDeposit(binding(), refunded.deps)).outcome, 'refunded');
  const held = await harness({ order: { status: 'Paid' } });
  assert.equal((await processDeposit(binding(), held.deps)).outcome, 'held');
  assert.equal(held.signed.length, 0);
  const low = await harness({ balance: '1' });
  assert.equal((await processDeposit(binding(), low.deps)).outcome, 'ambiguous');
  assert.equal(low.signed.length, 0);
  const ro = await harness();
  assert.equal((await processDeposit(binding(), ro.deps, { forward: false })).outcome, 'ready');
  assert.equal(ro.signed.length, 0);
  await assert.rejects(readdir(join(ro.dir, 'payments')), { code: 'ENOENT' });
});

test('bindings must be forwarder-route quotes', () => {
  assert.throws(() => bindingInfo(binding({ request: { ...binding().request, recipient: CONTRACT } }), { forwarder: FWD }), /BINDING_INVALID/);
  assert.throws(() => bindingInfo(binding({ request: { ...binding().request, customRecipientMsg: '{"pay":{"order_id":7}}' } }), { forwarder: FWD }), /BINDING_INVALID/);
  assert.throws(() => bindingInfo(binding({ minAmountOut: undefined }), { forwarder: FWD }), /BINDING_INVALID/);
  assert.equal(findDelivery([], { forwarder: FWD, minAmountOut: '1' }).status, 'none');
});

test('two concurrent runs on one store: the exclusive claim lets only one send', async () => {
  const h = await harness();
  const rs = await Promise.all([processDeposit(binding(), h.deps), processDeposit(binding(), h.deps), processDeposit(binding(), h.deps)]);
  assert.equal(h.sent.length, 1);
  assert.equal(rs.filter((r) => r.outcome === 'delivered').length, 1);
  assert.equal(rs.filter((r) => r.record?.reason === 'CLAIMED_BY_ANOTHER_RUN').length, 2);
});
