import Link from "next/link";
import { FEATURED_POOL } from "@/lib/config";

const STEPS = ["Invoice", "Approved", "AI underwritten", "Funded", "Paid", "Claimed"];

export default function Welcome() {
  return (
    <section className="flex flex-col items-center py-10 text-center sm:py-16">
      <h1 className="max-w-5xl text-4xl leading-[0.95] text-balance sm:text-7xl">
        Get paid today for invoices settled later
      </h1>
      <p className="mt-6 max-w-2xl text-base text-muted text-pretty">
        Investors fund a merchant&apos;s <span className="font-semibold text-accent">AI-approved invoices</span> on NEAR and are repaid when the customer pays, from any chain.
      </p>
      <div className="mt-10 flex flex-wrap justify-center gap-3">
        <Link href={`/pools/${FEATURED_POOL}`} className="flex items-center gap-6 border border-accent bg-accent px-5 py-3 text-sm font-medium text-accent-ink hover:opacity-90">
          Explore a pool <span aria-hidden="true">↗</span>
        </Link>
        <Link href="/invoices" className="flex items-center gap-6 border border-ink px-5 py-3 text-sm font-medium hover:bg-sunken">
          Open an invoice <span aria-hidden="true">→</span>
        </Link>
      </div>
      <div className="grid-paper relative mt-14 w-full max-w-5xl border border-line px-4 py-10 sm:px-6">
        <p className="absolute left-3 top-2 text-[11px] text-muted">How a pool moves</p>
        <ol className="flex flex-col items-center gap-2 text-sm sm:flex-row sm:justify-center sm:gap-0">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center">
              {i > 0 && <span aria-hidden="true" className="mx-1.5 hidden h-px w-5 bg-ink/40 sm:block" />}
              <span className={`whitespace-nowrap border px-2.5 py-1.5 ${s === "AI underwritten" ? "border-accent bg-accent text-accent-ink" : "border-ink bg-bg"}`}>
                <span className="mr-1.5 text-[11px] opacity-70">0{i + 1}</span>{s}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
