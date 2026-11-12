// Proof that an on-chain underwriter verdict came from a verified-private NEAR AI completion. Recomputed from the
// evidence file and the chain on every call; a `verified` flag stored in the file is never trusted.
//   1. the file's privacy block says verified_private (nonce-bound report, TDX quote checked when it was made)
//   2. the provider_tee signature re-checks offline over the saved raw request and response bytes
//   3. the signed answer is this verdict: same score and same reason hash as on-chain
//   4. the signed request asked about this order: same invoice number and amount
import { recheckPasses, recheckSaved } from './tee.mjs';
import { parseModelAnswer, reasonHash } from './underwriter.mjs';

export async function verdictVerified(file, order) {
  const tee = file?.tee;
  if (file?.source !== 'model' || tee?.privacy?.verified_private !== true) return false;
  if (!recheckPasses(await recheckSaved(tee.privacy, tee.raw))) return false;
  try {
    const answer = parseModelAnswer(JSON.parse(tee.raw.response_body).choices[0].message.content);
    const asked = JSON.parse(JSON.parse(tee.raw.request_body).messages[1].content).order;
    return answer.score === order.score && reasonHash(answer.reasons) === order.reason_hash
      && asked.invoice_no === order.invoice_no && asked.amount_usdc === Number(BigInt(order.amount) / 1_000_000n);
  } catch {
    return false;
  }
}
