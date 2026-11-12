// Offline re-check of a saved private-matching run (no keys, no network):
//   node scripts/verify-match.mjs [evidence/privacy/match-run.json]
// Recomputes the request/response hashes from the saved raw bodies and recovers the signer of the
// provider_tee signature, then compares it with the signer the attestation report bound to our nonce.
// The TDX quote and GPU checks need network collateral; they are recorded in the file, not repeated here.

import { readFileSync } from 'node:fs';
import { checkSignature } from '../agent/tee.mjs';

const file = process.argv[2] ?? 'evidence/privacy/match-run.json';
const run = JSON.parse(readFileSync(file, 'utf8'));
const { privacy } = run.response;
const ev = privacy.evidence;
const signers = ev.attested_signers.map((s) => (typeof s === 'string' ? { signing_address: s } : s));

const result = await checkSignature({
  model: privacy.model,
  candidates: signers,
  requestBytes: Buffer.from(run.raw.request_body, 'utf8'),
  responseBytes: Buffer.from(run.raw.response_body, 'utf8'),
  signature: { text: ev.signed_text, signature: ev.signature, signing_address: ev.signing_address, signing_algo: 'ecdsa', signature_kind: privacy.signature_kind },
});

console.log(JSON.stringify({ file, ...result, recorded: { nonce_bound: privacy.nonce_bound, tdx_quote_verified: privacy.tdx_quote_verified, gpu_attested: privacy.gpu_attested } }, null, 2));
if (!(result.signature_valid && result.signer_matches_attestation && result.signature_kind === 'provider_tee')) process.exitCode = 1;
