"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "./WalletProvider";

export function WalletButton() {
  const { ready, accountId, signIn, signOut } = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  if (!accountId) {
    return (
      <button type="button" onClick={signIn} disabled={!ready} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50">
        {ready ? "Sign in" : "Loading…"}
      </button>
    );
  }
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className="max-w-[11rem] truncate rounded-md border border-line px-3 py-1.5 text-sm hover:bg-sunken sm:max-w-[16rem]">
        {accountId}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-48 rounded-md border border-line bg-surface p-1 text-sm shadow-lg">
          <Link role="menuitem" href="/portfolio" onClick={() => setOpen(false)} className="block rounded px-3 py-2 hover:bg-sunken">Portfolio</Link>
          <Link role="menuitem" href="/merchant" onClick={() => setOpen(false)} className="block rounded px-3 py-2 hover:bg-sunken">Merchant</Link>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); signOut(); }} className="block w-full rounded px-3 py-2 text-left hover:bg-sunken">Sign out</button>
        </div>
      )}
    </div>
  );
}
