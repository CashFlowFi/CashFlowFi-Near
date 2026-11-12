import Link from "next/link";
import type { Metadata } from "next";
import { getAllPools } from "@/lib/chain";
import { formatNs } from "@/lib/format";
import { TIER_LTV } from "@/lib/types";
import { Account, ErrorPanel, StatusBadge, Usdc } from "@/components/ui";

export const metadata: Metadata = { title: "Pools" };
export const dynamic = "force-dynamic";

export default async function PoolsPage() {
  let pools;
  try {
    pools = (await getAllPools()).sort((a, b) => b.id - a.id);
  } catch (e) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Pools</h1>
        <div className="mt-6"><ErrorPanel title="Waiting for NEAR testnet to load pools" detail={(e as Error).message} /></div>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Pools</h1>
      <p className="mt-1 text-sm text-muted">Every pool on the contract, read live from NEAR testnet.</p>
      {pools.length === 0 ? (
        <p className="mt-8 text-muted">No pools yet.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Pool</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Merchant</th>
                <th scope="col" className="px-4 py-3 font-medium">Tier</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Receivable</th>
                <th scope="col" className="px-4 py-3 font-medium">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pools.map((p) => (
                <tr key={p.id} className="hover:bg-sunken/60">
                  <td className="px-4 py-3">
                    <Link href={`/pools/${p.id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">
                      #{p.id}
                    </Link>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                  <td className="px-4 py-3"><Account id={p.merchant} link={false} /></td>
                  <td className="px-4 py-3" title={`${TIER_LTV[p.tier]}% advance`}>{p.tier}</td>
                  <td className="px-4 py-3 text-right"><Usdc value={p.receivable} /></td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted">{formatNs(p.due_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
