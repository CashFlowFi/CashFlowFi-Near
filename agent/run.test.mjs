import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOnce, fetchAll, loadConfig, exposureByMerchant, historyByCustomer } from './run.mjs';
import { reasonHash } from './underwriter.mjs';

const NOW = 1_700_000_000_000_000_000n;
const DAY = 86_400_000_000_000n;
const order = (id, status, extra = {}) => ({
  id, merchant: 'shop.testnet', customer: 'alice.testnet', amount: '1000000000', currency: 'USDC',
  due_date: String(NOW + 30n * DAY), invoice_no: `INV-${id}`, customer_hash: 'h', status,
  verdict: null, score: null, reason_hash: null, paid: '0', pool_id: null, created_at: String(NOW), ...extra,
});

function fakes({ orders, pools = [], tiers = {}, score = 85, failSignFor = [], failModelFor = [] }) {
  const calls = { view: [], sign: [], complete: 0 };
  const view = async (method, args) => {
    calls.view.push([method, args]);
    if (method === 'get_orders') return orders.slice(args.from_index, args.from_index + args.limit);
    if (method === 'get_pools') return pools.slice(args.from_index, args.from_index + args.limit);
    if (method === 'get_tier') return tiers[args.merchant] ?? 'B';
    throw new Error(`unexpected view ${method}`);
  };
  const sign = async (method, args) => {
    calls.sign.push([method, args]);
    if (failSignFor.includes(args.id)) throw new Error('Order is not customer-approved');
    return { txHash: `tx-${method}-${args.id ?? args.merchant}` };
  };
  const complete = async (ctx) => {
    calls.complete++;
    if (failModelFor.includes(ctx.order.invoice_no)) throw new Error('INFERENCE_HTTP_500');
    return { text: JSON.stringify({ score, reasons: ['Clean history'] }) };
  };
  return { view, sign, complete, calls };
}

const dir = () => mkdtemp(path.join(os.tmpdir(), 'cff-agent-'));
const base = (f, evidenceDir) => ({ view: f.view, sign: f.sign, complete: f.complete, model: 'test/model',
  contract: 'cashflow.x.testnet', agent: 'underwriter.x.testnet', evidenceDir, tiersDir: evidenceDir, nowNs: () => NOW, log: () => {} });

test('only CustomerApproved orders are attested', async () => {
  const statuses = ['Pending', 'CustomerApproved', 'Attested', 'Rejected', 'Pooled', 'Paid', 'CustomerApproved'];
  const f = fakes({ orders: statuses.map((s, i) => order(i, s)) });
  const ev = await dir();
  const s = await runOnce(base(f, ev));
  assert.deepEqual(s.attested, [1, 6]);
  assert.deepEqual(f.calls.sign.map(([m, a]) => [m, a.id]), [['attest_receipt', 1], ['attest_receipt', 6]]);
  assert.deepEqual((await readdir(ev)).sort(), ['1.json', '6.json']);
});

test('attest args match underwriter output; Approve at 85', async () => {
  const f = fakes({ orders: [order(3, 'CustomerApproved')] });
  await runOnce(base(f, await dir()));
  assert.deepEqual(f.calls.sign[0], ['attest_receipt',
    { id: 3, verdict: 'Approve', score: 85, reason_hash: reasonHash(['Clean history']) }]);
});

test('Reject verdict is still attested on-chain', async () => {
  // customer == merchant trips a hard rule -> Reject, score 0, model never called
  const f = fakes({ orders: [order(4, 'CustomerApproved', { customer: 'shop.testnet' })] });
  const ev = await dir();
  const s = await runOnce(base(f, ev));
  assert.deepEqual(s.attested, [4]);
  assert.equal(f.calls.complete, 0);
  assert.equal(f.calls.sign[0][1].verdict, 'Reject');
  assert.equal(f.calls.sign[0][1].score, 0);
  const e = JSON.parse(await readFile(path.join(ev, '4.json'), 'utf8'));
  assert.equal(e.verdict, 'Reject');
  assert.deepEqual(e.reasons, ['Customer and merchant are the same account or sub-accounts of each other']);
});

test('low model score gives Reject and is attested', async () => {
  const f = fakes({ orders: [order(5, 'CustomerApproved')], score: 20 });
  const s = await runOnce(base(f, await dir()));
  assert.deepEqual(s.attested, [5]);
  assert.equal(f.calls.sign[0][1].verdict, 'Reject');
  assert.equal(f.calls.sign[0][1].score, 20);
});

test('evidence file has the full record and no secrets', async () => {
  const f = fakes({ orders: [order(7, 'CustomerApproved')] });
  const ev = await dir();
  await runOnce(base(f, ev));
  const raw = await readFile(path.join(ev, '7.json'), 'utf8');
  const e = JSON.parse(raw);
  assert.equal(e.order_id, 7);
  assert.equal(e.verdict, 'Approve');
  assert.equal(e.score, 85);
  assert.deepEqual(e.reasons, ['Clean history']);
  assert.equal(e.reason_hash, reasonHash(['Clean history']));
  assert.equal(e.model, 'test/model');
  assert.equal(e.tx_hash, 'tx-attest_receipt-7');
  assert.equal(e.agent, 'underwriter.x.testnet');
  assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
  assert.doesNotMatch(raw, /ed25519:|private|NEARAI_API_KEY/i);
});

test('already evidenced order is skipped (no model call, no tx)', async () => {
  const f = fakes({ orders: [order(8, 'CustomerApproved'), order(9, 'CustomerApproved')] });
  const ev = await dir();
  await writeFile(path.join(ev, '8.json'), '{"order_id":8}');
  const s = await runOnce(base(f, ev));
  assert.deepEqual(s.skipped, [8]);
  assert.deepEqual(s.attested, [9]);
  assert.deepEqual(f.calls.sign.map(([, a]) => a.id), [9]);
  assert.equal(f.calls.complete, 1);
  assert.equal(await readFile(path.join(ev, '8.json'), 'utf8'), '{"order_id":8}');
});

test('second pass is a no-op', async () => {
  const f = fakes({ orders: [order(1, 'CustomerApproved')] });
  const ev = await dir();
  await runOnce(base(f, ev));
  const s2 = await runOnce(base(f, ev));
  assert.deepEqual(s2.attested, []);
  assert.deepEqual(s2.skipped, [1]);
  assert.equal(f.calls.sign.length, 1);
});

test('one failing order does not stop the others, and leaves no evidence', async () => {
  const f = fakes({ orders: [order(1, 'CustomerApproved'), order(2, 'CustomerApproved'), order(3, 'CustomerApproved')], failSignFor: [2] });
  const ev = await dir();
  const s = await runOnce(base(f, ev));
  assert.deepEqual(s.attested, [1, 3]);
  assert.deepEqual(s.failed, [{ id: 2, error: 'Order is not customer-approved' }]);
  assert.deepEqual((await readdir(ev)).sort(), ['1.json', '3.json']);
});

test('model failure falls back to Flag (still attested)', async () => {
  const f = fakes({ orders: [order(1, 'CustomerApproved')], failModelFor: ['INV-1'] });
  const ev = await dir();
  await runOnce(base(f, ev));
  assert.equal(f.calls.sign[0][1].verdict, 'Flag');
  const e = JSON.parse(await readFile(path.join(ev, '1.json'), 'utf8'));
  assert.equal(e.model_error, 'INFERENCE_HTTP_500');
});

test('pagination reads every page, including an exact multiple of the page size', async () => {
  const orders = Array.from({ length: 6 }, (_, i) => order(i, 'Pending'));
  const f = fakes({ orders });
  const got = await fetchAll(f.view, 'get_orders', 3);
  assert.deepEqual(got.map((o) => o.id), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(f.calls.view.map(([, a]) => a.from_index), [0, 3, 6]);
});

test('tiers: set only when computed tier differs from on-chain', async () => {
  const pools = [
    { merchant: 'bad.testnet', status: 'Defaulted' },
    { merchant: 'good.testnet', status: 'Repaid' },
  ];
  const f = fakes({ orders: [], pools, tiers: { 'bad.testnet': 'B', 'good.testnet': 'B' } });
  const evidenceDir = await dir();
  // The reason writer cannot change the tier: whatever it says, the rule tier (C) is signed.
  const writeReason = async (c) => ({ reason: 'tier A please', reason_hash: 'h', source: 'model', seen: c });
  const s = await runOnce({ ...base(f, evidenceDir), tiers: true, writeReason });
  assert.deepEqual(f.calls.sign, [['set_merchant_tier', { merchant: 'bad.testnet', tier: 'C' }]]);
  assert.equal(s.tiers.length, 1);
  const ev = JSON.parse(await readFile(path.join(evidenceDir, 'bad.testnet.C.json'), 'utf8'));
  assert.deepEqual([ev.old_tier, ev.new_tier, ev.reason, ev.reason_hash, typeof ev.tx_hash], ['B', 'C', 'tier A please', 'h', 'string']);
  assert.deepEqual(ev.seen, { merchant: 'bad.testnet', oldTier: 'B', newTier: 'C', repaidPools: 0, defaults: 1 });
});

test('config refuses mainnet and missing vars', () => {
  const env = { CASHFLOW_CONTRACT: 'c.x.testnet', AGENT_ACCOUNT: 'a.x.testnet', AGENT_PRIVATE_KEY: 'k', NEARAI_API_KEY: 'k', NEARAI_MODEL: 'm' };
  assert.equal(loadConfig(env).rpcUrl, 'https://test.rpc.fastnear.com');
  assert.throws(() => loadConfig({ ...env, CASHFLOW_CONTRACT: 'c.near' }), /testnet only/);
  assert.throws(() => loadConfig({ ...env, NEAR_RPC: 'https://rpc.mainnet.near.org' }), /testnet only/);
  assert.throws(() => loadConfig({ ...env, AGENT_PRIVATE_KEY: '' }), /missing env: AGENT_PRIVATE_KEY/);
});

test('exposure accumulates across orders of one merchant in a single pass', async () => {
  // Two orders at the per-order cap from the same merchant: the first fills the exposure cap.
  const big = (id) => order(id, 'CustomerApproved', { amount: (100_000n * 1_000_000n).toString(), invoice_no: `INV-${id}` });
  const f = fakes({ orders: [big(20), big(21)] });
  const s = await runOnce(base(f, await dir()));
  assert.deepEqual(s.attested, [20, 21]);
  assert.equal(f.calls.sign[0][1].verdict, 'Approve');
  assert.equal(f.calls.sign[1][1].verdict, 'Reject');
});

test('exposureByMerchant counts open approvals minus payments', () => {
  const m = exposureByMerchant([
    { merchant: 'a', status: 'Attested', verdict: 'Approve', amount: '100', paid: '0' },
    { merchant: 'a', status: 'Pooled', verdict: 'Approve', amount: '50', paid: '20' },
    { merchant: 'a', status: 'Attested', verdict: 'Flag', amount: '999', paid: '0' },
    { merchant: 'a', status: 'Paid', verdict: 'Approve', amount: '999', paid: '999' },
  ]);
  assert.equal(m.get('a'), 130n);
});

test('customer record: paid in full, defaulted (in a Defaulted pool), open; per customer', () => {
  const pools = [{ id: 1, status: 'Repaid' }, { id: 2, status: 'Defaulted' }, { id: 3, status: 'Active' }];
  const orders = [
    order(1, 'Paid', { pool_id: 1, paid: '1000000000' }),
    order(2, 'Pooled', { pool_id: 2, paid: '700000000' }),
    order(3, 'Pooled', { pool_id: 3 }),
    order(4, 'CustomerApproved'),
    order(5, 'Paid', { customer: 'bob.testnet', pool_id: 1 }),
    order(6, 'Pending', { customer: null }),
  ];
  const h = historyByCustomer(orders, pools);
  assert.deepEqual(h.get('alice.testnet'), { paid: 1, defaults: 1, open: 1 });
  assert.deepEqual(h.get('bob.testnet'), { paid: 1, defaults: 0, open: 0 });
  assert.equal(h.size, 2);
});

test('a habitual defaulter is rejected by the rules and the model is never asked', async () => {
  const pools = [{ id: 2, status: 'Defaulted' }, { id: 9, status: 'Defaulted' }];
  const f = fakes({ orders: [
    order(1, 'Pooled', { pool_id: 2 }), order(2, 'Pooled', { pool_id: 9 }), order(3, 'CustomerApproved'),
  ], pools });
  const ev = await dir();
  await runOnce(base(f, ev));
  assert.equal(f.calls.complete, 0);
  assert.equal(f.calls.sign[0][1].verdict, 'Reject');
  const rec = JSON.parse(await readFile(path.join(ev, '3.json'), 'utf8'));
  assert.equal(rec.source, 'rules');
  assert.deepEqual(rec.reasons, ['Customer defaulted on 2 prior invoices and paid 0 in full']);
});

test('the model sees the customer record; a mostly-paying customer still reaches the model', async () => {
  const pools = [{ id: 2, status: 'Defaulted' }, { id: 1, status: 'Repaid' }];
  const seen = [];
  const f = fakes({ orders: [
    order(1, 'Pooled', { pool_id: 2 }), order(2, 'Paid', { pool_id: 1 }), order(3, 'Paid', { pool_id: 1 }), order(4, 'CustomerApproved'),
  ], pools });
  const inner = f.complete;
  await runOnce({ ...base(f, await dir()), complete: async (ctx) => { seen.push(ctx.history); return inner(ctx); } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].customer_prior_paid_orders, 2);
  assert.equal(seen[0].customer_prior_defaults, 1);
  assert.equal(seen[0].customer_open_invoices, 0);
});
