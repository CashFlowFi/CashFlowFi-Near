import type { Metadata } from "next";
import { PortfolioWorkspace } from "@/components/portfolio/PortfolioWorkspace";
import { DEMO_ACCOUNTS } from "@/lib/config";

export const metadata: Metadata = { title: "Portfolio" };

const DEMO_INVESTORS = Object.keys(DEMO_ACCOUNTS).filter((a) => DEMO_ACCOUNTS[a] === "demo investor");

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const requested = (await searchParams).account;
  const demo = requested && DEMO_INVESTORS.includes(requested) ? requested : DEMO_INVESTORS[0];
  return <PortfolioWorkspace demoAccount={demo} demoAccounts={DEMO_INVESTORS} />;
}
