import { nsToDate } from "./amount.ts";

const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** UTC so server and client render the same text. */
export function formatNs(ns: string): string {
  return `${fmt.format(nsToDate(ns))} UTC`;
}

export function shortHash(h: string, n = 6): string {
  return h.length <= n * 2 + 1 ? h : `${h.slice(0, n)}…${h.slice(-n)}`;
}

export function formatDuration(ns: string): string {
  const s = Number(BigInt(ns) / BigInt(1_000_000_000));
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
