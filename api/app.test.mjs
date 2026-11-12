import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realTidepool from '../watcher/tidepool.mjs';
import { reasonHash } from '../agent/underwriter.mjs';
import { createApp } from './app.mjs';

const CONTRACT = 'cashflow.cfi.testnet';
const RPC = 'http://rpc.fake';
const TOKEN = 'usdc.tidepool-sandbox.testnet';
const VERIFIER = 'verifier.tidepool-sandbox.testnet';
const REFUND = '0x1903bddf6f73ee4aa8f66d170e7590d28cd3f8b9';
const DEPOSIT = '0x0e54Cf33cEBBB71c4531C762f14E27bC29753428';
const NEAR_HASH = '93tnePQQPVsRDV4xFiQ4eeEYFUZWbQEr1YQXANatCVYC';
const EVM_HASH = '0x' + 'ab'.repeat(32);
const NOW = 1_800_000_000;
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');

const order = (o = {}) => ({ id: 7, merchant: 'm.testnet', customer: 'c.testnet', amount: '1000000000', currency: 'USDC',
  due_date: '1', invoice_no: 'INV-7', customer_hash: 'h', status: 'Pooled', verdict: 'Approve', score: 82,
  reason_hash: null, paid: '400000000', pool_id: 1, created_at: '1', ...o });

function payTx({ onTransferOk = true, logExecutor = CONTRACT, orderId = 7 } = {}) {
  const log = `EVENT_JSON:${JSON.stringify({ standard: 'cashflow', version: '1.0.0', event: 'payment_applied',
    data: [{ pool_id: 1, order_id: orderId, amount: '600000000', senior: '600000000', junior: '0', merchant: '0', insurance_refill: '0' }] })}`;
  return {
    status: { SuccessValue: '' },
    receipts: [
      { receipt_id: 'R1', predecessor_id: VERIFIER, receiver_id: TOKEN, receipt: { Action: { actions: [{ FunctionCall: {
        method_name: 'ft_transfer_call', args: b64({ receiver_id: CONTRACT, amount: '600000000', msg: '{"pay":{"order_id":7}}' }) } }] } } },
      { receipt_id: 'R2', predecessor_id: TOKEN, receiver_id: CONTRACT, receipt: { Action: { actions: [{ FunctionCall: {
        method_name: 'ft_on_transfer', args: b64({ sender_id: VERIFIER, amount: '600000000', msg: '{"pay":{"order_id":7}}' }) } }] } } },
    ],
    receipts_outcome: [
      { id: 'R1', outcome: { executor_id: TOKEN, logs: [], status: { SuccessReceiptId: 'R3' } } },
      { id: 'R2', outcome: { executor_id: logExecutor, logs: [log],
        status: onTransferOk ? { SuccessValue: b64('"0"') } : { Failure: { ActionError: {} } } } },
    ],
  };
}

/** Fake network: NEAR RPC + Tidepool. Records every call. */
function fakeNet({ orders = { 7: order() }, pool = { id: 1, status: 'Active' }, status = null, tx = payTx(), quoteBody = null } = {}) {
  const calls = [];
  const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    if (url === RPC) {
      const { method, params } = JSON.parse(init.body);
      calls.push({ rpc: method, params });
      if (method === 'query') {
        const args = JSON.parse(Buffer.from(params.args_base64, 'base64'));
        const v = params.method_name === 'get_order' ? (orders[args.id] ?? null) : params.method_name === 'get_pool' ? pool : null;
        return json({ jsonrpc: '2.0', result: { result: [...Buffer.from(JSON.stringify(v))] } });
      }
      if (method === 'EXPERIMENTAL_tx_status') return json({ jsonrpc: '2.0', result: tx });
    }
    calls.push({ url });
    if (url.includes('/v0/status')) return json(status);
    if (url.endsWith('/v0/quote')) return json(quoteBody);
    throw new Error('unexpected url ' + url);
  };
  return { fetchImpl, calls };
}

async function serve(t, opts) {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'cfi-api-'));
  const app = createApp({ contractId: CONTRACT, rpcUrl: RPC, live: false, evidenceDir, now: () => NOW, ...opts });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, init) => {
    const r = await fetch(base + path, init);
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };
  const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { call, post, evidenceDir };
}

// Stub only the network+signature step of the quote; payQuoteRequest etc. stay real.
function stubQuote(record) {
  return { ...realTidepool, fetchPayQuote: async (request, opts) => {
    record.push({ request, opts });
    return { response: { quote: { deadline: request.dry ? undefined : '2027-01-15T08:30:00.000Z' } }, signatureVerified: true,
      depositAddress: request.dry ? null : DEPOSIT, amountIn: request.amount, minAmountOut: '590000000' };
  } };
}

const quoteBody = { order_id: 7, origin_asset: 'arb-sepolia-usdc', refund_to: REFUND };

test('quote: owed = amount - paid, dry by default, execution not allowed', async (t) => {
  const net = fakeNet(); const rec = [];
  const { post } = await serve(t, { fetchImpl: net.fetchImpl, tidepool: stubQuote(rec) });
  const r = await post('/api/pay/quote', quoteBody);
  assert.equal(r.status, 200);
  assert.equal(rec[0].request.amount, '600000000'); // not the full 1000000000
  assert.equal(rec[0].request.dry, true);
  assert.equal(rec[0].opts.allowExecution, false);
  assert.equal(rec[0].request.customRecipientMsg, '{"pay":{"order_id":7}}');
  assert.deepEqual(r.body, { depositAddress: null, amountIn: '600000000', deadline: rec[0].request.deadline, dry: true, order_id: 7, minAmountOut: '590000000' });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('quote: live mode asks for a real quote and saves it for status checks', async (t) => {
  const net = fakeNet(); const rec = [];
  const { post, evidenceDir } = await serve(t, { fetchImpl: net.fetchImpl, tidepool: stubQuote(rec), live: true });
  const r = await post('/api/pay/quote', { ...quoteBody, origin_asset: realTidepool.TIDEPOOL.origins['arb-sepolia-usdc'].asset });
  assert.equal(r.status, 200);
  assert.equal(rec[0].request.dry, false);
  assert.equal(rec[0].opts.allowExecution, true);
  assert.equal(r.body.depositAddress, DEPOSIT);
  assert.equal(r.body.deadline, '2027-01-15T08:30:00.000Z');
  const saved = JSON.parse(await readFile(join(evidenceDir, 'quotes', DEPOSIT.toLowerCase() + '.json'), 'utf8'));
  assert.equal(saved.order_id, 7);
  assert.equal(saved.request.amount, '600000000');
});

test('quote: input and state errors', async (t) => {
  const net = fakeNet({ orders: { 7: order(), 8: order({ id: 8, status: 'Attested', pool_id: null }), 9: order({ id: 9, paid: '1000000000' }) } });
  const { post, call } = await serve(t, { fetchImpl: net.fetchImpl, tidepool: stubQuote([]) });
  const cases = [
    [{ ...quoteBody, refund_to: '0x123' }, 400, 'PAY_REFUND_ADDRESS'],
    [{ ...quoteBody, order_id: 0 }, 400, 'ORDER_ID'],
    [{ ...quoteBody, order_id: '7; rm' }, 400, 'ORDER_ID'],
    [{ ...quoteBody, origin_asset: 'eth-mainnet' }, 400, 'PAY_UNSUPPORTED_ORIGIN'],
    [{ ...quoteBody, order_id: 99 }, 404, 'ORDER_NOT_FOUND'],
    [{ ...quoteBody, order_id: 8 }, 409, 'ORDER_NOT_PAYABLE'],
    [{ ...quoteBody, order_id: 9 }, 409, 'ORDER_ALREADY_PAID'],
  ];
  for (const [body, code, err] of cases) {
    const r = await post('/api/pay/quote', body);
    assert.deepEqual([r.status, r.body.error], [code, err], JSON.stringify(body));
  }
  const notJson = await call('/api/pay/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.deepEqual([notJson.status, notJson.body.error], [400, 'BODY_NOT_JSON']);
});

test('quote: pool not active is refused', async (t) => {
  const net = fakeNet({ pool: { id: 1, status: 'Funding' } });
  const { post } = await serve(t, { fetchImpl: net.fetchImpl, tidepool: stubQuote([]) });
  const r = await post('/api/pay/quote', quoteBody);
  assert.deepEqual([r.status, r.body.error], [409, 'POOL_NOT_ACTIVE']);
});

test('quote: real watcher module rejects an unsigned provider answer with 502', async (t) => {
  const net = fakeNet({ quoteBody: null });
  // The real fetchPayQuote validates the echo + ed25519 signature; a fake provider cannot sign, so it must fail.
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/v0/quote')) {
      const request = JSON.parse(init.body);
      const body = { quoteRequest: request, quote: { amountIn: request.amount, amountOut: request.amount, minAmountOut: request.amount },
        timestamp: new Date().toISOString(), signature: 'ed25519:' + '1'.repeat(64) };
      return { ok: true, text: async () => JSON.stringify(body) };
    }
    return net.fetchImpl(url, init);
  };
  const { post } = await serve(t, { fetchImpl, now: () => Math.floor(Date.now() / 1000) });
  const r = await post('/api/pay/quote', quoteBody);
  assert.deepEqual([r.status, r.body.error], [502, 'PAY_SIGNATURE']);
});

function providerStatus(st = 'SUCCESS') {
  const request = realTidepool.payQuoteRequest({ contractId: CONTRACT, orderId: 7, amount: '600000000', refundTo: REFUND, dry: false, now: NOW });
  return { status: st, quoteResponse: { quoteRequest: request },
    swapDetails: { originChainTxHashes: [{ hash: '0x' + 'cd'.repeat(32) }], destinationChainTxHashes: [{ hash: EVM_HASH }, { hash: NEAR_HASH }] } };
}

test('status: verified NEAR delivery is recorded once; RPC sees only the NEAR hash', async (t) => {
  const net = fakeNet({ status: providerStatus() });
  const { call, evidenceDir } = await serve(t, { fetchImpl: net.fetchImpl });
  const r = await call(`/api/pay/status?depositAddress=${DEPOSIT}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'delivered', originTx: '0x' + 'cd'.repeat(32), destinationTx: NEAR_HASH, nearTx: NEAR_HASH, evidence: 'provider-linked-near-receipt' });
  const txCalls = net.calls.filter((c) => c.rpc === 'EXPERIMENTAL_tx_status');
  assert.deepEqual(txCalls.map((c) => c.params.tx_hash), [NEAR_HASH]);
  await call(`/api/pay/status?depositAddress=${DEPOSIT}`); // poll again: no duplicate row
  const rows = (await readFile(join(evidenceDir, 'ledger', 'payments.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_id, 7);
  assert.equal(rows[0].amount, '600000000');
  const ev = JSON.parse(await readFile(join(evidenceDir, 'payments', '7.json'), 'utf8'));
  assert.equal(ev.payments.length, 1);
  assert.equal(ev.payments[0].ft_on_transfer_receipt, 'R2');
});

for (const [name, tx, why] of [
  ['ft_on_transfer failed', payTx({ onTransferOk: false }), 'ambiguous'],
  ['payment_applied logged by another account', payTx({ logExecutor: 'evil.testnet' }), 'ambiguous'],
  ['payment_applied for a different order', payTx({ orderId: 8 }), 'ambiguous'],
]) {
  test(`status: provider SUCCESS but ${name} -> not delivered, nothing recorded`, async (t) => {
    const net = fakeNet({ status: providerStatus(), tx });
    const { call, evidenceDir } = await serve(t, { fetchImpl: net.fetchImpl });
    const r = await call(`/api/pay/status?depositAddress=${DEPOSIT}`);
    assert.equal(r.body.status, why);
    assert.equal(r.body.nearTx, null);
    await assert.rejects(readFile(join(evidenceDir, 'ledger', 'payments.jsonl')), { code: 'ENOENT' });
  });
}

test('status: pending provider state skips the RPC; bad address and foreign quotes are refused', async (t) => {
  const net = fakeNet({ status: providerStatus('PROCESSING') });
  const { call } = await serve(t, { fetchImpl: net.fetchImpl });
  const r = await call(`/api/pay/status?depositAddress=${DEPOSIT}`);
  assert.equal(r.body.status, 'pending');
  assert.equal(net.calls.some((c) => c.rpc === 'EXPERIMENTAL_tx_status'), false);
  const badAddr = await call('/api/pay/status?depositAddress=../../etc');
  assert.deepEqual([badAddr.status, badAddr.body.error], [400, 'PAY_DEPOSIT_ADDRESS']);

  const foreign = providerStatus(); foreign.quoteResponse.quoteRequest.recipient = 'someone-else.testnet';
  const net2 = fakeNet({ status: foreign });
  const s2 = await serve(t, { fetchImpl: net2.fetchImpl });
  const r2 = await s2.call(`/api/pay/status?depositAddress=${DEPOSIT}`);
  assert.deepEqual([r2.status, r2.body.error], [404, 'QUOTE_UNKNOWN']);
});

test('verdicts: chain verdict, reasons only when they match the on-chain hash, no privacy claim', async (t) => {
  const reasons = ['Repeat customer', 'Short tenor'];
  const net = fakeNet({ orders: { 7: order({ reason_hash: reasonHash(reasons) }), 8: order({ id: 8, reason_hash: reasonHash(['x']) }), 9: order({ id: 9, verdict: null, score: null }) } });
  const { call, evidenceDir } = await serve(t, { fetchImpl: net.fetchImpl });
  await mkdir(join(evidenceDir, 'attestations'), { recursive: true });
  const file = { order_id: 7, verdict: 'Approve', score: 82, reasons, reason_hash: reasonHash(reasons), model: 'Qwen/Qwen3.6-35B-A3B-FP8', tx_hash: NEAR_HASH };
  await writeFile(join(evidenceDir, 'attestations', '7.json'), JSON.stringify(file));
  await writeFile(join(evidenceDir, 'attestations', '8.json'), JSON.stringify({ ...file, order_id: 8 }));

  const r = await call('/api/agent/verdicts?order_id=7');
  assert.deepEqual(r.body, { verdict: 'Approve', score: 82, reasons, attestation: { verified: false, model: 'Qwen/Qwen3.6-35B-A3B-FP8', report_url: null } });
  const tampered = await call('/api/agent/verdicts?order_id=8');
  assert.deepEqual(tampered.body.reasons, []);
  const notYet = await call('/api/agent/verdicts?order_id=9');
  assert.deepEqual([notYet.status, notYet.body.error], [404, 'NOT_ATTESTED']);
  const bad = await call('/api/agent/verdicts?order_id=abc');
  assert.deepEqual([bad.status, bad.body.error], [400, 'ORDER_ID']);
});

test('ledger: JSON rows and CSV with escaping', async (t) => {
  const { call, evidenceDir } = await serve(t, { fetchImpl: fakeNet().fetchImpl });
  assert.deepEqual((await call('/api/ledger/payments')).body, []);
  await mkdir(join(evidenceDir, 'ledger'), { recursive: true });
  const rows = [{ recorded_at: 't', order_id: 7, amount: '600000000', deposit_address: DEPOSIT, origin_tx: '=HYPERLINK("x")', near_tx: NEAR_HASH, evidence: 'a,b' }];
  await writeFile(join(evidenceDir, 'ledger', 'payments.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual((await call('/api/ledger/payments')).body, rows);
  const csv = await call('/api/ledger/payments?format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.equal(csv.body, `recorded_at,order_id,amount,deposit_address,origin_tx,near_tx,evidence\nt,7,600000000,${DEPOSIT},"'=HYPERLINK(""x"")",${NEAR_HASH},"a,b"\n`);
  assert.equal((await call('/api/ledger/payments?format=xml')).status, 400);
});

test('routing: CORS preflight, 404, 405, missing contract config', async (t) => {
  const { call } = await serve(t, { fetchImpl: fakeNet().fetchImpl });
  const pre = await call('/api/pay/quote', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/api/pay/quote')).status, 405);
  const s = await serve(t, { fetchImpl: fakeNet().fetchImpl, contractId: '' });
  const r = await s.call('/api/agent/verdicts?order_id=7');
  assert.deepEqual([r.status, r.body.error], [503, 'CASHFLOW_CONTRACT_NOT_SET']);
});
