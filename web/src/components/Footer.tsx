import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";
import { CONTRACT, REPO_URL, accountUrl } from "@/lib/config";

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-6 text-sm text-muted sm:px-6">
        <Link href="/merchant" className="hover:text-ink">Merchant</Link>
        <Link href="/agents" className="hover:text-ink">Agents</Link>
        <Link href="/insurance" className="hover:text-ink">Insurance</Link>
        <a href={accountUrl(CONTRACT)} target="_blank" rel="noreferrer" className="hover:text-ink">Contract</a>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="hover:text-ink">Source</a>
        <span className="ml-auto flex items-center gap-3">NEAR testnet<span className="sm:hidden"><ThemeToggle /></span></span>
      </div>
    </footer>
  );
}
