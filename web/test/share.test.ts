import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { customerHashOf, erc20TransferUri, invoiceShareText, isRealCustomerHash, telegramUrl, whatsappUrl } from "../src/lib/share.ts";

const URL_ = "https://cashflow.example/invoices/41";

test("share text names invoice, amount, merchant, the ask and the link", () => {
  const t = invoiceShareText({ invoiceNo: "INV-7", amount: "10500000", merchant: "shop.testnet", step: "approve" }, URL_);
  assert.equal(t, "Invoice INV-7 for 10.50 USDC from shop.testnet. Please review and approve it on-chain: https://cashflow.example/invoices/41");
  assert.match(invoiceShareText({ invoiceNo: "INV-7", amount: "1", merchant: "s.testnet", step: "pay" }, URL_), /pay it from NEAR or from Arbitrum/);
});

test("chat links are URL-encoded and Telegram does not repeat the link", () => {
  const t = invoiceShareText({ invoiceNo: "A&B #1", amount: "1000000", merchant: "s.testnet", step: "approve" }, URL_);
  const wa = new URL(whatsappUrl(t));
  assert.equal(wa.host, "wa.me");
  assert.equal(wa.searchParams.get("text"), t);
  const tg = new URL(telegramUrl(URL_, t));
  assert.equal(tg.searchParams.get("url"), URL_);
  assert.equal(tg.searchParams.get("text")!.includes(URL_), false);
});

test("EIP-681 transfer URI for Arbitrum Sepolia USDC", () => {
  const usdc = "0x38d81431b9f76d9699af7517040d5221d9dea252";
  const to = "0x000000000000000000000000000000000000dEaD";
  assert.equal(erc20TransferUri(usdc, 421614, to, "10000000"), `ethereum:${usdc}@421614/transfer?address=${to}&uint256=10000000`);
  assert.throws(() => erc20TransferUri(usdc, 421614, "0xabc", "1"));
  assert.throws(() => erc20TransferUri(usdc, 421614, to, "1.5"));
});

test("customer hash matches the merchant form's rule (trim + lower case + sha256)", async () => {
  const want = "sha256:" + createHash("sha256").update("buyer@example.com").digest("hex");
  assert.equal(await customerHashOf("  Buyer@Example.com "), want);
  assert.equal(isRealCustomerHash(want), true);
  assert.equal(isRealCustomerHash("sha256:demo-customer"), false);
});
