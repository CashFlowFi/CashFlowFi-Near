"use client";
import { useEffect, useState } from "react";
import { API_URL } from "./config";

export interface VerdictResponse {
  verdict: string;
  score: number;
  reasons?: string[];
  attestation?: { verified: boolean; model: string | null; report_url: string | null };
}

export type VerdictState =
  | { kind: "unavailable"; reason: string }
  | { kind: "loading" }
  | { kind: "ok"; data: VerdictResponse };

/** Off-chain verdict details. Verdict and score themselves always come from chain. */
export function useVerdict(orderId: number): VerdictState {
  const [state, setState] = useState<VerdictState>(API_URL ? { kind: "loading" } : { kind: "unavailable", reason: "API not configured" });
  useEffect(() => {
    if (!API_URL) return;
    const ctrl = new AbortController();
    fetch(`${API_URL}/api/agent/verdicts?order_id=${orderId}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (r.status === 404) return setState({ kind: "unavailable", reason: "not attested yet" });
        if (!r.ok) return setState({ kind: "unavailable", reason: `API HTTP ${r.status}` });
        setState({ kind: "ok", data: await r.json() });
      })
      .catch((e) => {
        if (e.name !== "AbortError") setState({ kind: "unavailable", reason: "API unreachable" });
      });
    return () => ctrl.abort();
  }, [orderId]);
  return state;
}
