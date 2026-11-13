"use client";
import { useEffect, useRef } from "react";
import { CONTRACT, accountUrl, txUrl } from "@/lib/config";
import { ProofLink } from "@/components/proof/ProofProvider";
import { shortHash } from "@/lib/format";
import type { ReceiptRun } from "@/lib/receipts";
import type { Order, Pool } from "@/lib/types";

export function ReceiptsDrawer({ open, onClose, pool, orders, receipts }: { open: boolean; onClose: () => void; pool: Pool; orders: Order[]; receipts: ReceiptRun[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby="receipts-title"
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-md border-l border-line bg-surface p-0 text-ink backdrop:bg-black/40"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id="receipts-title" className="font-semibold">Activity &amp; receipts</h2>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-muted hover:bg-sunken hover:text-ink" aria-label="Close">✕</button>
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4 text-sm">
          {receipts.length === 0 ? (
            <p className="text-muted">
              No recorded run covers pool #{pool.id}. Its transactions are on the{" "}
              <a className="underline" href={accountUrl(CONTRACT)} target="_blank" rel="noreferrer">contract&apos;s explorer page</a>.
            </p>
          ) : (
            receipts.map((r) => (
              <section key={r.file}>
                <h3 className="font-medium">{r.scenario || "Recorded run"}</h3>
                <p className="text-xs text-muted">
                  {r.finished_at ? `${new Date(r.finished_at).toISOString().replace("T", " ").slice(0, 16)} UTC · ` : ""}
                  <ProofLink path={r.file}>View proof · {r.file.split("/").pop()}</ProofLink>
                </p>
                <ol className="mt-3 space-y-2 border-l border-line pl-4">
                  {r.steps.map((s) => (
                    <li key={s.tx} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span>{s.step}</span>
                      <a className="font-mono text-xs underline decoration-line hover:decoration-ink" href={txUrl(s.tx)} target="_blank" rel="noreferrer">
                        {shortHash(s.tx)}
                      </a>
                    </li>
                  ))}
                </ol>
              </section>
            ))
          )}
          <section className="border-t border-line pt-4 text-xs text-muted">
            Contract <a className="underline" href={accountUrl(CONTRACT)} target="_blank" rel="noreferrer">{CONTRACT}</a>
            {orders.length > 0 && <> · invoices {orders.map((o) => `#${o.id}`).join(", ")}</>}
          </section>
        </div>
      </div>
    </dialog>
  );
}
