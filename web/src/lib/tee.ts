// Human labels for the TEE privacy checks the agents record (agent/tee.mjs privacy block).

export interface PrivacyBlock {
  model?: string | null;
  nonce_bound?: boolean;
  signature_valid?: boolean;
  signer_matches_attestation?: boolean;
  signature_kind?: string | null;
  gpu_attested?: boolean;
  tdx_quote_verified?: boolean;
  verified_private?: boolean;
}

const CHECKS: [keyof PrivacyBlock, string, string][] = [
  ["nonce_bound", "Fresh attestation", "The hardware report echoed a random 32-byte nonce we generated for this request."],
  ["tdx_quote_verified", "Intel TDX quote verified", "The CPU enclave's quote was verified and is not in debug mode."],
  ["gpu_attested", "NVIDIA GPU attested", "NVIDIA's attestation service confirmed the GPU evidence for this nonce."],
  ["signature_valid", "Response signed", "The model's answer carries a valid signature over the exact request and response bytes."],
  ["signer_matches_attestation", "Signer is the attested model", "The signing key is the one inside the attested enclave."],
];

export interface CheckItem { key: string; label: string; detail: string; ok: boolean }

/** Only checks the record actually contains; never assumes a missing check passed. */
export function teeCheckList(p: PrivacyBlock | null | undefined): CheckItem[] {
  if (!p) return [];
  return CHECKS.filter(([k]) => typeof p[k] === "boolean").map(([k, label, detail]) => ({ key: k, label, detail, ok: p[k] === true }));
}

/** Pick the boolean check fields (and model) out of a full privacy block, dropping raw evidence. */
export function slimPrivacy(p: Record<string, unknown> | null | undefined): PrivacyBlock | null {
  if (!p || typeof p !== "object") return null;
  const out: PrivacyBlock = {};
  for (const [k] of CHECKS) if (typeof p[k] === "boolean") (out as Record<string, unknown>)[k] = p[k];
  if (typeof p.verified_private === "boolean") out.verified_private = p.verified_private;
  if (typeof p.model === "string") out.model = p.model;
  if (typeof p.signature_kind === "string") out.signature_kind = p.signature_kind;
  return Object.keys(out).length ? out : null;
}
