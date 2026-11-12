"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { CONTRACT, NETWORK, RPC_URL } from "@/lib/config";
import { friendlyError, readOutcome, type TxResult, type TxSpec } from "@/lib/tx";
import { txStatus } from "@/lib/chain";
import "@near-wallet-selector/modal-ui/styles.css";

interface WalletCtx {
  ready: boolean;
  accountId: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Signs and sends; returns one result per tx. Redirect wallets resolve on return (see `returned`). */
  send: (txs: TxSpec[]) => Promise<TxResult[] | null>;
  /** Results recovered after a redirect wallet sent the user back. */
  returned: TxResult[] | null;
  clearReturned: () => void;
}

const Ctx = createContext<WalletCtx | null>(null);

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const selectorRef = useRef<WalletSelector | null>(null);
  const modalRef = useRef<WalletSelectorModal | null>(null);
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [returned, setReturned] = useState<TxResult[] | null>(null);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    (async () => {
      const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/my-near-wallet"),
        import("@near-wallet-selector/meteor-wallet"),
      ]);
      const selector = await setupWalletSelector({
        network: { networkId: NETWORK, nodeUrl: RPC_URL, helperUrl: "https://helper.testnet.near.org", explorerUrl: "https://testnet.nearblocks.io", indexerUrl: "https://testnet-api.kitwallet.app" },
        modules: [setupMyNearWallet(), setupMeteorWallet()],
      });
      selectorRef.current = selector;
      modalRef.current = setupModal(selector, { contractId: CONTRACT });
      const active = () => selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
      setAccountId(active());
      sub = selector.store.observable.subscribe(() => setAccountId(active()));
      setReady(true);
    })().catch(() => setReady(true));
    return () => sub?.unsubscribe();
  }, []);

  // Redirect wallets come back with ?transactionHashes=a,b or ?errorCode=...
  useEffect(() => {
    if (!accountId) return;
    const url = new URL(window.location.href);
    const hashes = url.searchParams.get("transactionHashes");
    const err = url.searchParams.get("errorCode");
    if (!hashes && !err) return;
    url.searchParams.delete("transactionHashes");
    url.searchParams.delete("errorCode");
    url.searchParams.delete("errorMessage");
    window.history.replaceState(null, "", url.toString());
    if (err) {
      setReturned([{ hash: null, ok: false, error: friendlyError(err), transfer: null, events: [] }]);
      return;
    }
    Promise.all(hashes!.split(",").map((h) => txStatus(h, accountId).then((o) => readOutcome(o as Parameters<typeof readOutcome>[0]))))
      .then((r) => { setReturned(r); router.refresh(); })
      .catch((e) => setReturned([{ hash: hashes!.split(",")[0], ok: false, error: `Sent. Status lookup: ${(e as Error).message}`, transfer: null, events: [] }]));
  }, [accountId, router]);

  const signIn = useCallback(() => modalRef.current?.show(), []);
  const signOut = useCallback(async () => {
    const s = selectorRef.current;
    if (!s) return;
    const w = await s.wallet();
    await w.signOut();
  }, []);

  const send = useCallback(async (txs: TxSpec[]) => {
    const s = selectorRef.current;
    if (!s || !accountId) throw new Error("Sign in first.");
    const { actionCreators } = await import("@near-wallet-selector/core");
    const wallet = await s.wallet();
    const toTx = (t: TxSpec) => ({
      signerId: accountId,
      receiverId: t.receiverId,
      actions: t.calls.map((c) => actionCreators.functionCall(c.method, c.args, BigInt(c.gas), BigInt(c.deposit))),
    });
    try {
      let outcomes: unknown[] | void;
      if (txs.length === 1) {
        const o = await wallet.signAndSendTransaction(toTx(txs[0]));
        outcomes = o ? [o] : undefined;
      } else {
        outcomes = await wallet.signAndSendTransactions({ transactions: txs.map(toTx) });
      }
      if (!outcomes) return null; // redirect wallet: results arrive via `returned`
      const results = outcomes.map((o) => readOutcome(o as Parameters<typeof readOutcome>[0]));
      router.refresh();
      return results;
    } catch (e) {
      return [{ hash: null, ok: false, error: friendlyError((e as Error).message ?? String(e)), transfer: null, events: [] }];
    }
  }, [accountId, router]);

  return (
    <Ctx.Provider value={{ ready, accountId, signIn, signOut, send, returned, clearReturned: () => setReturned(null) }}>
      {children}
    </Ctx.Provider>
  );
}
