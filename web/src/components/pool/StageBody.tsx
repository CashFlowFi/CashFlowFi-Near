"use client";
import { remaining, sum, toBig } from "@/lib/amount";
import { repoFileUrl } from "@/lib/config";
import { formatDuration, formatNs, shortHash } from "@/lib/format";
import type { StageKey, StageState } from "@/lib/stages";
import type { Order } from "@/lib/types";
import { useVerdict } from "@/lib/verdict";
import { Account, Info, Rows, Usdc } from "@/components/ui";
import type { WorkspaceProps } from "./PoolWorkspace";

type Props = WorkspaceProps & { stage: StageKey; state: StageState; settled: boolean };

const STATE_PILL: Record<StageState, [string, string]> = {
  done: ["Done", "bg-accent-soft text-accent"],
  current: ["In progress", "bg-warn-soft text-warn"],
  upcoming: ["Not reached", "bg-sunken text-muted"],
  missed: ["Did not happen", "bg-bad-soft text-bad"],
};

function Head({ title, state, line, tip }: { title: string; state: StageState; line: string; tip?: string }) {
  const [text, cls] = STATE_PILL[state];
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>
        {tip && <Info text={tip} />}
      </div>
      <p className="mt-1 text-sm text-muted">{line}</p>
    </div>
  );
}

export function StageBody(p: Props) {
  switch (p.stage) {
    case "invoice": return <InvoiceStage {...p} />;
    case "approved": return <ApprovedStage {...p} />;
    case "underwritten": return <UnderwrittenStage {...p} />;
    case "funded": return <FundedStage {...p} />;
    case "paid": return <PaidStage {...p} />;
    case "default": return <DefaultStage {...p} />;
    case "cover": return <CoverStage {...p} />;
    case "claimed": return <ClaimedStage {...p} />;
  }
}

function InvoiceStage({ orders, state, pool }: Props) {
  return (
    <>
      <Head title="Invoice" state={state} line={`The merchant recorded ${orders.length === 1 ? "a credit sale" : `${orders.length} credit sales`} on-chain.`} />
      {orders.map((o) => (
        <Rows
          key={o.id}
          rows={[
            ["Invoice", <span key="i" className="font-mono">{o.invoice_no}</span>],
            ["Amount", <Usdc key="a" value={o.amount} />],
            ["Merchant", <Account key="m" id={pool.merchant} />],
            ["Created", formatNs(o.created_at)],
            ["Due", formatNs(o.due_date)],
          ]}
        />
      ))}
    </>
  );
}

function ApprovedStage({ orders, state }: Props) {
  return (
    <>
      <Head title="Approved by the customer" state={state} line="The customer confirmed the invoice from their own account." tip="The contract rejects an approval from the merchant's own account." />
      {orders.map((o) => (
        <Rows key={o.id} rows={[["Invoice", <span key="i" className="font-mono">{o.invoice_no}</span>], ["Customer", <Account key="c" id={o.customer} />]]} />
      ))}
    </>
  );
}

function UnderwrittenStage({ orders, state }: Props) {
  return (
    <>
      <Head title="Underwritten" state={state} line="The AI underwriter scored the invoice and wrote its verdict on-chain." tip="Approve at 70 or more, Flag 40–69, Reject below 40. Only approved invoices can be pooled." />
      <div className="space-y-6">{orders.map((o) => <VerdictCard key={o.id} order={o} />)}</div>
    </>
  );
}

function VerdictCard({ order }: { order: Order }) {
  const v = useVerdict(order.id);
  const verified = v.kind === "ok" && v.data.attestation?.verified === true;
  return (
    <div>
      <Rows
        rows={[
          ["Verdict", <span key="v" className="font-medium">{order.verdict ?? "none yet"}</span>],
          ["Score", order.score === null ? "—" : <span key="s" className="num">{order.score} / 100</span>],
          ["Reason hash", order.reason_hash ? <span key="h" className="font-mono text-xs" title={order.reason_hash}>{shortHash(order.reason_hash, 8)}</span> : "—"],
          [
            "Attestation",
            v.kind === "loading" ? <span key="l" className="text-muted">checking…</span>
              : v.kind === "unavailable" ? <span key="u" className="text-muted">details unavailable ({v.reason})</span>
              : verified ? (
                <span key="t" className="inline-flex items-center gap-2">
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">TEE verified</span>
                  {v.data.attestation?.report_url && <a className="text-xs underline" href={repoFileUrl(v.data.attestation.report_url)} target="_blank" rel="noreferrer">report</a>}
                </span>
              ) : <span key="n" className="text-muted">not verified</span>,
          ],
        ]}
      />
      {v.kind === "ok" && v.data.reasons && v.data.reasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
          {v.data.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}

function FundedStage({ pool, positions, state }: Props) {
  const tranches = [
    { name: "Senior", tip: "Paid first.", target: pool.senior_target, funded: pool.senior_funded, face: pool.senior_face },
    { name: "Junior", tip: "Takes the first loss, earns more.", target: pool.junior_target, funded: pool.junior_funded, face: pool.junior_face },
  ];
  const full = tranches.every((t) => toBig(t.funded) >= toBig(t.target));
  const line = state === "done"
    ? "Both tranches filled, the merchant received the advance minus the fee, and each investor got a position NFT."
    : full
      ? "Both tranches are full but the advance transfer has not gone through yet."
      : "Investors are filling the senior and junior tranches.";
  return (
    <>
      <Head title="Funded" state={state} line={line} tip="Half the fee goes to the insurance fund and half to the treasury." />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th scope="col" className="py-2 font-medium">Tranche</th>
              <th scope="col" className="py-2 text-right font-medium">Funded</th>
              <th scope="col" className="py-2 text-right font-medium">Target</th>
              <th scope="col" className="py-2 text-right font-medium">Room left</th>
              <th scope="col" className="py-2 text-right font-medium">Owed back</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-t border-line">
            {tranches.map((t) => (
              <tr key={t.name}>
                <th scope="row" className="py-2 text-left font-medium">{t.name}<Info text={t.tip} /></th>
                <td className="py-2 text-right"><Usdc value={t.funded} unit={false} /></td>
                <td className="py-2 text-right"><Usdc value={t.target} unit={false} /></td>
                <td className="py-2 text-right"><Usdc value={remaining(t.target, t.funded)} unit={false} /></td>
                <td className="py-2 text-right"><Usdc value={t.face} unit={false} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4">
        <Rows
          rows={[
            ["Advance", <Usdc key="a" value={pool.advance} />],
            ["Fee", <Usdc key="f" value={pool.fee} />],
            ["Merchant received", state === "done" ? <Usdc key="r" value={toBig(pool.advance) - toBig(pool.fee)} /> : <span key="r" className="text-muted">not yet</span>],
            ["Position NFTs", positions ? positions.map((x) => x.token_id).join(", ") || "none yet" : <span key="u" className="text-muted">unavailable</span>],
          ]}
        />
      </div>
    </>
  );
}

function PaidStage({ pool, orders, state }: Props) {
  const paid = sum(...orders.map((o) => o.paid));
  const defaulted = pool.status === "Defaulted";
  const line = state === "done"
    ? "The customer paid in full and the waterfall paid senior, then junior, then any insurance refill, then the merchant's residual."
    : state === "missed"
      ? "The customer did not pay in full before the due date plus grace."
      : state === "current"
        ? "Waiting for the customer to pay. Each payment runs the waterfall."
        : "Payment starts once the pool is funded.";
  return (
    <>
      <Head title="Paid" state={state} line={line} tip="Payments arrive on NEAR directly or from another chain through Tidepool; both land through the token's ft_transfer_call." />
      <Rows
        rows={[
          ["Paid by customer", <span key="p"><Usdc value={paid} unit={false} /> / <Usdc value={pool.receivable} /></span>],
          [defaulted ? "Senior repaid (incl. cover)" : "Senior repaid", <span key="s"><Usdc value={pool.senior_repaid} unit={false} /> / <Usdc value={pool.senior_face} /></span>],
          [defaulted ? "Junior repaid (incl. cover)" : "Junior repaid", <span key="j"><Usdc value={pool.junior_repaid} unit={false} /> / <Usdc value={pool.junior_face} /></span>],
          ["Insurance refilled", <Usdc key="i" value={pool.insurance_refilled} />],
          ["Residual to merchant", <Usdc key="r" value={pool.residual_paid} />],
        ]}
      />
    </>
  );
}

function DefaultStage({ pool, config, state }: Props) {
  return (
    <>
      <Head title="Default" state={state} line="The due date and grace period passed without full payment, so the pool was marked defaulted." />
      <Rows rows={[["Due", formatNs(pool.due_date)], ["Grace period", formatDuration(config.grace_ns)]]} />
    </>
  );
}

function CoverStage({ pool, config, state }: Props) {
  const aboveThreshold = toBig(pool.insurance_paid) > toBig(config.dao_threshold) || toBig(pool.pending_cover) > toBig(config.dao_threshold);
  const line = state === "current"
    ? "The cover is above the DAO threshold and waits for the insurance DAO to approve it."
    : state === "done"
      ? aboveThreshold ? "The insurance DAO approved the cover and the fund paid investors." : "The insurance fund paid investors automatically."
      : "No insurance cover was paid for this pool.";
  return (
    <>
      <Head title="Insurance cover" state={state} line={line} tip="Cover is capped at the lower of 50% of the junior face and 10% of the receivable. Covers above the threshold need a Sputnik DAO vote." />
      <Rows
        rows={[
          ["Cover paid", <Usdc key="c" value={pool.insurance_paid} />],
          ["Waiting for DAO", <Usdc key="w" value={pool.pending_cover} />],
          ["DAO threshold", <Usdc key="t" value={config.dao_threshold} />],
          ["Insurance DAO", <Account key="d" id={config.dao_id} />],
        ]}
      />
    </>
  );
}

function ClaimedStage({ pool, positions, state, settled }: Props) {
  const owed = sum(pool.senior_repaid, pool.junior_repaid);
  const line = settled
    ? "Every payout this pool made has been claimed by the position holders."
    : state === "current"
      ? "Payouts are waiting for the current NFT holders to claim them."
      : "Claims open once payments arrive.";
  return (
    <>
      <Head title={settled ? "Result" : "Claimed"} state={state} line={line} tip="Payouts go to whoever holds the position NFT at claim time." />
      {positions === null ? (
        <p className="text-sm text-muted">Positions unavailable: the NFT read from NEAR failed.</p>
      ) : positions.length === 0 ? (
        <p className="text-sm text-muted">No positions minted yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th scope="col" className="py-2 font-medium">Position</th>
                <th scope="col" className="py-2 font-medium">Holder</th>
                <th scope="col" className="py-2 text-right font-medium">Invested</th>
                <th scope="col" className="py-2 text-right font-medium">Claimed</th>
                <th scope="col" className="py-2 text-right font-medium">Claimable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line border-t border-line">
              {positions.map((x) => (
                <tr key={x.token_id}>
                  <th scope="row" className="py-2 text-left font-medium">{x.tranche} <span className="font-mono text-xs text-muted">{x.token_id}</span></th>
                  <td className="py-2"><Account id={x.owner} /></td>
                  <td className="py-2 text-right"><Usdc value={x.amount} unit={false} /></td>
                  <td className="py-2 text-right"><Usdc value={x.claimed} unit={false} /></td>
                  <td className="py-2 text-right"><Usdc value={x.claimable} unit={false} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-sm text-muted">
            Claimed <Usdc value={sum(...positions.map((x) => x.claimed))} unit={false} /> of <Usdc value={owed} /> paid out to the tranches.
          </p>
        </div>
      )}
    </>
  );
}
