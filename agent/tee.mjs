// Verified private inference on NEAR AI Cloud (https://docs.near.ai/cloud/verification).
// Before the prompt leaves this process: a fresh model attestation report bound to our random nonce.
// After the completion: the response signature over the EXACT request and response bytes, and its signer
// must be the attested model key. The privacy block reports each check separately; nothing is assumed.
import { createHash, randomBytes } from 'node:crypto';
import { recoverMessageAddress } from 'viem';

export const NEAR_AI = 'https://cloud-api.near.ai/v1';
export const DEFAULT_MATCH_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8'; // provider_tee signatures verified live 2026-11-12
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,119}$/;
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const KINDS = ['provider_tee', 'gateway'];
// What this client does not check, stated in every privacy block so nobody reads more into it.
export const NOT_VERIFIED = [
  'gateway attestation and TLS binding: the cloud-api.near.ai gateway terminates TLS and relays the request',
  'RTMR3 event-log replay and app_compose measurement (MRCONFIGID)',
  'signature of the NVIDIA NRAS token (the verdict is read over TLS from nras.attestation.nvidia.com)',
];

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const newNonce = () => randomBytes(32).toString('hex');
const fail = (code) => { throw new Error(code); };
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Privacy block for a request that made no (verified) model call. */
export const unverifiedPrivacy = (model = null) => ({
  model, nonce_bound: false, signature_valid: false, signer_matches_attestation: false, signature_kind: null,
  gpu_attested: false, tdx_quote_verified: false, verified_private: false, intent_stored: false, not_verified: NOT_VERIFIED,
});

/** Model-report candidates for `model`. All must echo our nonce with an ECDSA signer, else none count. */
export function attestedSigners(report, model, nonce) {
  const all = (report?.model_attestations ?? []).filter((a) => a?.model_name === model);
  const ok = all.length > 0 && all.every((a) => a.request_nonce === nonce && a.signing_algo === 'ecdsa' && ADDRESS.test(a.signing_address ?? ''));
  return ok ? all : [];
}

/** The text NEAR AI signs for each signature_kind. An unknown kind has no expected text. */
export function expectedText(kind, model, requestHash, responseHash) {
  if (kind === 'provider_tee') return `${model}:${requestHash}:${responseHash}`;
  if (kind === 'gateway') return `${requestHash}:${responseHash}`;
  return null;
}

/** Check one signed completion against the attested signers. Pure apart from ECDSA recovery. */
export async function checkSignature({ model, candidates, requestBytes, responseBytes, signature }) {
  const kind = KINDS.includes(signature?.signature_kind) ? signature.signature_kind : null;
  const text = expectedText(kind, model, sha256(requestBytes), sha256(responseBytes));
  let signer = null;
  if (text && signature.text === text && signature.signing_algo === 'ecdsa' && SIGNATURE.test(signature.signature ?? '')) {
    try { signer = await recoverMessageAddress({ message: text, signature: signature.signature }); } catch { signer = null; }
  }
  const signatureValid = signer !== null && sameAddress(signer, signature.signing_address);
  return {
    signature_valid: signatureValid,
    signer_matches_attestation: signatureValid && candidates.some((c) => sameAddress(c.signing_address, signer)),
    signature_kind: kind,
  };
}

/** Combine the checks. verified_private needs a nonce-bound report and a valid provider_tee signature by its key. */
export function privacyBlock({ model, nonceBound, sig, gpu, tdx, evidence }) {
  const verified = nonceBound && sig.signature_valid && sig.signer_matches_attestation && sig.signature_kind === 'provider_tee';
  return { ...unverifiedPrivacy(model), nonce_bound: nonceBound, ...sig, gpu_attested: gpu, tdx_quote_verified: tdx,
    verified_private: verified, evidence };
}

/**
 * Returns chat({ system, user, maxTokens }) -> { text, privacy, transcript }. The prompt is sent only after the
 * report is bound to our nonce (and, when `verifyQuote` is given, after its TDX quote verifies).
 *   verifyQuote(candidate, nonce) -> { ok, tcb_status }      attestGpu(candidate, nonce) -> boolean
 */
export function createVerifiedChat({ apiKey, model, fetchImpl = fetch, verifyQuote = null, attestGpu = null,
  timeoutMs = 30000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!apiKey || /[\r\n]/.test(apiKey)) fail('NEARAI_API_KEY missing');
  if (typeof model !== 'string' || !MODEL_ID.test(model)) fail('MATCH_MODEL invalid');
  // x-no-aliasing: fail instead of silently serving another model. Bearer key never logged.
  const headers = { authorization: `Bearer ${apiKey}`, 'x-no-aliasing': 'true', accept: 'application/json' };
  const get = (url) => fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });

  async function fetchSignature(chatId) {
    if (!CHAT_ID.test(chatId ?? '')) return null;
    const q = new URLSearchParams({ model, signing_algo: 'ecdsa' });
    for (let attempt = 0; attempt < 3; attempt++) { // the docs allow a brief retry on 404
      const r = await get(`${NEAR_AI}/signature/${chatId}?${q}`);
      if (r.status === 404) { await sleep(1000); continue; }
      const body = r.ok ? await r.json() : null;
      return body && !body.error_code ? body : null; // a 2xx error body is not a signature
    }
    return null;
  }

  return async function chat({ system, user, maxTokens = 600 }) {
    const nonce = newNonce();
    const q = new URLSearchParams({ model, provider: 'near', include_tls_fingerprint: 'false', signing_algo: 'ecdsa', nonce });
    const ar = await get(`${NEAR_AI}/attestation/report?${q}`);
    if (!ar.ok) fail(`ATTESTATION_HTTP_${ar.status}`);
    const candidates = attestedSigners(await ar.json(), model, nonce);
    if (!candidates.length) fail('TEE_NONCE_NOT_BOUND');
    const quotes = verifyQuote ? await Promise.all(candidates.map((c) => verifyQuote(c, nonce))) : [];
    if (verifyQuote && !quotes.every((x) => x.ok)) fail('TEE_QUOTE_REJECTED');
    const gpu = attestGpu ? (await Promise.all(candidates.map((c) => attestGpu(c, nonce)))).every(Boolean) : false;

    // Built once; these exact bytes are sent and hashed. Qwen3 needs thinking off to answer within max_tokens.
    const requestBytes = Buffer.from(JSON.stringify({ model, temperature: 0.1, max_tokens: maxTokens, stream: false,
      ...(/qwen3/i.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }));
    const r = await fetchImpl(`${NEAR_AI}/chat/completions`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { ...headers, 'content-type': 'application/json', 'accept-encoding': 'identity' }, body: requestBytes });
    if (!r.ok) fail(`INFERENCE_HTTP_${r.status}`);
    const responseBytes = Buffer.from(await r.arrayBuffer());
    let payload; try { payload = JSON.parse(responseBytes.toString('utf8')); } catch { fail('INFERENCE_NOT_JSON'); }
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string') fail('INFERENCE_INCOMPLETE');

    const signature = await fetchSignature(payload.id);
    const sig = await checkSignature({ model, candidates, requestBytes, responseBytes, signature });
    const evidence = {
      nonce, chat_id: payload.id ?? null, attested_signers: candidates.map((c) => c.signing_address),
      tdx_tcb_status: quotes.map((x) => x.tcb_status ?? null), request_sha256: sha256(requestBytes), response_sha256: sha256(responseBytes),
      signed_text: signature?.text ?? null, signature: signature?.signature ?? null, signing_address: signature?.signing_address ?? null,
    };
    const privacy = privacyBlock({ model, nonceBound: true, sig, gpu, tdx: quotes.length > 0, evidence });
    return { text: choice.message.content, privacy, transcript: { request: requestBytes, response: responseBytes } };
  };
}
