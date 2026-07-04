// ============================================================
// Basic content moderation
// ------------------------------------------------------------
// Applied to user-authored text before it's stored: listing &
// auction titles/descriptions, order chat messages, and profile
// bios. Two tiers:
//
//   - BLOCK  : hate slurs and other content we never want on the
//              site. Submitting it is rejected with a 400.
//   - MASK   : ordinary profanity. Allowed but the word is starred
//              out (f***) so listings/chat stay presentable.
//
// Both lists are matched against a *normalized* copy of the text so
// simple evasions (leetspeak, extra spaces/punctuation between
// letters, repeated characters) don't slip through. Deployments can
// extend either list with the MOD_BLOCKLIST / MOD_MASKLIST env vars
// (comma-separated) or disable the whole thing with MODERATION=0.
// ============================================================

const enabled = process.env.MODERATION !== '0';

// Hard-blocked terms. Kept intentionally short — hate slurs and the
// like. These are matched loosely (see normalize) so we don't need a
// spelling for every variation.
const DEFAULT_BLOCKLIST = [
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'chink', 'spic',
  'kike', 'coon', 'tranny', 'wetback', 'gook', 'paki',
  'childporn', 'cp', 'kys', 'killyourself',
];

// Masked (softened) terms — allowed but starred out.
const DEFAULT_MASKLIST = [
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'pussy',
  'bastard', 'whore', 'slut', 'cock', 'wanker',
];

function fromEnv(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const BLOCKLIST = [...new Set([...DEFAULT_BLOCKLIST, ...fromEnv('MOD_BLOCKLIST')])];
const MASKLIST = [...new Set([...DEFAULT_MASKLIST, ...fromEnv('MOD_MASKLIST')])];

const LEET = { '@': 'a', '4': 'a', '8': 'b', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't' };

// Collapse leetspeak, strip anything that isn't a letter, and squash
// runs of the same letter ("fuuuck" -> "fuck"). Used only for matching.
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[@480$517!+3]/g, (c) => LEET[c] || c)
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1+/g, '$1');
}

// Build a matcher term the same way we normalize input, so a listed
// word like "f u c k" or "sh1t" still lines up.
function normTerm(term) {
  return String(term).toLowerCase().replace(/(.)\1+/g, '$1').replace(/[^a-z]/g, '');
}

const BLOCK_NORM = BLOCKLIST.map(normTerm).filter(Boolean);

/**
 * Check text for hard-blocked content.
 * @returns {{ blocked: boolean, term?: string }}
 */
function findBlocked(text) {
  if (!enabled || !text) return { blocked: false };
  const norm = normalize(text);
  for (const term of BLOCK_NORM) {
    if (term && norm.includes(term)) return { blocked: true, term };
  }
  return { blocked: false };
}

// Star out a masked word, keeping the first letter: "fuck" -> "f***".
function star(word) {
  if (word.length <= 1) return word;
  return word[0] + '*'.repeat(word.length - 1);
}

// Common inflections we still want to mask (fuck -> fucking / fucker /
// fucks). Anchored to the START of the token and limited to this set so
// we don't hit the "Scunthorpe problem" — peacock, dickens, classic and
// friends normalize to stem+<something-not-here> and are left alone.
const MASK_SUFFIXES = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y', 'a', 'as', 'z'];
const MASK_NORM = MASKLIST.map(normTerm).filter(Boolean);

/**
 * Mask ordinary profanity in-place, preserving the original casing and
 * surrounding text. Operates token-by-token so we only touch words that
 * are a masked term or a close inflection of one.
 */
function maskProfanity(text) {
  if (!enabled || !text) return text;
  return String(text).replace(/[A-Za-z0-9@$!+]+/g, (token) => {
    const n = normalize(token);
    const hit = MASK_NORM.some(
      (stem) => n.startsWith(stem) && MASK_SUFFIXES.includes(n.slice(stem.length))
    );
    return hit ? star(token) : token;
  });
}

/**
 * Moderate a single field of user text.
 * @returns {{ ok: boolean, error?: string, clean?: string }}
 *   ok:false  -> reject (hard-blocked term found)
 *   ok:true   -> use `clean` (profanity masked) as the stored value
 */
function moderateField(text, label = 'text') {
  if (text == null) return { ok: true, clean: text };
  const { blocked } = findBlocked(text);
  if (blocked) {
    return { ok: false, error: `Your ${label} contains content that isn't allowed here.` };
  }
  return { ok: true, clean: maskProfanity(text) };
}

module.exports = { enabled, moderateField, findBlocked, maskProfanity, BLOCKLIST, MASKLIST };
