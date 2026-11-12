"use client";
import { useState } from "react";
import { CONTRACT, TOKEN } from "@/lib/config";
import { remaining, sum, toBig } from "@/lib/amount";
import { isRegistered } from "@/lib/chain";
import { approveTx, claimTxs, investTx, payTx, retryAdvanceTx, toInputString } from "@/lib/tx";
import { checkAmount } from "@/lib/validate";
import type { Order, Pool, Position, Tranche } from "@/lib/types";
import { useWallet } from "@/components/wallet/WalletProvider";
import { AmountField } from "./AmountField";
import { TxResultView } from "./TxResultView";
import { useTx } from "./useTx";
import { Usdc } from "@/components/ui";

const C = { cashflow: CONTRACT, token: TOKEN };
const BTN = "w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

/** Shown in place of an action when nobody is signed in. */
export function SignInFor({ label }: { label: string }) {
  const { signIn, ready } = useWallet();
  return (
    <button type="button" onClick={signIn} disabled={!ready} className={BTN}>
      Sign in to {label.toLowerCase()}
    </button>
  );
}

function Busy({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return <>{busy ? "Waiting for wallet…" : children}</>;
}

export function InvestForm({ pool, accountId }: { pool: Pool; accountId: string }) {
  const room = (t: Tranche) => (t === "Senior" ? remaining(pool.senior_target, pool.senior_funded) : remaining(pool.junior_target, pool.junior_funded));
  const first: Tranche = room("Senior") > BigInt(0) ? "Senior" : "Junior";
  const [tranche, setTranche] = useState<Tranche>(first);
  const [text, setText] = useState(toInputString(room(first)));
  const [balance, setBalance] = useState<bigint | null>(null);
  const [touched, setTouched] = useState(false);
  const tx = useTx();
  const check = checkAmount(text, { max: room(tranche), balance });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (check.amount === null) return;
        tx.run(async () => [investTx(C, accountId, pool.id, tranche, check.amount!, await isRegistered(accountId))]);
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium">Tranche</legend>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {(["Senior", "Junior"] as Tranche[]).map((t) => (
            <label key={t} className={`cursor-pointer rounded-md border px-3 py-2 text-sm ${tranche === t ? "border-ink bg-surface" : "border-line"} ${room(t) === BigInt(0) ? "opacity-50" : ""}`}>
              <input type="radio" name="tranche" value={t} checked={tranche === t} disabled={room(t) === BigInt(0)} onChange={() => { setTranche(t); setText(toInputString(room(t))); }} className="sr-only" />
              <span className="font-medium">{t}</span>
              <span className="block text-xs text-muted">{t === "Senior" ? "Paid first" : "Higher return"} · room <Usdc value={room(t)} unit={false} /></span>
            </label>
          ))}
        </div>
      </fieldset>
      <AmountField id="invest-amount" label="Amount" value={text} onChange={(v) => { setText(v); setTouched(true); }} accountId={accountId} max={room(tranche)} maxLabel="Room" onBalance={setBalance} />
      {touched && check.error && <p className="text-xs text-warn">{check.error}</p>}
      <button type="submit" disabled={tx.busy || check.amount === null} className={BTN}><Busy busy={tx.busy}>Invest</Busy></button>
      {tx.results && <TxResultView results={tx.results} onDismiss={tx.clear} />}
    </form>
  );
}

export function PayForm({ orders, accountId }: { orders: Order[]; accountId: string }) {
  const payable = orders.filter((o) => o.status === "Pooled" && toBig(o.amount) > toBig(o.paid));
  const [orderId, setOrderId] = useState(payable[0]?.id);
  const order = payable.find((o) => o.id === orderId) ?? payable[0];
  const owed = order ? remaining(order.amount, order.paid) : BigInt(0);
  const [text, setText] = useState(toInputString(owed));
  const [balance, setBalance] = useState<bigint | null>(null);
  const [touched, setTouched] = useState(false);
  const tx = useTx();
  if (!order) return <p className="text-sm text-muted">This invoice is fully paid.</p>;
  const check = checkAmount(text, { max: owed, balance });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (check.amount === null) return;
        tx.run(async () => [payTx(C, accountId, order.id, check.amount!, await isRegistered(accountId))]);
      }}
    >
      {payable.length > 1 && (
        <label className="block text-sm font-medium">
          Invoice
          <select value={order.id} onChange={(e) => { const o = payable.find((x) => x.id === Number(e.target.value))!; setOrderId(o.id); setText(toInputString(remaining(o.amount, o.paid))); }} className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm">
            {payable.map((o) => <option key={o.id} value={o.id}>{o.invoice_no}</option>)}
          </select>
        </label>
      )}
      <AmountField id="pay-amount" label="Pay on NEAR" value={text} onChange={(v) => { setText(v); setTouched(true); }} accountId={accountId} max={owed} maxLabel="Owed" onBalance={setBalance} />
      {touched && check.error && <p className="text-xs text-warn">{check.error}</p>}
      <button type="submit" disabled={tx.busy || check.amount === null} className={BTN}><Busy busy={tx.busy}>Pay invoice</Busy></button>
      {tx.results && <TxResultView results={tx.results} onDismiss={tx.clear} />}
    </form>
  );
}

export function ClaimButton({ positions, accountId }: { positions: Position[]; accountId: string }) {
  const mine = positions.filter((p) => p.owner === accountId && toBig(p.claimable) > BigInt(0));
  const tx = useTx();
  if (mine.length === 0) return <p className="text-sm text-muted">Your positions here are fully claimed.</p>;
  const total = sum(...mine.map((p) => p.claimable));
  return (
    <div className="space-y-3">
      <button type="button" disabled={tx.busy} onClick={() => tx.run(async () => claimTxs(C, accountId, mine.map((p) => p.token_id), await isRegistered(accountId)))} className={BTN}>
        <Busy busy={tx.busy}>Claim <Usdc value={total} /></Busy>
      </button>
      {tx.results && <TxResultView results={tx.results} onDismiss={tx.clear} />}
    </div>
  );
}

export function ApproveButton({ order }: { order: Order }) {
  const tx = useTx();
  return (
    <div className="space-y-3">
      <button type="button" disabled={tx.busy} onClick={() => tx.run(async () => [approveTx(C, order.id)])} className={BTN}>
        <Busy busy={tx.busy}>Approve invoice</Busy>
      </button>
      {tx.results && <TxResultView results={tx.results} onDismiss={tx.clear} />}
    </div>
  );
}

export function RetryAdvanceButton({ pool }: { pool: Pool }) {
  const tx = useTx();
  return (
    <div className="space-y-3">
      <button type="button" disabled={tx.busy} onClick={() => tx.run(async () => [retryAdvanceTx(C, pool.id)])} className={BTN}>
        <Busy busy={tx.busy}>Send advance</Busy>
      </button>
      {tx.results && <TxResultView results={tx.results} onDismiss={tx.clear} />}
    </div>
  );
}
