"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./wallet/WalletButton";

const LINKS = [
  { href: "/pools", label: "Pools" },
  { href: "/invoices", label: "Invoices" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="border-b border-line bg-surface/80 backdrop-blur">
      <nav aria-label="Main" className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-4 sm:gap-4 sm:px-6">
        <Link href="/" className="mr-2 font-semibold tracking-tight sm:mr-4">
          Cashflow<span className="text-accent"> Fi</span>
        </Link>
        {LINKS.map((l) => {
          const active = path === l.href || path.startsWith(l.href + "/");
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-2 py-1.5 text-sm ${active ? "bg-sunken font-medium text-ink" : "text-muted hover:text-ink"}`}
            >
              {l.label}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <WalletButton />
        </div>
      </nav>
    </header>
  );
}
