"use client";
import data from "@/data/agents.json";
import { teeCheckList, type PrivacyBlock } from "@/lib/tee";

const RECORDS = (data as { tee?: Record<string, PrivacyBlock> }).tee ?? {};
export const teeRecordFor = (orderId: number): PrivacyBlock | null => RECORDS[String(orderId)] ?? null;

/** "What was verified": the recorded TEE checks behind a badge, opened on demand. */
export function TeeChecks({ privacy, title = "What was verified" }: { privacy: PrivacyBlock | null; title?: string }) {
  const items = teeCheckList(privacy);
  if (!items.length) return null;
  return (
    <details className="group mt-2 rounded-md border border-ai/30 bg-ai-soft/60 text-left text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-medium text-ai">
        <span aria-hidden="true" className="transition-transform group-open:rotate-90">›</span>
        {title}
        <span className="ml-auto font-mono text-[10px] text-muted">{items.filter((i) => i.ok).length}/{items.length} passed</span>
      </summary>
      <ul className="space-y-1.5 px-3 pb-3">
        {items.map((i) => (
          <li key={i.key} className="flex gap-2">
            <span aria-hidden="true" className={i.ok ? "text-accent" : "text-warn"}>{i.ok ? "✓" : "–"}</span>
            <span>
              <span className="font-medium text-ink">{i.label}</span>
              <span className="block text-muted">{i.detail}</span>
            </span>
          </li>
        ))}
        {privacy?.model && <li className="pt-1 font-mono text-[10px] text-muted">Model: {privacy.model}</li>}
      </ul>
    </details>
  );
}
