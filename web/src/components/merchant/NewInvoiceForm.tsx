"use client";
import Link from "next/link";
import { useState } from "react";
import { CONTRACT, TOKEN } from "@/lib/config";
import { checkInvoice, msToNs } from "@/lib/merchant";
import { createOrderTx, parseUsdcInput } from "@/lib/tx";
import { useTx } from "@/components/actions/useTx";
import { TxResultView } from "@/components/actions/TxResultView";

const C = { cashflow: CONTRACT, token: TOKEN };
const INPUT = "mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm";

async function customerHash(ref: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ref.trim().toLowerCase())));
  return "sha256:" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function NewInvoiceForm({ onDone }: { onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USDC");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [due, setDue] = useState(isoDay(Date.now() + 30 * 86_400_000));
  const [customerRef, setCustomerRef] = useState("");
  const [touched, setTouched] = useState(false);
  const tx = useTx();

  // Due at the end of the chosen day, UTC.
  const dueMs = due ? Date.parse(`${due}T23:59:00Z`) : null;
  const draft = { amount: parseUsdcInput(amount), currency, invoiceNo, dueMs: Number.isFinite(dueMs) ? dueMs : null, customerRef };
  const errors = checkInvoice(draft, Date.now());
  const valid = Object.keys(errors).length === 0;
  const created = tx.results?.flatMap((r) => r.events).find((e) => e.event === "order_created")?.data[0]?.order_id as number | undefined;
  const err = (k: keyof typeof errors) => touched && errors[k] && <p className="mt-1 text-xs text-warn">{errors[k]}</p>;

  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!valid) return;
        tx.run(async () => [createOrderTx(C, { amount: draft.amount!, currency, dueNs: msToNs(draft.dueMs!), invoiceNo, customerHash: await customerHash(customerRef) })]).then(onDone);
      }}
    >
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <label className="text-sm font-medium">Amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${INPUT} num`} placeholder="10.00" /></label>
        <label className="text-sm font-medium">Currency<input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className={INPUT} /></label>
      </div>
      {err("amount")}{err("currency")}
      <label className="block text-sm font-medium">Invoice number<input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className={`${INPUT} font-mono`} placeholder="INV-2026-001" /></label>
      {err("invoiceNo")}
      <label className="block text-sm font-medium">Due date<input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={INPUT} /></label>
      {err("dueMs")}
      <label className="block text-sm font-medium">
        Customer reference
        <input value={customerRef} onChange={(e) => setCustomerRef(e.target.value)} className={INPUT} placeholder="buyer@example.com" />
        <span className="mt-1 block text-xs font-normal text-muted">Only its SHA-256 hash goes on-chain.</span>
      </label>
      {err("customerRef")}
      <button type="submit" disabled={tx.busy} className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50">
        {tx.busy ? "Waiting for wallet…" : "Create invoice"}
      </button>
      {tx.results && <TxResultView results={tx.results} onDismiss={tx.clear} />}
      {created !== undefined && (
        <p className="text-sm">
          Send your customer this link to approve it: <Link className="underline" href={`/invoices/${created}`}>/invoices/{created}</Link>
        </p>
      )}
    </form>
  );
}
