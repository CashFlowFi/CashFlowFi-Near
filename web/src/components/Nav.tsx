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
    <header className="border-b border-line bg-bg">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:h-20 sm:gap-6 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-3">
          <span aria-hidden="true" className="grid h-7 w-7 grid-cols-3 gap-[2px] bg-transparent">
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className={[0, 2, 4, 6, 8].includes(i) ? "bg-accent" : "bg-line"} />
            ))}
          </span>
          <span className="hidden font-display text-lg font-bold tracking-tight sm:inline">Cashflow Fi</span>
          <span className="sr-only sm:hidden">Cashflow Fi home</span>
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-1 sm:justify-center sm:gap-6">
          {LINKS.map((l) => {
            const active = path === l.href || path.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`px-1 py-1 text-[12px] sm:px-1.5 sm:text-[13px] font-medium underline-offset-[6px] ${active ? "text-accent underline decoration-2" : "text-ink hover:underline"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <WalletButton />
        </div>
      </nav>
    </header>
  );
}
