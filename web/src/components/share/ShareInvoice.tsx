"use client";
import { useEffect, useState } from "react";
import type { Order } from "@/lib/types";
import { invoiceShareText, telegramUrl, whatsappUrl, type ShareStep } from "@/lib/share";
import { QrCode, downloadQrSvg } from "./QrCode";

const CHIP = "inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-sunken";

/** The buyer's way in: a QR to scan at the counter, or a link sent over WhatsApp or Telegram. */
export function ShareInvoice({ order, step }: { order: Pick<Order, "id" | "invoice_no" | "amount" | "merchant">; step: ShareStep }) {
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setUrl(`${window.location.origin}/invoices/${order.id}`);
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, [order.id]);
  if (!url) return null;
  const text = invoiceShareText({ invoiceNo: order.invoice_no, amount: order.amount, merchant: order.merchant, step }, url);

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <QrCode value={url} label={`QR code linking to invoice ${order.invoice_no}`} />
      <div className="min-w-0 space-y-3">
        <p className="text-sm">
          {step === "approve" ? "Your customer scans this to review and approve the invoice from their own NEAR wallet." : "Your customer scans this to pay from NEAR or from Arbitrum."}
        </p>
        <div className="flex flex-wrap gap-2">
          <a className={CHIP} href={whatsappUrl(text)} target="_blank" rel="noreferrer">WhatsApp</a>
          <a className={CHIP} href={telegramUrl(url, text)} target="_blank" rel="noreferrer">Telegram</a>
          <button type="button" className={CHIP} onClick={copy} aria-live="polite">{copied ? "Link copied" : "Copy link"}</button>
          {canShare && <button type="button" className={CHIP} onClick={() => navigator.share({ title: `Invoice ${order.invoice_no}`, text, url }).catch(() => {})}>Share…</button>}
          <button type="button" className={CHIP} onClick={() => downloadQrSvg(url, `invoice-${order.id}-qr.svg`)}>QR ↓</button>
        </div>
        <p className="truncate font-mono text-xs text-muted">{url}</p>
      </div>
    </div>
  );
}
