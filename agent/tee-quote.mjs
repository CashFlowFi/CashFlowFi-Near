// Hardware evidence for one NEAR AI model attestation candidate (agent/tee.mjs runs these before any prompt is sent).
// TDX: @phala/dcap-qvl verifies the Intel quote signature chain and TCB against Intel-signed collateral, then we check
// the quote is not a debug TD and its report_data binds the attested signer and our nonce.
// GPU: the NVIDIA payload must carry our nonce and NRAS must return overall result true.
// Layout per https://docs.near.ai/cloud/verification/reference/quote-nonce-signer.
import { getCollateralAndVerify } from '@phala/dcap-qvl';

export const ACCEPTED_TCB = new Set(['UpToDate', 'SWHardeningNeeded']);
export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';

/** 64 bytes: the 20-byte signing address right-padded to 32 bytes, then the 32-byte client nonce. */
export function expectedReportData(address, nonce) {
  return Buffer.concat([Buffer.from(address.slice(2), 'hex'), Buffer.alloc(12), Buffer.from(nonce, 'hex')]).toString('hex');
}

/** Checks on a verified TD report: TDATTRIBUTES bit 0 (DEBUG) clear, report_data bound to signer + nonce. */
export function checkTdReport(td, address, nonce) {
  if (!td?.tdAttributes || !td?.reportData) return false;
  const debug = (td.tdAttributes[0] & 1) === 1;
  return !debug && Buffer.from(td.reportData).toString('hex') === expectedReportData(address, nonce);
}

/** Verify the candidate's Intel TDX quote. Collateral comes from the library's default PCCS and is Intel-signed. */
export async function verifyTdxQuote(candidate, nonce, { verify = getCollateralAndVerify } = {}) {
  try {
    const r = await verify(Buffer.from(candidate.intel_quote ?? '', 'hex'));
    const td = r.report?.asTd10?.() ?? null;
    return { ok: ACCEPTED_TCB.has(r.status) && checkTdReport(td, candidate.signing_address, nonce), tcb_status: r.status ?? null };
  } catch {
    return { ok: false, tcb_status: null };
  }
}

const jwtClaims = (jwt) => JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString('utf8'));

/** NVIDIA GPU attestation through NRAS. The payload is sent unchanged. */
export async function attestGpu(candidate, nonce, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  try {
    if (JSON.parse(candidate.nvidia_payload).nonce !== nonce) return false;
    const r = await fetchImpl(NRAS_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body: candidate.nvidia_payload });
    if (!r.ok) return false;
    const body = await r.json(); // [["JWT", <platform token>], { <gpu>: <token> }]
    return Array.isArray(body?.[0]) && body[0][0] === 'JWT' && jwtClaims(body[0][1])['x-nvidia-overall-att-result'] === true;
  } catch {
    return false;
  }
}
