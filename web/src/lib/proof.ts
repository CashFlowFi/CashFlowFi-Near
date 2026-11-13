// Proof viewer: a plain-English summary of an evidence record, and its JSON as lines that know their path,
// so the summary can highlight the exact fields it is talking about. Pure; no fetches.
import { formatUsdc } from "./amount.ts";
import { slimPrivacy, teeCheckList } from "./tee.ts";

export type JsonPath = (string | number)[];
export type Tone = "ok" | "ai" | "warn" | "info";

export interface ProofPoint {
  label: string;
  detail?: string;
  tone: Tone;
  /** Fields this point refers to; any line at or below one of them is highlighted. */
  paths: JsonPath[];
}

export interface ProofSummary {
  kind: "attestation" | "run" | "tier" | "reminder" | "record";
  title: string;
  subtitle: string;
  points: ProofPoint[];
  txs: { label: string; hash: string }[];
}

type Doc = Record<string, unknown>;
const isObj = (v: unknown): v is Doc => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const NEAR_TX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export function proofKind(path: string, doc: unknown): ProofSummary["kind"] {
  if (!isObj(doc)) return "record";
  if (path.startsWith("evidence/attestations/") && "verdict" in doc) return "attestation";
  if (path.startsWith("evidence/tiers/") && "new_tier" in doc) return "tier";
  if (path.startsWith("evidence/collections/") && isObj(doc.message)) return "reminder";
  if (Array.isArray(doc.steps)) return "run";
  return "record";
}

export function summarize(path: string, doc: unknown): ProofSummary {
  const kind = proofKind(path, doc);
  const d = (isObj(doc) ? doc : {}) as Doc;
  const tx = (label: string, v: unknown) => (typeof v === "string" && NEAR_TX.test(v) ? [{ label, hash: v }] : []);

  if (kind === "attestation") {
    const privacy = isObj(d.tee) && isObj(d.tee.privacy) ? (d.tee.privacy as Doc) : null;
    const checks = teeCheckList(slimPrivacy(privacy));
    const points: ProofPoint[] = [
      { label: `AI verdict: ${str(d.verdict)}, score ${str(d.score)}`, tone: "ai", paths: [["verdict"], ["score"]] },
    ];
    if (d.source === "model") points.push({ label: `Scored by the model ${str(d.model)}`, tone: "ai", paths: [["source"], ["model"]] });
    else if (d.source === "rules") points.push({ label: "Decided by the hard rules before the model was asked", tone: "info", paths: [["source"], ["reasons"]] });
    else points.push({ label: `Safe fallback verdict (${str(d.model_error) || "model unavailable"})`, tone: "warn", paths: [["source"], ["model_error"]] });
    if (privacy?.verified_private === true) {
      points.push({ label: "Ran inside a verified TEE", detail: `${checks.filter((c) => c.ok).length}/${checks.length} hardware and signature checks passed`, tone: "ok", paths: [["tee", "privacy"]] });
    }
    if (Array.isArray(d.reasons) && d.reasons.length) points.push({ label: `${d.reasons.length} reasons, hashed on-chain`, detail: `reason_hash ${str(d.reason_hash).slice(0, 12)}…`, tone: "info", paths: [["reasons"], ["reason_hash"]] });
    return { kind, title: `Underwriter verdict · order ${str(d.order_id)}`, subtitle: str(d.timestamp), points, txs: tx("attest_receipt on NEAR", d.tx_hash) };
  }

  if (kind === "tier") {
    const privacy = isObj(d.privacy) ? (d.privacy as Doc) : null;
    const points: ProofPoint[] = [
      { label: `Tier ${str(d.old_tier)} → ${str(d.new_tier)} by the rules`, detail: `${str(d.repaid_pools)} repaid pools, ${str(d.defaults)} defaults`, tone: "info", paths: [["old_tier"], ["new_tier"], ["repaid_pools"], ["defaults"]] },
      d.source === "model"
        ? { label: "Explanation written by the TEE model", tone: "ai", paths: [["reason"], ["source"]] }
        : { label: "Standard explanation text", detail: "The model's wording was not used for this change", tone: "info", paths: [["reason"], ["source"], ["model_error"]] },
      { label: "Explanation hashed and stored with the transaction", tone: "info", paths: [["reason_hash"]] },
    ];
    if (privacy?.verified_private === true && d.source === "model") points.push({ label: "Ran inside a verified TEE", tone: "ok", paths: [["privacy"]] });
    return { kind, title: `Merchant tier change · ${str(d.merchant)}`, subtitle: str(d.timestamp), points, txs: tx("set_merchant_tier on NEAR", d.tx_hash) };
  }

  if (kind === "reminder") {
    const m = d.message as Doc;
    const privacy = isObj(m.privacy) ? (m.privacy as Doc) : null;
    const due = typeof d.amount_due === "string" && /^\d+$/.test(d.amount_due) ? `${formatUsdc(d.amount_due)} ${str(d.currency)}` : str(d.amount_due);
    const points: ProofPoint[] = [
      { label: `Reminder for invoice ${str(d.invoice_no)}`, detail: `${due} due from ${str(d.customer)}`, tone: "info", paths: [["invoice_no"], ["amount_due"], ["customer"]] },
      m.source === "model"
        ? { label: "Wording written by the TEE model", tone: "ai", paths: [["message", "subject"], ["message", "body"], ["message", "source"]] }
        : { label: "Standard reminder text", tone: "info", paths: [["message", "source"]] },
    ];
    if (privacy?.verified_private === true) points.push({ label: "Ran inside a verified TEE", tone: "ok", paths: [["message", "privacy"]] });
    return { kind, title: `Payment reminder · order ${str(d.order_id)}`, subtitle: str(d.reminded_at), points, txs: [] };
  }

  if (kind === "run") {
    const steps = (d.steps as unknown[]).filter(isObj);
    const checks = Array.isArray(d.checks) ? d.checks.filter(isObj) : [];
    const passed = checks.filter((c) => c.ok === true).length;
    const points: ProofPoint[] = [
      { label: d.ok === true ? "Run finished with every check passing" : "Run did not finish cleanly", tone: d.ok === true ? "ok" : "warn", paths: [["ok"]] },
      { label: `${steps.length} on-chain steps, each with its transaction`, tone: "info", paths: [["steps"]] },
    ];
    if (checks.length) points.push({ label: `${passed}/${checks.length} state checks matched the chain`, tone: passed === checks.length ? "ok" : "warn", paths: [["checks"]] });
    if (d.order_id !== undefined || d.pool_id !== undefined) points.push({ label: `Order ${str(d.order_id)} · pool ${str(d.pool_id)}`, tone: "info", paths: [["order_id"], ["pool_id"]] });
    const txs = steps.flatMap((s) => tx(str(s.step), s.tx));
    return { kind, title: str(d.scenario) || "Recorded run", subtitle: str(d.finished_at || d.started_at), points, txs };
  }

  return { kind, title: path.split("/").pop() ?? path, subtitle: "", points: [], txs: [] };
}

// ---------- JSON as lines ----------

export interface JsonLine {
  indent: number;
  /** Rendered text of the line, without indentation. */
  text: string;
  /** Path of the value this line belongs to; closing brackets carry their container's path. */
  path: JsonPath;
  /** True when a long string was shortened for display. */
  clipped?: boolean;
}

export const MAX_STRING = 140;

function scalar(v: unknown): { text: string; clipped: boolean } {
  if (typeof v === "string") {
    if (v.length > MAX_STRING) return { text: JSON.stringify(v.slice(0, MAX_STRING)).slice(0, -1) + `…" (${v.length} chars)`, clipped: true };
    return { text: JSON.stringify(v), clipped: false };
  }
  return { text: JSON.stringify(v) ?? "null", clipped: false };
}

/** Pretty-print like JSON.stringify(v, null, 2), one entry per line, with each line's path. */
export function jsonLines(value: unknown): JsonLine[] {
  const out: JsonLine[] = [];
  const walk = (v: unknown, path: JsonPath, indent: number, prefix: string, comma: string) => {
    if (Array.isArray(v) || isObj(v)) {
      const entries: [string | number, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
      const [open, close] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
      if (!entries.length) { out.push({ indent, text: `${prefix}${open}${close}${comma}`, path }); return; }
      out.push({ indent, text: `${prefix}${open}`, path });
      entries.forEach(([k, x], i) => {
        const p = typeof k === "number" ? "" : `${JSON.stringify(k)}: `;
        walk(x, [...path, k], indent + 1, p, i < entries.length - 1 ? "," : "");
      });
      out.push({ indent, text: `${close}${comma}`, path });
      return;
    }
    const s = scalar(v);
    out.push({ indent, text: `${prefix}${s.text}${comma}`, path, ...(s.clipped ? { clipped: true } : {}) });
  };
  walk(value, [], 0, "", "");
  return out;
}

/** A line is highlighted when its path starts with one of the given paths (the root path never matches). */
export function isHighlighted(line: JsonPath, targets: JsonPath[]): boolean {
  return targets.some((t) => t.length > 0 && t.every((k, i) => line[i] === k));
}
