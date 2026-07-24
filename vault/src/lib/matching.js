// Fuzzy item-text matching for the trade finder and trade chains.
// Items on Vault are free text ("Neon Shadow Dragon (FR)"), so matching is
// token overlap: lowercase words, drop punctuation and filler, and compare.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'any', 'all', 'have', 'want', 'wants', 'offer',
  'offering', 'looking', 'item', 'items', 'trade', 'trading', 'or', 'of', 'a', 'an',
]);

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  );
}

// How many of `wantTokens` appear in `haveTokens` (0 = no match).
function overlap(wantTokens, haveTokens) {
  let n = 0;
  for (const t of wantTokens) if (haveTokens.has(t)) n++;
  return n;
}

module.exports = { tokens, overlap };
