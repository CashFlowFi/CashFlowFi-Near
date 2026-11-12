import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictVerified } from './verdict-proof.mjs';
import { reasonHash } from './underwriter.mjs';
import { OTHER_KEY, signedVerdictFile } from './verdict-proof.fixtures.mjs';

const REASONS = ['Repeat customer'];
const order = (o = {}) => ({ id: 7, amount: '1000000000', invoice_no: 'INV-7', verdict: 'Approve', score: 82, reason_hash: reasonHash(REASONS), ...o });

test('a signed, verified-private completion that produced this on-chain verdict is verified', async () => {
  assert.equal(await verdictVerified(await signedVerdictFile(order()), order()), true);
});

test('the stored verified_private flag alone is not enough: the signature must re-check', async () => {
  const file = await signedVerdictFile(order());
  file.tee.raw.response_body = file.tee.raw.response_body.replace('82', '92'); // tamper after signing
  assert.equal(await verdictVerified(file, order({ score: 92 })), false);
  assert.equal(await verdictVerified(await signedVerdictFile(order(), { signer: OTHER_KEY }), order()), false);
  // gateway signatures prove only the relay, not the model enclave
  assert.equal(await verdictVerified(await signedVerdictFile(order(), { kind: 'gateway' }), order()), false);
});

test('a valid signature that is not marked verified_private is not verified', async () => {
  assert.equal(await verdictVerified(await signedVerdictFile(order(), { verifiedPrivate: false }), order()), false);
});

test('the signed answer must be the on-chain verdict: score and reason hash', async () => {
  const file = await signedVerdictFile(order());
  assert.equal(await verdictVerified(file, order({ score: 83 })), false);
  assert.equal(await verdictVerified(file, order({ reason_hash: reasonHash(['Other']) })), false);
});

test('the signed request must be about this order: invoice number and amount', async () => {
  assert.equal(await verdictVerified(await signedVerdictFile(order(), { asked: { invoice_no: 'INV-8' } }), order()), false);
  assert.equal(await verdictVerified(await signedVerdictFile(order(), { asked: { amount_usdc: 999 } }), order()), false);
});

test('rule verdicts, missing TEE blocks and garbage are not verified', async () => {
  const file = await signedVerdictFile(order());
  assert.equal(await verdictVerified({ ...file, source: 'rules' }, order()), false);
  assert.equal(await verdictVerified({ ...file, tee: null }, order()), false);
  assert.equal(await verdictVerified({ ...file, tee: { ...file.tee, raw: { request_body: '{', response_body: '{' } } }, order()), false);
  assert.equal(await verdictVerified(null, order()), false);
});
