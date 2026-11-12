"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CONTRACT, TOKEN } from "@/lib/config";
import { sum, toBig } from "@/lib/amount";
import { getNftsForOwner, isRegistered, type NftToken } from "@/lib/chain";
import { parseExtra } from "@/lib/positions";
import { claimTxs, isAccountId, nftTransferTx } from "@/lib/tx";
import { useWallet } from "@/components/wallet/WalletProvider";
import { useTx } from "@/components/actions/useTx";
import { TxResultView } from "@/components/actions/TxResultView";
import { ErrorPanel, Usdc } from "@/components/ui";
import { Matching } from "./Matching";

const C = { cashflow: CONTRACT, token: TOKEN };
const BTN = "rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export function PortfolioWorkspace({ demoAccount, demoAccounts }: { demoAccount: string; demoAccounts: string[] }) {
  const { accountId } = useWallet();
  const viewing = accountId ?? demoAccount;
  const own = !!accountId;
  const [tokens, setTokens] = useState<NftToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await getNftsForOwner(viewing);
      setTokens(t.sort((a, b) => Number(b.token_id.split("-")[0]) - Number(a.token_id.split("-")[0])));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [viewing]);
  useEffect(() => { setTokens(null); load(); }, [load]);

  const claimable = (tokens ?? []).map((t) => ({ t, x: parseExtra(t.metadata.extra) })).filter(({ x }) => x && toBig(x.claimable) > BigInt(0));
  const total = sum(...claimable.map(({ x }) => x!.claimable));
  const claimAll = useTx();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
          <p className="mt-1 text-sm text-muted">
            {own ? <>Position NFTs held by <span className="font-medium text-ink">{viewing}</span>.</> : "Showing the position NFTs of a demo investor account. Sign in to see your own."}
          </p>
        </div>
        {own && claimable.length > 0 && (
          <button type="button" disabled={claimAll.busy} className={BTN}
            onClick={() => claimAll.run(async () => claimTxs(C, viewing, claimable.map(({ t }) => t.token_id), await isRegistered(viewing))).then(load)}>
            {claimAll.busy ? "Waiting for wallet…" : <>Claim all <Usdc value={total} /></>}
          </button>
        )}
      </header>
      {claimAll.results && <TxResultView results={claimAll.results} onDismiss={claimAll.clear} />}

      {!own && (
        <nav aria-label="Demo investors" className="flex flex-wrap gap-2">
          {demoAccounts.map((a) => (
            <Link key={a} href={`/portfolio?account=${a}`} aria-current={a === viewing ? "page" : undefined}
              className={`rounded-md border px-3 py-1.5 text-sm ${a === viewing ? "border-ink bg-surface font-medium" : "border-line text-muted hover:text-ink"}`}>
              {a.split(".")[0]} <span className="text-xs text-muted">(demo investor)</span>
            </Link>
          ))}
        </nav>
      )}

      <Matching />

      {error && <ErrorPanel title="Waiting for NEAR testnet to load positions" detail={error} />}
      {!tokens && !error && <div aria-busy="true" className="h-64 animate-pulse rounded-lg bg-sunken" />}
      {tokens && tokens.length === 0 && (
        <p className="text-muted">No positions yet. <Link href="/pools" className="underline">Browse pools</Link> to invest.</p>
      )}
      {tokens && tokens.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tokens.map((t) => <PositionCard key={t.token_id} token={t} own={own} accountId={viewing} onDone={load} />)}
        </ul>
      )}
    </div>
  );
}

function PositionCard({ token, own, accountId, onDone }: { token: NftToken; own: boolean; accountId: string; onDone: () => void }) {
  const x = parseExtra(token.metadata.extra);
  const pool = x?.pool_id ?? Number(token.token_id.split("-")[0]);
  const [to, setTo] = useState("");
  const [showSend, setShowSend] = useState(false);
  const claim = useTx();
  const send = useTx();
  const canClaim = own && x && toBig(x.claimable) > BigInt(0);
  const validTo = isAccountId(to) && to !== accountId;

  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface">
      <Link href={`/pools/${pool}`} className="block hover:opacity-90">
        {token.metadata.media?.startsWith("data:image/svg+xml") ? (
          // The contract renders this card from live pool state.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={token.metadata.media} alt={token.metadata.title ?? `Position ${token.token_id}`} className="aspect-[8/5] w-full" />
        ) : (
          <div className="flex aspect-[8/5] items-center justify-center bg-sunken text-sm text-muted">Position {token.token_id}</div>
        )}
      </Link>
      <div className="space-y-3 p-3">
        <p className="text-sm">{token.metadata.title ?? `Position ${token.token_id}`}</p>
        {own && (
          <div className="flex flex-wrap gap-2">
            {canClaim && (
              <button type="button" disabled={claim.busy} className={BTN}
                onClick={() => claim.run(async () => claimTxs(C, accountId, [token.token_id], await isRegistered(accountId))).then(onDone)}>
                {claim.busy ? "Waiting…" : <>Claim <Usdc value={x!.claimable} /></>}
              </button>
            )}
            <button type="button" aria-expanded={showSend} onClick={() => setShowSend((s) => !s)} className="rounded-md border border-line px-3 py-2 text-sm hover:bg-sunken">
              Transfer
            </button>
          </div>
        )}
        {showSend && (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (validTo) send.run(async () => [nftTransferTx(C, to, token.token_id)]).then(onDone); }}>
            <label className="block text-xs text-muted">
              New holder (future payouts follow the NFT)
              <input value={to} onChange={(e) => setTo(e.target.value.trim().toLowerCase())} placeholder="name.testnet" className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink" />
            </label>
            <button type="submit" disabled={!validTo || send.busy} className={`${BTN} w-full`}>{send.busy ? "Waiting for wallet…" : "Send position"}</button>
          </form>
        )}
        {claim.results && <TxResultView results={claim.results} onDismiss={claim.clear} />}
        {send.results && <TxResultView results={send.results} onDismiss={send.clear} />}
      </div>
    </li>
  );
}
