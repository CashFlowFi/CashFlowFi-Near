"use client";
import { usePathname } from "next/navigation";

/** Mint and violet glow with a halftone field; softer on inner pages than on the welcome screen. */
export function Ambient() {
  const home = usePathname() === "/";
  return (
    <div aria-hidden="true" className="ambient" style={{ opacity: home ? 1 : 0.7 }}>
      <div className="aurora" />
      <div className="halftone" />
    </div>
  );
}
export function Eyebrow({ children, ai = false }: { children: React.ReactNode; ai?: boolean }) {
  return (
    <p className={`eyebrow mb-2 flex items-center gap-2 ${ai ? "!text-ai" : ""}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${ai ? "bg-ai" : "bg-accent"}`} />
      {children}
    </p>
  );
}
