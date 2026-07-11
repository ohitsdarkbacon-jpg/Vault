const PAGE_SIZE_DEFAULT = 24;
const PAGE_SIZE_MAX = 60;
const MAX_QUERY_LEN = 100;
const MAX_TERMS = 8;

/** Clamp/parse pagination params from a query string into { page, limit, offset }. */
function parsePagination(query) {
  let page = parseInt(query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  let limit = parseInt(query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = PAGE_SIZE_DEFAULT;
  limit = Math.min(limit, PAGE_SIZE_MAX);
  return { page, limit, offset: (page - 1) * limit };
}

/** Parse a "$12.34"-or-"12.34" style price query param into integer cents, or null. */
function parsePriceCents(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).trim().replace(/[^0-9.-]/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Sanitize free-text input for a plain LIKE search, escaping SQLite's LIKE wildcards. */
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * Turn raw user input into a safe FTS5 MATCH expression: each token becomes a
 * quoted prefix match, ANDed together. Quoting each term neutralizes FTS5's
 * own query syntax (no user-controlled boolean operators, column filters, etc).
 */
function buildFtsMatchQuery(rawQuery) {
  const terms = rawQuery
    .slice(0, MAX_QUERY_LEN)
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter(Boolean)
    .slice(0, MAX_TERMS);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(' AND ');
}

function cleanQueryString(q) {
  return typeof q === 'string' ? q.trim().slice(0, MAX_QUERY_LEN) : '';
}

// Item categories = the biggest trading-economy Roblox games right now.
// (No limiteds — those are bought with Robux on the official marketplace;
// Vault is for real-money trades of in-game items.) 'other' is the default.
const CATEGORIES = ['adopt-me', 'blox-fruits', 'mm2', 'grow-a-garden', 'steal-a-brainrot', 'pet-sim-99', 'da-hood', 'other'];

function parseCategory(raw) {
  const c = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  return CATEGORIES.includes(c) ? c : null;
}

module.exports = {
  CATEGORIES,
  parseCategory,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  parsePagination,
  parsePriceCents,
  escapeLike,
  buildFtsMatchQuery,
  cleanQueryString,
};
