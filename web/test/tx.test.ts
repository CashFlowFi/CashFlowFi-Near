/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures are raw RPC JSON */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { approveTx, claimTxs, friendlyError, investTx, parseUsdcInput, payTx, readOutcome, toInputString, STORAGE_DEPOSIT } from "../src/lib/tx.ts";

// Real testnet outcomes (tx method, wait_until FINAL) for txs listed in evidence/demo-run.json and evidence/attacks/onchain.json.
const tx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/tx/${name}.json`, import.meta.url), "utf8"));
const C = { cashflow: "cashflow.cashflowfi.testnet", token: "usdc.tidepool-sandbox.testnet" };
const withSuccess = (o: any, v: string) => ({ ...o, status: { SuccessValue: Buffer.from(JSON.stringify(v)).toString("base64") } });

test("parseUsdcInput reads typed amounts exactly", () => {
  assert.equal(parseUsdcInput("1.5"), BigInt(1500000));
  assert.equal(parseUsdcInput("1,000.000001"), BigInt(1000000001));
  assert.equal(parseUsdcInput(" 4.78125 "), BigInt(4781250));
  assert.equal(parseUsdcInput(".5"), BigInt(500000));
  assert.equal(parseUsdcInput("7."), BigInt(7000000));
  assert.equal(parseUsdcInput("0"), BigInt(0));
  for (const bad of ["", ".", "-1", "1e3", "1.0000001", "abc", "1.2.3", "0x10"]) assert.equal(parseUsdcInput(bad), null, bad);
});

test("toInputString round-trips through parseUsdcInput", () => {
  for (const v of ["4781250", "1195312", "6000000", "1", "0", "1000000001"]) {
    assert.equal(parseUsdcInput(toInputString(v)), BigInt(v));
  }
  assert.equal(toInputString("6000000"), "6");
  assert.equal(toInputString("4781250"), "4.78125");
});

test("invest is ft_transfer_call on the token with 1 yocto, 150 TGas and the invest msg", () => {
  const t = investTx(C, "x.testnet", 22, "Senior", BigInt(4500000), true);
  assert.equal(t.receiverId, C.token);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0], {
    method: "ft_transfer_call",
    args: { receiver_id: C.cashflow, amount: "4500000", msg: '{"invest":{"pool_id":22,"tranche":"Senior"}}' },
    gas: "150000000000000",
    deposit: "1",
  });
});

test("an unregistered payer gets storage_deposit first, in the same transaction", () => {
  const t = payTx(C, "x.testnet", 37, BigInt(10000000), false);
  assert.equal(t.receiverId, C.token);
  assert.deepEqual(t.calls.map((c) => c.method), ["storage_deposit", "ft_transfer_call"]);
  assert.equal(t.calls[0].deposit, STORAGE_DEPOSIT);
  assert.deepEqual(t.calls[0].args, { account_id: "x.testnet", registration_only: true });
  assert.equal((t.calls[1].args as any).msg, '{"pay":{"order_id":37}}');
});

test("zero or negative transfers are refused before signing", () => {
  assert.throws(() => payTx(C, "x.testnet", 1, BigInt(0), true));
});

test("claims: one tx per position on the contract, registration as its own tx on the token", () => {
  const reg = claimTxs(C, "x.testnet", ["22-41", "22-42"], true);
  assert.deepEqual(reg.map((t) => [t.receiverId, t.calls[0].method, t.calls[0].gas]), [
    [C.cashflow, "claim", "100000000000000"],
    [C.cashflow, "claim", "100000000000000"],
  ]);
  const unreg = claimTxs(C, "x.testnet", ["22-41"], false);
  assert.deepEqual(unreg.map((t) => [t.receiverId, t.calls[0].method]), [[C.token, "storage_deposit"], [C.cashflow, "claim"]]);
  assert.deepEqual(approveTx(C, 37).calls[0].args, { id: 37 });
});

test("real invest outcome: full amount used, invested event read", () => {
  const r = readOutcome(tx("invest-senior"));
  assert.equal(r.ok, true);
  assert.equal(r.hash, "FEnmKDP5T3k2qaQ3z5VcFpoQKNsSdW65icRr3bkEjUDc");
  assert.deepEqual(r.transfer, { sent: BigInt(4500000), used: BigInt(4500000), refunded: BigInt(0) });
  assert.deepEqual(r.events.map((e) => e.event), ["invested"]);
});

test("real junior invest activates the pool", () => {
  const r = readOutcome(tx("invest-junior"));
  assert.ok(r.events.some((e) => e.event === "pool_activated"));
});

test("real pay outcome runs the waterfall", () => {
  const r = readOutcome(tx("pay"));
  assert.equal(r.ok, true);
  assert.equal(r.transfer!.used, BigInt(10000000));
  assert.ok(r.events.some((e) => e.event === "payment_applied"));
});

test("partial use reports the refund", () => {
  const r = readOutcome(withSuccess(tx("invest-senior"), "4000000"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.transfer, { sent: BigInt(4500000), used: BigInt(4000000), refunded: BigInt(500000) });
});

test("a fully refunded transfer is not reported as success", () => {
  const r = readOutcome(withSuccess(tx("invest-senior"), "0"));
  assert.equal(r.ok, false);
  assert.equal(r.transfer!.refunded, BigInt(4500000));
  assert.match(r.error!, /returned to your account/);
});

test("real claim and approve outcomes succeed without a transfer block", () => {
  const c = readOutcome(tx("claim"));
  assert.equal(c.ok, true);
  assert.equal(c.transfer, null);
  assert.deepEqual(c.events.map((e) => e.event), ["claimed"]);
  assert.deepEqual(readOutcome(tx("approve")).events.map((e) => e.event), ["receipt_approved"]);
});

test("real failures map to friendly messages", () => {
  const a = readOutcome(tx("fail-self-approve"));
  assert.equal(a.ok, false);
  assert.equal(a.error, "Invoices are approved from the customer's account. Sign in as the customer.");
  assert.equal(readOutcome(tx("fail-claim-not-owner")).error, "Only the current holder of this position NFT can claim it.");
  assert.equal(friendlyError("something new"), "something new");
});
