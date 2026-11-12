import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isEvmAddress, isEvmTxHash, quoteMessage, readQuote, readStatus, PAY_STEPS } from "../src/lib/payapi.ts";

// Real responses from the local API (api/server.mjs, dry quotes) on 2026-11-13.
const api = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/api/${n}.json`, import.meta.url), "utf8"));

test("a dry quote is a preview even with an amount", () => {
  const q = readQuote(api("quote-dry"));
  assert.equal(q.kind, "preview");
  assert.equal(q.amountIn, BigInt(10000000));
});

test("a live quote with a deposit address is payable", () => {
  const live = { ...api("quote-dry"), dry: false, depositAddress: "0x01CDfD9807a7b26A1B3255b1bAb01eb550db5F1D" };
  const q = readQuote(live);
  assert.equal(q.kind, "live");
  assert.equal(q.kind === "live" && q.depositAddress, "0x01CDfD9807a7b26A1B3255b1bAb01eb550db5F1D");
});

test("a live quote without a valid deposit address stays a preview", () => {
  assert.equal(readQuote({ ...api("quote-dry"), dry: false, depositAddress: null }).kind, "preview");
  assert.equal(readQuote({ ...api("quote-dry"), dry: false, depositAddress: "0x123" }).kind, "preview");
});

test("real 409 answers map to friendly text", () => {
  assert.equal(quoteMessage(api("quote-409-paid"), 409), "This invoice is paid in full.");
  assert.equal(quoteMessage(api("quote-409-pool"), 409), "This invoice opens for payment once its pool is fully funded.");
  assert.equal(quoteMessage(api("quote-409-order"), 409), "This invoice opens for payment once its pool is active.");
  assert.match(quoteMessage({ error: "PAY_UPSTREAM" }, 502), /PAY_UPSTREAM/);
  assert.match(quoteMessage(null, 500), /HTTP 500/);
});

test("status steps: real delivered status is final and on the last step", () => {
  const s = readStatus(api("status-delivered").status);
  assert.deepEqual(s, { step: PAY_STEPS.length - 1, label: "Paid on NEAR", final: true, tone: "done" });
  assert.equal(readStatus("pending").step, 0);
  assert.equal(readStatus("pending").final, false);
  assert.equal(readStatus("forwarding").step, 1);
  assert.equal(readStatus("forwarding").final, false);
  for (const s of ["refunded", "failed"]) assert.equal(readStatus(s).final, true, s);
  assert.equal(readStatus("ambiguous").final, false);
  assert.equal(readStatus("something-new").final, false);
});

test("EVM address and tx hash checks", () => {
  assert.ok(isEvmAddress("0x01CDfD9807a7b26A1B3255b1bAb01eb550db5F1D"));
  assert.ok(!isEvmAddress("0x01CDfD9807a7b26A1B3255b1bAb01eb550db5F1"));
  assert.ok(!isEvmAddress("01CDfD9807a7b26A1B3255b1bAb01eb550db5F1D00"));
  assert.ok(!isEvmAddress("0x01CDfD9807a7b26A1B3255b1bAb01eb550db5F1D0"));
  assert.ok(isEvmTxHash(api("status-delivered").originTx));
  assert.ok(!isEvmTxHash("0x01CDfD9807a7b26A1B3255b1bAb01eb550db5F1D"));
});
