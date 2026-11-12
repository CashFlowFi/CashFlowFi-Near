import Link from "next/link";
import { FEATURED_POOL } from "@/lib/config";
import { getAllOrders, getAllPools, getInsurance } from "@/lib/chain";
import { sum } from "@/lib/amount";
import { Usdc } from "@/components/ui";

export const revalidate = 30;

const STEPS = [
  { k: "Invoice", ai: false },
  { k: "Approved", ai: false },
  { k: "AI underwriting", ai: true },
  { k: "Funded", ai: false },
  { k: "Paid", ai: false },
  { k: "Claimed", ai: false },
];

const AGENTS = [
  { title: "Underwriter", line: "Scores every invoice 0–100", href: "/agents" },
  { title: "Collections", line: "Writes reminders, flags defaults", href: "/agents" },
  { title: "Matching", line: "Finds a tranche for your intent", href: "/portfolio" },
];

async function stats() {
  try {
    const [pools, orders, ins] = await Promise.all([getAllPools(), getAllOrders(), getInsurance()]);
    return {
      pools: pools.length,
      repaid: sum(...pools.map((p) => p.senior_repaid), ...pools.map((p) => p.junior_repaid)),
      scored: orders.filter((o) => o.verdict !== null).length,
      insurance: ins.balance,
    };
  } catch {
    return null;
  }
}

export default async function Welcome() {
  const s = await stats();
  return (
    <div className="relative">

      <section className="relative grid grid-cols-[minmax(0,1fr)] items-center gap-10 py-10 sm:py-16 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <p className="eyebrow flex items-center gap-2">
            <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-accent" /> Live on NEAR testnet
          </p>
          <h1 className="mt-4 text-[2.6rem] leading-[1.02] text-balance sm:text-6xl">
            Get paid today for invoices settled <span className="text-accent">later</span>.
          </h1>
          <p className="mt-5 max-w-xl text-base text-muted text-pretty sm:text-lg">
            Investors fund a merchant&apos;s <span className="text-ai">AI-approved</span> invoices and are repaid when the customer pays, from any chain.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={`/pools/${FEATURED_POOL}`} className="rounded-md bg-ink px-5 py-3 text-sm font-semibold text-bg hover:opacity-90">
              Explore a pool
            </Link>
            <Link href="/invoices" className="rounded-md border border-line bg-surface px-5 py-3 text-sm font-semibold hover:bg-sunken">
              Open an invoice
            </Link>
          </div>
        </div>

        <aside className="glass card p-6">
          <p className="eyebrow">Protocol, live from chain</p>
          <p className="num mt-3 text-4xl font-medium text-accent">
            {s ? <Usdc value={s.repaid} unit={false} /> : "—"}
            <span className="ml-2 font-sans text-sm font-normal text-muted">USDC repaid</span>
          </p>
          <dl className="mt-5 divide-y divide-line border-t border-line text-sm">
            <Stat label="Pools opened" value={s ? String(s.pools) : "unavailable"} />
            <Stat label="Invoices scored by AI" value={s ? String(s.scored) : "unavailable"} ai />
            <Stat label="Insurance fund" value={s ? <Usdc value={s.insurance} /> : "unavailable"} />
          </dl>
        </aside>
      </section>

      <section aria-labelledby="flow" className="relative mt-4">
        <h2 id="flow" className="eyebrow">How a pool moves</h2>
        <ol className="ledger-grid mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
          {STEPS.map((st, i) => (
            <li key={st.k} className={`p-4 ${st.ai ? "bg-ai-soft" : "bg-surface"}`}>
              <span className={`num text-xs ${st.ai ? "text-ai" : "text-muted"}`}>0{i + 1}</span>
              <p className={`mt-1 text-sm font-medium ${st.ai ? "text-ai" : ""}`}>{st.k}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="ai" className="mt-10">
        <h2 id="ai" className="eyebrow">Where AI works</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {AGENTS.map((a) => (
            <li key={a.title}>
              <Link href={a.href} className="group block card p-4 hover:border-ai">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span aria-hidden="true" className="text-ai">◆</span>{a.title}
                  <span aria-hidden="true" className="ml-auto text-muted transition-transform group-hover:translate-x-0.5">→</span>
                </p>
                <p className="mt-1 text-sm text-muted">{a.line}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value, ai = false }: { label: string; value: React.ReactNode; ai?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`num ${ai ? "text-ai" : ""}`}>{value}</dd>
    </div>
  );
}
