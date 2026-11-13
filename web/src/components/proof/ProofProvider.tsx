"use client";
import { createContext, useCallback, useContext, useState } from "react";
import { ProofViewer } from "./ProofViewer";

const Ctx = createContext<(path: string) => void>(() => {});

/** Lets any evidence link open the in-app proof viewer instead of a raw GitHub page. */
export function ProofProvider({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState<string | null>(null);
  const open = useCallback((p: string) => setPath(p), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      <ProofViewer path={path} onClose={() => setPath(null)} />
    </Ctx.Provider>
  );
}

/** A link-styled button that opens one evidence record (repo path such as "evidence/attestations/42.json"). */
export function ProofLink({ path, children, className = "underline decoration-line underline-offset-2 hover:decoration-ink" }: {
  path: string; children: React.ReactNode; className?: string;
}) {
  const open = useContext(Ctx);
  return (
    <button type="button" onClick={() => open(path)} className={className}>
      {children}
    </button>
  );
}

/** Proof link styled as a pill that pairs with the "TEE verified" badge. */
export function ProofChip({ path, label = "Proof" }: { path: string; label?: string }) {
  return (
    <ProofLink
      path={path}
      className="inline-flex items-center gap-1 rounded-full border border-ai/40 px-2 py-0.5 text-xs font-medium text-ai transition-colors hover:border-ai hover:bg-ai-soft"
    >
      {label}
      <span aria-hidden="true">›</span>
    </ProofLink>
  );
}
