import Link from "next/link";
import { Eyebrow } from "@/components/Ambient";
import type { Metadata } from "next";
import { getAllOrders } from "@/lib/chain";
import { formatNs } from "@/lib/format";
import { Account, ErrorPanel, Usdc } from "@/components/ui";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  let orders;
  try {
    orders = (await getAllOrders()).sort((a, b) => b.id - a.id);
  } catch (e) {
    return (
      <>
        <Eyebrow>On-chain receivables</Eyebrow>
<h1 className="text-3xl sm:text-4xl tracking-tight">Invoices</h1>
        <div className="mt-6"><ErrorPanel title="Waiting for NEAR testnet to load invoices" detail={(e as Error).message} /></div>
      </>
    );
  }
  return (
    <>
      <Eyebrow>On-chain receivables</Eyebrow>
<h1 className="text-3xl sm:text-4xl tracking-tight">Invoices</h1>
      <p className="mt-1 text-sm text-muted">Credit sales recorded on-chain, newest first.</p>
      <div className="mt-6 overflow-x-auto card">
        <table className="w-full min-w-[680px] text-sm">
          <thead className="border-b border-line text-left text-xs font-mono uppercase tracking-[0.08em] text-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Invoice</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 font-medium">Customer</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
              <th scope="col" className="px-4 py-3 font-medium">Due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {orders.map((o) => (
              <tr key={o.id} className="hover:bg-sunken/60">
                <td className="px-4 py-3">
                  <Link href={`/invoices/${o.id}`} className="font-medium underline decoration-line underline-offset-2 hover:decoration-ink">#{o.id}</Link>
                  <span className="ml-2 font-mono text-xs text-muted">{o.invoice_no}</span>
                </td>
                <td className="px-4 py-3">{o.status}</td>
                <td className="px-4 py-3"><Account id={o.customer} link={false} /></td>
                <td className="px-4 py-3 text-right"><Usdc value={o.amount} /></td>
                <td className="px-4 py-3 whitespace-nowrap text-muted">{formatNs(o.due_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
