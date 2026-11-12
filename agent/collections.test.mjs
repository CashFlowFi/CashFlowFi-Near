import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as realTidepool from '../watcher/tidepool.mjs';
import { createApp } from '../api/app.mjs';
import { runCollections, createApiQuoter, poolDefaultedEvent, loadConfig } from './collections.mjs';

const NOW = 1_800_000_000_000_000_000n;
const SEC = 1_000_000_000n;
const HOUR = 3600n * SEC;
const WINDOW = 72n * HOUR;
const GRACE = 300n * SEC;
const CONTRACT = 'cashflow.x.testnet';

const pool = (id, status, due, extra = {}) => ({ id, merchant: 'shop.testnet', order_ids: [], status, due_date: String(due), ...extra });
const order = (id, poolId, due, extra = {}) => ({
  id, merchant: 'shop.testnet', customer: 'alice.testnet', amount: '1000000000', currency: 'USDC', due_date: String(due),
  invoice_no: `INV-${id}`, customer_hash: 'h', status: 'Pooled', verdict: 'Approve', score: 85, reason_hash: null,
  paid: '0', pool_id: poolId, created_at: '1', ...extra,
});
const defaultedLog = (poolId, cover, needsDao) => `EVENT_JSON:${JSON.stringify({ standard: 'cashflow', version: '1.0.0',
  event: 'pool_defaulted', data: [{ pool_id: poolId, cover, needs_dao: needsDao }] })}`;

function fakes({ pools, orders = [], failSignFor = [], failQuoteFor = [] }) {
  const calls = { sign: [], quote: [] };
  const view = async (method, args) => {
    if (method === 'get_config') return { grace_ns: String(GRACE), dao_threshold: '500000', paused: false };
    if (method === 'get_pools') return pools.slice(args.from_index, args.from_index + args.limit);
    if (method === 'get_orders') return orders.slice(args.from_index, args.from_index + args.limit);
    throw new Error(`unexpected view ${method}`);
  };
  const sign = async (method, args) => {
    calls.sign.push([method, args]);
    if (failSignFor.includes(args.pool_id)) throw new Error('Grace period not over');
    return { txHash: `tx-${args.pool_id}`, logs: [defaultedLog(args.pool_id + 100, '1', true), defaultedLog(args.pool_id, '100000000', false)] };
  };
  const quote = async (orderId) => {
    calls.quote.push(orderId);
    if (failQuoteFor.includes(orderId)) throw new Error('quote 502 PAY_PROVIDER_UNAVAILABLE');
    return { depositAddress: null, amountIn: '1000000000', deadline: '2027-01-15T08:30:00.000Z', dry: true, order_id: orderId, minAmountOut: '990000000' };
  };
  return { view, sign, quote, calls };
}

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'cff-coll-'));
async function deps(f, now = NOW) {
  const root = await tmp();
  return { view: f.view, sign: f.sign, quote: f.quote, contract: CONTRACT, collector: 'collector.x.testnet',
    remindersDir: path.join(root, 'collections'), defaultsDir: path.join(root, 'defaults'),
    windowNs: WINDOW, nowNs: () => now, log: () => {} };
}
const ls = async (d) => { try { return (await readdir(d)).sort(); } catch { return []; } };

test('reminder only inside [due - window, due)', async () => {
  const far = NOW + 1000n * HOUR; // pool not near default
  const f = fakes({
    pools: [pool(1, 'Active', far)],
    orders: [
      order(10, 1, NOW + WINDOW + 1n), // 1 ns before the window opens: no
      order(11, 1, NOW + WINDOW),      // window opens exactly now: yes
      order(12, 1, NOW + 1n),          // due in 1 ns: yes
      order(13, 1, NOW),               // due now: no longer "before due"
      order(14, 1, NOW - HOUR),        // overdue, in grace: no
    ],
  });
  const d = await deps(f);
  const s = await runCollections(d);
  assert.deepEqual(s.reminded, [11, 12]);
  assert.deepEqual(f.calls.quote, [11, 12]);
  assert.deepEqual(await ls(d.remindersDir), ['11.json', '12.json']);
  assert.deepEqual(f.calls.sign, []);
});

test('reminder file has pay link, amount due and quote', async () => {
  const f = fakes({ pools: [pool(1, 'Active', NOW + HOUR)], orders: [order(7, 1, NOW + HOUR, { paid: '400000000' })] });
  const d = await deps(f);
  await runCollections({ ...d, payUrlBase: 'https://cashflow.example/pay/' });
  const raw = await readFile(path.join(d.remindersDir, '7.json'), 'utf8');
  const r = JSON.parse(raw);
  assert.equal(r.pay_url, 'https://cashflow.example/pay/7');
  assert.equal(r.amount_due, '600000000');
  assert.equal(r.pool_id, 1);
  assert.equal(r.window_start, String(NOW + HOUR - WINDOW));
  assert.equal(r.quote.dry, true);
  assert.equal(r.quote.amountIn, '1000000000');
  assert.doesNotMatch(raw, /ed25519:|private/i);
});

test('default pay url and no quote when quoting is off', async () => {
  const f = fakes({ pools: [pool(1, 'Active', NOW + HOUR)], orders: [order(3, 1, NOW + HOUR)] });
  const d = await deps(f);
  await runCollections({ ...d, quote: null, payUrlBase: undefined });
  const r = JSON.parse(await readFile(path.join(d.remindersDir, '3.json'), 'utf8'));
  assert.equal(r.pay_url, 'http://localhost:3000/pay/3');
  assert.equal(r.quote, null);
});

test('no duplicate reminder: second pass skips and does not re-quote', async () => {
  const f = fakes({ pools: [pool(1, 'Active', NOW + HOUR)], orders: [order(5, 1, NOW + HOUR)] });
  const d = await deps(f);
  await runCollections(d);
  const first = await readFile(path.join(d.remindersDir, '5.json'), 'utf8');
  const s2 = await runCollections(d);
  assert.deepEqual(s2.reminded, []);
  assert.deepEqual(s2.skipped, [{ order_id: 5 }]);
  assert.deepEqual(f.calls.quote, [5]);
  assert.equal(await readFile(path.join(d.remindersDir, '5.json'), 'utf8'), first);
});

test('paid orders get no reminder', async () => {
  const f = fakes({ pools: [pool(1, 'Active', NOW + HOUR)], orders: [
    order(1, 1, NOW + HOUR, { status: 'Paid', paid: '1000000000' }),
    order(2, 1, NOW + HOUR, { paid: '1000000000' }),
  ] });
  const s = await runCollections(await deps(f));
  assert.deepEqual(s.reminded, []);
  assert.deepEqual(f.calls.quote, []);
});

test('no default at exactly due + grace (contract needs strictly greater)', async () => {
  const due = NOW - GRACE;
  const f = fakes({ pools: [pool(4, 'Active', due)], orders: [order(40, 4, due)] });
  const d = await deps(f);
  const s = await runCollections(d);
  assert.deepEqual(f.calls.sign, []);
  assert.deepEqual(s.defaulted, []);
  assert.deepEqual(s.reminded, []); // overdue: no reminder either
  assert.deepEqual(await ls(d.defaultsDir), []);
});

test('default 1 ns after due + grace, with tx hash and cover from our event', async () => {
  const due = NOW - GRACE - 1n;
  const f = fakes({ pools: [pool(4, 'Active', due)] });
  const d = await deps(f);
  const s = await runCollections(d);
  assert.deepEqual(f.calls.sign, [['mark_default', { pool_id: 4 }]]);
  assert.deepEqual(s.defaulted, [{ pool_id: 4, txHash: 'tx-4', cover: '100000000', needs_dao: false }]);
  const e = JSON.parse(await readFile(path.join(d.defaultsDir, '4.json'), 'utf8'));
  assert.equal(e.tx_hash, 'tx-4');
  assert.equal(e.cover, '100000000'); // not the pool-104 event logged first
  assert.equal(e.needs_dao, false);
  assert.equal(e.event_found, true);
  assert.equal(e.grace_ns, String(GRACE));
});

test('already-evidenced default is not re-sent', async () => {
  const f = fakes({ pools: [pool(4, 'Active', NOW - GRACE - 1n)] });
  const d = await deps(f);
  await mkdir(d.defaultsDir, { recursive: true });
  await writeFile(path.join(d.defaultsDir, '4.json'), '{}');
  const s = await runCollections(d);
  assert.deepEqual(f.calls.sign, []);
  assert.deepEqual(s.skipped, [{ pool_id: 4 }]);
});

test('Repaid, Defaulted and Funding pools are ignored', async () => {
  const past = NOW - GRACE - HOUR; const soon = NOW + HOUR;
  const f = fakes({
    pools: [pool(1, 'Repaid', past), pool(2, 'Defaulted', past), pool(3, 'Funding', past), pool(5, 'Repaid', soon)],
    orders: [order(10, 1, past), order(20, 2, past), order(30, 3, past), order(50, 5, soon)],
  });
  const d = await deps(f);
  const s = await runCollections(d);
  assert.deepEqual(f.calls.sign, []);
  assert.deepEqual(f.calls.quote, []);
  assert.deepEqual(s, { reminded: [], defaulted: [], skipped: [], failed: [] });
});

test('one bad pool or order does not stop the others, and leaves no evidence', async () => {
  const past = NOW - GRACE - 1n; const soon = NOW + HOUR;
  const f = fakes({
    pools: [pool(1, 'Active', past), pool(2, 'Active', past), pool(3, 'Active', soon)],
    orders: [order(30, 3, soon), order(31, 3, soon), order(32, 3, soon)],
    failSignFor: [1], failQuoteFor: [31],
  });
  const d = await deps(f);
  const s = await runCollections(d);
  assert.deepEqual(s.defaulted.map((x) => x.pool_id), [2]);
  assert.deepEqual(s.reminded, [30, 32]);
  assert.deepEqual(s.failed, [
    { pool_id: 1, error: 'Grace period not over' },
    { order_id: 31, error: 'quote 502 PAY_PROVIDER_UNAVAILABLE' },
  ]);
  assert.deepEqual(await ls(d.defaultsDir), ['2.json']);
  assert.deepEqual(await ls(d.remindersDir), ['30.json', '32.json']);
});

test('pool_defaulted parser ignores other pools, events and malformed logs', () => {
  assert.equal(poolDefaultedEvent(['EVENT_JSON:{bad', 'plain log', defaultedLog(9, '5', true)], 4), null);
  assert.deepEqual(poolDefaultedEvent([defaultedLog(4, '0', false)], 4), { cover: '0', needs_dao: false });
  const other = `EVENT_JSON:${JSON.stringify({ standard: 'other', event: 'pool_defaulted', data: [{ pool_id: 4, cover: '1', needs_dao: false }] })}`;
  assert.equal(poolDefaultedEvent([other], 4), null);
});

// ---- the quoter goes through the real /api/pay/quote handler ----

function apiHandler({ poolStatus = 'Active' } = {}) {
  const RPC = 'http://rpc.fake';
  const seen = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, RPC);
    const { params } = JSON.parse(init.body);
    const v = params.method_name === 'get_order' ? order(7, 1, NOW, { paid: '400000000' }) : { id: 1, status: poolStatus };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', result: { result: [...Buffer.from(JSON.stringify(v))] } }) };
  };
  const tidepool = { ...realTidepool, fetchPayQuote: async (request, opts) => {
    seen.push({ request, opts });
    return { depositAddress: null, amountIn: request.amount, minAmountOut: '594000000', response: { quote: {} } };
  } };
  return { handler: createApp({ contractId: CONTRACT, rpcUrl: RPC, live: false, evidenceDir: os.tmpdir(), fetchImpl, tidepool, now: () => 1_800_000_000 }), seen };
}

test('quoter reuses /api/pay/quote: dry, owed amount, pay message for the order', async () => {
  const { handler, seen } = apiHandler();
  const q = await createApiQuoter({ handler, refundTo: '0x1903bddf6f73ee4aa8f66d170e7590d28cd3f8b9' })(7);
  assert.equal(q.dry, true);
  assert.equal(q.amountIn, '600000000');
  assert.equal(seen[0].request.customRecipientMsg, '{"pay":{"order_id":7}}');
  assert.equal(seen[0].opts.allowExecution, false);
});

test('quoter surfaces API refusals as errors', async () => {
  const { handler } = apiHandler({ poolStatus: 'Repaid' });
  await assert.rejects(createApiQuoter({ handler, refundTo: '0x1903bddf6f73ee4aa8f66d170e7590d28cd3f8b9' })(7), /quote 409 POOL_NOT_ACTIVE \(Repaid\)/);
});

// ---- config ----

test('config: testnet only, key from env or near-cli keychain, never echoed', async () => {
  const home = await tmp();
  const env = { CASHFLOW_CONTRACT: 'c.x.testnet', COLLECTOR_ACCOUNT: 'col.x.testnet' };
  assert.throws(() => loadConfig(env, { home }), (e) => /no key for col\.x\.testnet/.test(e.message));
  await mkdir(path.join(home, '.near-credentials', 'testnet'), { recursive: true });
  await writeFile(path.join(home, '.near-credentials', 'testnet', 'col.x.testnet.json'),
    JSON.stringify({ account_id: 'col.x.testnet', public_key: 'ed25519:pub', private_key: 'ed25519:FILEKEY' }));
  const c = loadConfig(env, { home });
  assert.equal(c.privateKey, 'ed25519:FILEKEY');
  assert.equal(c.windowNs, 259_200n * SEC);
  assert.equal(c.payUrlBase, 'http://localhost:3000/pay');
  assert.equal(c.refundTo, null);
  assert.equal(c.live, false);
  assert.equal(loadConfig({ ...env, COLLECTOR_PRIVATE_KEY: 'ed25519:ENVKEY' }, { home }).privateKey, 'ed25519:ENVKEY');
  assert.throws(() => loadConfig({ ...env, COLLECTOR_ACCOUNT: 'col.near' }, { home }), /testnet only/);
  assert.throws(() => loadConfig({ ...env, NEAR_RPC: 'https://rpc.mainnet.near.org' }, { home }), /testnet only/);
  assert.throws(() => loadConfig({ CASHFLOW_CONTRACT: 'c.x.testnet' }, { home }), /missing env: COLLECTOR_ACCOUNT/);
  assert.throws(() => loadConfig({ ...env, COLLECTIONS_REFUND_TO: '0x' + '0'.repeat(40) }, { home }), /COLLECTIONS_REFUND_TO/);
});
