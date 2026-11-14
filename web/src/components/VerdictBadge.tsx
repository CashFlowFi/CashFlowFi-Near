/** Underwriter verdict as a colored badge. Color is never the only cue: each verdict also has a symbol and a word. */
const STYLE: Record<string, { cls: string; glyph: string; label: string }> = {
  Approve: { cls: "bg-accent-soft text-accent", glyph: "✓", label: "Approved" },
  Flag: { cls: "bg-warn-soft text-warn", glyph: "!", label: "Flagged for review" },
  Reject: { cls: "bg-bad-soft text-bad", glyph: "✕", label: "Rejected" },
};

export function VerdictBadge({ verdict, score }: { verdict: string | null; score?: number | null }) {
  if (!verdict) return <span className="text-muted">none yet</span>;
  const s = STYLE[verdict] ?? { cls: "bg-sunken text-muted", glyph: "·", label: verdict };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.cls}`}>
      <span aria-hidden="true">{s.glyph}</span>
      {s.label}
      {score !== undefined && score !== null && <span className="num font-medium opacity-80">· {score}/100</span>}
    </span>
  );
}
