"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { repoFileUrl, txUrl } from "@/lib/config";
import { shortHash } from "@/lib/format";
import { isHighlighted, jsonLines, summarize, type JsonPath, type Tone } from "@/lib/proof";

const DOT: Record<Tone, string> = { ok: "text-accent", ai: "text-ai", warn: "text-warn", info: "text-muted" };
const GLYPH: Record<Tone, string> = { ok: "✓", ai: "◆", warn: "!", info: "•" };

type Load = { state: "idle" } | { state: "loading" } | { state: "ok"; doc: unknown } | { state: "error"; message: string };

export function ProofViewer({ path, onClose }: { path: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [active, setActive] = useState<number | null>(null);
  const [tab, setTab] = useState<"summary" | "json">("summary");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (path && !d.open) d.showModal();
    if (!path && d.open) d.close();
  }, [path]);

  useEffect(() => {
    if (!path) return;
    if (!/^evidence\/[\w./-]+\.json$/.test(path) || path.includes("..")) { setLoad({ state: "error", message: "Not an evidence file" }); return; }
    let live = true;
    setLoad({ state: "loading" });
    setActive(null);
    setTab("summary");
    fetch(`/${path}`)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((doc) => live && setLoad({ state: "ok", doc }))
      .catch((e) => live && setLoad({ state: "error", message: (e as Error).message }));
    return () => { live = false; };
  }, [path]);

  const summary = useMemo(() => (load.state === "ok" && path ? summarize(path, load.doc) : null), [load, path]);
  const lines = useMemo(() => (load.state === "ok" ? jsonLines(load.doc) : []), [load]);
  const targets: JsonPath[] = (active !== null && summary?.points[active]?.paths) || [];
  const firstHit = targets.length ? lines.findIndex((l) => isHighlighted(l.path, targets)) : -1;
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => { if (firstHit >= 0) lineRefs.current[firstHit]?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [firstHit]);

  const copy = async () => {
    if (load.state !== "ok") return;
    try { await navigator.clipboard.writeText(JSON.stringify(load.doc, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby="proof-title"
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-5xl border-l border-line bg-surface p-0 text-ink backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <p className="eyebrow">Proof</p>
            <h2 id="proof-title" className="mt-1 truncate text-lg">{summary?.title ?? path ?? ""}</h2>
            {summary?.subtitle && <p className="font-mono text-xs text-muted">{summary.subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md px-2 py-1 text-muted hover:bg-sunken hover:text-ink">✕</button>
        </header>

        <div role="tablist" aria-label="Proof view" className="flex gap-1 border-b border-line px-5 py-2 md:hidden">
          {(["summary", "json"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-sunken text-ink" : "text-muted"}`}>
              {t === "summary" ? "Summary" : "JSON"}
            </button>
          ))}
        </div>

        {load.state === "loading" && <p className="p-5 text-sm text-muted">Loading the record…</p>}
        {load.state === "error" && <p className="p-5 text-sm text-warn">This record is unavailable here ({load.message}). {path && <a className="underline" href={repoFileUrl(path)} target="_blank" rel="noreferrer">Open it on GitHub</a>}.</p>}

        {load.state === "ok" && summary && (
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <section aria-label="What this proves" className={`min-h-0 overflow-y-auto border-line p-5 md:border-r ${tab === "summary" ? "" : "hidden md:block"}`}>
              <p className="eyebrow">What this proves</p>
              <ul className="mt-3 space-y-1">
                {summary.points.map((p, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onClick={() => { setActive(i); setTab("json"); }}
                      className={`flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${active === i ? "bg-ai-soft" : "hover:bg-sunken"}`}
                    >
                      <span aria-hidden="true" className={`mt-0.5 w-3 shrink-0 text-center ${DOT[p.tone]}`}>{GLYPH[p.tone]}</span>
                      <span>
                        <span className="font-medium">{p.label}</span>
                        {p.detail && <span className="block text-xs text-muted">{p.detail}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {summary.txs.length > 0 && (
                <>
                  <p className="eyebrow mt-6">On-chain transactions</p>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {summary.txs.map((t) => (
                      <li key={t.hash} className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-muted">{t.label}</span>
                        <a className="font-mono text-xs underline" href={txUrl(t.hash)} target="_blank" rel="noreferrer">{shortHash(t.hash)} ↗</a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {path && <a className="mt-6 inline-block text-xs text-muted underline hover:text-ink" href={repoFileUrl(path)} target="_blank" rel="noreferrer">Open {path} on GitHub ↗</a>}
            </section>

            <section aria-label="Raw record" className={`flex min-h-0 flex-col bg-bg ${tab === "json" ? "" : "hidden md:flex"}`}>
              <div className="flex items-center justify-between border-b border-line px-4 py-2">
                <p className="eyebrow">Raw record · JSON</p>
                <button type="button" onClick={copy} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-sunken" aria-live="polite">{copied ? "Copied" : "Copy"}</button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto py-3 font-mono text-[12px] leading-5">
                {lines.map((l, i) => {
                  const hit = isHighlighted(l.path, targets);
                  return (
                    <div
                      key={i}
                      ref={(el) => { lineRefs.current[i] = el; }}
                      className={`flex whitespace-pre pr-4 ${hit ? "border-l-2 border-ai bg-ai-soft" : "border-l-2 border-transparent"}`}
                    >
                      <span aria-hidden="true" className="w-10 shrink-0 select-none pr-3 text-right text-muted/60">{i + 1}</span>
                      <span style={{ paddingLeft: `${l.indent * 2}ch` }} className={l.clipped ? "text-muted" : ""}>{l.text}</span>
                    </div>
                  );
                })}
              </div>
              {lines.some((l) => l.clipped) && <p className="border-t border-line px-4 py-2 text-[11px] text-muted">Long values are shortened here; Copy and the GitHub file have them in full.</p>}
            </section>
          </div>
        )}
      </div>
    </dialog>
  );
}
