import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtra } from "../src/lib/positions.ts";

// metadata.extra of token 10-17 as returned by nft_tokens on testnet.
const REAL = '{"pool_id":10,"tranche":"Senior","amount":"6000000","claimed":"6375000","claimable":"0","pool_status":"Repaid"}';

test("parses the real extra", () => {
  assert.deepEqual(parseExtra(REAL), { pool_id: 10, tranche: "Senior", amount: "6000000", claimed: "6375000", claimable: "0", pool_status: "Repaid" });
});

test("rejects anything off-shape instead of guessing", () => {
  assert.equal(parseExtra(undefined), null);
  assert.equal(parseExtra("not json"), null);
  assert.equal(parseExtra(REAL.replace('"claimable":"0"', '"claimable":0')), null);
  assert.equal(parseExtra(REAL.replace('"claimable":"0"', '"claimable":"1.5"')), null);
  assert.equal(parseExtra(REAL.replace("Senior", "Mezz")), null);
  assert.equal(parseExtra(REAL.replace('"pool_id":10', '"pool_id":"10"')), null);
  assert.equal(parseExtra(REAL.replace("Repaid", "Gone")), null);
});
