import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkInvoice, msToNs, poolTerms } from "../src/lib/merchant.ts";
import { createOrderTx, createPoolTx, isAccountId, nftTransferTx } from "../src/lib/tx.ts";

const U = BigInt(1_000_000);
const C = { cashflow: "cashflow.cashflowfi.testnet", token: "usdc.tidepool-sandbox.testnet" };

test("terms preview matches cashflow-core for 1,000 USDC tier B", () => {
  const t = poolTerms(BigInt(1000) * U, "B")!;
  assert.equal(t.advance, BigInt(800) * U);
  assert.equal(t.fee, BigInt(8) * U);
  assert.equal(t.merchant_net, BigInt(792) * U);
  assert.equal(t.claim, BigInt(850) * U);
  assert.equal(t.senior_face, BigInt(637_500_000));
  assert.equal(t.junior_face, BigInt(212_500_000));
  assert.equal(t.senior_target, BigInt(600) * U);
  assert.equal(t.junior_target, BigInt(200) * U);
  assert.equal(poolTerms(BigInt(1000) * U, "A")!.advance, BigInt(850) * U);
  assert.equal(poolTerms(BigInt(1000) * U, "C")!.advance, BigInt(700) * U);
  assert.equal(poolTerms(BigInt(0), "B"), null);
});

test("terms preview equals the real on-chain pool 22 (tier D) field by field", () => {
  const { pool } = JSON.parse(readFileSync(new URL("./fixtures/pool-22.json", import.meta.url), "utf8"));
  const t = poolTerms(BigInt(pool.receivable), pool.tier)!;
  for (const k of ["advance", "fee", "claim", "senior_face", "junior_face", "senior_target", "junior_target"] as const) {
    assert.equal(t[k].toString(), pool[k], k);
  }
});

test("invoice checks mirror the contract and underwriter rules", () => {
  const now = Date.UTC(2026, 10, 13);
  const ok = { amount: BigInt(10) * U, currency: "USDC", invoiceNo: "INV-2026/001", dueMs: now + 30 * 86_400_000, customerRef: "buyer@example.com" };
  assert.deepEqual(checkInvoice(ok, now), {});
  assert.ok(checkInvoice({ ...ok, amount: BigInt(100_000) * U + BigInt(1) }, now).amount);
  assert.deepEqual(checkInvoice({ ...ok, amount: BigInt(100_000) * U }, now), {});
  assert.ok(checkInvoice({ ...ok, amount: null }, now).amount);
  assert.ok(checkInvoice({ ...ok, currency: "usdc" }, now).currency);
  assert.ok(checkInvoice({ ...ok, invoiceNo: "-bad" }, now).invoiceNo);
  assert.ok(checkInvoice({ ...ok, invoiceNo: "a b" }, now).invoiceNo);
  assert.ok(checkInvoice({ ...ok, dueMs: now }, now).dueMs);
  assert.ok(checkInvoice({ ...ok, dueMs: now + 181 * 86_400_000 }, now).dueMs);
  assert.deepEqual(checkInvoice({ ...ok, dueMs: now + 180 * 86_400_000 }, now), {});
  assert.ok(checkInvoice({ ...ok, customerRef: "  " }, now).customerRef);
});

test("create_order args use base units and nanoseconds", () => {
  const t = createOrderTx(C, { amount: BigInt(10) * U, currency: "USDC", dueNs: msToNs(1797093891775), invoiceNo: "A1", customerHash: "sha256:x" });
  assert.deepEqual(t.calls[0].args, { amount: "10000000", currency: "USDC", due_date: "1797093891775000000", invoice_no: "A1", customer_hash: "sha256:x" });
  assert.equal(t.calls[0].deposit, "0");
});

test("create_pool takes 1 to 20 orders; nft_transfer attaches 1 yocto", () => {
  assert.deepEqual(createPoolTx(C, [41, 42]).calls[0].args, { order_ids: [41, 42] });
  assert.throws(() => createPoolTx(C, []));
  assert.throws(() => createPoolTx(C, Array.from({ length: 21 }, (_, i) => i)));
  const n = nftTransferTx(C, "carol.cashflowfi.testnet", "22-41");
  assert.equal(n.calls[0].deposit, "1");
  assert.deepEqual(n.calls[0].args, { receiver_id: "carol.cashflowfi.testnet", token_id: "22-41" });
});

test("account id validation", () => {
  for (const ok of ["carol.cashflowfi.testnet", "a1.testnet", "x_y-z.testnet", "a".repeat(64)]) assert.ok(isAccountId(ok), ok);
  for (const bad of ["", "A.testnet", "a..testnet", ".a", "a.", "a b", "a@b", "a".repeat(65)]) assert.ok(!isAccountId(bad), bad);
});
