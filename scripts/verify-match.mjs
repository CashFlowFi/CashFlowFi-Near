// Offline re-check of a saved private-matching run (no keys, no network):
//   node scripts/verify-match.mjs [evidence/privacy/match-run.json]
// Recomputes the request/response hashes from the saved raw bodies and recovers the signer of the
// provider_tee signature, then compares it with the signer the attestation report bound to our nonce.
// The TDX quote and GPU checks need network collateral; they are recorded in the file, not repeated here.

import { readFileSync } from 'node:fs';
import { recheckPasses, recheckSaved } from '../agent/tee.mjs';

const file = process.argv[2] ?? 'evidence/privacy/match-run.json';
const run = JSON.parse(readFileSync(file, 'utf8'));
const { privacy } = run.response;
const result = await recheckSaved(privacy, run.raw);

console.log(JSON.stringify({ file, ...result, recorded: { nonce_bound: privacy.nonce_bound, tdx_quote_verified: privacy.tdx_quote_verified, gpu_attested: privacy.gpu_attested } }, null, 2));
if (!recheckPasses(result)) process.exitCode = 1;
