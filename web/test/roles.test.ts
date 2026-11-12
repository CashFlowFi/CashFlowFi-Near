import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultRole, roleAction } from "../src/lib/roles.ts";

const fx = (id: number) => JSON.parse(readFileSync(new URL(`./fixtures/pool-${id}.json`, import.meta.url), "utf8"));

test("default role follows the signed-in account", () => {
  const { pool, orders, positions } = fx(22);
  assert.equal(defaultRole(null, pool, orders, positions), "observer");
  assert.equal(defaultRole("merchant.cashflowfi.testnet", pool, orders, positions), "merchant");
  assert.equal(defaultRole("customer.cashflowfi.testnet", pool, orders, positions), "customer");
  assert.equal(defaultRole("bob.cashflowfi.testnet", pool, orders, positions), "investor");
  assert.equal(defaultRole("stranger.testnet", pool, orders, positions), "observer");
  const f = fx(1);
  assert.equal(defaultRole("stranger.testnet", f.pool, f.orders, f.positions), "investor");
});

test("funding pool with room: investor invests; full funding pool: merchant sends the advance", () => {
  const { pool, orders, positions } = fx(1);
  assert.equal(roleAction("investor", pool, orders, positions, null), "invest");
  const full = { ...pool, senior_funded: pool.senior_target, junior_funded: pool.junior_target };
  assert.equal(roleAction("investor", full, orders, positions, null), null);
  assert.equal(roleAction("merchant", full, orders, positions, null), "retry_advance");
  assert.equal(roleAction("merchant", pool, orders, positions, null), null);
});

test("active pool: customer pays; repaid pool: customer has nothing to do", () => {
  const a = fx(3);
  assert.equal(roleAction("customer", a.pool, a.orders, a.positions, null), "pay");
  const r = fx(22);
  assert.equal(roleAction("customer", r.pool, r.orders, r.positions, null), null);
});

test("claim only for the holder of a claimable position when signed in", () => {
  const { pool, orders, positions } = fx(22);
  const open = positions.map((p: any) => (p.owner === "bob.cashflowfi.testnet" ? { ...p, claimable: "5" } : p));
  assert.equal(roleAction("investor", pool, orders, open, "bob.cashflowfi.testnet"), "claim");
  assert.equal(roleAction("investor", pool, orders, open, "alice.cashflowfi.testnet"), null);
  assert.equal(roleAction("investor", pool, orders, open, null), "claim");
  assert.equal(roleAction("investor", pool, orders, positions, null), null);
  assert.equal(roleAction("observer", pool, orders, open, null), null);
});
