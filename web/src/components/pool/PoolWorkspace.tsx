"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deriveStages, type Stage, type StageKey } from "@/lib/stages";
import { remaining, sum, toBig } from "@/lib/amount";
import { TIER_LTV, type Config, type Order, type Pool, type Position } from "@/lib/types";
import type { ReceiptRun } from "@/lib/receipts";
import { formatNs } from "@/lib/format";
import { Account, Info, Rows, StatusBadge, Usdc } from "@/components/ui";
import { StageBody } from "./StageBody";
import { defaultRole, roleAction, type ActionKey, type Role } from "@/lib/roles";
import { useWallet } from "@/components/wallet/WalletProvider";
import { ClaimButton, InvestForm, PayForm, RetryAdvanceButton, SignInFor } from "@/components/actions/Actions";
import { ReceiptsDrawer } from "./ReceiptsDrawer";

const ROLES: { key: Role; label: string }[] = [
  { key: "observer", label: "Observer" },
  { key: "merchant", label: "Merchant" },
  { key: "customer", label: "Customer" },
  { key: "investor", label: "Investor" },
];

export interface WorkspaceProps {
  pool: Pool;
  orders: Order[];
  positions: Position[] | null;
  config: Config;
  receipts: ReceiptRun[];
}

export function PoolWorkspace(props: WorkspaceProps) {
  const { pool, orders, positions } = props;
  const router = useRouter();
  const view = useMemo(() => deriveStages(pool, orders, positions), [pool, orders, positions]);
  const [open, setOpen] = useState<StageKey>(view.open);
  const { accountId } = useWallet();
  const [role, setRole] = useState<Role>("observer");
  // Signing in picks the role this account plays on the pool; "View as" can still switch it.
  // Only on sign-in changes, so the 15 s refresh never overrides the reader's choice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setRole(defaultRole(accountId, pool, orders, positions)), [accountId, pool.id]);
  const [replaying, setReplaying] = useState(false);
  const [drawer, setDrawer] = useState(false);

  // A live pool follows the chain: refresh every 15 s, and move to the new current stage when it changes.
  useEffect(() => {
    if (view.settled) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [view.settled, router]);
  const lastOpen = useRef(view.open);
  useEffect(() => {
    if (lastOpen.current !== view.open) {
      lastOpen.current = view.open;
      setOpen(view.open);
    }
  }, [view.open]);

  // Replay: view only, steps through the recorded stages and stops on the result.
  useEffect(() => {
    if (!replaying) return;
    const keys = view.stages.map((s) => s.key);
    let i = 0;
    setOpen(keys[0]);
    const t = setInterval(() => {
      i += 1;
      if (i >= keys.length) {
        clearInterval(t);
        setReplaying(false);
        return;
      }
      setOpen(keys[i]);
    }, 1600);
    return () => clearInterval(t);
  }, [replaying, view.stages]);

  const repaid = sum(pool.senior_repaid, pool.junior_repaid);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted">
            <Link href="/pools" className="hover:text-ink">Pools</Link> / #{pool.id}
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            Pool #{pool.id} <StatusBadge status={pool.status} />
          </h1>
        </div>
        <dl className="grid grid-cols-3 gap-4 sm:gap-8">
          <Metric label="Receivable" value={<Usdc value={pool.receivable} />} />
          <Metric label={`Advance · tier ${pool.tier}`} value={<Usdc value={pool.advance} />} hint={`${TIER_LTV[pool.tier]}% of the receivable is advanced to the merchant.`} />
          <Metric label="Repaid" value={<Usdc value={repaid} />} hint="Repaid to senior and junior investors, including any insurance cover." />
        </dl>
      </header>

      <StageSelector stages={view.stages} open={open} onOpen={(k) => { setReplaying(false); setOpen(k); }} />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section role="tabpanel" aria-labelledby={`tab-${open}`} aria-live={replaying ? "polite" : undefined} className="self-start rounded-lg border border-line bg-surface p-5">
          <StageBody stage={open} state={view.stages.find((s) => s.key === open)!.state} settled={view.settled} {...props} />
        </section>

        <aside className="space-y-4">
          <div className="rounded-lg border border-line bg-surface p-5">
            <label htmlFor="view-as" className="text-xs font-medium uppercase tracking-wide text-muted">View as</label>
            <select
              id="view-as"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="mt-2 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
            >
              {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <div className="mt-3"><RoleSummary role={role} {...props} /></div>
            <div className="mt-4">
              <PrimaryAction role={role} settled={view.settled} replaying={replaying} onReplay={() => setReplaying((r) => !r)} {...props} />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDrawer(true)}
            className="flex w-full items-center justify-between rounded-lg border border-line bg-surface px-5 py-3 text-sm font-medium hover:bg-sunken"
          >
            Activity &amp; receipts
            <span className="text-muted">{props.receipts.reduce((n, r) => n + r.steps.length, 0) || ""} →</span>
          </button>
        </aside>
      </div>

      <ReceiptsDrawer open={drawer} onClose={() => setDrawer(false)} pool={pool} orders={orders} receipts={props.receipts} />
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">
        {label}
        {hint && <Info text={hint} />}
      </dt>
      <dd className="mt-0.5 text-base font-semibold sm:text-lg">{value}</dd>
    </div>
  );
}

const DOT: Record<Stage["state"], string> = {
  done: "bg-accent border-accent text-accent-ink",
  current: "border-warn bg-warn-soft text-warn",
  upcoming: "border-line bg-surface text-muted",
  missed: "border-warn bg-warn-soft text-warn",
};
const STATE_TEXT: Record<Stage["state"], string> = { done: "done", current: "in progress", upcoming: "upcoming", missed: "skipped" };

function StageSelector({ stages, open, onOpen }: { stages: Stage[]; open: StageKey; onOpen: (k: StageKey) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Keep the open stage visible when the selector scrolls sideways (mobile).
  useEffect(() => {
    refs.current[stages.findIndex((s) => s.key === open)]?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [open, stages]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % stages.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + stages.length) % stages.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = stages.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onOpen(stages[j].key);
    refs.current[j]?.focus();
  };
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div role="tablist" aria-label="Pool stages" className="flex min-w-max items-center">
        {stages.map((s, i) => {
          const selected = s.key === open;
          return (
            <div key={s.key} className="flex items-center">
              {i > 0 && <span aria-hidden="true" className={`h-px w-5 sm:w-8 ${s.state === "upcoming" ? "bg-line" : "bg-accent/50"}`} />}
              <button
                ref={(el) => { refs.current[i] = el; }}
                role="tab"
                id={`tab-${s.key}`}
                aria-selected={selected}
                aria-label={`${s.label}, ${STATE_TEXT[s.state]}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onOpen(s.key)}
                onKeyDown={(e) => onKey(e, i)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${selected ? "border-ink bg-surface font-medium shadow-sm" : "border-transparent text-muted hover:text-ink"}`}
              >
                <span aria-hidden="true" className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-bold ${DOT[s.state]}`}>
                  {s.state === "done" ? "✓" : s.state === "missed" ? "–" : ""}
                </span>
                {s.label}
                {s.key === "underwritten" && <span className="rounded bg-ai-soft px-1 font-mono text-[10px] text-ai">AI</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoleSummary({ role, pool, orders, positions }: { role: Role } & WorkspaceProps) {
  const owed = remaining(pool.receivable, sum(...orders.map((o) => o.paid)));
  if (role === "merchant") {
    const funded = pool.status !== "Funding";
    return (
      <Rows
        rows={[
          ["Merchant", <Account key="m" id={pool.merchant} />],
          ["Advance", <Usdc key="a" value={pool.advance} />],
          ["Fee", <Usdc key="f" value={pool.fee} />],
          ["Paid out to merchant", funded ? <Usdc key="r" value={toBig(pool.advance) - toBig(pool.fee)} /> : <span key="r" className="text-muted">after funding</span>],
          ["Residual received", <Usdc key="res" value={pool.residual_paid} />],
        ]}
      />
    );
  }
  if (role === "customer") {
    return (
      <Rows
        rows={[
          ["Customer", <Account key="c" id={orders[0]?.customer ?? null} />],
          ["Invoice total", <Usdc key="t" value={pool.receivable} />],
          ["Paid", <Usdc key="p" value={sum(...orders.map((o) => o.paid))} />],
          ["Still owed", <Usdc key="o" value={owed} />],
        ]}
      />
    );
  }
  if (role === "investor") {
    return (
      <Rows
        rows={[
          ["Senior funded", <span key="s"><Usdc value={pool.senior_funded} unit={false} /> / <Usdc value={pool.senior_target} /></span>],
          ["Senior repaid", <span key="sr"><Usdc value={pool.senior_repaid} unit={false} /> / <Usdc value={pool.senior_face} /></span>],
          ["Junior funded", <span key="j"><Usdc value={pool.junior_funded} unit={false} /> / <Usdc value={pool.junior_target} /></span>],
          ["Junior repaid", <span key="jr"><Usdc value={pool.junior_repaid} unit={false} /> / <Usdc value={pool.junior_face} /></span>],
          ["Positions", positions ? String(positions.length) : <span key="u" className="text-muted">unavailable</span>],
        ]}
      />
    );
  }
  return (
    <Rows
      rows={[
        ["Merchant", <Account key="m" id={pool.merchant} />],
        ["Tier", `${pool.tier} · ${TIER_LTV[pool.tier]}% advance`],
        ["Due", formatNs(pool.due_date)],
        ["Invoices", orders.map((o) => o.invoice_no).join(", ") || "—"],
      ]}
    />
  );
}

const ACTION_LABEL: Record<ActionKey, string> = { invest: "Invest", claim: "Claim", pay: "Pay invoice", retry_advance: "Send advance" };

function PrimaryAction({
  role, pool, orders, positions, settled, replaying, onReplay,
}: { role: Role; settled: boolean; replaying: boolean; onReplay: () => void } & WorkspaceProps) {
  const { accountId } = useWallet();
  const primary = "w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90";

  if (role === "observer") {
    return settled ? (
      <button type="button" onClick={onReplay} className={primary} aria-pressed={replaying}>
        {replaying ? "Stop replay" : "Replay this pool"}
      </button>
    ) : (
      <p className="text-sm text-muted">Pick a role to see its next step on this pool.</p>
    );
  }

  const action = roleAction(role, pool, orders, positions, accountId);
  if (!action) {
    return settled ? (
      <button type="button" onClick={onReplay} className={primary} aria-pressed={replaying}>
        {replaying ? "Stop replay" : "Replay this pool"}
      </button>
    ) : (
      <p className="text-sm text-muted">The {role} is all set at this stage.</p>
    );
  }
  if (!accountId) return <SignInFor label={ACTION_LABEL[action]} />;
  if (action === "invest") return <InvestForm key={pool.id} pool={pool} accountId={accountId} />;
  if (action === "pay") return <PayForm orders={orders} accountId={accountId} />;
  if (action === "claim") return <ClaimButton positions={positions ?? []} accountId={accountId} />;
  return <RetryAdvanceButton pool={pool} />;
}
