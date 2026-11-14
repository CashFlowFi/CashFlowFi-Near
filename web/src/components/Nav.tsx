"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./wallet/WalletButton";
import Image from "next/image";

const LINKS = [
  { href: "/pools", label: "Pools" },
  { href: "/invoices", label: "Invoices" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <Image src="/logo.jpg" alt="" width={28} height={28} priority className="h-7 w-7 rounded-md" />
          <span className="hidden leading-none sm:block">
            <span className="block text-[15px] font-semibold tracking-tight">Cashflow Fi</span>
            <span className="block font-mono text-[10px] text-accent">on NEAR</span>
          </span>
          <span className="sr-only sm:hidden">Cashflow Fi home</span>
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 sm:justify-center sm:gap-2">
          {LINKS.map((l) => {
            const active = path === l.href || path.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-1.5 py-1.5 text-[13px] sm:px-3 sm:text-sm ${active ? "bg-sunken text-ink" : "text-muted hover:text-ink"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden sm:block"><ThemeToggle /></span>
          <WalletButton />
        </div>
      </nav>
    </header>
  );
}
