import Link from "next/link";
import type { Metadata } from "next";
import { getNftsForOwner } from "@/lib/chain";
import { DEMO_ACCOUNTS } from "@/lib/config";
import { ErrorPanel } from "@/components/ui";

export const metadata: Metadata = { title: "Portfolio" };
export const dynamic = "force-dynamic";

const DEMO_INVESTORS = Object.keys(DEMO_ACCOUNTS).filter((a) => DEMO_ACCOUNTS[a] === "demo investor");

type Props = { searchParams: Promise<{ account?: string }> };

export default async function PortfolioPage({ searchParams }: Props) {
  const requested = (await searchParams).account;
  const account = requested && DEMO_INVESTORS.includes(requested) ? requested : DEMO_INVESTORS[0];
  let tokens;
  let error: string | null = null;
  try {
    tokens = (await getNftsForOwner(account)).sort((a, b) => Number(b.token_id.split("-")[0]) - Number(a.token_id.split("-")[0]));
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
      <p className="mt-1 text-sm text-muted">Not signed in. Showing the position NFTs of a demo investor account.</p>
      <nav aria-label="Demo investors" className="mt-4 flex flex-wrap gap-2">
        {DEMO_INVESTORS.map((a) => (
          <Link
            key={a}
            href={`/portfolio?account=${a}`}
            aria-current={a === account ? "page" : undefined}
            className={`rounded-md border px-3 py-1.5 text-sm ${a === account ? "border-ink bg-surface font-medium" : "border-line text-muted hover:text-ink"}`}
          >
            {a.split(".")[0]} <span className="text-xs text-muted">(demo investor)</span>
          </Link>
        ))}
      </nav>
      {error ? (
        <div className="mt-6"><ErrorPanel title="Could not read positions from NEAR testnet" detail={error} /></div>
      ) : tokens!.length === 0 ? (
        <p className="mt-8 text-muted">This account holds no positions.</p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tokens!.map((t) => {
            const pool = t.token_id.split("-")[0];
            return (
              <li key={t.token_id}>
                <Link href={`/pools/${pool}`} className="block overflow-hidden rounded-lg border border-line bg-surface hover:border-ink">
                  {t.metadata.media?.startsWith("data:image/svg+xml") ? (
                    // The contract renders this card from live pool state.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.metadata.media} alt={t.metadata.title ?? `Position ${t.token_id}`} className="aspect-[8/5] w-full" />
                  ) : (
                    <div className="flex aspect-[8/5] items-center justify-center text-sm text-muted">Card image unavailable</div>
                  )}
                  <p className="px-3 py-2 text-sm">{t.metadata.title ?? `Position ${t.token_id}`}</p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
