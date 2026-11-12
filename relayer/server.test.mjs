// HTTP handler end to end, server config, relayer key loading and client encoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, encodeSignedDelegate } from 'near-api-js';
import { createRelayHandler } from './relay.mjs';
import { encodeSignedDelegateBase64, functionCall, signDelegate, submitToRelayer } from './client.mjs';
import { loadConfig, loadRelayerKey, nearToYocto } from './server.mjs';
import { CONTRACT, TOKEN, RELAYER, SENDER, signer, delegate, fakeChain, relayerFor } from './relay.fixtures.mjs';

// ---------- HTTP ----------

async function serve(relayer) {
  const server = createServer(createRelayHandler(relayer));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

test('HTTP: POST /relay via client.submitToRelayer, JSON errors, health, CORS', async () => {
  const chain = fakeChain();
  const s = await serve(relayerFor(chain));
  try {
    const out = await submitToRelayer(s.url, await delegate());
    assert.deepEqual(out, { txHash: 'tx1', status: 'success' });

    await assert.rejects(submitToRelayer(s.url, await delegate({ receiverId: 'evil.testnet' })),
      (e) => e.message === 'RECEIVER_NOT_ALLOWED' && e.status === 403 && e.detail === 'evil.testnet');

    const h = await fetch(`${s.url}/relay/health`);
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('access-control-allow-origin'), '*');
    const body = await h.json();
    assert.equal(body.relayer, RELAYER);
    assert.equal(body.network, 'testnet');
    assert.ok(!JSON.stringify(body).includes('ed25519:'));

    const wrongType = await fetch(`${s.url}/relay`, { method: 'POST', body: '{}' });
    assert.equal(wrongType.status, 415);
    const notJson = await fetch(`${s.url}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.deepEqual(await notJson.json(), { error: 'BODY_NOT_JSON' });
    assert.equal((await fetch(`${s.url}/relay`)).status, 405);
    assert.equal((await fetch(`${s.url}/nope`)).status, 404);
    assert.equal((await fetch(`${s.url}/relay`, { method: 'OPTIONS' })).status, 204);
  } finally { await s.close(); }
});

// ---------- config ----------

const ENV = { CASHFLOW_CONTRACT: CONTRACT, USDC_TOKEN: TOKEN, RELAYER_ACCOUNT: RELAYER, NEAR_NETWORK: 'testnet' };

test('config is testnet only and parses limits', () => {
  const c = loadConfig({ ...ENV, RELAYER_SPEND_CAP_NEAR: '0.5', RELAYER_RATE_LIMIT: '3' });
  assert.equal(c.spendCapYocto, 5n * 10n ** 23n);
  assert.equal(c.rateLimit, 3);
  assert.throws(() => loadConfig({ ...ENV, RELAYER_ACCOUNT: 'relayer.near' }), /testnet only/);
  assert.throws(() => loadConfig({ ...ENV, NEAR_RPC: 'https://rpc.mainnet.near.org' }), /testnet only/);
  assert.throws(() => loadConfig({ ...ENV, NEAR_NETWORK: 'mainnet' }), /testnet only/);
  assert.throws(() => loadConfig({ ...ENV, USDC_TOKEN: '' }), /missing env: USDC_TOKEN/);
  assert.throws(() => loadConfig({ ...ENV, RELAYER_RATE_LIMIT: '0' }), /positive integer/);
  assert.equal(nearToYocto('1.000000000000000000000001'), 10n ** 24n + 1n);
  assert.throws(() => nearToYocto('1e3'));
});

test('relayer key: env first, then ~/.near-credentials/testnet/<account>.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cff-relayer-'));
  assert.throws(() => loadRelayerKey(RELAYER, {}, home), /no relayer key/);
  await mkdir(join(home, '.near-credentials', 'testnet'), { recursive: true });
  const key = KeyPair.fromRandom('ed25519').toString();
  await writeFile(join(home, '.near-credentials', 'testnet', `${RELAYER}.json`), JSON.stringify({ account_id: RELAYER, private_key: key }));
  assert.equal(loadRelayerKey(RELAYER, {}, home), key);
  assert.equal(loadRelayerKey(RELAYER, { RELAYER_PRIVATE_KEY: 'ed25519:fromenv' }, home), 'ed25519:fromenv');
});

test('encodeSignedDelegateBase64 matches Buffer base64 of the borsh bytes', async () => {
  const { signedDelegate, encoded } = await signDelegate({ signer, senderId: SENDER, receiverId: CONTRACT,
    actions: [functionCall('approve_receipt', { id: 1 })], nonce: 1n, maxBlockHeight: 2n });
  assert.equal(encodeSignedDelegateBase64(signedDelegate), encoded);
  assert.equal(Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64'), encoded);
});
