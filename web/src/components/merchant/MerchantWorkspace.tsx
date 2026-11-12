"use client";
import Link from "next/link";
import { Eyebrow } from "@/components/Ambient";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CONTRACT, TOKEN } from "@/lib/config";
import { sum, toBig } from "@/lib/amount";
import { getAllPools, getOrdersByMerchant, getTier, getWithdrawable } from "@/lib/chain";
import { poolTerms } from "@/lib/merchant";
import { createPoolTx, withdrawResidualTx } from "@/lib/tx";
import { TIER_LTV, type Order, type Pool, type Tier } from "@/lib/types";
import { formatNs } from "@/lib/format";
import { useWallet } from "@/components/wallet/WalletProvider";
import { useTx } from "@/components/actions/useTx";
import { TxResultView } from "@/components/actions/TxResultView";
import { ErrorPanel, Info, Rows, StatusBadge, Usdc } from "@/components/ui";
import { NewInvoiceForm } from "./NewInvoiceForm";

const DEMO = "merchant.cashflowfi.testnet";
const C = { cashflow: CONTRACT, token: TOKEN };
const BTN = "rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

interface Data { orders: Order[]; pools: Pool[]; tier: Tier; withdrawable: string }

export function MerchantWorkspace({ demo }: { demo: boolean }) {
  const { accountId, ready, signIn } = useWallet();
  const viewing = accountId ?? (demo ? DEMO : null);
  const own = !!accountId;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!viewing) return;
    try {
      const [orders, pools, tier, withdrawable] = await Promise.all([
        getOrdersByMerchant(viewing), getAllPools(), getTier(viewing), getWithdrawable(viewing),
      ]);
      setData({ orders: orders.sort((a, b) => b.id - a.id), pools: pools.filter((p) => p.merchant === viewing).sort((a, b) => b.id - a.id), tier, withdrawable });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [viewing]);
  useEffect(() => { setData(null); load(); }, [load]);
  // Verdicts arrive from the agent within a minute; keep the list current.
  useEffect(() => {
    if (!viewing) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [viewing, load]);

  if (!viewing) {
    return (
      <section className="max-w-xl py-6">
        <Eyebrow>Merchant desk</Eyebrow>
<h1 className="text-3xl sm:text-4xl tracking-tight">Merchant</h1>
        <p className="mt-1 text-sm text-muted">Sign in to create invoices, follow their verdicts and open pools.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={signIn} disabled={!ready} className={BTN}>Sign in</button>
          <Link href={`/merchant?account=${DEMO}`} className="rounded-md border border-line bg-surface px-4 py-2.5 text-sm font-medium hover:bg-sunken">View the demo merchant</Link>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Merchant desk</Eyebrow>
<h1 className="text-3xl sm:text-4xl tracking-tight">Merchant</h1>
          <p className="mt-1 text-sm text-muted">
            {own ? <>Signed in as <span className="font-medium text-ink">{viewing}</span>.</> : <>Viewing the demo merchant account <span className="font-medium text-ink">{viewing}</span>.</>}
          </p>
        </div>
        {data && (
          <span className="rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent">
            Tier {data.tier} · {TIER_LTV[data.tier]}% advance
            <Info text="The underwriter agent sets the tier from repayment history. A 85%, B 80%, C 70%, D 60% of each receivable is advanced." />
          </span>
        )}
      </header>
      {error && <ErrorPanel title="Waiting for NEAR testnet to load your merchant data" detail={error} />}
      {!data && !error && <div aria-busy="true" className="h-64 animate-pulse rounded-lg bg-sunken" />}
      {data && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Invoices data={data} own={own} onDone={load} />
            <aside className="space-y-4 self-start">
              {own ? (
                <div className="card p-5">
                  <h2 className="font-semibold">New invoice</h2>
                  <div className="mt-3"><NewInvoiceForm onDone={load} /></div>
                </div>
              ) : (
                <div className="card p-5">
                  <h2 className="font-semibold">New invoice</h2>
                  <p className="mt-1 text-sm text-muted">Sign in with your own account to create invoices.</p>
                  <button type="button" onClick={signIn} className={`${BTN} mt-3 w-full`}>Sign in</button>
                </div>
              )}
              {own && toBig(data.withdrawable) > BigInt(0) && <Withdraw amount={data.withdrawable} onDone={load} />}
            </aside>
          </div>
          <Pools pools={data.pools} />
        </>
      )}
    </div>
  );
}

function Invoices({ data, own, onDone }: { data: Data; own: boolean; onDone: () => void }) {
  const poolable = data.orders.filter((o) => o.status === "Attested" && o.verdict === "Approve");
  const [picked, setPicked] = useState<number[]>([]);
  const [all, setAll] = useState(false);
  // Approved invoices ready to pool come first, then the most recent.
  const sorted = [...poolable, ...data.orders.filter((o) => !poolable.includes(o))];
  const shown = all ? sorted : sorted.slice(0, 10);
  const tx = useTx();
  const chosen = poolable.filter((o) => picked.includes(o.id));
  const terms = useMemo(() => poolTerms(sum(...chosen.map((o) => o.amount)), data.tier), [chosen, data.tier]);

  return (
    <section className="card">
      <h2 className="px-5 pt-5 font-semibold">Invoices</h2>
      {data.orders.length === 0 ? (
        <p className="px-5 pb-5 pt-2 text-sm text-muted">Your invoices appear here once created.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-y border-line text-left text-xs text-muted">
              <tr>
                {own && <th scope="col" className="w-10 px-5 py-2"><span className="sr-only">Select for pool</span></th>}
                <th scope="col" className="px-5 py-2 font-medium">Invoice</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Verdict</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                <th scope="col" className="px-5 py-2 font-medium">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((o) => {
                const can = poolable.includes(o);
                return (
                  <tr key={o.id}>
                    {own && (
                      <td className="px-5 py-2">
                        {can && (
                          <input type="checkbox" aria-label={`Add ${o.invoice_no} to a new pool`} checked={picked.includes(o.id)}
                            onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))} className="h-4 w-4 accent-[var(--accent)]" />
                        )}
                      </td>
                    )}
                    <td className="px-5 py-2">
                      <Link href={`/invoices/${o.id}`} className="font-mono text-xs underline decoration-line underline-offset-2 hover:decoration-ink">{o.invoice_no}</Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{o.pool_id !== null ? <Link className="underline decoration-line" href={`/pools/${o.pool_id}`}>{o.status} · #{o.pool_id}</Link> : o.status}</td>
                    <td className="whitespace-nowrap px-3 py-2">{o.verdict ? `${o.verdict} · ${o.score}` : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2 text-right"><Usdc value={o.amount} unit={false} /></td>
                    <td className="whitespace-nowrap px-5 py-2 text-muted">{formatNs(o.due_date)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sorted.length > 10 && (
            <button type="button" onClick={() => setAll((a) => !a)} className="w-full border-t border-line px-5 py-2 text-left text-sm text-muted hover:text-ink">
              {all ? "Show fewer" : `Show all ${sorted.length} invoices`}
            </button>
          )}
        </div>
      )}
      {own && poolable.length > 0 && (
        <div className="border-t border-line p-5">
          <h3 className="text-sm font-medium">Open a pool <span className="font-normal text-muted">· {poolable.length} approved invoice{poolable.length > 1 ? "s" : ""} ready</span></h3>
          {terms ? (
            <>
              <p className="mt-1 text-xs text-muted">Preview of the terms the contract will set for tier {data.tier}.</p>
              <div className="mt-2">
                <Rows rows={[
                  ["Receivable", <Usdc key="r" value={terms.receivable} />],
                  ["You receive when funded", <Usdc key="n" value={terms.merchant_net} />],
                  ["Senior / junior to raise", <span key="t"><Usdc value={terms.senior_target} unit={false} /> / <Usdc value={terms.junior_target} /></span>],
                  ["Owed to investors", <Usdc key="c" value={terms.claim} />],
                ]} />
              </div>
              <button type="button" disabled={tx.busy} onClick={() => tx.run(async () => [createPoolTx(C, picked)]).then(() => { setPicked([]); onDone(); })} className={`${BTN} mt-3 w-full`}>
                {tx.busy ? "Waiting for wallet…" : "Open pool"}
              </button>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">Select approved invoices above to preview the pool.</p>
          )}
          {tx.results && <div className="mt-3"><TxResultView results={tx.results} onDismiss={tx.clear} /></div>}
        </div>
      )}
    </section>
  );
}

function Withdraw({ amount, onDone }: { amount: string; onDone: () => void }) {
  const tx = useTx();
  return (
    <div className="card p-5">
      <h2 className="font-semibold">Residual ready</h2>
      <p className="mt-1 text-sm text-muted"><Usdc value={amount} /> from repaid pools is ready to withdraw.</p>
      <button type="button" disabled={tx.busy} onClick={() => tx.run(async () => [withdrawResidualTx(C)]).then(onDone)} className={`${BTN} mt-3 w-full`}>
        {tx.busy ? "Waiting for wallet…" : "Withdraw"}
      </button>
      {tx.results && <div className="mt-3"><TxResultView results={tx.results} onDismiss={tx.clear} /></div>}
    </div>
  );
}

function Pools({ pools }: { pools: Pool[] }) {
  return (
    <section className="card">
      <h2 className="px-5 pt-5 font-semibold">Pools</h2>
      {pools.length === 0 ? (
        <p className="px-5 pb-5 pt-2 text-sm text-muted">Pools you open appear here.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-y border-line text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">Pool</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Advance</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Funded</th>
                <th scope="col" className="px-5 py-2 text-right font-medium">Residual paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pools.map((p) => (
                <tr key={p.id}>
                  <td className="px-5 py-2"><Link href={`/pools/${p.id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">#{p.id}</Link></td>
                  <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
                  <td className="px-3 py-2 text-right"><Usdc value={p.advance} unit={false} /></td>
                  <td className="px-3 py-2 text-right"><Usdc value={sum(p.senior_funded, p.junior_funded)} unit={false} /></td>
                  <td className="px-5 py-2 text-right"><Usdc value={p.residual_paid} unit={false} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
