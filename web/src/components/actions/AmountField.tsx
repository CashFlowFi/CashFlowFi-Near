"use client";
import { useEffect, useState } from "react";
import { formatUsdc } from "@/lib/amount";
import { getFtBalance } from "@/lib/chain";

/** Amount input in USDC with the signed-in account's live balance. */
export function AmountField({ id, label, value, onChange, accountId, max, maxLabel, onBalance }: {
  id: string; label: string; value: string; onChange: (v: string) => void;
  accountId: string; max?: bigint; maxLabel?: string; onBalance?: (b: bigint | null) => void;
}) {
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getFtBalance(accountId).then((b) => live && setBalance(BigInt(b))).catch(() => live && setBalance(null));
    return () => { live = false; };
  }, [accountId]);
  useEffect(() => { if (balance !== undefined) onBalance?.(balance); }, [balance, onBalance]);
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div className="mt-1 flex items-center rounded-md border border-line bg-bg focus-within:outline focus-within:outline-2 focus-within:outline-accent">
        <input id={id} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} className="num w-full bg-transparent px-3 py-2 text-sm outline-none" />
        <span className="pr-3 text-xs text-muted">USDC</span>
      </div>
      <p className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted">
        <span>Balance: {balance === undefined ? "…" : balance === null ? "unavailable" : `${formatUsdc(balance)} USDC`}</span>
        {max !== undefined && <span>{maxLabel ?? "Max"}: {formatUsdc(max)}</span>}
      </p>
    </div>
  );
}
