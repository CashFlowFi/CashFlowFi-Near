import data from "@/data/receipts.json";

export interface ReceiptRun {
  file: string;
  scenario: string;
  finished_at: string | null;
  steps: { step: string; tx: string }[];
}

const index = data as { pools: Record<string, ReceiptRun[]>; orders: Record<string, ReceiptRun[]> };

export const poolReceipts = (id: number): ReceiptRun[] => index.pools[String(id)] ?? [];
export const orderReceipts = (id: number): ReceiptRun[] => index.orders[String(id)] ?? [];
