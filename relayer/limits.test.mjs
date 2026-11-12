// Per-sender rate limit and total spend cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { HEIGHT, delegate, fakeChain, relayerFor, rejects } from './relay.fixtures.mjs';

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
