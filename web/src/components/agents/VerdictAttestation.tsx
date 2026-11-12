"use client";
import { repoFileUrl } from "@/lib/config";
import { useVerdict } from "@/lib/verdict";

/** Attestation cell: the badge appears only when the API re-verified the TEE signature for this on-chain verdict. */
export function VerdictAttestation({ orderId }: { orderId: number }) {
  const v = useVerdict(orderId);
  if (v.kind === "loading") return <span className="text-muted">checking…</span>;
  if (v.kind === "unavailable") return <span className="text-muted">details unavailable</span>;
  if (v.data.attestation?.verified !== true) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">TEE verified</span>
      {v.data.attestation.report_url && (
        <a className="text-xs underline" href={repoFileUrl(v.data.attestation.report_url)} target="_blank" rel="noreferrer">report</a>
      )}
    </span>
  );
}
