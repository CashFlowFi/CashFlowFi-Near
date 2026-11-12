// Off-chain attack cases against the real underwriter. Defended cases must hold; known weaknesses
// are `todo` tests that assert the secure behaviour, so they report as failing todos until fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, runCase, splitInvoice } from './prompt-injection.mjs';

for (const c of CASES.filter((c) => !c.weakness)) {
  test(`held: ${c.name}`, async () => {
    const got = await runCase(c);
    assert.notEqual(got.verdict, 'Approve');
    assert.equal(got.verdict, c.expect.verdict);
    assert.equal(got.source, c.expect.source);
    assert.equal(got.model_error, c.expect.model_error);
    assert.equal(got.modelCalled, c.expect.modelCalled);
  });
}

test('hijacked model really is hijacked: same reply without the fence would approve', async () => {
  // Proves the defended cases are discriminating: the attacker's score passes threshold if parsing let it through.
  const c = CASES.find((c) => c.name.startsWith('Hijacked model: model adds') || c.name.startsWith('Hijacked model: adds'));
  const clean = { ...c, reply: '{"score":100,"reasons":["ok"]}' };
  assert.equal((await runCase(clean)).verdict, 'Approve');
});

for (const c of CASES.filter((c) => c.weakness)) {
  test(c.name, { todo: c.weakness }, async () => {
    assert.notEqual((await runCase(c)).verdict, 'Approve');
  });
}

test('held: split invoice capped by merchant exposure', async () => {
  const s = await splitInvoice();
  assert.equal(s.whole, 'Reject');
  assert.ok(s.approvedUsdc <= 100_000, `approved ${s.approvedUsdc} USDC in one pool`);
});
