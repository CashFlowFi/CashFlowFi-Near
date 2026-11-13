import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isHighlighted, jsonLines, MAX_STRING, summarize } from "../src/lib/proof.ts";

const ev = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));

test("jsonLines reproduces JSON.stringify(v, null, 2) exactly when nothing is clipped", () => {
  let compared = 0;
  for (const p of ["evidence/demo-run.json", "evidence/tiers/merchant.cashflowfi.testnet.D.json", "evidence/attacks/onchain.json"]) {
    const doc = ev(p);
    const lines = jsonLines(doc);
    if (lines.some((l) => l.clipped)) continue;
    compared++;
    assert.equal(lines.map((l) => "  ".repeat(l.indent) + l.text).join("\n"), JSON.stringify(doc, null, 2), p);
  }
  assert.ok(compared >= 2, `compared ${compared} real files`);
  const small = { a: [1, { b: "x" }, []], c: {}, d: null, e: true };
  assert.equal(jsonLines(small).map((l) => "  ".repeat(l.indent) + l.text).join("\n"), JSON.stringify(small, null, 2));
});

test("long strings are clipped for display and marked", () => {
  const lines = jsonLines({ s: "a".repeat(MAX_STRING + 10) });
  const l = lines.find((x) => x.path.join() === "s")!;
  assert.equal(l.clipped, true);
  assert.match(l.text, /\(150 chars\)/);
});

test("highlighting matches a field and everything below it, never the whole document", () => {
  assert.equal(isHighlighted(["tee", "privacy", "nonce_bound"], [["tee", "privacy"]]), true);
  assert.equal(isHighlighted(["tee"], [["tee", "privacy"]]), false);
  assert.equal(isHighlighted(["score"], [["verdict"]]), false);
  assert.equal(isHighlighted([], [[]]), false);
});

test("real TEE verdict (order 42): verdict, model, verified TEE with 5/5 checks, tx", () => {
  const s = summarize("evidence/attestations/42.json", ev("evidence/attestations/42.json"));
  assert.equal(s.kind, "attestation");
  assert.equal(s.points[0].label, "AI verdict: Approve, score 92");
  assert.ok(s.points.some((p) => p.label === "Ran inside a verified TEE" && p.detail === "5/5 hardware and signature checks passed"));
  assert.equal(s.txs[0].hash, "49G6MguB6GvYQH7CUHNtvvnvevsFPKseQ18uT3MwfNxG");
  // every highlighted path exists in the document
  const lines = jsonLines(ev("evidence/attestations/42.json"));
  for (const p of s.points) for (const path of p.paths) assert.ok(lines.some((l) => isHighlighted(l.path, [path])), path.join("."));
});

test("real fallback verdict (order 2) is shown as a fallback, not as AI-verified", () => {
  const s = summarize("evidence/attestations/2.json", ev("evidence/attestations/2.json"));
  assert.ok(s.points.some((p) => p.tone === "warn" && /fallback/.test(p.label)));
  assert.equal(s.points.some((p) => p.label === "Ran inside a verified TEE"), false);
});

test("real tier change says the rules decided and the text was standard", () => {
  const s = summarize("evidence/tiers/merchant.cashflowfi.testnet.D.json", ev("evidence/tiers/merchant.cashflowfi.testnet.D.json"));
  assert.equal(s.kind, "tier");
  assert.equal(s.points[0].label, "Tier B → D by the rules");
  assert.equal(s.points[1].label, "Standard explanation text");
  assert.equal(s.points.some((p) => p.label === "Ran inside a verified TEE"), false);
});

test("real reminder (order 43) and run log (pool 22)", () => {
  const r = summarize("evidence/collections/43.json", ev("evidence/collections/43.json"));
  assert.equal(r.kind, "reminder");
  assert.match(r.points[0].detail!, /^4\.820313 USDC due from customer\.cashflowfi\.testnet$/);
  assert.ok(r.points.some((p) => p.label === "Ran inside a verified TEE"));
  const run = summarize("evidence/demo-run.json", ev("evidence/demo-run.json"));
  assert.equal(run.kind, "run");
  assert.equal(run.points[0].label, "Run finished with every check passing");
  assert.equal(run.txs.length, 9);
  assert.equal(run.points.find((p) => p.paths[0][0] === "order_id")!.label, "Order 37 · pool 22");
});

test("a run that did not pass every check is never shown as passing", () => {
  const run = summarize("evidence/x.json", { scenario: "s", ok: false, steps: [{ step: "a", tx: "x" }], checks: [{ ok: true }, { ok: false }] });
  assert.equal(run.points[0].tone, "warn");
  assert.notEqual(run.points[0].label, "Run finished with every check passing");
  assert.equal(run.points.find((p) => p.paths[0][0] === "checks")!.label, "1/2 state checks matched the chain");
  assert.equal(run.txs.length, 0, "non-NEAR hashes are not linked");
});
