export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading from NEAR testnet…</span>
      <div className="h-8 w-40 animate-pulse rounded bg-sunken" />
      <div className="mt-6 h-64 animate-pulse rounded-lg bg-sunken" />
    </div>
  );
}
