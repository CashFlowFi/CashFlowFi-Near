import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getOrder, getPool } from "@/lib/chain";
import { InvoiceActions } from "@/components/actions/InvoiceActions";
import { remaining } from "@/lib/amount";
import { formatNs, shortHash } from "@/lib/format";
import { Account, ErrorPanel, Rows, Usdc } from "@/components/ui";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: `Invoice #${(await params).id}` };
}

export default async function InvoicePage({ params }: Props) {
  const { id: raw } = await params;
  if (!/^\d{1,9}$/.test(raw)) notFound();
  let order;
  try {
    order = await getOrder(Number(raw));
  } catch (e) {
    return (
      <>
        <h1 className="text-3xl sm:text-4xl tracking-tight">Invoice #{raw}</h1>
        <div className="mt-6"><ErrorPanel title="Waiting for NEAR testnet to load this invoice" detail={(e as Error).message} /></div>
      </>
    );
  }
  if (!order) notFound();
  const pool = order.pool_id === null ? null : await getPool(order.pool_id).catch(() => null);
  return (
    <div className="max-w-2xl">
      <p className="eyebrow mb-2"><Link href="/invoices" className="hover:text-ink">Invoices</Link> / #{order.id}</p>
      <h1 className="mt-1 text-3xl sm:text-4xl tracking-tight">Invoice {order.invoice_no}</h1>
      <div className="mt-6 card p-5">
        <InvoiceActions order={order} pool={pool} />
      </div>
      <div className="mt-4 card p-5">
        <Rows
          rows={[
            ["Status", order.status],
            ["Amount", <Usdc key="a" value={order.amount} />],
            ["Paid", <Usdc key="p" value={order.paid} />],
            ["Still owed", <Usdc key="o" value={remaining(order.amount, order.paid)} />],
            ["Due", formatNs(order.due_date)],
            ["Merchant", <Account key="m" id={order.merchant} />],
            ["Customer", <Account key="c" id={order.customer} />],
            ["Verdict", order.verdict ? `${order.verdict} · ${order.score} / 100` : "not scored yet"],
            ["Reason hash", order.reason_hash ? <span key="h" className="font-mono text-xs" title={order.reason_hash}>{shortHash(order.reason_hash, 8)}</span> : "—"],
            ["Pool", order.pool_id === null ? "not pooled" : <Link key="pl" className="underline" href={`/pools/${order.pool_id}`}>#{order.pool_id}</Link>],
          ]}
        />
      </div>
    </div>
  );
}
