"use client";
import { useState } from "react";
import { customerHashOf, isRealCustomerHash } from "@/lib/share";

/** Lets the buyer confirm the invoice names them, without the reference ever leaving the browser. */
export function ForMeCheck({ customerHash }: { customerHash: string }) {
  const [ref, setRef] = useState("");
  const [result, setResult] = useState<"match" | "nomatch" | null>(null);
  if (!isRealCustomerHash(customerHash)) return null;
  return (
    <form
      className="space-y-2 rounded-md border border-line p-3 text-sm"
      onSubmit={async (e) => { e.preventDefault(); if (ref.trim()) setResult((await customerHashOf(ref)) === customerHash ? "match" : "nomatch"); }}
    >
      <label htmlFor="forme" className="font-medium">Is this invoice for you?</label>
      <p className="text-xs text-muted">Type the email or reference you gave the merchant. It is hashed in your browser and compared with the hash on-chain; it is never sent anywhere.</p>
      <div className="flex gap-2">
        <input id="forme" value={ref} onChange={(e) => { setRef(e.target.value); setResult(null); }} autoComplete="off" placeholder="you@example.com" className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2" />
        <button type="submit" className="rounded-md border border-line px-3 py-2 hover:bg-sunken">Check</button>
      </div>
      {result === "match" && <p role="status" className="text-accent">✓ Matches. This invoice was issued to you.</p>}
      {result === "nomatch" && <p role="status" className="text-warn">This reference differs from the one on the invoice. Check with the merchant before approving.</p>}
    </form>
  );
}
