let ME = null;
let FEE = { fee_bps: 600, fee_mode: 'added' };
function feeOnTop(baseCents) { return FEE.fee_mode === 'added' ? Math.round(baseCents * FEE.fee_bps / 10000) : 0; }
function buyerTotal(baseCents) { return baseCents + feeOnTop(baseCents); }
let AUCTIONS = [];
let LISTINGS = [];
let FAVKEYS = new Set();      // "listing:12", "auction:3"
let activeAuctionId = null;
let activeListingId = null;
let activeChatOrderId = null;
let activeReviewOrderId = null;
let activeDisputeOrderId = null;
let bidPollTimer = null;
let cryptoPollTimer = null;
let chatPollTimer = null;
let notifPollTimer = null;
let lastChatMessageId = 0;
let pendingCryptoContext = null; // { kind: 'auction'|'listing', id }
let dashTab = 'purchases';
let adminTab = 'disputes';

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function money(cents) { return '$' + (cents / 100).toFixed(2); }
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso + (iso.includes('T') ? '' : 'Z'))) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function timeLeft(iso) {
  const ms = new Date(iso) - new Date();
  if (ms <= 0) return { text: 'Ended', urgent: true };
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const text = d > 0 ? `${d}d ${h % 24}h left` : h > 0 ? `${h}h ${m % 60}m left` : `${m}m left`;
  return { text, urgent: ms < 5 * 60000 };
}

// ---------- Toasts ----------
function toast(message, type = 'info') {
  const stack = $('#toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- Modals ----------
function openModal(id) { $('#' + id).classList.add('open'); }
function closeModal(id) {
  $('#' + id).classList.remove('open');
  if (id === 'chat-overlay') { clearInterval(chatPollTimer); activeChatOrderId = null; }
  if (id === 'bid-overlay') clearInterval(bidPollTimer);
}
$$('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
$$('.overlay').forEach(ov => ov.addEventListener('click', e => {
  if (e.target === ov) { ov.classList.remove('open'); if (ov.id === 'chat-overlay') { clearInterval(chatPollTimer); activeChatOrderId = null; } if (ov.id === 'bid-overlay') clearInterval(bidPollTimer); }
}));

// ---------- Mobile nav ----------
$('#nav-toggle').addEventListener('click', () => $('#mobile-nav').classList.toggle('open'));
$$('#mobile-nav a').forEach(a => a.addEventListener('click', () => $('#mobile-nav').classList.remove('open')));

// ---------- Fetch helper ----------
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok && !data.error) data.error = 'Something went wrong. Please try again.';
  return data;
}

// ============================================================
// Views / routing
// ============================================================
function showView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  const el = $('#view-' + name);
  (el || $('#view-home')).classList.add('active');
  window.scrollTo({ top: 0 });
}

async function route() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('u/')) { showView('profile'); loadProfile(decodeURIComponent(h.slice(2))); return; }
  if (h === 'dashboard') {
    if (!ME) { showView('home'); return openModal('auth-overlay'); }
    showView('dashboard'); loadDashboard(); return;
  }
  if (h === 'admin') {
    if (!ME || !ME.is_admin) { showView('home'); return; }
    showView('admin'); loadAdmin(); return;
  }
  if (h.startsWith('order-')) {
    if (!ME) { showView('home'); return openModal('auth-overlay'); }
    showView('dashboard'); await loadDashboard(); openChat(parseInt(h.slice(6), 10)); return;
  }
  if (h.startsWith('auction-')) {
    showView('home'); openAuction(h.slice(8)); return;
  }
  showView('home');
  if (h === 'auctions' || h === 'listings') {
    const target = document.getElementById(h);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth' }), 50);
  }
}
window.addEventListener('hashchange', route);
$$('#main-nav a[data-scroll], #mobile-nav a[data-scroll]').forEach(a => a.addEventListener('click', () => {
  if (location.hash.replace(/^#/,'').match(/^(dashboard|admin|u\/|order-)/)) { /* let hashchange route home then scroll */ }
}));
$$('[data-go]').forEach(el => el.addEventListener('click', () => {
  closeDropdowns();
  location.hash = el.dataset.go;
}));

// ============================================================
// Auth + header
// ============================================================
async function loadMe() {
  const r = await api('/api/me');
  ME = r.user;
  renderAuth();
  if (ME) {
    loadFavKeys();
    loadNotifications();
    clearInterval(notifPollTimer);
    notifPollTimer = setInterval(loadNotifications, 30000);
  }
}

function renderAuth() {
  const area = $('#auth-area');
  if (ME) {
    const avatar = ME.avatar_url
      ? `<img src="${escapeHtml(ME.avatar_url)}" alt="">`
      : `<span class="avatar-fallback">${escapeHtml(ME.username[0].toUpperCase())}</span>`;
    area.innerHTML = `
      <a class="balance-chip" href="#dashboard" title="Your balance">◈ ${money(ME.site_credit_cents)}</a>
      <button class="icon-btn" id="bell-btn" title="Notifications">🔔<span class="badge-dot" id="bell-badge" style="display:none"></span></button>
      <button class="avatar-btn" id="avatar-btn" title="${escapeHtml(ME.username)}">${avatar}</button>
    `;
    $('#bell-btn').onclick = (e) => { e.stopPropagation(); toggleDropdown('notif-dropdown'); };
    $('#avatar-btn').onclick = (e) => { e.stopPropagation(); toggleDropdown('user-dropdown'); };
    $('#menu-admin').style.display = ME.is_admin ? 'flex' : 'none';
  } else {
    area.innerHTML = `<button class="btn btn-gold" id="login-btn">Sign in with Discord</button>`;
    $('#login-btn').onclick = () => openModal('auth-overlay');
  }
}
$('#do-login').onclick = () => { window.location.href = '/auth/discord/login'; };
$('#menu-logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.hash = ''; location.reload(); };
$('#menu-profile').onclick = () => { closeDropdowns(); if (ME) location.hash = 'u/' + encodeURIComponent(ME.username); };

function toggleDropdown(id) {
  const el = $('#' + id);
  const wasOpen = el.classList.contains('open');
  closeDropdowns();
  if (!wasOpen) {
    el.classList.add('open');
    if (id === 'notif-dropdown') markNotifsRead();
  }
}
function closeDropdowns() { $$('.dropdown').forEach(d => d.classList.remove('open')); }
document.addEventListener('click', (e) => { if (!e.target.closest('.dropdown') && !e.target.closest('.icon-btn') && !e.target.closest('.avatar-btn')) closeDropdowns(); });

// ============================================================
// Notifications
// ============================================================
const NOTIF_ICONS = {
  outbid: '📈', auction_won: '🏆', auction_sold: '🔨', item_sold: '💰',
  order_paid: '🛡', order_delivered: '📦', order_completed: '✅',
  order_disputed: '⚠️', order_refunded: '↩️', new_message: '💬',
  review: '⭐', withdrawal: '🏦', admin: '🛡',
};

async function loadNotifications() {
  if (!ME) return;
  const r = await api('/api/my/notifications');
  if (r.error) return;
  const badge = $('#bell-badge');
  if (badge) {
    badge.style.display = r.unread > 0 ? 'flex' : 'none';
    badge.textContent = r.unread > 9 ? '9+' : r.unread;
  }
  const list = $('#notif-list');
  if (!r.notifications.length) {
    list.innerHTML = `<div class="notif-item" style="cursor:default;color:var(--muted)">Nothing yet — activity on your trades shows up here.</div>`;
    return;
  }
  list.innerHTML = r.notifications.map(n => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}" data-link="${escapeHtml(n.link || '')}">
      <span class="n-type">${NOTIF_ICONS[n.type] || '•'}</span>
      <div><div>${escapeHtml(n.body)}</div><div class="n-time">${timeAgo(n.created_at)}</div></div>
    </div>
  `).join('');
  list.querySelectorAll('.notif-item[data-link]').forEach(el => el.addEventListener('click', () => {
    closeDropdowns();
    const link = el.dataset.link;
    if (link) { location.hash = link.replace(/^#/, ''); route(); }
  }));
}
async function markNotifsRead() {
  if (!ME) return;
  await api('/api/my/notifications/read', { method: 'POST' });
  const badge = $('#bell-badge'); if (badge) badge.style.display = 'none';
  $$('#notif-list .notif-item.unread').forEach(el => el.classList.remove('unread'));
}
$('#notif-mark-read').onclick = (e) => { e.stopPropagation(); markNotifsRead(); };

// ============================================================
// Favorites
// ============================================================
async function loadFavKeys() {
  const r = await api('/api/my/favorites');
  if (r.keys) FAVKEYS = new Set(r.keys.map(k => `${k.kind}:${k.item_id}`));
}
async function toggleFavorite(kind, itemId, starEl) {
  if (!ME) return openModal('auth-overlay');
  const r = await api('/api/favorites/toggle', { method: 'POST', body: JSON.stringify({ kind, item_id: Number(itemId) }) });
  if (r.error) return toast(r.error, 'error');
  const key = `${kind}:${itemId}`;
  if (r.favorited) { FAVKEYS.add(key); toast('Added to favorites', 'success'); }
  else FAVKEYS.delete(key);
  if (starEl) starEl.classList.toggle('on', r.favorited);
}
function syncFavStar(el, kind, id) {
  el.classList.toggle('on', FAVKEYS.has(`${kind}:${id}`));
  el.onclick = (e) => { e.stopPropagation(); toggleFavorite(kind, id, el); };
}

// ============================================================
// Home stats / ticker
// ============================================================
async function loadSiteStats() {
  const r = await api('/api/stats');
  if (r.error) return;
  $('#hero-stats').innerHTML = `
    <div class="stat"><b>${r.live_auctions}</b><span>Live auctions</span></div>
    <div class="stat"><b>${r.active_listings}</b><span>Listings</span></div>
    <div class="stat"><b>${r.completed_trades}</b><span>Trades settled</span></div>
    <div class="stat"><b>${r.traders}</b><span>Traders</span></div>
  `;
}
function renderTicker() {
  const items = AUCTIONS.slice(0, 8).map(a => `
    <span class="tick"><span class="dot"></span> <b>${escapeHtml(a.title)}</b> <span class="amt">${money(a.current_bid_cents || a.starting_bid_cents)}</span></span>
  `).join('') || '<span class="tick">No live activity yet — be the first to list an item.</span>';
  $('#ticker').innerHTML = items + items;
}

// ============================================================
// Auctions (browse)
// ============================================================
const auctionState = { q: '', minPrice: '', maxPrice: '', sort: 'ending_soon', page: 1, total: 0, totalPages: 1 };

function buildSearchParams(state) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.minPrice) params.set('min_price', state.minPrice);
  if (state.maxPrice) params.set('max_price', state.maxPrice);
  if (state.sort) params.set('sort', state.sort);
  params.set('page', state.page);
  return params;
}

async function loadAuctions({ append = false } = {}) {
  const r = await api(`/api/auctions?${buildSearchParams(auctionState)}`);
  const items = r.auctions || [];
  AUCTIONS = append ? AUCTIONS.concat(items) : items;
  auctionState.total = r.total || 0;
  auctionState.totalPages = r.total_pages || 1;
  renderAuctions();
  renderAuctionsMeta();
  if (!auctionState.q && !auctionState.minPrice && !auctionState.maxPrice) renderTicker();
}

function renderAuctionsMeta() {
  const meta = $('#auctions-meta');
  const hasFilters = auctionState.q || auctionState.minPrice || auctionState.maxPrice;
  meta.textContent = hasFilters
    ? `${auctionState.total} result${auctionState.total === 1 ? '' : 's'}${auctionState.q ? ` for "${auctionState.q}"` : ''}`
    : '';
  $('#auctions-load-more-wrap').style.display = auctionState.page < auctionState.totalPages ? 'flex' : 'none';
}

function auctionCardHtml(a) {
  const t = timeLeft(a.ends_at);
  const bid = a.current_bid_cents || a.starting_bid_cents;
  return `
    <div class="card" data-auction-id="${a.id}">
      <div class="thumb" style="${a.image_url ? `background-image:url('${escapeHtml(a.image_url)}')` : ''}">${a.image_url ? '' : 'No image'}</div>
      <div class="card-body">
        <div class="badge"><span class="dot"></span> Live</div>
        <div class="card-title">${escapeHtml(a.title)}</div>
        <div class="card-meta">Seller: <a class="seller-link" href="#u/${encodeURIComponent(a.seller_name)}" onclick="event.stopPropagation()">${escapeHtml(a.seller_name)}</a>${a.current_bidder_name ? ' · High bidder: ' + escapeHtml(a.current_bidder_name) : ''}</div>
        <div class="card-foot">
          <span class="price">${money(bid)}</span>
          <span class="timer ${t.urgent ? 'urgent' : ''}">${t.text}</span>
        </div>
        <button class="btn btn-gold btn-full">View &amp; bid</button>
      </div>
    </div>`;
}

function renderAuctions() {
  const grid = $('#auctions-grid');
  if (!AUCTIONS.length) {
    const msg = (auctionState.q || auctionState.minPrice || auctionState.maxPrice)
      ? 'No auctions match your search.'
      : 'No live auctions right now — check back soon, or list your own.';
    grid.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  grid.innerHTML = AUCTIONS.map(auctionCardHtml).join('');
  grid.querySelectorAll('.card').forEach(card => card.addEventListener('click', () => openAuction(card.dataset.auctionId)));
}

async function openAuction(id) {
  activeAuctionId = id;
  await refreshAuctionModal();
  openModal('bid-overlay');
  clearInterval(bidPollTimer);
  bidPollTimer = setInterval(refreshAuctionModal, 8000);
}

async function refreshAuctionModal() {
  const r = await api(`/api/auctions/${activeAuctionId}`);
  if (r.error) { closeModal('bid-overlay'); return; }
  const a = r.auction;
  $('#bid-thumb').classList.toggle('show', !!a.image_url);
  if (a.image_url) $('#bid-thumb').style.backgroundImage = `url('${a.image_url}')`;
  $('#bid-title').textContent = a.title;
  const t = timeLeft(a.ends_at);
  $('#bid-sub').innerHTML = `Current bid <b>${money(a.current_bid_cents || a.starting_bid_cents)}</b> · ${t.text} · min increment ${money(a.min_increment_cents)} · Seller <a class="seller-link" href="#u/${encodeURIComponent(a.seller_name)}">${escapeHtml(a.seller_name)}</a>`;
  $('#bid-desc').textContent = a.description || '';
  syncFavStar($('#bid-fav'), 'auction', a.id);

  const won = a.status !== 'live' && ME && a.winner_id === ME.id;
  if (won) {
    const base = a.current_bid_cents || a.starting_bid_cents;
    const total = buyerTotal(base);
    $('#checkout-area .sub').textContent = total !== base
      ? `You won this auction. Total ${money(total)} (${money(base)} + ${(FEE.fee_bps / 100).toFixed(0)}% buyer fee). Choose how to pay:`
      : 'You won this auction. Choose how to pay:';
  }
  const isMine = ME && a.seller_id === ME.id;
  $('#bid-field').style.display = a.status === 'live' && !isMine ? 'block' : 'none';
  $('#bid-actions').style.display = a.status === 'live' && !isMine ? 'flex' : 'none';
  $('#checkout-area').style.display = won ? 'block' : 'none';
  if (a.status !== 'live' && !won) clearInterval(bidPollTimer);

  const br = await api(`/api/auctions/${activeAuctionId}/bids`);
  const bids = br.bids || [];
  $('#bid-history').innerHTML = bids.length
    ? `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:6px">Bid history</div>` +
      bids.map(b => `<div class="bid-row"><span>${escapeHtml(b.bidder_name)}</span><b>${money(b.amount_cents)}</b></div>`).join('')
    : '';
}

$('#bid-submit').onclick = async () => {
  if (!ME) return openModal('auth-overlay');
  const val = parseFloat($('#bid-amount').value);
  if (!val || val <= 0) { $('#bid-error').textContent = 'Enter a valid bid amount.'; return; }
  $('#bid-submit').disabled = true;
  const r = await api(`/api/auctions/${activeAuctionId}/bid`, {
    method: 'POST',
    body: JSON.stringify({ amount_cents: Math.round(val * 100) })
  });
  $('#bid-submit').disabled = false;
  if (r.error) { $('#bid-error').textContent = r.error; return; }
  $('#bid-error').textContent = '';
  $('#bid-amount').value = '';
  toast(r.extended ? 'Bid placed — auction extended 2 min (anti-snipe)!' : 'Bid placed!', 'success');
  await refreshAuctionModal();
  loadAuctions();
};

$('#pay-stripe').onclick = async () => {
  $('#pay-stripe').disabled = true;
  const r = await api(`/api/auctions/${activeAuctionId}/checkout/stripe`, { method: 'POST' });
  $('#pay-stripe').disabled = false;
  if (r.error) return toast(r.error, 'error');
  window.location.href = r.url;
};
$('#pay-crypto').onclick = () => {
  pendingCryptoContext = { kind: 'auction', id: activeAuctionId };
  openModal('currency-overlay');
};

const runAuctionSearch = debounce(() => { auctionState.page = 1; loadAuctions(); }, 350);
$('#auctions-q').addEventListener('input', (e) => { auctionState.q = e.target.value.trim(); runAuctionSearch(); });
$('#auctions-min-price').addEventListener('input', (e) => { auctionState.minPrice = e.target.value; runAuctionSearch(); });
$('#auctions-max-price').addEventListener('input', (e) => { auctionState.maxPrice = e.target.value; runAuctionSearch(); });
$('#auctions-sort').addEventListener('change', (e) => { auctionState.sort = e.target.value; auctionState.page = 1; loadAuctions(); });
$('#auctions-clear').addEventListener('click', () => {
  auctionState.q = ''; auctionState.minPrice = ''; auctionState.maxPrice = ''; auctionState.sort = 'ending_soon'; auctionState.page = 1;
  $('#auctions-q').value = ''; $('#auctions-min-price').value = ''; $('#auctions-max-price').value = ''; $('#auctions-sort').value = 'ending_soon';
  loadAuctions();
});
$('#auctions-load-more').addEventListener('click', () => { auctionState.page += 1; loadAuctions({ append: true }); });

// ============================================================
// Listings (browse)
// ============================================================
const listingState = { q: '', minPrice: '', maxPrice: '', sort: 'newest', page: 1, total: 0, totalPages: 1 };

async function loadListings({ append = false } = {}) {
  const r = await api(`/api/listings?${buildSearchParams(listingState)}`);
  const items = r.listings || [];
  LISTINGS = append ? LISTINGS.concat(items) : items;
  listingState.total = r.total || 0;
  listingState.totalPages = r.total_pages || 1;
  renderListings();
  renderListingsMeta();
}

function renderListingsMeta() {
  const meta = $('#listings-meta');
  const hasFilters = listingState.q || listingState.minPrice || listingState.maxPrice;
  meta.textContent = hasFilters
    ? `${listingState.total} result${listingState.total === 1 ? '' : 's'}${listingState.q ? ` for "${listingState.q}"` : ''}`
    : '';
  $('#listings-load-more-wrap').style.display = listingState.page < listingState.totalPages ? 'flex' : 'none';
}

function listingCardHtml(l) {
  return `
    <div class="card" data-listing-id="${l.id}">
      <div class="thumb" style="${l.image_url ? `background-image:url('${escapeHtml(l.image_url)}')` : ''}">${l.image_url ? '' : 'No image'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(l.title)}</div>
        <div class="card-meta">Seller: <a class="seller-link" href="#u/${encodeURIComponent(l.seller_name)}" onclick="event.stopPropagation()">${escapeHtml(l.seller_name)}</a></div>
        <div class="card-foot"><span class="price">${l.price_cents ? money(l.price_cents) : 'Auction only'}</span></div>
        <button class="btn btn-gold btn-full" data-buy="${l.id}" ${l.price_cents ? '' : 'disabled'}>Buy now</button>
      </div>
    </div>`;
}

function renderListings() {
  const grid = $('#listings-grid');
  if (!LISTINGS.length) {
    const msg = (listingState.q || listingState.minPrice || listingState.maxPrice)
      ? 'No listings match your search.'
      : 'No fixed-price listings yet.';
    grid.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  grid.innerHTML = LISTINGS.map(listingCardHtml).join('');
  grid.querySelectorAll('[data-buy]:not([disabled])').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ME) return openModal('auth-overlay');
    openBuyModal(btn.dataset.buy);
  }));
}

function openBuyModal(id, itemOverride) {
  activeListingId = id;
  const l = itemOverride || LISTINGS.find(x => String(x.id) === String(id));
  if (!l) return;
  $('#buy-thumb').classList.toggle('show', !!l.image_url);
  if (l.image_url) $('#buy-thumb').style.backgroundImage = `url('${l.image_url}')`;
  $('#buy-title').textContent = l.title;
  const total = buyerTotal(l.price_cents);
  $('#buy-sub').innerHTML = `<b>${money(total)}</b>${total !== l.price_cents ? ` <span style="color:var(--muted)">(${money(l.price_cents)} + ${(FEE.fee_bps / 100).toFixed(0)}% buyer fee)</span>` : ''} · Seller: <a class="seller-link" href="#u/${encodeURIComponent(l.seller_name)}">${escapeHtml(l.seller_name)}</a>`;
  $('#buy-desc').textContent = l.description || '';
  $('#buy-error').textContent = '';
  syncFavStar($('#buy-fav'), 'listing', l.id);
  $('#buy-credit').textContent = ME && ME.site_credit_cents >= total ? `Use site credit (${money(ME.site_credit_cents)})` : 'Insufficient credit';
  $('#buy-credit').disabled = !ME || ME.site_credit_cents < total;
  openModal('buy-overlay');
}

$('#buy-credit').onclick = async () => {
  $('#buy-credit').disabled = true;
  const r = await api(`/api/listings/${activeListingId}/buy-with-credit`, { method: 'POST' });
  $('#buy-credit').disabled = false;
  if (r.error) { $('#buy-error').textContent = r.error; return; }
  closeModal('buy-overlay');
  toast('Purchase complete — payment held in escrow. Coordinate the trade in order chat!', 'success');
  loadListings(); loadMe();
  if (r.order_id) { location.hash = `order-${r.order_id}`; }
};
$('#buy-stripe').onclick = async () => {
  $('#buy-stripe').disabled = true;
  const r = await api(`/api/listings/${activeListingId}/checkout/stripe`, { method: 'POST' });
  $('#buy-stripe').disabled = false;
  if (r.error) { $('#buy-error').textContent = r.error; return; }
  window.location.href = r.url;
};
$('#buy-crypto').onclick = () => {
  pendingCryptoContext = { kind: 'listing', id: activeListingId };
  openModal('currency-overlay');
};

const runListingSearch = debounce(() => { listingState.page = 1; loadListings(); }, 350);
$('#listings-q').addEventListener('input', (e) => { listingState.q = e.target.value.trim(); runListingSearch(); });
$('#listings-min-price').addEventListener('input', (e) => { listingState.minPrice = e.target.value; runListingSearch(); });
$('#listings-max-price').addEventListener('input', (e) => { listingState.maxPrice = e.target.value; runListingSearch(); });
$('#listings-sort').addEventListener('change', (e) => { listingState.sort = e.target.value; listingState.page = 1; loadListings(); });
$('#listings-clear').addEventListener('click', () => {
  listingState.q = ''; listingState.minPrice = ''; listingState.maxPrice = ''; listingState.sort = 'newest'; listingState.page = 1;
  $('#listings-q').value = ''; $('#listings-min-price').value = ''; $('#listings-max-price').value = ''; $('#listings-sort').value = 'newest';
  loadListings();
});
$('#listings-load-more').addEventListener('click', () => { listingState.page += 1; loadListings({ append: true }); });

// ============================================================
// Crypto flow
// ============================================================
$('#currency-choices').addEventListener('click', async (e) => {
  const btn = e.target.closest('.pill');
  if (!btn || !pendingCryptoContext) return;
  const currency = btn.dataset.cur;
  const { kind, id } = pendingCryptoContext;
  const url = kind === 'auction' ? `/api/auctions/${id}/checkout/crypto` : `/api/listings/${id}/checkout/crypto`;
  const r = await api(url, { method: 'POST', body: JSON.stringify({ pay_currency: currency }) });
  if (r.error) { toast(r.error, 'error'); return; }
  closeModal('currency-overlay');
  closeModal('buy-overlay');
  showCryptoPayment(r);
});

function showCryptoPayment(payment) {
  $('#crypto-amount').textContent = `${payment.pay_amount} ${String(payment.pay_currency).toUpperCase()}`;
  $('#crypto-address').textContent = payment.pay_address;
  $('#crypto-status').textContent = 'Waiting for payment…';
  $('#crypto-status').classList.remove('paid');
  openModal('crypto-overlay');

  clearInterval(cryptoPollTimer);
  cryptoPollTimer = setInterval(async () => {
    const r = await api(`/api/orders/${payment.order_id}`);
    if (r.order && ['paid', 'delivered', 'completed'].includes(r.order.status)) {
      $('#crypto-status').textContent = '✓ Payment received — held in escrow. Open your dashboard to coordinate the trade.';
      $('#crypto-status').classList.add('paid');
      clearInterval(cryptoPollTimer);
      loadMe(); loadListings(); loadAuctions();
    } else if (r.order && r.order.status === 'failed') {
      $('#crypto-status').textContent = 'Payment failed or expired.';
      clearInterval(cryptoPollTimer);
    }
  }, 6000);
}

$('#crypto-copy').onclick = () => {
  navigator.clipboard.writeText($('#crypto-address').textContent).then(() => toast('Address copied', 'success'));
};

// ============================================================
// Sell flow
// ============================================================
let sellType = 'fixed';
$('#sell-type').addEventListener('click', (e) => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  sellType = btn.dataset.type;
  $$('#sell-type .pill').forEach(p => p.classList.toggle('active', p === btn));
  $('#sell-price-field').style.display = sellType === 'fixed' ? 'block' : 'none';
  $('#sell-auction-fields').style.display = sellType === 'auction' ? 'block' : 'none';
  $('#sell-submit').textContent = sellType === 'fixed' ? 'Post listing' : 'Start auction';
});

function openSellModal() {
  if (!ME) return openModal('auth-overlay');
  const priceLabel = $('#sell-price-field label');
  if (priceLabel) priceLabel.textContent = FEE.fee_mode === 'added'
    ? 'Price (USD) — you receive this full amount'
    : 'Price (USD)';
  ['sell-title','sell-desc','sell-image','sell-price','sell-start-bid'].forEach(id => $('#' + id).value = '');
  $('#sell-error').textContent = '';
  openModal('sell-overlay');
}
$('#cta-sell').onclick = $('#nav-sell').onclick = $('#nav-sell-mobile').onclick = (e) => { e.preventDefault(); openSellModal(); };
$('#dash-sell').onclick = openSellModal;
$('#cta-browse').onclick = () => document.getElementById('auctions').scrollIntoView({ behavior: 'smooth' });

$('#sell-submit').onclick = async () => {
  const title = $('#sell-title').value.trim();
  const description = $('#sell-desc').value.trim();
  const image_url = $('#sell-image').value.trim();
  if (!title) { $('#sell-error').textContent = 'Title is required.'; return; }
  $('#sell-submit').disabled = true;
  let r;
  if (sellType === 'fixed') {
    const price = parseFloat($('#sell-price').value);
    if (!price || price <= 0) { $('#sell-error').textContent = 'Enter a valid price.'; $('#sell-submit').disabled = false; return; }
    r = await api('/api/listings', { method: 'POST', body: JSON.stringify({ title, description, image_url, price_cents: Math.round(price * 100) }) });
  } else {
    const start = parseFloat($('#sell-start-bid').value);
    const inc = parseFloat($('#sell-increment').value) || 1;
    if (!start || start <= 0) { $('#sell-error').textContent = 'Enter a valid starting bid.'; $('#sell-submit').disabled = false; return; }
    r = await api('/api/auctions', { method: 'POST', body: JSON.stringify({
      title, description, image_url,
      starting_bid_cents: Math.round(start * 100),
      min_increment_cents: Math.round(inc * 100),
      duration_minutes: parseInt($('#sell-duration').value, 10),
    }) });
  }
  $('#sell-submit').disabled = false;
  if (r.error) { $('#sell-error').textContent = r.error; return; }
  closeModal('sell-overlay');
  toast(sellType === 'fixed' ? 'Listing posted!' : 'Auction started!', 'success');
  loadListings(); loadAuctions(); loadSiteStats();
};

// ============================================================
// Dashboard
// ============================================================
const STATUS_LABEL = {
  pending: 'Awaiting payment', paid: 'In escrow', delivered: 'Delivered',
  completed: 'Completed', disputed: 'Disputed', refunded: 'Refunded',
  failed: 'Failed', cancelled: 'Cancelled',
};
function statusBadge(status) {
  return `<span class="status-badge status-${status}">${STATUS_LABEL[status] || status}</span>`;
}
function escrowSteps(o) {
  if (['refunded', 'failed', 'cancelled', 'pending'].includes(o.status)) return '';
  const stage = o.status === 'paid' ? 1 : o.status === 'delivered' ? 2 : o.status === 'completed' ? 3 : 1;
  const disputed = o.status === 'disputed';
  const cls = (i) => disputed && i > 0 ? '' : (i < stage ? 'done' : i === stage ? 'now' : '');
  return `<div class="escrow-steps">
    <div class="estep done">Paid</div>
    <div class="estep ${cls(1)}">${disputed ? '⚠ Disputed' : 'Trade in Roblox'}</div>
    <div class="estep ${cls(2)}">Delivered</div>
    <div class="estep ${cls(3)}">Funds released</div>
  </div>`;
}

function orderCardHtml(o, role) {
  const other = role === 'buyer' ? o.seller_name : o.buyer_name;
  const otherLabel = role === 'buyer' ? 'Seller' : 'Buyer';
  const actions = [];
  actions.push(`<button class="btn btn-small" data-chat="${o.id}">💬 Chat${o.message_count ? ` (${o.message_count})` : ''}</button>`);
  if (role === 'seller' && o.status === 'paid') {
    actions.push(`<button class="btn btn-small btn-gold" data-delivered="${o.id}">Mark delivered</button>`);
  }
  if (role === 'buyer' && ['paid', 'delivered'].includes(o.status)) {
    actions.push(`<button class="btn btn-small btn-gold" data-confirm="${o.id}">Confirm receipt</button>`);
    actions.push(`<button class="btn btn-small" data-dispute="${o.id}" style="color:var(--danger)">Dispute</button>`);
  }
  if (role === 'buyer' && o.status === 'completed' && !o.review_rating) {
    actions.push(`<button class="btn btn-small" data-review="${o.id}" data-seller="${escapeHtml(o.seller_name)}">⭐ Review seller</button>`);
  }
  if (o.review_rating) {
    actions.push(`<span class="stars">${'★'.repeat(o.review_rating)}<span class="off">${'★'.repeat(5 - o.review_rating)}</span></span>`);
  }
  return `
  <div class="order-card" id="oc-${o.id}">
    <div class="order-thumb" style="${o.item_image ? `background-image:url('${escapeHtml(o.item_image)}')` : ''}">${o.item_image ? '' : '📦'}</div>
    <div class="order-main">
      <div class="order-title">${escapeHtml(o.item_title || 'Order #' + o.id)}</div>
      <div class="order-sub">${otherLabel}: <a href="#u/${encodeURIComponent(other)}">${escapeHtml(other)}</a> · ${o.method} · ${timeAgo(o.created_at)}${o.status === 'delivered' && role === 'buyer' ? ' · auto-releases 72h after delivery' : ''}</div>
    </div>
    <div class="order-price">${money(o.amount_cents)}</div>
    ${statusBadge(o.status)}
    <div class="order-actions">${actions.join('')}</div>
    ${escrowSteps(o)}
  </div>`;
}

function wireOrderCardActions(container) {
  container.querySelectorAll('[data-chat]').forEach(b => b.onclick = () => openChat(parseInt(b.dataset.chat, 10)));
  container.querySelectorAll('[data-delivered]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const r = await api(`/api/orders/${b.dataset.delivered}/delivered`, { method: 'POST' });
    if (r.error) { toast(r.error, 'error'); b.disabled = false; return; }
    toast('Marked delivered — the buyer has been notified.', 'success');
    loadDashboard();
  });
  container.querySelectorAll('[data-confirm]').forEach(b => b.onclick = async () => {
    if (!confirm('Confirm you received this item in Roblox? This releases payment to the seller and can\'t be undone.')) return;
    b.disabled = true;
    const r = await api(`/api/orders/${b.dataset.confirm}/confirm`, { method: 'POST' });
    if (r.error) { toast(r.error, 'error'); b.disabled = false; return; }
    toast('Receipt confirmed — payment released to the seller.', 'success');
    loadDashboard(); loadMe();
  });
  container.querySelectorAll('[data-dispute]').forEach(b => b.onclick = () => {
    activeDisputeOrderId = parseInt(b.dataset.dispute, 10);
    $('#dispute-reason').value = '';
    $('#dispute-error').textContent = '';
    openModal('dispute-overlay');
  });
  container.querySelectorAll('[data-review]').forEach(b => b.onclick = () => {
    activeReviewOrderId = parseInt(b.dataset.review, 10);
    reviewRating = 0;
    $$('#review-stars button').forEach(s => s.classList.remove('on'));
    $('#review-comment').value = '';
    $('#review-error').textContent = '';
    $('#review-sub').textContent = `How was your trade with ${b.dataset.seller}?`;
    openModal('review-overlay');
  });
}

async function loadDashboard() {
  if (!ME) return;
  const ov = await api('/api/my/overview');
  if (ov.error) return;
  $('#dash-hello').textContent = `Signed in as ${ME.username}`;
  $('#dash-stats').innerHTML = `
    <div class="stat-card"><div class="val gold">${money(ov.balance_cents)}</div><div class="lbl">Balance</div></div>
    <div class="stat-card"><div class="val">${ov.purchases_open}</div><div class="lbl">Open purchases</div></div>
    <div class="stat-card"><div class="val">${ov.sales_open}</div><div class="lbl">Open sales</div></div>
    <div class="stat-card"><div class="val">${ov.active_listings + ov.live_auctions}</div><div class="lbl">Items on the market</div></div>
    <div class="stat-card"><div class="val">${ov.avg_rating ? ov.avg_rating + '★' : '—'}</div><div class="lbl">Seller rating (${ov.review_count})</div></div>
  `;
  $('#tc-purchases').textContent = ov.purchases_open || '';
  $('#tc-sales').textContent = ov.sales_open || '';
  $('#tc-selling').textContent = (ov.active_listings + ov.live_auctions) || '';
  renderDashTab();
}

$('#dash-tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  dashTab = t.dataset.tab;
  $$('#dash-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
  renderDashTab();
});

async function renderDashTab() {
  const c = $('#dash-content');
  c.innerHTML = '<div class="empty-block">Loading…</div>';

  if (dashTab === 'purchases' || dashTab === 'sales') {
    const role = dashTab === 'purchases' ? 'buyer' : 'seller';
    const r = await api(`/api/my/${dashTab}`);
    const orders = r.orders || [];
    if (!orders.length) {
      c.innerHTML = `<div class="empty-block">${dashTab === 'purchases' ? 'Nothing bought yet — browse the marketplace to get started.' : 'No sales yet — list an item to start selling.'}</div>`;
      return;
    }
    c.innerHTML = `<div class="order-list">${orders.map(o => orderCardHtml(o, role)).join('')}</div>`;
    wireOrderCardActions(c);
    return;
  }

  if (dashTab === 'selling') {
    const r = await api('/api/my/listings');
    const listings = r.listings || [], auctions = r.auctions || [];
    let html = '';
    html += `<h3 class="section-sub">Fixed-price listings</h3>`;
    html += listings.length ? `<div class="order-list">` + listings.map(l => `
      <div class="order-card">
        <div class="order-thumb" style="${l.image_url ? `background-image:url('${escapeHtml(l.image_url)}')` : ''}">${l.image_url ? '' : '🏷'}</div>
        <div class="order-main"><div class="order-title">${escapeHtml(l.title)}</div><div class="order-sub">Listed ${timeAgo(l.created_at)}</div></div>
        <div class="order-price">${l.price_cents ? money(l.price_cents) : '—'}</div>
        ${statusBadge(l.status)}
        <div class="order-actions">${l.status === 'active' ? `<button class="btn btn-small" data-cancel-listing="${l.id}" style="color:var(--danger)">Remove</button>` : ''}</div>
      </div>`).join('') + `</div>` : `<div class="empty-block">No fixed-price listings.</div>`;
    html += `<h3 class="section-sub">Auctions</h3>`;
    html += auctions.length ? `<div class="order-list">` + auctions.map(a => {
      const t = timeLeft(a.ends_at);
      return `
      <div class="order-card">
        <div class="order-thumb" style="${a.image_url ? `background-image:url('${escapeHtml(a.image_url)}')` : ''}">${a.image_url ? '' : '🔨'}</div>
        <div class="order-main"><div class="order-title">${escapeHtml(a.title)}</div>
          <div class="order-sub">${a.status === 'live' ? t.text : 'Ended'} · ${a.current_bidder_name ? 'High bidder: ' + escapeHtml(a.current_bidder_name) : 'No bids yet'}</div></div>
        <div class="order-price">${money(a.current_bid_cents || a.starting_bid_cents)}</div>
        ${statusBadge(a.status)}
        <div class="order-actions">
          <button class="btn btn-small" data-view-auction="${a.id}">View</button>
          ${a.status === 'live' && !a.current_bidder_id ? `<button class="btn btn-small" data-cancel-auction="${a.id}" style="color:var(--danger)">Cancel</button>` : ''}
        </div>
      </div>`;
    }).join('') + `</div>` : `<div class="empty-block">No auctions.</div>`;
    c.innerHTML = html;
    c.querySelectorAll('[data-cancel-listing]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove this listing from the marketplace?')) return;
      const r2 = await api(`/api/listings/${b.dataset.cancelListing}/cancel`, { method: 'POST' });
      if (r2.error) return toast(r2.error, 'error');
      toast('Listing removed.', 'success'); renderDashTab(); loadListings();
    });
    c.querySelectorAll('[data-cancel-auction]').forEach(b => b.onclick = async () => {
      if (!confirm('Cancel this auction?')) return;
      const r2 = await api(`/api/auctions/${b.dataset.cancelAuction}/cancel`, { method: 'POST' });
      if (r2.error) return toast(r2.error, 'error');
      toast('Auction cancelled.', 'success'); renderDashTab(); loadAuctions();
    });
    c.querySelectorAll('[data-view-auction]').forEach(b => b.onclick = () => openAuction(b.dataset.viewAuction));
    return;
  }

  if (dashTab === 'bids') {
    const r = await api('/api/my/bids');
    const auctions = r.auctions || [];
    if (!auctions.length) { c.innerHTML = `<div class="empty-block">You haven't bid on anything yet.</div>`; return; }
    c.innerHTML = `<div class="order-list">` + auctions.map(a => {
      const t = timeLeft(a.ends_at);
      const winning = !!a.winning;
      const wonEnded = a.status === 'ended' && ME && a.winner_id === ME.id;
      return `
      <div class="order-card">
        <div class="order-thumb" style="${a.image_url ? `background-image:url('${escapeHtml(a.image_url)}')` : ''}">${a.image_url ? '' : '🔨'}</div>
        <div class="order-main"><div class="order-title">${escapeHtml(a.title)}</div>
          <div class="order-sub">${a.status === 'live' ? t.text : 'Ended'} · Your bid ${money(a.my_bid_cents)} · Current ${money(a.current_bid_cents || a.starting_bid_cents)}</div></div>
        <span class="status-badge ${winning || wonEnded ? 'status-completed' : 'status-disputed'}">${a.status === 'live' ? (winning ? 'Winning' : 'Outbid') : (wonEnded ? 'Won — pay now' : 'Lost')}</span>
        <div class="order-actions"><button class="btn btn-small ${wonEnded ? 'btn-gold' : ''}" data-view-auction="${a.id}">${wonEnded ? 'Checkout' : 'View'}</button></div>
      </div>`;
    }).join('') + `</div>`;
    c.querySelectorAll('[data-view-auction]').forEach(b => b.onclick = () => openAuction(b.dataset.viewAuction));
    return;
  }

  if (dashTab === 'wallet') {
    const r = await api('/api/my/withdrawals');
    const ws = r.withdrawals || [];
    c.innerHTML = `
      <div class="order-card" style="justify-content:space-between">
        <div><div class="order-title">Available balance</div><div class="order-sub">Escrow releases and refunds land here. Withdraw any time (min ${money(r.min_cents || 500)}).</div></div>
        <div class="order-price" style="font-size:1.4rem;color:var(--gold)">${money(ME.site_credit_cents)}</div>
        <button class="btn btn-gold" id="open-withdraw">Withdraw</button>
      </div>
      <h3 class="section-sub">Withdrawal history</h3>
      ${ws.length ? `<div class="table-wrap"><table class="data">
        <tr><th>Amount</th><th>Method</th><th>Destination</th><th>Status</th><th>Requested</th></tr>
        ${ws.map(w => `<tr>
          <td class="mono">${money(w.amount_cents)}</td><td>${w.method}</td>
          <td>${escapeHtml(w.destination)}</td>
          <td>${statusBadge(w.status === 'paid' ? 'completed' : w.status === 'rejected' ? 'refunded' : 'paid').replace(STATUS_LABEL.completed, 'Paid').replace(STATUS_LABEL.refunded, 'Rejected').replace(STATUS_LABEL.paid, 'Pending')}</td>
          <td>${timeAgo(w.created_at)}${w.admin_note ? ' · ' + escapeHtml(w.admin_note) : ''}</td>
        </tr>`).join('')}
      </table></div>` : `<div class="empty-block">No withdrawals yet.</div>`}
    `;
    $('#open-withdraw').onclick = () => {
      $('#withdraw-balance').textContent = `Available: ${money(ME.site_credit_cents)} · min ${money(r.min_cents || 500)}`;
      $('#withdraw-amount').value = '';
      $('#withdraw-dest').value = '';
      $('#withdraw-error').textContent = '';
      syncWithdrawMethodUi();
      openModal('withdraw-overlay');
    };
    return;
  }

  if (dashTab === 'favorites') {
    const r = await api('/api/my/favorites');
    const listings = r.listings || [], auctions = r.auctions || [];
    if (!listings.length && !auctions.length) {
      c.innerHTML = `<div class="empty-block">No favorites yet — hit the ★ on any item to watch it.</div>`;
      return;
    }
    let html = '';
    if (auctions.length) {
      html += `<h3 class="section-sub">Watched auctions</h3><div class="grid">${auctions.map(auctionCardHtml).join('')}</div>`;
    }
    if (listings.length) {
      html += `<h3 class="section-sub">Saved listings</h3><div class="grid">${listings.map(listingCardHtml).join('')}</div>`;
    }
    c.innerHTML = html;
    c.querySelectorAll('[data-auction-id]').forEach(card => card.addEventListener('click', () => openAuction(card.dataset.auctionId)));
    c.querySelectorAll('[data-buy]:not([disabled])').forEach(btn => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const l = listings.find(x => String(x.id) === String(btn.dataset.buy));
      openBuyModal(btn.dataset.buy, l);
    }));
    return;
  }
}

// ---------- Withdraw modal ----------
let withdrawMethod = 'paypal';
function syncWithdrawMethodUi() {
  $('#withdraw-dest-label').textContent = withdrawMethod === 'paypal' ? 'PayPal email' : 'Wallet address';
  $('#withdraw-dest').placeholder = withdrawMethod === 'paypal' ? 'you@example.com' : 'Paste the exact address for the selected coin/network';
  $('#withdraw-currency-field').style.display = withdrawMethod === 'crypto' ? 'block' : 'none';
}
$('#withdraw-method').addEventListener('click', (e) => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  withdrawMethod = btn.dataset.method;
  $$('#withdraw-method .pill').forEach(p => p.classList.toggle('active', p === btn));
  syncWithdrawMethodUi();
});
$('#withdraw-submit').onclick = async () => {
  const amount = parseFloat($('#withdraw-amount').value);
  const destination = $('#withdraw-dest').value.trim();
  if (!amount || amount <= 0) { $('#withdraw-error').textContent = 'Enter a valid amount.'; return; }
  if (!destination) { $('#withdraw-error').textContent = 'Enter where to send the money.'; return; }
  $('#withdraw-submit').disabled = true;
  const r = await api('/api/my/withdrawals', { method: 'POST', body: JSON.stringify({
    amount_cents: Math.round(amount * 100), method: withdrawMethod, destination,
    currency: withdrawMethod === 'crypto' ? $('#withdraw-currency').value : undefined,
  }) });
  $('#withdraw-submit').disabled = false;
  if (r.error) { $('#withdraw-error').textContent = r.error; return; }
  closeModal('withdraw-overlay');
  toast(r.auto
    ? 'Withdrawal sent — crypto is on its way to your wallet. 🚀'
    : 'Withdrawal requested — you\'ll get a notification when it\'s processed.', 'success');
  await loadMe(); renderDashTab();
};

// ---------- Dispute modal ----------
$('#dispute-submit').onclick = async () => {
  const reason = $('#dispute-reason').value.trim();
  if (!reason) { $('#dispute-error').textContent = 'Please describe what went wrong.'; return; }
  $('#dispute-submit').disabled = true;
  const r = await api(`/api/orders/${activeDisputeOrderId}/dispute`, { method: 'POST', body: JSON.stringify({ reason }) });
  $('#dispute-submit').disabled = false;
  if (r.error) { $('#dispute-error').textContent = r.error; return; }
  closeModal('dispute-overlay');
  toast('Dispute opened — payment is frozen and a moderator will review it.', 'success');
  loadDashboard();
};

// ---------- Review modal ----------
let reviewRating = 0;
$('#review-stars').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  reviewRating = parseInt(btn.dataset.star, 10);
  $$('#review-stars button').forEach(s => s.classList.toggle('on', parseInt(s.dataset.star, 10) <= reviewRating));
});
$('#review-submit').onclick = async () => {
  if (!reviewRating) { $('#review-error').textContent = 'Pick a star rating.'; return; }
  $('#review-submit').disabled = true;
  const r = await api(`/api/orders/${activeReviewOrderId}/review`, { method: 'POST', body: JSON.stringify({
    rating: reviewRating, comment: $('#review-comment').value.trim(),
  }) });
  $('#review-submit').disabled = false;
  if (r.error) { $('#review-error').textContent = r.error; return; }
  closeModal('review-overlay');
  toast('Review posted — thanks!', 'success');
  loadDashboard();
};

// ============================================================
// Order chat
// ============================================================
async function openChat(orderId) {
  activeChatOrderId = orderId;
  lastChatMessageId = 0;
  const r = await api(`/api/orders/${orderId}`);
  if (r.error) return toast(r.error, 'error');
  const o = r.order;
  $('#chat-title').textContent = o.item_title || `Order #${o.id}`;
  const other = ME.id === o.buyer_id ? o.seller_name : o.buyer_name;
  $('#chat-sub').innerHTML = `${money(o.amount_cents)} · ${statusBadge(o.status)} · with <a class="seller-link" href="#u/${encodeURIComponent(other)}">${escapeHtml(other)}</a>`;
  $('#chat-box').innerHTML = '<div class="chat-empty">Loading…</div>';
  openModal('chat-overlay');
  await pollChat(true);
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(() => pollChat(false), 4000);
}

async function pollChat(initial) {
  if (!activeChatOrderId) return;
  const r = await api(`/api/orders/${activeChatOrderId}/messages?after=${lastChatMessageId}`);
  if (r.error) return;
  const box = $('#chat-box');
  if (initial) box.innerHTML = '';
  const msgs = r.messages || [];
  if (initial && !msgs.length) {
    box.innerHTML = '<div class="chat-empty">No messages yet — say hi and agree on when to trade in Roblox. Keep everything in this chat so moderators can help if something goes wrong.</div>';
    return;
  }
  if (msgs.length && box.querySelector('.chat-empty')) box.innerHTML = '';
  msgs.forEach(m => {
    lastChatMessageId = Math.max(lastChatMessageId, m.id);
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (m.sender_id === ME.id ? 'mine' : 'theirs');
    el.innerHTML = `${escapeHtml(m.body)}<div class="m-meta">${escapeHtml(m.sender_name)} · ${timeAgo(m.created_at)}</div>`;
    box.appendChild(el);
  });
  if (msgs.length) box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  const input = $('#chat-input');
  const body = input.value.trim();
  if (!body || !activeChatOrderId) return;
  input.value = '';
  const r = await api(`/api/orders/${activeChatOrderId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
  if (r.error) { toast(r.error, 'error'); input.value = body; return; }
  await pollChat(false);
}
$('#chat-send').onclick = sendChat;
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ============================================================
// Public profile
// ============================================================
async function loadProfile(username) {
  const page = $('#profile-page');
  page.innerHTML = '<div class="empty-block">Loading profile…</div>';
  const r = await api(`/api/users/${encodeURIComponent(username)}`);
  if (r.error) { page.innerHTML = `<div class="empty-block">${escapeHtml(r.error)}</div>`; return; }
  const u = r.user;
  const stars = u.avg_rating
    ? `<span class="stars">${'★'.repeat(Math.round(u.avg_rating))}<span class="off">${'★'.repeat(5 - Math.round(u.avg_rating))}</span></span> <b>${u.avg_rating}</b> (${u.review_count})`
    : '<span style="color:var(--muted)">No reviews yet</span>';
  const isMe = ME && ME.id === u.id;
  page.innerHTML = `
    <div class="profile-head">
      ${u.avatar_url ? `<img src="${escapeHtml(u.avatar_url)}" alt="">` : `<div class="profile-avatar-fallback">${escapeHtml(u.username[0].toUpperCase())}</div>`}
      <div>
        <h2>${escapeHtml(u.username)} ${u.is_banned ? '<span class="status-badge status-disputed">Banned</span>' : ''}</h2>
        <div class="profile-meta">
          <span>${stars}</span>
          <span>·</span><span>${u.completed_sales} completed sale${u.completed_sales === 1 ? '' : 's'}</span>
          <span>·</span><span>Member since ${new Date(u.created_at + 'Z').toLocaleDateString()}</span>
        </div>
        ${u.bio ? `<p class="profile-bio" id="profile-bio-text">${escapeHtml(u.bio)}</p>` : (isMe ? '<p class="profile-bio" style="font-style:italic">No bio yet.</p>' : '')}
        ${isMe ? `<button class="btn btn-small" id="edit-bio" style="margin-top:8px">Edit bio</button>` : ''}
      </div>
    </div>
    ${r.auctions.length ? `<h3 class="section-sub">Live auctions</h3><div class="grid" id="pf-auctions">${r.auctions.map(auctionCardHtml).join('')}</div>` : ''}
    ${r.listings.length ? `<h3 class="section-sub">Listings</h3><div class="grid" id="pf-listings">${r.listings.map(listingCardHtml).join('')}</div>` : ''}
    ${!r.auctions.length && !r.listings.length ? `<div class="empty-block" style="margin-top:22px">Nothing on the market right now.</div>` : ''}
    <h3 class="section-sub">Reviews</h3>
    ${r.reviews.length ? `<div class="review-list">${r.reviews.map(rv => `
      <div class="review-item">
        <div class="r-head">
          ${rv.reviewer_avatar ? `<img src="${escapeHtml(rv.reviewer_avatar)}">` : ''}
          <b>${escapeHtml(rv.reviewer_name)}</b>
          <span class="stars">${'★'.repeat(rv.rating)}<span class="off">${'★'.repeat(5 - rv.rating)}</span></span>
          <span class="r-time">${timeAgo(rv.created_at)}</span>
        </div>
        ${rv.comment ? `<div class="r-body">${escapeHtml(rv.comment)}</div>` : ''}
      </div>`).join('')}</div>` : `<div class="empty-block">No reviews yet.</div>`}
  `;
  const pfa = $('#pf-auctions'); if (pfa) pfa.querySelectorAll('[data-auction-id]').forEach(card => card.addEventListener('click', () => openAuction(card.dataset.auctionId)));
  const pfl = $('#pf-listings'); if (pfl) pfl.querySelectorAll('[data-buy]:not([disabled])').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ME) return openModal('auth-overlay');
    const l = r.listings.find(x => String(x.id) === String(btn.dataset.buy));
    openBuyModal(btn.dataset.buy, l);
  }));
  const eb = $('#edit-bio');
  if (eb) eb.onclick = async () => {
    const current = $('#profile-bio-text') ? $('#profile-bio-text').textContent : '';
    const bio = prompt('Your bio (max 300 chars):', current || '');
    if (bio === null) return;
    const r2 = await api('/api/my/bio', { method: 'POST', body: JSON.stringify({ bio }) });
    if (r2.error) return toast(r2.error, 'error');
    toast('Bio updated.', 'success');
    loadProfile(username);
  };
}

// ============================================================
// Admin
// ============================================================
async function loadAdmin() {
  const r = await api('/api/admin/overview');
  if (r.error) return;
  $('#admin-stats').innerHTML = `
    <div class="stat-card"><div class="val">${r.users}</div><div class="lbl">Users</div></div>
    <div class="stat-card"><div class="val">${r.active_listings + r.live_auctions}</div><div class="lbl">Items live</div></div>
    <div class="stat-card"><div class="val ${r.open_disputes ? 'gold' : ''}">${r.open_disputes}</div><div class="lbl">Open disputes</div></div>
    <div class="stat-card"><div class="val ${r.pending_withdrawals ? 'gold' : ''}">${r.pending_withdrawals}</div><div class="lbl">Pending payouts</div></div>
    <div class="stat-card"><div class="val">${money(r.escrow_held_cents)}</div><div class="lbl">Held in escrow</div></div>
    <div class="stat-card"><div class="val gold">${money(r.fees_earned_cents)}</div><div class="lbl">Fees earned</div></div>
  `;
  renderAdminTab();
}

$('#admin-tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  adminTab = t.dataset.tab;
  $$('#admin-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
  renderAdminTab();
});

async function renderAdminTab() {
  const c = $('#admin-content');
  c.innerHTML = '<div class="empty-block">Loading…</div>';

  if (adminTab === 'disputes') {
    const r = await api('/api/admin/disputes');
    const ds = r.disputes || [];
    if (!ds.length) { c.innerHTML = '<div class="empty-block">No open disputes. 🎉</div>'; return; }
    c.innerHTML = `<div class="order-list">` + ds.map(d => `
      <div class="order-card" style="align-items:flex-start">
        <div class="order-main">
          <div class="order-title">#${d.id} · ${escapeHtml(d.item_title || 'Order')}</div>
          <div class="order-sub">Buyer <a href="#u/${encodeURIComponent(d.buyer_name)}">${escapeHtml(d.buyer_name)}</a> vs seller <a href="#u/${encodeURIComponent(d.seller_name)}">${escapeHtml(d.seller_name)}</a> · ${money(d.amount_cents)} · ${d.method}</div>
          <div class="inline-note danger" style="margin-bottom:0">“${escapeHtml(d.dispute_reason || '')}”</div>
        </div>
        <div class="order-actions" style="flex-direction:column;align-items:stretch">
          <button class="btn btn-small" data-adm-chat="${d.id}">💬 Read chat</button>
          <button class="btn btn-small" data-resolve="${d.id}" data-action="refund_buyer" style="color:var(--danger)">Refund buyer</button>
          <button class="btn btn-small btn-gold" data-resolve="${d.id}" data-action="release_seller">Release to seller</button>
        </div>
      </div>`).join('') + `</div>`;
    c.querySelectorAll('[data-adm-chat]').forEach(b => b.onclick = () => openChat(parseInt(b.dataset.admChat, 10)));
    c.querySelectorAll('[data-resolve]').forEach(b => b.onclick = async () => {
      const note = prompt('Optional note for both parties:') || '';
      b.disabled = true;
      const r2 = await api(`/api/admin/disputes/${b.dataset.resolve}/resolve`, { method: 'POST', body: JSON.stringify({ action: b.dataset.action, note }) });
      if (r2.error) { toast(r2.error, 'error'); b.disabled = false; return; }
      toast('Dispute resolved.', 'success');
      loadAdmin();
    });
    return;
  }

  if (adminTab === 'withdrawals') {
    const r = await api('/api/admin/withdrawals');
    const ws = r.withdrawals || [];
    if (!ws.length) { c.innerHTML = '<div class="empty-block">No pending withdrawals.</div>'; return; }
    const canAuto = !!r.payouts_enabled;
    c.innerHTML = `<div class="table-wrap"><table class="data">
      <tr><th>User</th><th>Amount</th><th>Method</th><th>Destination</th><th>Requested</th><th></th></tr>
      ${ws.map(w => `<tr>
        <td><a href="#u/${encodeURIComponent(w.username)}" style="color:var(--gold)">${escapeHtml(w.username)}</a></td>
        <td class="mono">${money(w.amount_cents)}</td><td>${w.method}${w.currency ? ' · ' + w.currency.toUpperCase() : ''}</td>
        <td class="mono" style="max-width:220px;overflow-wrap:anywhere">${escapeHtml(w.destination)}</td>
        <td>${timeAgo(w.created_at)}</td>
        <td style="white-space:nowrap">
          ${w.status === 'processing'
            ? '<span class="status-badge status-paid">Sending…</span>'
            : `${canAuto && w.method === 'crypto' ? `<button class="btn btn-small btn-gold" data-send-crypto="${w.id}">⚡ Send via NOWPayments</button>` : ''}
               <button class="btn btn-small ${canAuto && w.method === 'crypto' ? '' : 'btn-gold'}" data-wd="${w.id}" data-action="paid">Mark sent manually</button>
               <button class="btn btn-small" data-wd="${w.id}" data-action="rejected" style="color:var(--danger)">Reject</button>`}
        </td>
      </tr>`).join('')}
    </table></div>
    <div class="inline-note" style="margin-top:14px">${canAuto
      ? '⚡ Crypto payouts within your caps are sent <b>automatically</b> the moment a seller requests them — anything here hit a cap, failed, or is PayPal. “Send via NOWPayments” retries a crypto one manually; “Mark sent” records an external manual payment; “Reject” refunds their balance. Keep your NOWPayments balance topped up.'
      : 'Automated crypto payouts are off — set NOWPAYMENTS_EMAIL / NOWPAYMENTS_PASSWORD / NOWPAYMENTS_2FA_SECRET to enable them. “Mark sent” records an external manual payment; “Reject” refunds their balance.'}</div>`;
    c.querySelectorAll('[data-send-crypto]').forEach(b => b.onclick = async () => {
      if (!confirm('Send this payout now from your NOWPayments balance?')) return;
      b.disabled = true; b.textContent = 'Sending…';
      const r2 = await api(`/api/admin/withdrawals/${b.dataset.sendCrypto}/send-crypto`, { method: 'POST' });
      if (r2.error) { toast(r2.error, 'error'); b.disabled = false; b.textContent = '⚡ Send via NOWPayments'; return; }
      toast('Payout submitted — it will flip to Paid when the transfer confirms.', 'success');
      loadAdmin();
    });
    c.querySelectorAll('[data-wd]').forEach(b => b.onclick = async () => {
      const note = prompt('Optional note to the user:') || '';
      b.disabled = true;
      const r2 = await api(`/api/admin/withdrawals/${b.dataset.wd}`, { method: 'POST', body: JSON.stringify({ action: b.dataset.action, note }) });
      if (r2.error) { toast(r2.error, 'error'); b.disabled = false; return; }
      toast('Withdrawal updated.', 'success');
      loadAdmin();
    });
    return;
  }

  if (adminTab === 'users') {
    c.innerHTML = `
      <div class="search-bar" style="margin-bottom:14px"><div class="search-input-wrap" style="flex:1">
        <input type="search" id="admin-user-q" placeholder="Search users…" autocomplete="off" style="width:100%">
      </div></div>
      <div id="admin-users-table"></div>`;
    const renderUsers = async () => {
      const q = $('#admin-user-q').value.trim();
      const r = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
      const us = r.users || [];
      $('#admin-users-table').innerHTML = `<div class="table-wrap"><table class="data">
        <tr><th>User</th><th>Balance</th><th>Joined</th><th>Status</th><th></th></tr>
        ${us.map(u => `<tr>
          <td><a href="#u/${encodeURIComponent(u.username)}" style="color:var(--gold)">${escapeHtml(u.username)}</a>${u.is_admin ? ' 🛡' : ''}</td>
          <td class="mono">${money(u.site_credit_cents)}</td>
          <td>${timeAgo(u.created_at)}</td>
          <td>${u.is_banned ? '<span class="status-badge status-disputed">Banned</span>' : '<span class="status-badge status-active">Active</span>'}</td>
          <td>${u.is_admin ? '' : (u.is_banned
            ? `<button class="btn btn-small" data-unban="${u.id}">Unban</button>`
            : `<button class="btn btn-small" data-ban="${u.id}" style="color:var(--danger)">Ban</button>`)}</td>
        </tr>`).join('')}
      </table></div>`;
      $('#admin-users-table').querySelectorAll('[data-ban]').forEach(b => b.onclick = async () => {
        if (!confirm('Ban this user? Their active listings will be pulled off the market.')) return;
        const r2 = await api(`/api/admin/users/${b.dataset.ban}/ban`, { method: 'POST' });
        if (r2.error) return toast(r2.error, 'error');
        renderUsers();
      });
      $('#admin-users-table').querySelectorAll('[data-unban]').forEach(b => b.onclick = async () => {
        const r2 = await api(`/api/admin/users/${b.dataset.unban}/unban`, { method: 'POST' });
        if (r2.error) return toast(r2.error, 'error');
        renderUsers();
      });
    };
    $('#admin-user-q').addEventListener('input', debounce(renderUsers, 300));
    renderUsers();
    return;
  }
}

// ============================================================
// Init
// ============================================================
(async function init() {
  const params = new URLSearchParams(location.search);
  api('/api/config').then(c => { if (c.fee_bps) FEE = c; });
  await loadMe();
  loadSiteStats();
  loadAuctions();
  loadListings();
  route();

  if (params.get('checkout') === 'success') {
    toast('Payment received — held in escrow until you confirm delivery.', 'success');
    const order = params.get('order');
    history.replaceState({}, '', '/' + (order ? `#order-${order}` : '#dashboard'));
    route();
  } else if (params.get('checkout') === 'cancelled') {
    toast('Checkout cancelled.', 'info');
    history.replaceState({}, '', '/');
  }
  if (params.get('auth_error')) {
    toast('Sign-in failed: ' + params.get('auth_error'), 'error');
    history.replaceState({}, '', '/');
  }

  setInterval(() => { if ($('#view-home').classList.contains('active')) { loadAuctions(); } }, 60000);
})();
