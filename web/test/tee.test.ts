import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { slimPrivacy, teeCheckList } from "../src/lib/tee.ts";

// Real privacy block from evidence/attestations/42.json (order 42, TEE-verified verdict).
const real = JSON.parse(readFileSync(new URL("../../evidence/attestations/42.json", import.meta.url), "utf8")).tee.privacy;

test("all five recorded checks pass for order 42 and raw evidence is dropped", () => {
  const slim = slimPrivacy(real)!;
  assert.equal("evidence" in slim, false);
  assert.equal(slim.verified_private, true);
  const items = teeCheckList(slim);
  assert.deepEqual(items.map((i) => i.key), ["nonce_bound", "tdx_quote_verified", "gpu_attested", "signature_valid", "signer_matches_attestation"]);
  assert.ok(items.every((i) => i.ok));
});

test("a failed check is shown as not passed, a missing one is not shown at all", () => {
  const items = teeCheckList({ nonce_bound: true, gpu_attested: false });
  assert.deepEqual(items.map((i) => [i.key, i.ok]), [["nonce_bound", true], ["gpu_attested", false]]);
  assert.deepEqual(teeCheckList(null), []);
  assert.equal(slimPrivacy({ evidence: {} }), null);
});
