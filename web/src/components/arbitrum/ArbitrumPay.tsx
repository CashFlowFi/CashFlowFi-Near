"use client";
import { useEffect, useRef, useState } from "react";
import { API_URL, txUrl } from "@/lib/config";
import { formatUsdc } from "@/lib/amount";
import { shortHash } from "@/lib/format";
import {
  ARBISCAN, ARB_SEPOLIA_USDC, PAY_STEPS, TIDEPOOL_SUBMIT_URL, isEvmAddress, isEvmTxHash, quoteMessage, readQuote, readStatus,
  type QuoteResponse, type QuoteView, type StatusView,
} from "@/lib/payapi";
import type { Order } from "@/lib/types";
import { erc20TransferUri } from "@/lib/share";
import { QrCode } from "@/components/share/QrCode";

const ARB_SEPOLIA_CHAIN_ID = 421614;
const payUri = (to: string, amount: string | bigint): string | null => {
  try { return erc20TransferUri(ARB_SEPOLIA_USDC, ARB_SEPOLIA_CHAIN_ID, to, amount); } catch { return null; }
};

const POLL_MS = 7000;
const BTN = "rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT = "w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm";

interface StatusBody { status: string; originTx: string | null; nearTx: string | null }

/** Pay an invoice with Arbitrum Sepolia USDC through Tidepool: quote → deposit → report tx → follow delivery to NEAR. */
export function ArbitrumPay({ order }: { order: Order }) {
  const [refundTo, setRefundTo] = useState("");
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [tracking, setTracking] = useState(false);
  const [status, setStatus] = useState<(StatusView & { body: StatusBody }) | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!API_URL) return <p className="text-sm text-muted">Cross-chain payment is available when the payments API is connected.</p>;

  const getQuote = async () => {
    setBusy(true);
    setMessage(null);
    setQuote(null);
    try {
      const r = await fetch(`${API_URL}/api/pay/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_id: order.id, origin_asset: "arb-sepolia-usdc", refund_to: refundTo.trim() }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) setMessage(quoteMessage(body, r.status));
      else setQuote(readQuote(body as QuoteResponse));
    } catch {
      setMessage("The payments service is out of reach right now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const poll = async (depositAddress: string) => {
    try {
      const r = await fetch(`${API_URL}/api/pay/status?depositAddress=${encodeURIComponent(depositAddress)}`);
      if (r.ok) {
        const body = (await r.json()) as StatusBody;
        const view = readStatus(body.status);
        setStatus({ ...view, body });
        if (view.final) return;
      }
    } catch {}
    timer.current = setTimeout(() => poll(depositAddress), POLL_MS);
  };

  const track = async () => {
    if (quote?.kind !== "live") return;
    setTracking(true);
    // Reporting the deposit tx speeds up detection; tracking continues either way.
    fetch(TIDEPOOL_SUBMIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: txHash.trim(), depositAddress: quote.depositAddress }),
    }).catch(() => {});
    poll(quote.depositAddress);
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  return (
    <div className="space-y-4 text-sm">
      {!tracking && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (isEvmAddress(refundTo)) getQuote(); }}>
          <label htmlFor="refund-to" className="font-medium">Your Arbitrum address</label>
          <p className="text-xs text-muted">Used only if the provider needs to return the deposit.</p>
          <input id="refund-to" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} className={INPUT} />
          {refundTo && !isEvmAddress(refundTo) && <p className="text-xs text-warn">Enter a 0x address with 40 hex characters.</p>}
          <button type="submit" disabled={busy || !isEvmAddress(refundTo)} className={BTN}>{busy ? "Getting quote…" : "Get quote"}</button>
        </form>
      )}

      {message && <p role="status" className="rounded-md bg-warn-soft p-3 text-warn">{message}</p>}

      {quote?.kind === "preview" && (
        <div className="rounded-md border border-line p-3">
          <p className="flex items-center gap-2 font-medium">
            <span className="rounded-full bg-sunken px-2 py-0.5 text-xs text-muted">Preview</span>
            Price preview
          </p>
          <p className="mt-2">About <span className="num font-medium">{formatUsdc(quote.amountIn)}</span> Arbitrum Sepolia USDC would settle this invoice.</p>
          <p className="mt-1 text-xs text-muted">A payable quote with a deposit address is issued when live payments are switched on.</p>
        </div>
      )}

      {quote?.kind === "live" && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <p>
            Send exactly <span className="num font-medium">{formatUsdc(quote.amountIn)} USDC</span> on Arbitrum Sepolia
            {" "}(token <a className="font-mono underline" href={`${ARBISCAN}/token/${ARB_SEPOLIA_USDC}`} target="_blank" rel="noreferrer">{shortHash(ARB_SEPOLIA_USDC)}</a>) to:
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-sunken px-2 py-1.5 text-xs">{quote.depositAddress}</code>
            <button type="button" onClick={() => copy(quote.depositAddress)} className="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-sunken" aria-live="polite">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {payUri(quote.depositAddress, quote.amountIn) && <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <QrCode value={payUri(quote.depositAddress, quote.amountIn)!} label="Scan with an EVM wallet to send the exact USDC amount" size={148} />
            <p className="text-xs text-muted">Scan with MetaMask mobile or another EVM wallet: it opens a USDC transfer of exactly this amount to the deposit address on Arbitrum Sepolia.</p>
          </div>}
          <p className="text-xs text-muted">Quote valid until {quote.deadline.replace("T", " ").slice(0, 16)} UTC.</p>
          {!tracking && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (isEvmTxHash(txHash)) track(); }}>
              <label htmlFor="evm-tx" className="font-medium">Deposit transaction hash</label>
              <input id="evm-tx" value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} className={INPUT} />
              <button type="submit" disabled={!isEvmTxHash(txHash)} className={BTN}>Track payment</button>
            </form>
          )}
        </div>
      )}

      {tracking && (
        <div className="space-y-3" aria-live="polite">
          <ol className="flex flex-wrap gap-2">
            {PAY_STEPS.map((s, i) => {
              const reached = status ? status.step >= i : i === 0;
              return (
                <li key={s.key} className={`rounded-full border px-3 py-1 text-xs ${reached ? "border-accent bg-accent-soft text-accent" : "border-line text-muted"}`}>
                  {s.label}
                </li>
              );
            })}
          </ol>
          <p className={status?.tone === "attention" ? "text-warn" : status?.tone === "done" ? "text-accent" : "text-muted"}>
            {status ? status.label : "Checking with the provider…"}
          </p>
          {status?.body.originTx && (
            <p className="text-xs">Arbitrum: <a className="font-mono underline" href={`${ARBISCAN}/tx/${status.body.originTx}`} target="_blank" rel="noreferrer">{shortHash(status.body.originTx)}</a></p>
          )}
          {status?.body.nearTx && (
            <p className="text-xs">NEAR: <a className="font-mono underline" href={txUrl(status.body.nearTx)} target="_blank" rel="noreferrer">{shortHash(status.body.nearTx)}</a></p>
          )}
        </div>
      )}
    </div>
  );
}
