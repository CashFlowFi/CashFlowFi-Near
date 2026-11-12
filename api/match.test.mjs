import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';

const RPC = 'http://rpc.fake';
const NOW = 1_800_000_000;
const DUE = String((BigInt(NOW) + 30n * 86_400n) * 1_000_000_000n);
const POOLS = [{ id: 1, merchant: 'm.testnet', order_ids: [3], tier: 'B', receivable: '10000000', advance: '8000000',
  senior_face: '6375000', junior_face: '2125000', senior_target: '6000000', junior_target: '2000000',
  senior_funded: '0', junior_funded: '0', status: 'Funding', due_date: DUE }];
const INTENT = 'private-intent-c41e: short senior only';

/** Fake NEAR RPC for get_pools / get_order. */
async function fetchImpl(url, init) {
  assert.equal(url, RPC);
  const { params } = JSON.parse(init.body);
  const v = params.method_name === 'get_pools' ? POOLS : { id: 3, score: 81 };
  return Response.json({ jsonrpc: '2.0', result: { result: [...Buffer.from(JSON.stringify(v))] } });
}

async function serve(t, matchChat) {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'cfi-match-'));
  const server = createServer(createApp({ contractId: 'cashflow.cfi.testnet', rpcUrl: RPC, evidenceDir, fetchImpl, now: () => NOW, matchChat }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/invest/match`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  return { post, evidenceDir };
}

/** Capture everything written to the console while `fn` runs. */
async function captureConsole(fn) {
  const out = []; const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => out.push(a.map(String).join(' ')); }
  try { return { result: await fn(), output: out.join('\n') }; } finally { Object.assign(console, saved); }
}

test('POST /api/invest/match: filtered, clamped suggestion; the intent is not stored, logged or echoed', async (t) => {
  let shown = null;
  const matchChat = async (req) => { shown = req.user; return { text: '{"ranking":[{"pool_id":1,"tranche":"Senior","amount_usdc":50,"reason":"short and senior"}]}',
    privacy: { verified_private: true } }; };
  const { post, evidenceDir } = await serve(t, matchChat);
  const { result: r, output } = await captureConsole(() => post({ intent: INTENT, filters: { tranche: 'Senior', max_usdc: 4 } }));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.deepEqual(body.suggestions, [{ rank: 1, pool_id: 1, tranche: 'Senior', amount_usdc: 4, amount: '4000000', reason: 'short and senior',
    invest_msg: '{"invest":{"pool_id":1,"tranche":"Senior"}}' }]);
  assert.equal(body.privacy.verified_private, true);
  assert.equal(JSON.parse(shown).intent, INTENT); // it reached the model ...
  assert.ok(!r.text.includes(INTENT)); // ... and nowhere else
  assert.ok(!output.includes(INTENT));
  assert.deepEqual(await readdir(evidenceDir, { recursive: true }), []);
});

test('POST /api/invest/match: no model -> fallback with an unverified privacy block', async (t) => {
  const { post } = await serve(t, null);
  const body = JSON.parse((await post({ intent: 'anything' })).text);
  assert.equal(body.source, 'fallback');
  assert.equal(body.model_error, 'MODEL_NOT_CONFIGURED');
  assert.equal(body.privacy.verified_private, false);
  assert.equal(body.suggestions.length, 2);
});

test('POST /api/invest/match: bad input is a 400 with a code, never echoing the intent', async (t) => {
  const { post } = await serve(t, null);
  const r = await post({ intent: `${INTENT}${'x'.repeat(300)}` });
  assert.deepEqual([r.status, JSON.parse(r.text)], [400, { error: 'MATCH_INTENT' }]);
  assert.equal((await post({ intent: 'x', filters: { min_tier: 'Z' } })).status, 400);
});
