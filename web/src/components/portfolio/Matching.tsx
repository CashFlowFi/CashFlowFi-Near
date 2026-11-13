"use client";
import Link from "next/link";
import { useState } from "react";
import { API_URL } from "@/lib/config";
import { Info, Usdc } from "@/components/ui";
import { TeeChecks } from "@/components/TeeChecks";
import type { PrivacyBlock } from "@/lib/tee";

interface Suggestion { rank: number; pool_id: number; tranche: string; amount: string; reason: string }
interface MatchResponse {
  source: "model" | "fallback";
  suggestions: Suggestion[];
  candidates: number;
  privacy: PrivacyBlock & { model: string | null; verified_private: boolean };
}

/** Private matching: the intent goes to the API only, never stored here or logged. */
export function Matching() {
  const [intent, setIntent] = useState("");
  const [tranche, setTranche] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<MatchResponse | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!API_URL) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = intent.trim();
    if (!text || text.length > 280) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch(`${API_URL}/api/invest/match`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tranche ? { intent: text, filters: { tranche } } : { intent: text }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRes(await r.json());
    } catch (err) {
      setNote(`Matching is reconnecting. Try again in a moment. (${(err as Error).message})`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5">
      <h2 className="font-semibold">
        Find a tranche
        <Info text="Describe what you want. Open pools are filtered in code, then a NEAR AI model in a TEE ranks them. Your text is not stored." />
      </h2>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="intent">What are you looking for?</label>
        <input id="intent" value={intent} maxLength={280} onChange={(e) => setIntent(e.target.value)} placeholder="Short-dated, senior only, about 5 USDC" className="flex-1 rounded-md border border-line bg-bg px-3 py-2 text-sm" />
        <label className="sr-only" htmlFor="tranche-filter">Tranche</label>
        <select id="tranche-filter" value={tranche} onChange={(e) => setTranche(e.target.value)} className="rounded-md border border-line bg-bg px-3 py-2 text-sm">
          <option value="">Any tranche</option>
          <option value="Senior">Senior</option>
          <option value="Junior">Junior</option>
        </select>
        <button type="submit" disabled={busy || !intent.trim()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50">
          {busy ? "Matching…" : "Match"}
        </button>
      </form>
      {note && <p className="mt-3 text-sm text-muted">{note}</p>}
      {res && (
        <div className="mt-4 space-y-3">
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {res.privacy.verified_private && <span className="inline-flex items-center gap-1 rounded-full bg-ai-soft px-2 py-0.5 font-medium text-ai"><span aria-hidden="true">◆</span>Verified private (TEE)</span>}
            <span>{res.source === "model" ? `Ranked by ${res.privacy.model ?? "the model"}` : "Ranked by underwriter score, tier and term"}</span>
          </p>
          {res.privacy.verified_private && <TeeChecks privacy={res.privacy} title="What was verified for this answer" />}
          {res.suggestions.length === 0 ? (
            <p className="text-sm text-muted">Every open tranche is fully funded right now. New pools appear on the Pools page.</p>
          ) : (
            <ol className="divide-y divide-line">
              {res.suggestions.map((s) => (
                <li key={`${s.pool_id}-${s.tranche}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="font-medium">Pool #{s.pool_id} · {s.tranche}</span> · <Usdc value={s.amount} />
                    <span className="block text-xs text-muted">{s.reason}</span>
                  </span>
                  <Link href={`/pools/${s.pool_id}`} className="rounded-md border border-line px-3 py-1.5 hover:bg-sunken">Review and invest</Link>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
