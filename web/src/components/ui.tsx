import { DEMO_ACCOUNTS, accountUrl } from "@/lib/config";
import { formatUsdc } from "@/lib/amount";
import type { PoolStatus } from "@/lib/types";

export function Account({ id, link = true }: { id: string | null; link?: boolean }) {
  if (!id) return <span className="text-muted">not set</span>;
  const label = DEMO_ACCOUNTS[id];
  const name = link ? (
    <a href={accountUrl(id)} target="_blank" rel="noreferrer" className="break-all underline decoration-line underline-offset-2 hover:decoration-ink">
      {id}
    </a>
  ) : (
    <span className="break-all">{id}</span>
  );
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      {name}
      {label && <span className="rounded bg-sunken px-1.5 text-xs text-muted">{label}</span>}
    </span>
  );
}

export function Usdc({ value, unit = true }: { value: string | bigint; unit?: boolean }) {
  return (
    <span className="num whitespace-nowrap">
      {formatUsdc(value)}
      {unit && <span className="ml-1 text-xs text-muted">USDC</span>}
    </span>
  );
}

const STATUS_STYLE: Record<PoolStatus, string> = {
  Funding: "bg-warn-soft text-warn",
  Active: "bg-accent-soft text-accent",
  Repaid: "bg-sunken text-ink",
  Defaulted: "bg-bad-soft text-bad",
};

export function StatusBadge({ status }: { status: PoolStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{status}</span>;
}

/** Explanation on hover and keyboard focus; the text stays available to screen readers. */
export function Info({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex align-middle">
      <button type="button" aria-label={text} className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-line text-[10px] leading-none text-muted">
        i
      </button>
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-60 -translate-x-1/2 rounded-md border border-line bg-surface p-2 text-xs font-normal text-ink shadow-lg group-focus-within:block group-hover:block">
        {text}
      </span>
    </span>
  );
}

export function Rows({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-line">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Unavailable({ what }: { what?: string }) {
  return <span className="text-muted">{what ? `${what} unavailable` : "unavailable"}</span>;
}

export function ErrorPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div role="alert" className="rounded-lg border border-bad/40 bg-bad-soft p-4 text-sm">
      <p className="font-medium text-bad">{title}</p>
      <p className="mt-1 text-muted">{detail}</p>
    </div>
  );
}
