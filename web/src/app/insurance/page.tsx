import Link from "next/link";
import { Eyebrow } from "@/components/Ambient";
import type { Metadata } from "next";
import { getAllPools, getConfig, getInsurance, view } from "@/lib/chain";
import { coverProposalFor, summarizeProposal, type SputnikProposal } from "@/lib/dao";
import { formatNs } from "@/lib/format";
import { toBig } from "@/lib/amount";
import { Account, ErrorPanel, Info, Usdc } from "@/components/ui";

export const metadata: Metadata = { title: "Insurance" };
export const dynamic = "force-dynamic";

async function getProposals(dao: string): Promise<SputnikProposal[]> {
  const out: SputnikProposal[] = [];
  for (let from = 0; ; from += 50) {
    const page = await view<SputnikProposal[]>("get_proposals", { from_index: from, limit: 50 }, dao);
    out.push(...page);
    if (page.length < 50) return out;
  }
}

const Metric = ({ label, value, tip }: { label: string; value: React.ReactNode; tip: string }) => (
  <div className="card p-4">
    <dt className="text-xs text-muted">{label}<Info text={tip} /></dt>
    <dd className="mt-1 text-lg font-semibold">{value}</dd>
  </div>
);

export default async function InsurancePage() {
  let insurance, config, pools;
  try {
    [insurance, config, pools] = await Promise.all([getInsurance(), getConfig(), getAllPools()]);
  } catch (e) {
    return (
      <>
        <Eyebrow>Protection fund and DAO</Eyebrow>
<h1 className="text-3xl sm:text-4xl tracking-tight">Insurance</h1>
        <div className="mt-6"><ErrorPanel title="Waiting for NEAR testnet to load the insurance fund" detail={(e as Error).message} /></div>
      </>
    );
  }
  const proposals = await getProposals(config.dao_id).then((p) => p.map(summarizeProposal).sort((a, b) => b.id - a.id)).catch(() => null);
  const poolIds = new Set(pools.map((p) => p.id));
  const defaulted = pools.filter((p) => p.status === "Defaulted").sort((a, b) => b.id - a.id);

  return (
    <div className="space-y-10">
      <header>
        <Eyebrow>Protection fund and DAO</Eyebrow>
<h1 className="text-3xl sm:text-4xl tracking-tight">Insurance</h1>
        <p className="mt-1 text-sm text-muted">Half of every pool fee funds investor cover, and larger covers are approved by the insurance DAO.</p>
      </header>

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Fund balance" value={<Usdc value={insurance.balance} />} tip="Available to cover defaults." />
        <Metric label="Cover paid to date" value={<Usdc value={insurance.total_paid} />} tip="Total insurance paid out to investors in defaulted pools." />
        <Metric label="Treasury" value={<Usdc value={insurance.treasury} />} tip="The other half of pool fees." />
        <Metric label="DAO threshold" value={<Usdc value={config.dao_threshold} />} tip="Covers above this amount wait for a vote of the insurance DAO." />
      </dl>

      <section className="space-y-3">
        <h2 className="flex items-center text-lg font-semibold">
          Defaulted pools<Info text="Cover is capped at the lower of 50% of the junior face and 10% of the receivable." />
        </h2>
        {defaulted.length === 0 ? (
          <p className="text-sm text-muted">Every pool is in good standing.</p>
        ) : (
          <div className="overflow-x-auto card">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="border-b border-line text-left text-xs font-mono uppercase tracking-[0.08em] text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Pool</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Receivable</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Cover paid</th>
                  <th scope="col" className="px-4 py-3 font-medium">Cover</th>
                  <th scope="col" className="px-4 py-3 font-medium">DAO proposal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {defaulted.map((p) => {
                  const prop = proposals ? coverProposalFor(proposals, p.id) : null;
                  const waiting = toBig(p.pending_cover) > BigInt(0);
                  return (
                    <tr key={p.id}>
                      <td className="px-4 py-3">
                        <Link href={`/pools/${p.id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">#{p.id}</Link>
                      </td>
                      <td className="px-4 py-3 text-right"><Usdc value={p.receivable} /></td>
                      <td className="px-4 py-3 text-right"><Usdc value={p.insurance_paid} /></td>
                      <td className="px-4 py-3">
                        {waiting ? (
                          <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">Awaiting DAO vote · <Usdc value={p.pending_cover} unit={false} /></span>
                        ) : toBig(p.insurance_paid) > BigInt(0) ? (
                          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Paid</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{prop ? `#${prop.id} · ${prop.status}` : <span className="text-muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold">
          DAO proposals <span className="text-sm font-normal text-muted"><Account id={config.dao_id} /></span>
        </h2>
        {proposals === null ? (
          <p className="text-sm text-muted">Proposals are loading from the DAO. Refresh in a moment.</p>
        ) : proposals.length === 0 ? (
          <p className="text-sm text-muted">No proposals yet.</p>
        ) : (
          <ul className="space-y-3">
            {proposals.map((p) => (
              <li key={p.id} className="card p-4 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">#{p.id}</span>
                  <span>{p.description}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.status === "Approved" ? "bg-accent-soft text-accent" : p.status === "Voting" ? "bg-warn-soft text-warn" : "bg-sunken text-muted"}`}>
                    {p.status}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted">
                  <span className="font-mono">{p.action}</span> · {p.approve} approve, {p.reject} reject · {formatNs(p.submittedNs)}
                  {p.coverPoolId !== null && poolIds.has(p.coverPoolId) && <> · <Link className="underline" href={`/pools/${p.coverPoolId}`}>pool #{p.coverPoolId}</Link></>}
                </p>
                {p.voters.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {p.voters.map((v) => <li key={v.account}><Account id={v.account} link={false} /> <span className="text-muted">{v.vote}</span></li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
