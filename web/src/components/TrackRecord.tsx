import { CUSTOMER_EXPOSURE_CAP, NEW_CUSTOMER_LIMIT, defaultRate, habitualDefaulter, type CustomerRecord, type MerchantRecord } from "@/lib/records";
import { formatUsdc } from "@/lib/amount";
import { Account, Info } from "@/components/ui";

const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`;

/** The track records the underwriter weighs, from chain data, computed the same way as the agent. */
export function TrackRecord({ customer, customerRec, merchant, merchantRec, tier }: {
  customer: string | null; customerRec: CustomerRecord | null; merchant: string; merchantRec: MerchantRecord; tier?: string;
}) {
  const rate = customerRec ? defaultRate(customerRec) : null;
  return (
    <div className="space-y-3 text-sm">
      <p className="eyebrow flex items-center gap-2 !text-ai">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-ai" />
        Track record the AI weighs
        <Info text="Read from the contract today. The underwriter sees the customer's own record (paid, defaulted, open) and the merchant's pools, and weighs the customer's record most. Rules run first: a customer with 2+ defaults and more defaults than payments is rejected, a customer owing more than 100,000 USDC across all merchants is rejected, and a new customer's invoice above 20 USDC goes to human review until one is paid." />
      </p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-muted">Customer {customer && <Account id={customer} />}</span>
        {customerRec ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">{n(customerRec.paid, "paid", "paid")}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${customerRec.defaults ? "bg-bad-soft text-bad" : "bg-sunken text-muted"}`}>{n(customerRec.defaults, "default", "defaults")}</span>
            <span className="rounded-full bg-sunken px-2 py-0.5 text-xs text-muted">{customerRec.open} open</span>
            {customerRec.outstanding > BigInt(0) && <span className="rounded-full bg-sunken px-2 py-0.5 text-xs text-muted">owes {formatUsdc(customerRec.outstanding)} USDC</span>}
            {rate !== null && <span className="num text-xs text-muted">{rate}% default rate</span>}
          </span>
        ) : (
          <span className="text-muted">set when the customer approves</span>
        )}
      </div>
      {customerRec && customerRec.paid === 0 && customerRec.defaults === 0 && (
        <p className="rounded-md bg-ai-soft px-3 py-2 text-xs text-ai">New customer: invoices above {formatUsdc(NEW_CUSTOMER_LIMIT)} USDC go to human review until one is paid.</p>
      )}
      {customerRec && customerRec.outstanding >= CUSTOMER_EXPOSURE_CAP && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">At the 100,000 USDC limit across all merchants: new invoices are rejected by rule.</p>
      )}
      {customerRec && habitualDefaulter(customerRec) && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">Repeat defaulter: new invoices from this customer are rejected by rule.</p>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-muted">Merchant</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">{n(merchantRec.repaidPools, "repaid pool", "repaid pools")}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${merchantRec.defaults ? "bg-bad-soft text-bad" : "bg-sunken text-muted"}`}>{n(merchantRec.defaults, "default", "defaults")}</span>
          {tier && <span className="rounded-full bg-sunken px-2 py-0.5 text-xs">tier {tier}</span>}
        </span>
      </div>
      <p className="sr-only">Merchant account {merchant}</p>
    </div>
  );
}
