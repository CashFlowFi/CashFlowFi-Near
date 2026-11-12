// File store: evidence/{quotes,forwards,payments,ledger}.
//   quotes/<depositAddress>.json  the binding, written before any money moves
//   forwards/<delivery>.json      the claim, created exclusively BEFORE broadcast so a delivery is forwarded at most once
//   payments/<order>.json         per-order view of every deposit's stage
//   ledger/payments.jsonl         one row per confirmed payment_applied

import { mkdir, readdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

const B58 = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const fail = (code) => { throw new Error(code); };

const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

const listJson = async (d) => {
  let names; try { names = await readdir(d); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.json')).sort()) { try { out.push(JSON.parse(await readFile(path.join(d, n), 'utf8'))); } catch { /* skip partial */ } }
  return out;
};

const atomic = async (file, data) => {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, file);
};

export function createFileStore(evidenceDir) {
  const dir = { quotes: path.join(evidenceDir, 'quotes'), forwards: path.join(evidenceDir, 'forwards'), payments: path.join(evidenceDir, 'payments') };
  const ledgerFile = path.join(evidenceDir, 'ledger', 'payments.jsonl');
  const claimPath = (id) => {
    const [h, r] = String(id).split('-');
    if (!B58.test(h ?? '') || !B58.test(r ?? '')) fail('DELIVERY_ID');
    return path.join(dir.forwards, `${id}.json`);
  };
  const paymentPath = (orderId) => { if (!Number.isSafeInteger(orderId) || orderId <= 0) fail('ORDER_ID'); return path.join(dir.payments, `${orderId}.json`); };
  async function readPayments(orderId) {
    const f = await readJson(paymentPath(orderId));
    if (f && !Array.isArray(f.payments)) fail(`PAYMENT_EVIDENCE_FORMAT: ${paymentPath(orderId)} is not a forwarder record; move it aside`);
    return f;
  }
  return {
    bindingPath: (addr) => path.join(dir.quotes, `${addr.toLowerCase()}.json`),
    readBinding: (addr) => readJson(path.join(dir.quotes, `${addr.toLowerCase()}.json`)),
    saveBinding: (binding) => atomic(path.join(dir.quotes, `${binding.depositAddress.toLowerCase()}.json`), binding),
    listBindings: () => listJson(dir.quotes),
    getClaim: (id) => readJson(claimPath(id)),
    async findClaimByDeposit(deposit) { return (await listJson(dir.forwards)).find((c) => c.deposit_address?.toLowerCase() === deposit.toLowerCase()) ?? null; },
    async claimedDeliveries() { return new Set((await listJson(dir.forwards)).map((c) => c.delivery_id)); },
    /** Exclusive create: false if this delivery is already claimed (by this or any other process). */
    async createClaim(id, data) {
      const p = claimPath(id);
      await mkdir(path.dirname(p), { recursive: true });
      try { await writeFile(p, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    },
    saveClaim: (id, data) => atomic(claimPath(id), data),
    async findEntry(orderId, deposit) {
      const f = await readPayments(orderId);
      return f?.payments.find((p) => p.deposit_address?.toLowerCase() === deposit.toLowerCase()) ?? null;
    },
    readPayments,
    async upsertEntry(orderId, entry) {
      const f = (await readPayments(orderId)) ?? { order_id: orderId, contract: entry.contract ?? null, forwarder: entry.forwarder ?? null, payments: [] };
      const i = f.payments.findIndex((p) => p.deposit_address?.toLowerCase() === entry.deposit_address.toLowerCase());
      const clean = { ...entry }; delete clean.forward_signed_tx;
      if (i >= 0) f.payments[i] = { ...f.payments[i], ...clean }; else f.payments.push(clean);
      await atomic(paymentPath(orderId), f);
    },
    async readLedger() {
      let text; try { text = await readFile(ledgerFile, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },
    async appendLedger(row) {
      if ((await this.readLedger()).some((r) => r.near_tx === row.near_tx)) return false;
      await mkdir(path.dirname(ledgerFile), { recursive: true });
      await appendFile(ledgerFile, JSON.stringify(row) + '\n');
      return true;
    },
  };
}
