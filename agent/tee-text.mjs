// Short AI-written text (reminders, tier reasons) from the verified TEE chat, with a deterministic fallback.
// The model never decides anything here: it only words facts that code already chose. Its answer must be strict
// JSON with exactly the expected keys, and `parse` rejects anything off-format, so injected instructions in the
// facts can at worst produce a rejected answer and the template text.
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const fail = (code) => { throw new Error(code); };

/** Strict JSON object with exactly `keys`, each a trimmed single-paragraph-safe string of 1..max chars. */
export function strictText(text, limits) {
  let v; try { v = JSON.parse(text); } catch { fail('TEXT_NOT_JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('TEXT_SHAPE');
  if (Object.keys(v).sort().join(',') !== Object.keys(limits).sort().join(',')) fail('TEXT_SHAPE');
  const out = {};
  for (const [k, max] of Object.entries(limits)) {
    const s = typeof v[k] === 'string' ? v[k].trim() : '';
    // newlines allowed in long fields only; no other control characters anywhere
    if (!s || s.length > max || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(s) || (max <= 200 && s.includes('\n'))) fail('TEXT_FIELD');
    out[k] = s;
  }
  return out;
}

/** Every http(s) link or www. host in `s` must be one of `allowed`. */
export function onlyLinks(s, allowed) {
  const links = s.match(/(https?:\/\/|www\.)[^\s"'<>)]+/gi) ?? [];
  return links.every((l) => allowed.includes(l.replace(/[.,;:!?]+$/, '')));
}

/**
 * chat: agent/tee-quote.mjs createAttestedChat (or null). Returns { ...fields, source, model_error, privacy }.
 * An answer that is not verified_private is not used.
 */
export async function teeText({ chat, system, facts, parse, fallback, maxTokens = 300 }) {
  let privacy = null;
  if (chat) {
    try {
      const r = await chat({ system, user: JSON.stringify(facts), maxTokens });
      privacy = r.privacy ?? null;
      if (privacy?.verified_private !== true) fail('TEE_NOT_VERIFIED');
      return { ...parse(r.text), source: 'model', model_error: null, privacy };
    } catch (e) {
      return { ...fallback(), source: 'template', model_error: CODE.test(e?.message ?? '') ? e.message : 'MODEL_ERROR', privacy };
    }
  }
  return { ...fallback(), source: 'template', model_error: 'MODEL_NOT_CONFIGURED', privacy };
}
