"use client";
import { useState } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import type { TxResult, TxSpec } from "@/lib/tx";

/** Shared submit state for every action: busy flag, results, and errors raised before signing. */
export function useTx() {
  const { send } = useWallet();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<TxResult[] | null>(null);
  const run = async (build: () => Promise<TxSpec[]>) => {
    setBusy(true);
    setResults(null);
    try {
      const r = await send(await build());
      if (r) setResults(r);
    } catch (e) {
      setResults([{ hash: null, ok: false, error: (e as Error).message, transfer: null, events: [] }]);
    } finally {
      setBusy(false);
    }
  };
  return { busy, results, run, clear: () => setResults(null) };
}
