"use client";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="py-16">
      <h1 className="text-3xl sm:text-4xl tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-muted">{error.message}</p>
      <button type="button" onClick={reset} className="mt-4 rounded-md border border-line px-4 py-2 text-sm hover:bg-sunken">Try again</button>
    </div>
  );
}
