// Sputnik DAO v2 proposal summaries for the insurance page.

export interface SputnikProposal {
  id: number;
  proposer: string;
  description: string;
  kind: Record<string, unknown> | string;
  status: string;
  vote_counts: Record<string, [number, number, number]>;
  votes: Record<string, string>;
  submission_time: string;
}

export interface ProposalSummary {
  id: number;
  description: string;
  status: string;
  /** e.g. "approve_cover · pool 25" */
  action: string;
  coverPoolId: number | null;
  approve: number;
  reject: number;
  voters: { account: string; vote: string }[];
  submittedNs: string;
}

const STATUS_LABEL: Record<string, string> = {
  InProgress: "Voting",
  Approved: "Approved",
  Rejected: "Rejected",
  Removed: "Removed",
  Expired: "Expired",
  Moved: "Moved",
  Failed: "Closed",
};

const decode = (b64: string) =>
  typeof atob === "function" ? new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))) : Buffer.from(b64, "base64").toString("utf8");

export function summarizeProposal(p: SputnikProposal): ProposalSummary {
  let action = typeof p.kind === "string" ? p.kind : Object.keys(p.kind)[0] ?? "Unknown";
  let coverPoolId: number | null = null;
  const fc = typeof p.kind === "object" ? (p.kind.FunctionCall as { receiver_id: string; actions: { method_name: string; args: string }[] } | undefined) : undefined;
  if (fc && fc.actions.length > 0) {
    const a = fc.actions[0];
    action = a.method_name;
    try {
      const args = JSON.parse(decode(a.args));
      if (a.method_name === "approve_cover" && Number.isInteger(args.pool_id)) {
        coverPoolId = args.pool_id;
        action = `approve_cover · pool ${args.pool_id}`;
      }
    } catch {}
  }
  let approve = 0;
  let reject = 0;
  for (const [a, r] of Object.values(p.vote_counts ?? {})) {
    approve += a;
    reject += r;
  }
  return {
    id: p.id,
    description: p.description,
    status: STATUS_LABEL[p.status] ?? p.status,
    action,
    coverPoolId,
    approve,
    reject,
    voters: Object.entries(p.votes ?? {}).map(([account, vote]) => ({ account, vote })).sort((x, y) => x.account.localeCompare(y.account)),
    submittedNs: p.submission_time,
  };
}

/** The latest approve_cover proposal for a pool, if any. */
export function coverProposalFor(summaries: ProposalSummary[], poolId: number): ProposalSummary | null {
  return summaries.filter((s) => s.coverPoolId === poolId).sort((a, b) => b.id - a.id)[0] ?? null;
}
