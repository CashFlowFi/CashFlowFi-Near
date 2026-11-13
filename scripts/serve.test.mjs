import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROCESSES, routeFor } from './serve.mjs';

test('relay paths go to the relayer, everything else to the API', () => {
  for (const p of ['/relay', '/relay/health', '/relay?x=1']) assert.equal(routeFor(p), 8788, p);
  for (const p of ['/', '/api/agent/verdicts?order_id=42', '/api/pay/quote', '/relayer', '/relays']) assert.equal(routeFor(p), 8787, p);
});

test('all five backend processes are hosted', () => {
  assert.deepEqual(PROCESSES.map((p) => p.name), ['api', 'relayer', 'agent', 'collections', 'forwarder']);
});
