"use client";
import { toBig } from "@/lib/amount";
import type { Order, Pool } from "@/lib/types";
import { useWallet } from "@/components/wallet/WalletProvider";
import { ApproveButton, PayForm, SignInFor } from "./Actions";
import { ArbitrumPay } from "@/components/arbitrum/ArbitrumPay";

/** The one next step on an invoice for whoever is looking at it. */
export function InvoiceActions({ order, pool }: { order: Order; pool: Pool | null }) {
  const { accountId } = useWallet();
  if (order.status === "Pending") {
    if (!accountId) return <SignInFor label="Approve invoice" />;
    if (accountId === order.merchant)
      return <p className="text-sm text-muted">Share this page with your customer. They approve it from their own account.</p>;
    return <ApproveButton order={order} />;
  }
  const payable = order.status === "Pooled" && pool?.status === "Active" && toBig(order.amount) > toBig(order.paid);
  if (payable) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="mb-3 font-semibold">Pay on NEAR</h2>
          {accountId ? <PayForm orders={[order]} accountId={accountId} /> : <SignInFor label="Pay invoice" />}
        </div>
        <div className="border-t border-line pt-5">
          <h2 className="mb-3 font-semibold">Pay from Arbitrum</h2>
          <ArbitrumPay order={order} />
        </div>
      </div>
    );
  }
  const next: Record<string, string> = {
    CustomerApproved: "Approved. The underwriter agent scores it next, usually within a minute.",
    Attested: order.verdict === "Approve" ? "Approved by the underwriter. The merchant can now open a pool." : "Scored by the underwriter.",
    Rejected: "Scored by the underwriter.",
    Pooled: "In a pool that is being funded. Payment opens once the pool is active.",
    Paid: "Paid in full.",
  };
  return <p className="text-sm text-muted">{next[order.status] ?? order.status}</p>;
}
