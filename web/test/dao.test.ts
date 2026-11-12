import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coverProposalFor, summarizeProposal, type ProposalSummary, type SputnikProposal } from "../src/lib/dao.ts";

// Real get_proposals output from dao.cashflowfi.testnet on 2026-11-13.
const proposals: SputnikProposal[] = JSON.parse(readFileSync(new URL("./fixtures/dao-proposals.json", import.meta.url), "utf8"));
const all: ProposalSummary[] = proposals.map(summarizeProposal);

test("proposal 5 is the approved cover for pool 25 with two approvals", () => {
  const p = all.find((s) => s.id === 5)!;
  assert.equal(p.coverPoolId, 25);
  assert.equal(p.action, "approve_cover · pool 25");
  assert.equal(p.status, "Approved");
  assert.equal(p.approve, 2);
  assert.equal(p.reject, 0);
  assert.deepEqual(p.voters.map((v) => v.account), ["alice.cashflowfi.testnet", "cashflowfi.testnet"]);
});

test("each cover proposal decodes its own pool id", () => {
  assert.deepEqual(all.map((s) => s.coverPoolId), [999, 5, 9, 13, 21, 25]);
});

test("Sputnik statuses get neutral labels", () => {
  assert.equal(all[0].status, "Closed");
  assert.equal(summarizeProposal({ ...proposals[0], status: "InProgress" }).status, "Voting");
});

test("coverProposalFor picks the latest proposal for the pool", () => {
  assert.equal(coverProposalFor(all, 25)?.id, 5);
  assert.equal(coverProposalFor(all, 22), null);
  const dup = [...all, { ...all[5], id: 9 }];
  assert.equal(coverProposalFor(dup, 25)?.id, 9);
});

test("non-function-call kinds summarise by kind name", () => {
  const s = summarizeProposal({ ...proposals[0], kind: { Transfer: { token_id: "", receiver_id: "x", amount: "1" } } });
  assert.equal(s.action, "Transfer");
  assert.equal(s.coverPoolId, null);
});

test("votes are summed across every role", () => {
  const s = summarizeProposal({ ...proposals[5], vote_counts: { council: [2, 0, 0], investors: [1, 1, 0] } });
  assert.equal(s.approve, 3);
  assert.equal(s.reject, 1);
});
