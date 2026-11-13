"use client";
import { toBig } from "@/lib/amount";
import type { Order, Pool } from "@/lib/types";
import { useWallet } from "@/components/wallet/WalletProvider";
import { ApproveButton, PayForm, SignInFor } from "./Actions";
import { ArbitrumPay } from "@/components/arbitrum/ArbitrumPay";
import { ShareInvoice } from "@/components/share/ShareInvoice";
import { ForMeCheck } from "@/components/share/ForMeCheck";
import { Info } from "@/components/ui";

/** The one next step on an invoice for whoever is looking at it. */
export function InvoiceActions({ order, pool }: { order: Order; pool: Pool | null }) {
  const { accountId } = useWallet();
  if (order.status === "Pending") {
    if (accountId === order.merchant) {
      return (
        <div>
          <h2 className="mb-3 font-semibold">Send to your customer</h2>
          <ShareInvoice order={order} step="approve" />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div>
          <h2 className="font-semibold">Approve this invoice</h2>
          <p className="mt-0.5 text-xs text-muted">Your signature confirms the sale on-chain. The merchant cannot approve its own invoice.</p>
        </div>
        <ForMeCheck customerHash={order.customer_hash} />
        {accountId ? <ApproveButton order={order} /> : <SignInFor label="Approve invoice" />}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">Show the QR for this invoice</summary>
          <div className="mt-3"><ShareInvoice order={order} step="approve" /></div>
        </details>
      </div>
    );
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
          <h2 className="font-semibold">
            Pay from Arbitrum
            <Info text="Cross-chain payments use the NEAR Intents 1Click flow through Tidepool, a community testnet running the unmodified Intents verifier, because Intents has no testnet. USDC lands in the contract with ft_transfer_call and runs the same waterfall." />
          </h2>
          <p className="mb-3 mt-0.5 text-xs text-muted">Settles on NEAR through <span className="font-medium text-accent">NEAR Intents 1Click</span></p>
          <ArbitrumPay order={order} />
        </div>
        <details className="border-t border-line pt-4 text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">Share the payment link</summary>
          <div className="mt-3"><ShareInvoice order={order} step="pay" /></div>
        </details>
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
