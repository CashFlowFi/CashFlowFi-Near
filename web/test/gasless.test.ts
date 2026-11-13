/* eslint-disable @typescript-eslint/no-explicit-any -- relayer modules are untyped .mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "@near-js/crypto";
import { gaslessEligible, signDelegateBase64 } from "../src/lib/gasless.ts";
import { approveTx, claimTxs, createPoolTx, investTx, nftTransferTx } from "../src/lib/tx.ts";
// The relayer's own code, proven live in evidence/relayer-run.json.
import { signDelegate } from "../../relayer/client.mjs";
import { decodeSignedDelegate, verifyDelegateSignature } from "../../relayer/decode.mjs";
import { validateDelegate, checkAccessKey } from "../../relayer/policy.mjs";
import { KeyPairSigner as RootSigner, actions as rootActions } from "../../node_modules/near-api-js/lib/index.js";

const C = { cashflow: "cashflow.cashflowfi.testnet", token: "usdc.tidepool-sandbox.testnet" };
const POLICY = { contractId: C.cashflow, tokenId: C.token, relayerId: "cashflowfi.testnet" };
const key = KeyPair.fromRandom("ed25519");
const fcKey = { privateKey: key.toString(), contractId: C.cashflow, methods: [] };
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

test("UI-signed delegate is byte-identical to the relayer client's for the same key, nonce and height", async () => {
  const spec = approveTx(C, 41);
  const ui = await signDelegateBase64({ privateKey: key.toString(), senderId: "buyer.testnet", spec, nonce: BigInt(7), maxBlockHeight: BigInt(1000) });
  const c = spec.calls[0];
  const ref = await signDelegate({
    signer: RootSigner.fromSecretKey(key.toString() as any), senderId: "buyer.testnet", receiverId: C.cashflow,
    actions: [rootActions.functionCall(c.method, c.args, BigInt(c.gas), BigInt(c.deposit))], nonce: 7, maxBlockHeight: 1000,
  });
  assert.equal(ui.encoded, ref.encoded);
});

test("relayer decodes, verifies the signature, and accepts approve and claim under a function-call key", async () => {
  for (const spec of [approveTx(C, 41), claimTxs(C, "buyer.testnet", ["22-41"], true)[0], createPoolTx(C, [41])]) {
    const { encoded } = await signDelegateBase64({ privateKey: key.toString(), senderId: "buyer.testnet", spec, nonce: BigInt(9), maxBlockHeight: BigInt(2000) });
    const d: any = decodeSignedDelegate(fromB64(encoded));
    assert.equal(verifyDelegateSignature(d.signedDelegate), true);
    assert.equal(d.senderId, "buyer.testnet");
    validateDelegate(d, POLICY);
    checkAccessKey({ nonce: 3, permission: { FunctionCall: { receiver_id: C.cashflow, method_names: [] } } }, d);
  }
});

test("a tampered delegate fails the relayer's signature check", async () => {
  const { encoded } = await signDelegateBase64({ privateKey: key.toString(), senderId: "buyer.testnet", spec: approveTx(C, 41), nonce: BigInt(9), maxBlockHeight: BigInt(2000) });
  const good: any = decodeSignedDelegate(fromB64(encoded));
  assert.equal(verifyDelegateSignature(good.signedDelegate), true);
  const bytes = fromB64(encoded);
  bytes[bytes.length - 1] ^= 1; // last byte of the signature: still decodes, must not verify
  const bad: any = decodeSignedDelegate(bytes);
  assert.equal(verifyDelegateSignature(bad.signedDelegate), false);
});

test("only zero-deposit calls on the cashflow contract with a matching key are gas-free", () => {
  assert.equal(gaslessEligible(approveTx(C, 41), fcKey, C.cashflow), true);
  assert.equal(gaslessEligible(claimTxs(C, "b.testnet", ["1-1"], true)[0], fcKey, C.cashflow), true);
  assert.equal(gaslessEligible(investTx(C, "b.testnet", 1, "Senior", BigInt(1), true), fcKey, C.cashflow), false, "token receiver");
  assert.equal(gaslessEligible(nftTransferTx(C, "c.testnet", "1-1"), fcKey, C.cashflow), false, "1 yocto deposit");
  const withDeposit = approveTx(C, 41);
  withDeposit.calls[0] = { ...withDeposit.calls[0], deposit: "1" };
  assert.equal(gaslessEligible(withDeposit, fcKey, C.cashflow), false, "allowed method but with a deposit");
  assert.equal(gaslessEligible(approveTx(C, 41), null, C.cashflow), false, "no key");
  assert.equal(gaslessEligible(approveTx(C, 41), { ...fcKey, contractId: "other.testnet" }, C.cashflow), false, "key for another contract");
  assert.equal(gaslessEligible(approveTx(C, 41), { ...fcKey, methods: ["claim"] }, C.cashflow), false, "method not on key");
});
