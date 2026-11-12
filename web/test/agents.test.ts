import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toReminder, toTierChange } from "../src/lib/agents.ts";

const ev = (p: string) => JSON.parse(readFileSync(new URL(`../../evidence/${p}`, import.meta.url), "utf8"));

test("real TEE-written reminder for order 43 is verified", () => {
  const r = toReminder(ev("collections/43.json"), "evidence/collections/43.json")!;
  assert.equal(r.order_id, 43);
  assert.equal(r.pool_id, 25);
  assert.equal(r.subject, "Payment Reminder: Invoice DFLT-1794502199115");
  assert.equal(r.teeVerified, true);
});

test("reminder badge needs both model source and verified_private", () => {
  const d = ev("collections/43.json");
  assert.equal(toReminder({ ...d, message: { ...d.message, source: "template" } }, "x")!.teeVerified, false);
  assert.equal(toReminder({ ...d, message: { ...d.message, privacy: { ...d.message.privacy, verified_private: false } } }, "x")!.teeVerified, false);
  assert.equal(toReminder({ ...d, message: { subject: "s" } }, "x"), null);
});

test("real tier change B to D: template reason carries no TEE badge", () => {
  const t = toTierChange(ev("tiers/merchant.cashflowfi.testnet.D.json"), "f")!;
  assert.deepEqual([t.old_tier, t.new_tier, t.repaid_pools, t.defaults], ["B", "D", 8, 3]);
  assert.equal(t.teeVerified, false);
  assert.equal(t.tx_hash, "BCSpFsXf2JLp1ikhngT2kPgE4dxCEadbPhfWL9QujKvE");
  assert.equal(toTierChange({ ...ev("tiers/merchant.cashflowfi.testnet.D.json"), source: "model" }, "f")!.teeVerified, true);
});
