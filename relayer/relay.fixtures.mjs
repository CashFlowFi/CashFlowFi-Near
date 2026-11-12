// Shared fixtures for the relayer tests: accounts, a signing user key, a fake chain, and a relayer factory.
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { createRelayer } from './relay.mjs';
import { functionCall, signDelegate } from './client.mjs';

export const CONTRACT = 'cashflow.cfi.testnet';
export const TOKEN = 'usdc.tidepool-sandbox.testnet';
export const RELAYER = 'relayer.cfi.testnet';
export const SENDER = 'merchant.cfi.testnet';
export const HEIGHT = 1000;
export const userKey = KeyPair.fromRandom('ed25519');
export const signer = new KeyPairSigner(userKey);
export const ORDER_ARGS = { amount: '1000000', currency: 'USDC', due_date: '1900000000000000000', invoice_no: 'INV-1', customer_hash: 'h' };

let nonceSeq = 10n;
export async function delegate({ senderId = SENDER, receiverId = CONTRACT, acts = [functionCall('create_order', ORDER_ARGS)],
  nonce = ++nonceSeq, maxBlockHeight = HEIGHT + 200, by = signer } = {}) {
  return (await signDelegate({ signer: by, senderId, receiverId, actions: acts, nonce, maxBlockHeight })).encoded;
}

/** Fake chain: one full-access key for SENDER (and any `keys` given), records relays. */
export function fakeChain({ keys = {}, result } = {}) {
  const sent = [];
  const pk = userKey.getPublicKey().toString();
  const table = { [`${SENDER}|${pk}`]: { nonce: 5n, permission: 'FullAccess', block_height: HEIGHT }, ...keys };
  return {
    sent,
    viewAccessKey: async (accountId, publicKey) => table[`${accountId}|${publicKey}`] ?? null,
    relay: async (sd) => { sent.push(sd); return result ?? { transaction_outcome: { id: `tx${sent.length}` }, status: { SuccessValue: '' }, receipts_outcome: [] }; },
  };
}
export const relayerFor = (chain, opts = {}) => createRelayer({ contractId: CONTRACT, tokenId: TOKEN, relayerId: RELAYER, chain, ...opts });
export async function rejects(p, code) {
  await assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });
}
