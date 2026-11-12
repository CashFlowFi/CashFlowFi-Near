"use client";
import { txUrl } from "@/lib/config";
import { formatUsdc } from "@/lib/amount";
import { shortHash } from "@/lib/format";
import type { TxResult } from "@/lib/tx";
import { useWallet } from "@/components/wallet/WalletProvider";

const EVENT_TEXT: Record<string, string> = {
  order_created: "Invoice created",
  receipt_approved: "Invoice approved",
  receipt_attested: "Verdict recorded",
  pool_created: "Pool opened",
  invested: "Investment recorded, position NFT minted",
  pool_activated: "Pool fully funded, advance sent to the merchant",
  payment_applied: "Payment applied through the waterfall",
  claimed: "Payout sent to the position holder",
  pool_defaulted: "Pool marked defaulted",
  insurance_cover: "Insurance cover paid",
  advance_failed: "Advance is queued until the merchant registers on the token",
  claim_failed: "Payout is kept on the position until the holder registers on the token",
};

export function TxResultView({ results, onDismiss }: { results: TxResult[]; onDismiss?: () => void }) {
  const ok = results.every((r) => r.ok);
  return (
    <div role="status" className={`rounded-md border p-3 text-sm ${ok ? "border-accent/40 bg-accent-soft" : "border-warn/40 bg-warn-soft"}`}>
      <div className="flex items-start justify-between gap-2">
        <p className={`font-medium ${ok ? "text-accent" : "text-warn"}`}>{ok ? "Confirmed on NEAR" : "Needs attention"}</p>
        {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-muted hover:text-ink">✕</button>}
      </div>
      <ul className="mt-1 space-y-2">
        {results.map((r, i) => (
          <li key={r.hash ?? i}>
            {r.error && <p>{r.error}</p>}
            {r.transfer && r.transfer.used > BigInt(0) && (
              <p>
                {formatUsdc(r.transfer.used)} USDC applied
                {r.transfer.refunded > BigInt(0) && <>, {formatUsdc(r.transfer.refunded)} USDC returned to you</>}.
              </p>
            )}
            {[...new Set(r.events.map((e) => e.event))].map((e) => <p key={e} className="text-muted">{EVENT_TEXT[e] ?? e}</p>)}
            {r.hash && (
              <a href={txUrl(r.hash)} target="_blank" rel="noreferrer" className="font-mono text-xs underline">{shortHash(r.hash)}</a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReturnedResults() {
  const { returned, clearReturned } = useWallet();
  if (!returned) return null;
  return <div className="mb-6"><TxResultView results={returned} onDismiss={clearReturned} /></div>;
}
