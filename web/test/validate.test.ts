import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAmount } from "../src/lib/validate.ts";

const M = BigInt(4500000);
test("amount within room and balance passes", () => {
  assert.deepEqual(checkAmount("4.5", { max: M, balance: M }), { amount: M, error: null });
});
test("exactly at the limit passes; one unit above fails", () => {
  assert.equal(checkAmount("4.5", { max: M }).amount, M);
  assert.match(checkAmount("4.500001", { max: M }).error!, /Up to 4.50 USDC/);
});
test("balance is checked after room", () => {
  assert.match(checkAmount("2", { max: M, balance: BigInt(1000000) }).error!, /balance is 1.00/);
  assert.equal(checkAmount("1", { max: M, balance: BigInt(1000000) }).amount, BigInt(1000000));
});
test("unknown balance does not block", () => {
  assert.equal(checkAmount("1", { balance: null }).amount, BigInt(1000000));
});
test("zero and junk are rejected", () => {
  assert.match(checkAmount("0", {}).error!, /above zero/);
  assert.match(checkAmount("1.1234567", {}).error!, /6 decimals/);
});
