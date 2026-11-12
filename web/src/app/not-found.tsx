import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="mt-2 text-muted">Nothing on the contract matches this address. <Link href="/pools" className="underline">Browse pools</Link>.</p>
    </div>
  );
}
