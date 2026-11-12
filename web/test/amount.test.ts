import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsdc, percent, remaining, sum, toBig, nsToDate } from "../src/lib/amount.ts";

test("formatUsdc keeps every significant digit and at least two decimals", () => {
  assert.equal(formatUsdc("4781250"), "4.78125");
  assert.equal(formatUsdc("1195312"), "1.195312");
  assert.equal(formatUsdc("6000000"), "6.00");
  assert.equal(formatUsdc("6500000"), "6.50");
  assert.equal(formatUsdc("1"), "0.000001");
  assert.equal(formatUsdc("0"), "0.00");
  assert.equal(formatUsdc("637500000"), "637.50");
  assert.equal(formatUsdc("1234567890123"), "1,234,567.890123");
});

test("formatUsdc is exact beyond float precision", () => {
  assert.equal(formatUsdc("9007199254740993000001"), "9,007,199,254,740,993.000001");
});

test("toBig rejects non-integers instead of guessing", () => {
  for (const bad of ["1.5", "-1", "", "1e6", " 1"]) assert.throws(() => toBig(bad));
});

test("sum, remaining and percent", () => {
  assert.equal(sum("4781250", "1593750"), BigInt(6375000));
  assert.equal(remaining("4500000", "4000000"), BigInt(500000));
  assert.equal(remaining("4500000", "5000000"), BigInt(0));
  assert.equal(percent("1195312", "1593750"), 74);
  assert.equal(percent("1", "0"), null);
});

test("nsToDate drops sub-millisecond precision only", () => {
  assert.equal(nsToDate("1794502349115000000").toISOString(), new Date(1794502349115).toISOString());
});
