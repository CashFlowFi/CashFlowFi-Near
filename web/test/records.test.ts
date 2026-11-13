/* eslint-disable @typescript-eslint/no-explicit-any -- agent modules are untyped .mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { customerRecord, defaultRate, habitualDefaulter, merchantRecord } from "../src/lib/records.ts";
// The agent's own implementations: the UI must show exactly what the underwriter uses.
import { historyByCustomer, historyByMerchant } from "../../agent/run.mjs";
import { habitualDefaulter as agentHabit, NEW_CUSTOMER_LIMIT as AGENT_NEW, CUSTOMER_EXPOSURE_CAP as AGENT_CAP } from "../../agent/underwriter.mjs";
import { NEW_CUSTOMER_LIMIT, CUSTOMER_EXPOSURE_CAP } from "../src/lib/records.ts";

const STATUSES = ["Pending", "CustomerApproved", "Attested", "Rejected", "Pooled", "Paid"];
const POOL_STATUSES = ["Funding", "Active", "Repaid", "Defaulted"];
const CUSTOMERS = ["a.testnet", "b.testnet", "c.testnet", null];
const MERCHANTS = ["m1.testnet", "m2.testnet"];

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

test("UI records equal the agent's records on 200 random chain states", () => {
  const r = rng(42);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  for (let round = 0; round < 200; round++) {
    const pools = Array.from({ length: 6 }, (_, i) => ({ id: i, merchant: pick(MERCHANTS), status: pick(POOL_STATUSES) })) as any[];
    const orders = Array.from({ length: 25 }, (_, i) => ({
      id: i, customer: pick(CUSTOMERS), merchant: pick(MERCHANTS), status: pick(STATUSES), pool_id: r() < 0.7 ? Math.floor(r() * 6) : null,
      amount: String(Math.floor(r() * 50_000_000) + 1), paid: String(Math.floor(r() * 1_000_000)), verdict: pick(["Approve", "Flag", "Reject", null]),
    })) as any[];
    const agentC = historyByCustomer(orders, pools);
    for (const c of CUSTOMERS.filter(Boolean) as string[]) {
      assert.deepEqual(customerRecord(orders, pools, c), agentC.get(c) ?? { paid: 0, defaults: 0, open: 0, outstanding: BigInt(0) }, `round ${round} ${c}`);
    }
    const agentM = historyByMerchant(pools);
    for (const m of MERCHANTS) assert.deepEqual(merchantRecord(pools, m), agentM.get(m) ?? { repaidPools: 0, defaults: 0 });
  }
});

test("the 200 random states exercise every branch", () => {
  const r = rng(42);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const seen = { paid: 0, defaults: 0, open: 0, owed: 0 };
  for (let round = 0; round < 200; round++) {
    const pools = Array.from({ length: 6 }, (_, i) => ({ id: i, merchant: pick(MERCHANTS), status: pick(POOL_STATUSES) })) as any[];
    const orders = Array.from({ length: 25 }, (_, i) => ({
      id: i, customer: pick(CUSTOMERS), merchant: pick(MERCHANTS), status: pick(STATUSES), pool_id: r() < 0.7 ? Math.floor(r() * 6) : null,
      amount: String(Math.floor(r() * 50_000_000) + 1), paid: String(Math.floor(r() * 1_000_000)), verdict: pick(["Approve", "Flag", "Reject", null]),
    })) as any[];
    const rec = customerRecord(orders, pools, "a.testnet");
    seen.paid += rec.paid; seen.defaults += rec.defaults; seen.open += rec.open; seen.owed += rec.outstanding > BigInt(0) ? 1 : 0;
  }
  assert.ok(seen.paid > 0 && seen.defaults > 0 && seen.open > 0 && seen.owed > 0, JSON.stringify(seen));
});

test("excluding the scored order and the habit rule match the agent", () => {
  const pools = [{ id: 1, status: "Defaulted" }] as any[];
  const orders = [{ id: 1, customer: "a.testnet", status: "Pooled", pool_id: 1 }, { id: 2, customer: "a.testnet", status: "Pooled", pool_id: 1 }] as any[];
  assert.deepEqual(customerRecord(orders, pools, "a.testnet", 2), { paid: 0, defaults: 1, open: 0, outstanding: BigInt(0) });
  for (const rec of [{ paid: 0, defaults: 2, open: 0 }, { paid: 2, defaults: 2, open: 0 }, { paid: 16, defaults: 6, open: 3 }, { paid: 0, defaults: 1, open: 0 }].map((x) => ({ ...x, outstanding: BigInt(0) }))) {
    assert.equal(habitualDefaulter(rec), agentHabit(rec), `${rec.paid}/${rec.defaults}`);
  }
  assert.equal(defaultRate({ paid: 16, defaults: 6, open: 3, outstanding: BigInt(0) }), 27);
  assert.equal(defaultRate({ paid: 0, defaults: 0, open: 2, outstanding: BigInt(0) }), null);
});

test("UI limits equal the agent's limits", () => {
  assert.equal(NEW_CUSTOMER_LIMIT, AGENT_NEW);
  assert.equal(CUSTOMER_EXPOSURE_CAP, AGENT_CAP);
});
