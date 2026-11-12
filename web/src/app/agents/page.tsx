import Link from "next/link";
import type { Metadata } from "next";
import { getAllOrders } from "@/lib/chain";
import { API_URL, repoFileUrl, txUrl } from "@/lib/config";
import { shortHash } from "@/lib/format";
import type { Reminder, TierChange } from "@/lib/agents";
import data from "@/data/agents.json";
import { Account, ErrorPanel, Info, Usdc } from "@/components/ui";
import { VerdictAttestation } from "@/components/agents/VerdictAttestation";

export const metadata: Metadata = { title: "Agents" };
export const dynamic = "force-dynamic";

const { tiers, reminders } = data as { tiers: TierChange[]; reminders: Reminder[] };
const VERDICTS_SHOWN = 20;

const TeeBadge = () => <span className="inline-flex items-center gap-1 rounded-full bg-ai-soft px-2 py-0.5 text-xs font-medium text-ai"><span aria-hidden="true">◆</span>TEE verified</span>;
const H2 = ({ children, tip }: { children: React.ReactNode; tip?: string }) => (
  <h2 className="flex items-center text-lg font-semibold">{children}{tip && <Info text={tip} />}</h2>
);
const iso = (s: string | null) => (s ? `${s.replace("T", " ").slice(0, 16)} UTC` : "—");

export default async function AgentsPage() {
  let orders;
  let error: string | null = null;
  try {
    orders = (await getAllOrders()).filter((o) => o.verdict !== null).sort((a, b) => b.id - a.id).slice(0, VERDICTS_SHOWN);
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-sm text-muted">The underwriter scores every invoice on-chain, and the collections agent writes reminders inside a TEE.</p>
      </header>

      <section className="space-y-3">
        <H2 tip="Verdict and score are read from the contract. The badge shows when the API re-checks the TEE signature bound to that verdict.">Underwriter verdicts</H2>
        {error ? (
          <ErrorPanel title="Waiting for NEAR testnet to load verdicts" detail={error} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Invoice</th>
                  <th scope="col" className="px-4 py-3 font-medium">Verdict</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Score</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
                  {API_URL && <th scope="col" className="px-4 py-3 font-medium">Attestation</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {orders!.map((o) => (
                  <tr key={o.id}>
                    <td className="px-4 py-3">
                      <Link href={`/invoices/${o.id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">#{o.id}</Link>
                      <span className="ml-2 font-mono text-xs text-muted">{o.invoice_no}</span>
                    </td>
                    <td className="px-4 py-3">{o.verdict}</td>
                    <td className="num px-4 py-3 text-right">{o.score ?? "—"}</td>
                    <td className="px-4 py-3 text-right"><Usdc value={o.amount} /></td>
                    {API_URL && <td className="px-4 py-3"><VerdictAttestation orderId={o.id} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <H2 tip="The agent moves a merchant between tiers A–D from its repayment record. Tier sets the advance: 85 / 80 / 70 / 60 %.">Merchant tiers</H2>
        {tiers.length === 0 ? (
          <p className="text-sm text-muted">No tier changes recorded.</p>
        ) : (
          <ul className="space-y-3">
            {tiers.map((t) => (
              <li key={t.file} className="rounded-lg border border-line bg-surface p-4 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Account id={t.merchant} />
                  <span className="font-medium">Tier {t.old_tier} → {t.new_tier}</span>
                  {t.teeVerified && <TeeBadge />}
                </div>
                <p className="mt-2">{t.reason}</p>
                <p className="mt-2 text-xs text-muted">
                  {iso(t.timestamp)}
                  {t.tx_hash && <> · <a className="font-mono underline" href={txUrl(t.tx_hash)} target="_blank" rel="noreferrer">{shortHash(t.tx_hash)}</a></>}
                  {" · "}<a className="underline" href={repoFileUrl(t.file)} target="_blank" rel="noreferrer">evidence</a>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <H2 tip="Before the due date the collections agent drafts a reminder with a NEAR AI model inside a TEE. The badge shows when the TEE checks passed for that message.">Payment reminders</H2>
        {reminders.length === 0 ? (
          <p className="text-sm text-muted">No reminders recorded.</p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {reminders.map((r) => (
              <li key={r.file} className="rounded-lg border border-line bg-surface p-4 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={`/invoices/${r.order_id}`} className="font-medium underline decoration-line underline-offset-2">Invoice #{r.order_id}</Link>
                  <Usdc value={r.amount_due} />
                  {r.teeVerified && <TeeBadge />}
                </div>
                <p className="mt-1 text-xs text-muted">To <Account id={r.customer} link={false} /> · {iso(r.reminded_at)}</p>
                <div className="mt-3 rounded-md bg-sunken p-3">
                  <p className="font-medium">{r.subject}</p>
                  <p className="mt-2 whitespace-pre-line text-muted">{r.body}</p>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {r.model && <>{r.model} · </>}
                  <a className="underline" href={repoFileUrl(r.file)} target="_blank" rel="noreferrer">evidence</a>
                  {r.pool_id !== null && <> · <Link className="underline" href={`/pools/${r.pool_id}`}>pool #{r.pool_id}</Link></>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
