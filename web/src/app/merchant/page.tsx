import type { Metadata } from "next";
import { MerchantWorkspace } from "@/components/merchant/MerchantWorkspace";

export const metadata: Metadata = { title: "Merchant" };

export default async function MerchantPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  return <MerchantWorkspace demo={(await searchParams).account === "merchant.cashflowfi.testnet"} />;
}
