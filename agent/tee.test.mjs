import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { checkSignature, createVerifiedChat, expectedText, sha256 } from './tee.mjs';
import { attestGpu, checkTdReport, expectedReportData, verifyTdxQuote } from './tee-quote.mjs';

const MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
const tee = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const other = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const NONCE = 'ab'.repeat(32);
const requestBytes = Buffer.from('{"model":"m","messages":[]}');
const responseBytes = Buffer.from('{"id":"chat-1",  "choices":[]}\n'); // odd whitespace: must be hashed as received

const candidate = (o = {}) => ({ model_name: MODEL, signing_address: tee.address, signing_algo: 'ecdsa', request_nonce: NONCE, ...o });
async function signed({ kind = 'provider_tee', signer = tee, req = requestBytes, resp = responseBytes } = {}) {
  const text = expectedText(kind, MODEL, sha256(req), sha256(resp));
  return { text, signature: await signer.signMessage({ message: text }), signing_address: signer.address, signing_algo: 'ecdsa', signature_kind: kind };
}
const check = async (signature, candidates = [candidate()]) => checkSignature({ model: MODEL, candidates, requestBytes, responseBytes, signature });

test('a real secp256k1 provider_tee signature by the attested key passes', async () => {
  assert.deepEqual(await check(await signed()), { signature_valid: true, signer_matches_attestation: true, signature_kind: 'provider_tee' });
});

test('one tampered response byte fails the signature', async () => {
  const sig = await signed();
  const tampered = Buffer.from(responseBytes); tampered[2] ^= 1;
  const r = await checkSignature({ model: MODEL, candidates: [candidate()], requestBytes, responseBytes: tampered, signature: sig });
  assert.equal(r.signature_valid, false);
  assert.equal(r.signer_matches_attestation, false);
});

test('a valid signature by a key that is not the attested one fails the signer match', async () => {
  const r = await check(await signed({ signer: other }));
  assert.equal(r.signature_valid, true);
  assert.equal(r.signer_matches_attestation, false);
});

test('a signature whose claimed signing_address differs from the recovered signer is invalid', async () => {
  const r = await check({ ...(await signed({ signer: other })), signing_address: tee.address });
  assert.equal(r.signature_valid, false);
});

test('unknown signature kinds are unavailable, not guessed', async () => {
  const r = await check({ ...(await signed()), signature_kind: 'something_new' });
  assert.deepEqual(r, { signature_valid: false, signer_matches_attestation: false, signature_kind: null });
});

/** Fake NEAR AI: attestation report echoing `reportNonce` (default: the request's), completion, signature. */
function fakeNearAi({ kind = 'provider_tee', reportNonce = null, signer = tee, signatureStatus = 200 } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    const u = new URL(url);
    if (u.pathname === '/v1/attestation/report') {
      const nonce = reportNonce ?? u.searchParams.get('nonce');
      return Response.json({ model_attestations: [candidate({ request_nonce: nonce })] });
    }
    if (u.pathname === '/v1/chat/completions') {
      const raw = '{"id":"chat-1",  "choices":[{"finish_reason":"stop","message":{"content":"{\\"ranking\\":[]}"}}]}\n';
      fakeNearAi.last = { req: init.body, resp: Buffer.from(raw) };
      return new Response(raw, { status: 200 });
    }
    if (u.pathname === '/v1/signature/chat-1') {
      if (signatureStatus !== 200) return new Response('{}', { status: signatureStatus });
      return Response.json(await signed({ kind, signer, req: fakeNearAi.last.req, resp: fakeNearAi.last.resp }));
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, seen };
}
const chatWith = (net, o = {}) => createVerifiedChat({ apiKey: 'k', model: MODEL, fetchImpl: net.fetchImpl, sleep: async () => {}, ...o });

test('end to end: nonce-bound report, exact-byte hashes, provider_tee signer = attested -> verified_private', async () => {
  const net = fakeNearAi();
  const r = await chatWith(net)({ system: 's', user: 'u' });
  const p = r.privacy;
  assert.equal(p.verified_private, true);
  assert.deepEqual([p.nonce_bound, p.signature_valid, p.signer_matches_attestation, p.signature_kind], [true, true, true, 'provider_tee']);
  assert.equal(p.tdx_quote_verified, false); // no quote verifier given -> not claimed
  assert.equal(p.evidence.response_sha256, sha256(fakeNearAi.last.resp));
  const att = new URL(net.seen[0].url);
  assert.equal(att.searchParams.get('nonce'), p.evidence.nonce);
  assert.equal(att.searchParams.get('signing_algo'), 'ecdsa');
  for (const s of net.seen) assert.equal(s.init.headers['x-no-aliasing'], 'true');
  assert.equal(net.seen[1].init.headers['accept-encoding'], 'identity');
  assert.deepEqual(JSON.parse(net.seen[1].init.body).chat_template_kwargs, { enable_thinking: false });
});

test('nonce mismatch: the prompt is never sent', async () => {
  const net = fakeNearAi({ reportNonce: 'cd'.repeat(32) });
  await assert.rejects(chatWith(net)({ system: 's', user: 'secret intent' }), /TEE_NONCE_NOT_BOUND/);
  assert.equal(net.seen.length, 1);
  assert.ok(!net.seen.some((s) => String(s.init.body ?? '').includes('secret intent')));
});

test('gateway signature: valid but not verified_private', async () => {
  const p = (await chatWith(fakeNearAi({ kind: 'gateway' }))({ system: 's', user: 'u' })).privacy;
  assert.equal(p.signature_valid, true);
  assert.equal(p.signature_kind, 'gateway');
  assert.equal(p.verified_private, false);
});

test('missing signature (404 after retries) -> not verified, answer still returned', async () => {
  const r = await chatWith(fakeNearAi({ signatureStatus: 404 }))({ system: 's', user: 'u' });
  assert.equal(r.text, '{"ranking":[]}');
  assert.equal(r.privacy.verified_private, false);
});

test('a rejected TDX quote stops the prompt before it is sent', async () => {
  const net = fakeNearAi();
  const chat = chatWith(net, { verifyQuote: async () => ({ ok: false, tcb_status: 'OutOfDate' }) });
  await assert.rejects(chat({ system: 's', user: 'u' }), /TEE_QUOTE_REJECTED/);
  assert.equal(net.seen.length, 1);
});

test('TD report must bind signer + nonce and not be a debug TD', () => {
  const rd = Buffer.from(expectedReportData(tee.address, NONCE), 'hex');
  assert.equal(rd.length, 64);
  assert.equal(rd.subarray(20, 32).every((b) => b === 0), true);
  const td = { tdAttributes: new Uint8Array(8), reportData: rd };
  assert.equal(checkTdReport(td, tee.address, NONCE), true);
  assert.equal(checkTdReport(td, other.address, NONCE), false);
  assert.equal(checkTdReport(td, tee.address, 'cd'.repeat(32)), false);
  assert.equal(checkTdReport({ ...td, tdAttributes: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0) }, tee.address, NONCE), false);
});

test('TDX quote: only accepted TCB statuses with a bound report pass', async () => {
  const td = { tdAttributes: new Uint8Array(8), reportData: Buffer.from(expectedReportData(tee.address, NONCE), 'hex') };
  const verify = (status) => async () => ({ status, report: { asTd10: () => td } });
  const c = { ...candidate(), intel_quote: '00' };
  assert.deepEqual(await verifyTdxQuote(c, NONCE, { verify: verify('UpToDate') }), { ok: true, tcb_status: 'UpToDate' });
  assert.equal((await verifyTdxQuote(c, NONCE, { verify: verify('Revoked') })).ok, false);
  assert.equal((await verifyTdxQuote(c, NONCE, { verify: async () => { throw new Error('bad quote'); } })).ok, false);
});

test('GPU attestation needs our nonce in the payload and an NRAS overall result of true', async () => {
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const nras = (result) => async () => Response.json([['JWT', jwt({ 'x-nvidia-overall-att-result': result })], {}]);
  const c = { nvidia_payload: JSON.stringify({ nonce: NONCE, evidence_list: [] }) };
  assert.equal(await attestGpu(c, NONCE, { fetchImpl: nras(true) }), true);
  assert.equal(await attestGpu(c, NONCE, { fetchImpl: nras(false) }), false);
  assert.equal(await attestGpu(c, 'cd'.repeat(32), { fetchImpl: nras(true) }), false);
});
