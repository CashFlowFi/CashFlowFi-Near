import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, KeyPairSigner, actions, encodeSignedDelegate } from 'near-api-js';
import { createRelayHandler, createRelayer, decodeSignedDelegate, TGAS } from './relay.mjs';
import { encodeSignedDelegateBase64, ftTransferCall, functionCall, signDelegate, submitToRelayer } from './client.mjs';
import { loadConfig, loadRelayerKey, nearToYocto } from './server.mjs';

const CONTRACT = 'cashflow.cfi.testnet';
const TOKEN = 'usdc.tidepool-sandbox.testnet';
const RELAYER = 'relayer.cfi.testnet';
const SENDER = 'merchant.cfi.testnet';
const HEIGHT = 1000;
const userKey = KeyPair.fromRandom('ed25519');
const signer = new KeyPairSigner(userKey);
const ORDER_ARGS = { amount: '1000000', currency: 'USDC', due_date: '1900000000000000000', invoice_no: 'INV-1', customer_hash: 'h' };

let nonceSeq = 10n;
async function delegate({ senderId = SENDER, receiverId = CONTRACT, acts = [functionCall('create_order', ORDER_ARGS)],
  nonce = ++nonceSeq, maxBlockHeight = HEIGHT + 200, by = signer } = {}) {
  return (await signDelegate({ signer: by, senderId, receiverId, actions: acts, nonce, maxBlockHeight })).encoded;
}

/** Fake chain: one full-access key for SENDER (and any `keys` given), records relays. */
function fakeChain({ keys = {}, result } = {}) {
  const sent = [];
  const pk = userKey.getPublicKey().toString();
  const table = { [`${SENDER}|${pk}`]: { nonce: 5n, permission: 'FullAccess', block_height: HEIGHT }, ...keys };
  return {
    sent,
    viewAccessKey: async (accountId, publicKey) => table[`${accountId}|${publicKey}`] ?? null,
    relay: async (sd) => { sent.push(sd); return result ?? { transaction_outcome: { id: `tx${sent.length}` }, status: { SuccessValue: '' }, receipts_outcome: [] }; },
  };
}
const relayerFor = (chain, opts = {}) => createRelayer({ contractId: CONTRACT, tokenId: TOKEN, relayerId: RELAYER, chain, ...opts });
async function rejects(p, code) {
  await assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });
}

// ---------- happy path and encoding ----------

test('accepts a valid create_order delegate and relays the exact signed bytes', async () => {
  const chain = fakeChain();
  const encoded = await delegate();
  const out = await relayerFor(chain).relay(encoded);
  assert.deepEqual(out, { txHash: 'tx1', status: 'success' });
  assert.equal(chain.sent.length, 1);
  assert.equal(Buffer.from(encodeSignedDelegate(chain.sent[0])).toString('base64'), encoded);
  assert.equal(chain.sent[0].delegateAction.senderId, SENDER);
});

test('client encoding round-trips through decodeSignedDelegate', async () => {
  const encoded = await delegate({ nonce: 77n, maxBlockHeight: 1234 });
  const d = decodeSignedDelegate(new Uint8Array(Buffer.from(encoded, 'base64')));
  assert.equal(d.senderId, SENDER);
  assert.equal(d.receiverId, CONTRACT);
  assert.equal(d.nonce, 77n);
  assert.equal(d.maxBlockHeight, 1234n);
  assert.equal(d.publicKey, userKey.getPublicKey().toString());
  assert.equal(d.calls[0].methodName, 'create_order');
  assert.deepEqual(JSON.parse(Buffer.from(d.calls[0].args).toString()), ORDER_ARGS);
  assert.equal(d.calls[0].gas, 30n * TGAS);
  assert.equal(d.calls[0].deposit, 0n);
});

test('accepts the other allowlisted calls with their exact deposits', async () => {
  const r = relayerFor(fakeChain());
  for (const acts of [
    [functionCall('approve_receipt', { id: 1 })],
    [functionCall('create_pool', { order_ids: [1] }, { gas: 50n * TGAS })],
    [functionCall('claim', { token_id: '1' }, { gas: 100n * TGAS })],
    [functionCall('nft_transfer', { receiver_id: 'bob.testnet', token_id: '1' }, { deposit: 1n })],
  ]) assert.equal((await r.relay(await delegate({ acts }))).status, 'success');
  for (const msg of [{ pay: { order_id: 7 } }, { invest: { pool_id: 1, tranche: 'Senior' } }, { repay: { pool_id: 1 } }, { seed_insurance: {} }]) {
    const acts = [ftTransferCall({ contractId: CONTRACT, amount: 5, msg })];
    assert.equal((await r.relay(await delegate({ receiverId: TOKEN, acts }))).status, 'success');
  }
});

test('reports an on-chain receipt failure with the tx hash', async () => {
  const chain = fakeChain({ result: { transaction_outcome: { id: 'txF' }, status: { SuccessValue: '' },
    receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: 'FunctionCallError' } } } } }] } });
  const out = await relayerFor(chain).relay(await delegate());
  assert.equal(out.txHash, 'txF');
  assert.equal(out.status, 'failure');
  assert.equal(out.failures.length, 1);
});

// ---------- allowlist ----------

test('rejects receivers other than the contract and the token', async () => {
  const chain = fakeChain();
  await rejects(relayerFor(chain).relay(await delegate({ receiverId: 'evil.testnet' })), 'RECEIVER_NOT_ALLOWED');
  await rejects(relayerFor(chain).relay(await delegate({ receiverId: RELAYER })), 'RECEIVER_NOT_ALLOWED');
  assert.equal(chain.sent.length, 0);
});

test('rejects methods off the allowlist, including agent/DAO/owner methods and storage_deposit', async () => {
  const chain = fakeChain();
  const r = relayerFor(chain);
  for (const m of ['attest_receipt', 'set_merchant_tier', 'approve_cover', 'mark_default', 'withdraw_treasury', 'nft_transfer_call', 'ft_transfer_call', 'on_claim'])
    await rejects(r.relay(await delegate({ acts: [functionCall(m, {})] })), 'METHOD_NOT_ALLOWED');
  for (const m of ['storage_deposit', 'ft_transfer', 'create_order'])
    await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: [functionCall(m, {})] })), 'METHOD_NOT_ALLOWED');
  // a later action in the same delegate is checked too
  await rejects(r.relay(await delegate({ acts: [functionCall('create_order', ORDER_ARGS), functionCall('withdraw_residual', {})] })), 'METHOD_NOT_ALLOWED');
  assert.equal(chain.sent.length, 0);
});

test('rejects wrong deposits: any NEAR on non-payable calls, anything but 1 yocto where required', async () => {
  const r = relayerFor(fakeChain());
  await rejects(r.relay(await delegate({ acts: [functionCall('create_order', ORDER_ARGS, { deposit: 1n })] })), 'DEPOSIT_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ acts: [functionCall('create_pool', { order_ids: [1] }, { deposit: 10n ** 23n })] })), 'DEPOSIT_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ acts: [functionCall('claim', { token_id: '1' }, { deposit: 1n })] })), 'DEPOSIT_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ acts: [functionCall('nft_transfer', { receiver_id: 'b.testnet', token_id: '1' })] })), 'DEPOSIT_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ acts: [functionCall('nft_transfer', { receiver_id: 'b.testnet', token_id: '1' }, { deposit: 2n })] })), 'DEPOSIT_NOT_ALLOWED');
  const ft = (deposit) => [actions.functionCall('ft_transfer_call', { receiver_id: CONTRACT, amount: '5', msg: '{"pay":{"order_id":1}}' }, 30n * TGAS, deposit)];
  await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: ft(0n) })), 'DEPOSIT_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: ft(10n ** 24n) })), 'DEPOSIT_NOT_ALLOWED');
});

test('rejects Transfer, AddKey, DeployContract and other non-FunctionCall actions', async () => {
  const r = relayerFor(fakeChain());
  const pk = KeyPair.fromRandom('ed25519').getPublicKey();
  for (const [action, name] of [
    [actions.transfer(1n), 'Transfer'],
    [actions.addFullAccessKey(pk), 'AddKey'],
    [actions.deployContract(new Uint8Array([0, 97, 115, 109])), 'DeployContract'],
    [actions.deleteKey(pk), 'DeleteKey'],
    [actions.deleteAccount(RELAYER), 'DeleteAccount'],
    [actions.stake(1n, pk), 'Stake'],
    [actions.createAccount(), 'CreateAccount'],
  ]) {
    await assert.rejects(r.relay(await delegate({ acts: [functionCall('create_order', ORDER_ARGS), action] })),
      (e) => e.code === 'ACTION_NOT_ALLOWED' && e.detail === name);
  }
});

test('ft_transfer_call must target our contract with a known msg', async () => {
  const r = relayerFor(fakeChain());
  const ft = (args) => [actions.functionCall('ft_transfer_call', args, 150n * TGAS, 1n)];
  await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: ft({ receiver_id: 'evil.testnet', amount: '5', msg: '{"pay":{"order_id":1}}' }) })), 'FT_RECEIVER_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: ft({ receiver_id: CONTRACT, amount: '5', msg: '{"steal":{}}' }) })), 'FT_MSG_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: ft({ receiver_id: CONTRACT, amount: '5', msg: 'x' }) })), 'FT_MSG_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: ft({ receiver_id: CONTRACT, amount: '-5', msg: '{"pay":{}}' }) })), 'FT_AMOUNT');
  await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: ft({ receiver_id: CONTRACT, amount: '5', msg: '{"pay":{}}', x: 1 }) })), 'ARGS_NOT_ALLOWED');
});

test('rejects gas over the per-method cap', async () => {
  const r = relayerFor(fakeChain());
  await rejects(r.relay(await delegate({ acts: [functionCall('create_order', ORDER_ARGS, { gas: 31n * TGAS })] })), 'GAS_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ acts: [functionCall('create_order', ORDER_ARGS, { gas: 0n })] })), 'GAS_NOT_ALLOWED');
  await rejects(r.relay(await delegate({ receiverId: TOKEN, acts: [ftTransferCall({ contractId: CONTRACT, amount: 5, msg: { pay: {} }, gas: 301n * TGAS })] })), 'GAS_NOT_ALLOWED');
});

// ---------- signature, key, nonce, block height ----------

test('rejects a bad signature and a tampered delegate', async () => {
  const chain = fakeChain();
  const other = new KeyPairSigner(KeyPair.fromRandom('ed25519'));
  const good = Buffer.from(await delegate(), 'base64');
  const tampered = Buffer.from(good); tampered[tampered.length - 1] ^= 1; // flip a signature bit
  await rejects(relayerFor(chain).relay(tampered.toString('base64')), 'BAD_SIGNATURE');
  // an unknown key (valid signature, but no access key on chain)
  await rejects(relayerFor(chain).relay(await delegate({ by: other })), 'ACCESS_KEY_NOT_FOUND');
  assert.equal(chain.sent.length, 0);
});

test('rejects malformed input: not base64, trailing bytes, truncated', async () => {
  const r = relayerFor(fakeChain());
  await rejects(r.relay('not base64!'), 'SIGNED_DELEGATE_BASE64');
  await rejects(r.relay(undefined), 'SIGNED_DELEGATE_BASE64');
  const good = Buffer.from(await delegate(), 'base64');
  await rejects(r.relay(Buffer.concat([good, Buffer.from([0])]).toString('base64')), 'DECODE_TRAILING_BYTES');
  await rejects(r.relay(good.subarray(0, 40).toString('base64')), 'DECODE_TRUNCATED');
});

test('rejects stale nonce, expired and too-far-ahead max_block_height', async () => {
  const r = relayerFor(fakeChain());
  await rejects(r.relay(await delegate({ nonce: 5n })), 'NONCE_TOO_LOW');
  await rejects(r.relay(await delegate({ maxBlockHeight: HEIGHT })), 'DELEGATE_EXPIRED');
  await rejects(r.relay(await delegate({ maxBlockHeight: HEIGHT + 601 })), 'DELEGATE_TTL_TOO_LONG');
  assert.equal((await r.relay(await delegate({ maxBlockHeight: HEIGHT + 600 }))).status, 'success');
});

test('function-call access keys: right receiver and method, no deposit', async () => {
  const fcKey = KeyPair.fromRandom('ed25519');
  const fc = new KeyPairSigner(fcKey);
  const keys = { [`${SENDER}|${fcKey.getPublicKey().toString()}`]: { nonce: 0n, block_height: HEIGHT,
    permission: { FunctionCall: { receiver_id: CONTRACT, method_names: ['approve_receipt', 'nft_transfer'], allowance: null } } } };
  const r = relayerFor(fakeChain({ keys }));
  assert.equal((await r.relay(await delegate({ by: fc, acts: [functionCall('approve_receipt', { id: 1 })] }))).status, 'success');
  await rejects(r.relay(await delegate({ by: fc })), 'ACCESS_KEY_NOT_ALLOWED'); // create_order not on key
  await rejects(r.relay(await delegate({ by: fc, acts: [functionCall('nft_transfer', { receiver_id: 'b.testnet', token_id: '1' }, { deposit: 1n })] })), 'ACCESS_KEY_NOT_ALLOWED');
});

test('the same signed delegate is relayed once', async () => {
  const chain = fakeChain();
  const r = relayerFor(chain);
  const encoded = await delegate();
  await r.relay(encoded);
  await rejects(r.relay(encoded), 'DUPLICATE_DELEGATE');
  assert.equal(chain.sent.length, 1);
});

test('rejects the relayer, contract or token as sender', async () => {
  const r = relayerFor(fakeChain());
  for (const s of [RELAYER, CONTRACT, TOKEN]) await rejects(r.relay(await delegate({ senderId: s })), 'SENDER_NOT_ALLOWED');
});

// ---------- rate limit and spend cap ----------

test('per-sender rate limit, window slides', async () => {
  let t = 0;
  const other = KeyPair.fromRandom('ed25519');
  const keys = { [`bob.testnet|${other.getPublicKey().toString()}`]: { nonce: 0n, permission: 'FullAccess', block_height: HEIGHT } };
  const chain = fakeChain({ keys });
  const r = relayerFor(chain, { rateLimit: 2, rateWindowMs: 1000, now: () => t });
  await r.relay(await delegate());
  await r.relay(await delegate());
  await rejects(r.relay(await delegate()), 'RATE_LIMITED');
  // another sender is unaffected
  await r.relay(await delegate({ senderId: 'bob.testnet', by: new KeyPairSigner(other) }));
  t = 1001;
  await r.relay(await delegate());
  assert.equal(chain.sent.length, 4);
});

test('concurrent requests cannot overrun the rate limit', async () => {
  const chain = fakeChain();
  const r = relayerFor(chain, { rateLimit: 2 });
  const encoded = await Promise.all([1, 2, 3, 4].map(() => delegate()));
  const results = await Promise.allSettled(encoded.map((e) => r.relay(e)));
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 2);
  assert.equal(chain.sent.length, 2);
});

test('total spend cap: refuses once the next relay would exceed it, health reports it', async () => {
  // create_order: (30 + 10 overhead) TGas * 2e8 yocto/gas = 8e21 yocto each
  const chain = fakeChain();
  const r = relayerFor(chain, { spendCapYocto: 16n * 10n ** 21n });
  await r.relay(await delegate());
  await r.relay(await delegate());
  await rejects(r.relay(await delegate()), 'SPEND_CAP_REACHED');
  assert.equal(chain.sent.length, 2);
  const h = r.health();
  assert.equal(h.spentYocto, (16n * 10n ** 21n).toString());
  assert.equal(h.ok, false);
  assert.equal(h.relayed, 2);
});

test('spend is reserved even when the submit errors', async () => {
  const chain = fakeChain();
  chain.relay = async () => { throw new Error('timeout'); };
  const r = relayerFor(chain, { spendCapYocto: 8n * 10n ** 21n });
  await rejects(r.relay(await delegate()), 'RELAY_SUBMIT_FAILED');
  await rejects(r.relay(await delegate()), 'SPEND_CAP_REACHED');
});

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
