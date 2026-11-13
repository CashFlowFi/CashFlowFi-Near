import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { csvCell, invoicesCsv, INVOICE_COLUMNS } from "../src/lib/csv.ts";

const order37 = JSON.parse(readFileSync(new URL("./fixtures/pool-22.json", import.meta.url), "utf8")).orders[0];

test("cells are quoted only when needed and never start a formula", () => {
  assert.equal(csvCell("INV-1"), "INV-1");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-5"), "'-5");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(0), "0");
});

test("real order 37 becomes one plain row an accountant can sum", () => {
  const lines = invoicesCsv([order37]).trimEnd().split("\r\n");
  assert.equal(lines[0], INVOICE_COLUMNS.join(","));
  assert.equal(lines[1], "37,DEMO-1794501891775,Paid,USDC,10.00,10.00,0.00,2026-11-12,2026-12-12,customer.cashflowfi.testnet,22,Approve,92");
});

test("amounts drop thousands separators so they stay numeric", () => {
  const big = { ...order37, amount: "1234567890000", paid: "0" };
  assert.match(invoicesCsv([big]), /,1234567\.89,0\.00,1234567\.89,/);
});
