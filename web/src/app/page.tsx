import Link from "next/link";
import { FEATURED_POOL } from "@/lib/config";

export default function Welcome() {
  return (
    <section className="flex min-h-[60dvh] flex-col justify-center py-10">
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        Get paid today for invoices your customers settle later.
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-muted text-pretty">
        Investors fund a merchant&apos;s approved invoices in senior and junior tranches on NEAR, and are repaid when the customer pays from any chain.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href={`/pools/${FEATURED_POOL}`} className="rounded-md bg-accent px-4 py-2.5 font-medium text-accent-ink hover:opacity-90">
          Explore a pool
        </Link>
        <Link href="/invoices" className="rounded-md border border-line bg-surface px-4 py-2.5 font-medium hover:bg-sunken">
          Open an invoice
        </Link>
      </div>
    </section>
  );
}
