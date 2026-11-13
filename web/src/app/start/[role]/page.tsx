import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GUIDES, guideFor } from "@/lib/guides";
import { getAllPools } from "@/lib/chain";
import { remaining, sum } from "@/lib/amount";
import { Eyebrow } from "@/components/Ambient";
import { RoleChooser } from "@/components/RoleChooser";
import { StatusBadge, Usdc } from "@/components/ui";

export const revalidate = 30;
type Props = { params: Promise<{ role: string }> };

export function generateStaticParams() {
  return GUIDES.map((g) => ({ role: g.key }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const g = guideFor((await params).role);
  return { title: g ? `${g.label} guide` : "Guide" };
}

/** Pools investors can join right now, read from chain. */
async function openPools() {
  try {
    return (await getAllPools())
      .filter((p) => p.status === "Funding")
      .map((p) => ({ p, room: sum(remaining(p.senior_target, p.senior_funded), remaining(p.junior_target, p.junior_funded)) }))
      .filter((x) => x.room > BigInt(0))
      .sort((a, b) => b.p.id - a.p.id);
  } catch {
    return null;
  }
}

export default async function GuidePage({ params }: Props) {
  const g = guideFor((await params).role);
  if (!g) notFound();
  const open = g.key === "investor" ? await openPools() : null;

  return (
    <div className="space-y-10">
      <header>
        <Eyebrow>Guide · {g.steps.length} steps</Eyebrow>
        <h1 className="flex items-center gap-3 text-3xl tracking-tight sm:text-4xl">
          <span aria-hidden="true">{g.emoji}</span>
          {g.label}
        </h1>
        <p className="mt-1 text-muted">{g.pitch}</p>
      </header>

      <ol className="relative space-y-3 before:absolute before:bottom-6 before:left-[19px] before:top-6 before:w-px before:bg-line">
        {g.steps.map((s, i) => (
          <li key={s.title} className="relative flex gap-4">
            <span className={`num relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm ${s.ai ? "border-ai bg-ai-soft text-ai" : "border-line bg-surface"}`}>
              {i + 1}
            </span>
            <div className="card flex min-w-0 flex-1 flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {s.title}
                  {s.ai && <span className="rounded bg-ai-soft px-1.5 font-mono text-[10px] text-ai">AI</span>}
                </p>
                <p className="mt-0.5 text-sm text-muted">{s.line}</p>
              </div>
              <Link href={s.cta.href} className={`shrink-0 rounded-md px-4 py-2 text-center text-sm font-semibold ${i === 0 ? "bg-accent text-accent-ink hover:opacity-90" : "border border-line hover:bg-sunken"}`}>
                {s.cta.label}
              </Link>
            </div>
          </li>
        ))}
      </ol>

      {g.key === "investor" && (
        <section aria-labelledby="open-now">
          <h2 id="open-now" className="eyebrow">Open to investors right now</h2>
          {open === null ? (
            <p className="mt-3 text-sm text-muted">Waiting for NEAR testnet. Refresh in a moment.</p>
          ) : open.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Every pool is fully funded right now. New pools appear here as merchants open them.</p>
          ) : (
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {open.map(({ p, room }) => (
                <li key={p.id}>
                  <Link href={`/pools/${p.id}`} className="card flex items-center gap-3 p-4 hover:border-accent">
                    <span className="font-medium">Pool #{p.id}</span>
                    <StatusBadge status={p.status} />
                    <span className="ml-auto text-sm text-muted">room <Usdc value={room} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="other">
        <h2 id="other" className="eyebrow">Other roles</h2>
        <div className="mt-3"><RoleChooser current={g.key} /></div>
      </section>
    </div>
  );
}
