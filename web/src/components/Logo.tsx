/** Mark: a ledger of three bars climbing (cash flowing in), framed by corner brackets. */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} aria-hidden="true" fill="none">
      <path d="M2 8V2h6M20 2h6v6M26 20v6h-6M8 26H2v-6" stroke="currentColor" strokeWidth="1.6" className="text-muted" />
      <rect x="7" y="15" width="3.2" height="6" rx="1" className="fill-accent" />
      <rect x="12.4" y="11" width="3.2" height="10" rx="1" className="fill-accent" opacity="0.8" />
      <rect x="17.8" y="7" width="3.2" height="14" rx="1" className="fill-ai" />
    </svg>
  );
}
