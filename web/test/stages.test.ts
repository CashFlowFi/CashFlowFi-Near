import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveStages } from "../src/lib/stages.ts";
import type { Order, Pool, Position } from "../src/lib/types.ts";

// Fixtures are real testnet state captured from cashflow.cashflowfi.testnet on 2026-11-13.
type Fx = { pool: Pool; orders: Order[]; positions: Position[] };
const fx = (id: number): Fx => JSON.parse(readFileSync(new URL(`./fixtures/pool-${id}.json`, import.meta.url), "utf8"));
const states = (v: ReturnType<typeof deriveStages>) => Object.fromEntries(v.stages.map((s) => [s.key, s.state]));

test("pool 22: repaid and fully claimed is settled and opens on the result", () => {
  const { pool, orders, positions } = fx(22);
  const v = deriveStages(pool, orders, positions);
  assert.equal(v.settled, true);
  assert.equal(v.open, "claimed");
  assert.deepEqual(v.stages.map((s) => s.key), ["invoice", "approved", "underwritten", "funded", "paid", "claimed"]);
  assert.ok(v.stages.every((s) => s.state === "done"));
});

test("pool 22 with one unclaimed unit is not settled and opens on Claimed", () => {
  const { pool, orders, positions } = fx(22);
  const short = positions.map((p, i) => (i === 1 ? { ...p, claimed: (BigInt(p.claimed) - BigInt(1)).toString(), claimable: "1" } : p));
  const v = deriveStages(pool, orders, short);
  assert.equal(v.settled, false);
  assert.equal(v.open, "claimed");
  assert.equal(states(v).claimed, "current");
});

test("repaid pool whose positions could not be read is not called settled", () => {
  const { pool, orders } = fx(22);
  const v = deriveStages(pool, orders, null);
  assert.equal(v.settled, false);
  assert.equal(states(v).claimed, "current");
});

test("pool 25: defaulted with cover paid shows Default and Cover, payment missed, settled", () => {
  const { pool, orders, positions } = fx(25);
  const v = deriveStages(pool, orders, positions);
  assert.deepEqual(v.stages.map((s) => s.key), ["invoice", "approved", "underwritten", "funded", "paid", "default", "cover", "claimed"]);
  assert.deepEqual(states(v), { invoice: "done", approved: "done", underwritten: "done", funded: "done", paid: "missed", default: "done", cover: "done", claimed: "done" });
  assert.equal(v.settled, true);
});

test("defaulted pool waiting for the DAO opens on Cover and keeps Claimed upcoming", () => {
  const { pool, orders, positions } = fx(25);
  const v = deriveStages({ ...pool, pending_cover: "796875", insurance_paid: "0" }, orders, positions);
  assert.equal(v.open, "cover");
  assert.equal(states(v).cover, "current");
  assert.equal(states(v).claimed, "upcoming");
  assert.equal(v.settled, false);
});

test("defaulted pool with no cover marks Cover missed", () => {
  const { pool, orders, positions } = fx(25);
  const v = deriveStages({ ...pool, insurance_paid: "0" }, orders, positions);
  assert.equal(states(v).cover, "missed");
});

test("pool 3: active opens on Paid", () => {
  const { pool, orders, positions } = fx(3);
  const v = deriveStages(pool, orders, positions);
  assert.equal(v.open, "paid");
  assert.equal(states(v).funded, "done");
  assert.equal(states(v).claimed, "upcoming");
  assert.equal(v.settled, false);
});

test("pool 1: funding opens on Funded with Paid upcoming", () => {
  const { pool, orders, positions } = fx(1);
  const v = deriveStages(pool, orders, positions);
  assert.equal(v.open, "funded");
  assert.equal(states(v).paid, "upcoming");
  assert.equal(v.settled, false);
});

test("closed pool with nothing paid out and no positions found is not called settled", () => {
  const { pool, orders } = fx(25);
  const v = deriveStages({ ...pool, senior_repaid: "0", junior_repaid: "0", insurance_paid: "0" }, orders, []);
  assert.equal(states(v).claimed, "current");
  assert.equal(v.settled, false);
});
