// Test fixture: an underwriter evidence file whose TEE block carries a real secp256k1 provider_tee signature.
import { privateKeyToAccount } from 'viem/accounts';
import { expectedText, sha256, unverifiedPrivacy } from './tee.mjs';
import { reasonHash, SYSTEM_PROMPT } from './underwriter.mjs';

export const MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
export const TEE_KEY = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
export const OTHER_KEY = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

/** Evidence for `order` as agent/run.mjs writes it. `asked` overrides the order facts in the signed request. */
export async function signedVerdictFile(order, { score = 82, reasons = ['Repeat customer'], signer = TEE_KEY, verifiedPrivate = true, asked = {}, kind = 'provider_tee' } = {}) {
  const facts = { amount_usdc: Number(BigInt(order.amount) / 1_000_000n), currency: 'USDC', invoice_no: order.invoice_no, ...asked };
  const request_body = JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ order: facts, history: {} }) }] });
  const response_body = JSON.stringify({ id: 'chat-1', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ score, reasons }) } }] });
  const text = expectedText(kind, MODEL, sha256(request_body), sha256(response_body));
  const privacy = { ...unverifiedPrivacy(MODEL), nonce_bound: true, signature_valid: true, signer_matches_attestation: true,
    signature_kind: kind, tdx_quote_verified: true, verified_private: verifiedPrivate,
    evidence: { attested_signers: [TEE_KEY.address], signed_text: text, signature: await signer.signMessage({ message: text }), signing_address: signer.address } };
  return { order_id: order.id, verdict: 'Approve', score, reasons, source: 'model', reason_hash: reasonHash(reasons), model: MODEL,
    tee: { privacy, raw: { request_body, response_body } } };
}
