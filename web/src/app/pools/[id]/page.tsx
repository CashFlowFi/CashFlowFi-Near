import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getConfig, getOrder, getPool, getPoolPositions } from "@/lib/chain";
import { poolReceipts } from "@/lib/receipts";
import type { Order } from "@/lib/types";
import { ErrorPanel } from "@/components/ui";
import { PoolWorkspace } from "@/components/pool/PoolWorkspace";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Pool #${id}` };
}

export default async function PoolPage({ params }: Props) {
  const { id: raw } = await params;
  if (!/^\d{1,9}$/.test(raw)) notFound();
  const id = Number(raw);

  let pool, orders: Order[], config;
  try {
    [pool, config] = await Promise.all([getPool(id), getConfig()]);
    if (!pool) notFound();
    orders = (await Promise.all(pool.order_ids.map((o) => getOrder(o)))).filter((o): o is Order => o !== null);
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_")) throw e;
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Pool #{id}</h1>
        <div className="mt-6"><ErrorPanel title="Waiting for NEAR testnet to load this pool" detail={(e as Error).message} /></div>
      </>
    );
  }
  // Positions are best effort: without them the workspace shows "unavailable", never a guess.
  const positions = await getPoolPositions(id).catch(() => null);

  return <PoolWorkspace pool={pool} orders={orders} positions={positions} config={config} receipts={poolReceipts(id)} />;
}
