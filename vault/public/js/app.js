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
let dmPollTimer = null;
let activeDmPartner = null;
let lastDmId = 0;
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
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const text = d > 0 ? `${d}d ${h % 24}h left`
    : h > 0 ? `${h}h ${m % 60}m left`
    : m >= 5 ? `${m}m left`
    : `${m}m ${s % 60}s left`; // final minutes tick by the second
  return { text, urgent: ms < 5 * 60000 };
}

// Verified-trader badge, shown next to usernames site-wide.
function vbadge(isVerified) {
  return isVerified ? '<span class="verified-badge" title="Verified trader">✓</span>' : '';
}

const CATEGORY_LABELS = {
  limiteds: 'Limiteds', dominus: 'Dominus', accessories: 'Accessories',
  faces: 'Faces', gear: 'Gear', bundles: 'Bundles', other: 'Other',
};
function catTag(category) {
  return category && category !== 'other'
    ? `<span class="thumb-tag">${CATEGORY_LABELS[category] || category}</span>` : '';
}
// Category filter chips above the browse grids
function renderCatChips(sel, state, reload) {
  const el = $(sel);
  el.innerHTML = ['', ...Object.keys(CATEGORY_LABELS)].map(c => `
    <button type="button" class="cat-chip ${state.category === c ? 'active' : ''}" data-c="${c}">${c ? CATEGORY_LABELS[c] : 'All'}</button>
  `).join('');
  el.querySelectorAll('.cat-chip').forEach(b => b.onclick = () => {
    state.category = b.dataset.c;
    state.page = 1;
    renderCatChips(sel, state, reload);
    reload();
  });
}

// Live countdowns: anything rendered with data-ends="<iso>" re-renders every
// second without a refetch.
setInterval(() => {
  $$('[data-ends]').forEach(el => {
    const t = timeLeft(el.dataset.ends);
    el.textContent = t.text;
    el.classList.toggle('urgent', t.urgent);
  });
}, 1000);

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
// ---------- Custom confirm / prompt dialogs (replace native popups) ----------
let dialogResolve = null;

function vaultDialog({ title, message, input = false, value = '', placeholder = '', okText = 'Confirm', cancelText = 'Cancel', danger = false, icon = '🛡' }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    $('#dialog-icon').textContent = icon;
    $('#dialog-title').textContent = title;
    $('#dialog-message').textContent = message || '';
    $('#dialog-message').style.display = message ? 'block' : 'none';
    $('#dialog-input-wrap').style.display = input ? 'block' : 'none';
    $('#dialog-input').value = value;
    $('#dialog-input').placeholder = placeholder;
    $('#dialog-ok').textContent = okText;
    $('#dialog-cancel').textContent = cancelText;
    $('#dialog-ok').classList.toggle('btn-danger', !!danger);
    $('#dialog-ok').classList.toggle('btn-gold', !danger);
    openModal('dialog-overlay');
    setTimeout(() => (input ? $('#dialog-input') : $('#dialog-ok')).focus(), 60);
  });
}

function settleDialog(result) {
  if (!dialogResolve) return;
  const resolve = dialogResolve;
  dialogResolve = null;
  closeModal('dialog-overlay');
  resolve(result);
}
$('#dialog-ok').addEventListener('click', () => {
  const isInput = $('#dialog-input-wrap').style.display !== 'none';
  settleDialog(isInput ? $('#dialog-input').value.trim() : true);
});
$('#dialog-cancel').addEventListener('click', () => settleDialog(null));
$('#dialog-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) settleDialog(null); });
$('#dialog-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#dialog-ok').click(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#dialog-overlay').classList.contains('open')) settleDialog(null);
});

// confirm() replacement — resolves true/false
function vaultConfirm(message, opts = {}) {
  return vaultDialog({ title: opts.title || 'Are you sure?', message, ...opts }).then(r => r !== null);
}
// prompt() replacement — resolves the string, or null if cancelled
function vaultPrompt(message, opts = {}) {
  return vaultDialog({ title: opts.title || 'One more thing', message, input: true, okText: opts.okText || 'Save', ...opts, danger: false });
}

// ---------- Custom select dropdowns (replace native <select>) ----------
function initCustomSelects() {
  document.querySelectorAll('.custom-select').forEach(sel => {
    if (sel._csInit) return;
    sel._csInit = true;
    Object.defineProperty(sel, 'value', {
      get() { return sel.dataset.value; },
      set(v) {
        sel.dataset.value = v;
        const opt = sel.querySelector(`.cs-option[data-value="${v}"]`);
        if (opt) {
          sel.querySelector('.cs-label').textContent = opt.textContent;
          sel.querySelectorAll('.cs-option').forEach(o => o.classList.toggle('active', o === opt));
        }
      }
    });
    const trigger = sel.querySelector('.cs-trigger');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = sel.classList.contains('open');
      closeAllSelects();
      if (!wasOpen) sel.classList.add('open');
    });
    sel.querySelectorAll('.cs-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        sel.dataset.value = opt.dataset.value;
        sel.querySelector('.cs-label').textContent = opt.textContent;
        sel.querySelectorAll('.cs-option').forEach(o => o.classList.toggle('active', o === opt));
        sel.classList.remove('open');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  });
}
function closeAllSelects() {
  document.querySelectorAll('.custom-select.open').forEach(s => s.classList.remove('open'));
}
document.addEventListener('click', closeAllSelects);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllSelects(); });
initCustomSelects();

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
  if (name !== 'messages') { clearInterval(dmPollTimer); activeDmPartner = null; }
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
  if (h === 'traders') { showView('traders'); loadTraders(); return; }
  if (h === 'messages' || h.startsWith('messages/')) {
    if (!ME) { showView('home'); return openModal('auth-overlay'); }
    showView('messages');
    const partner = h.startsWith('messages/') ? decodeURIComponent(h.slice(9)) : null;
    if (partner) openDmThread(partner); else loadConversations();
    return;
  }
  if (h.startsWith('order-')) {
    if (!ME) { showView('home'); return openModal('auth-overlay'); }
    showView('dashboard'); await loadDashboard(); openChat(parseInt(h.slice(6), 10)); return;
  }
  if (h.startsWith('auction-')) {
    showView('home'); openAuction(h.slice(8)); return;
  }
  if (h.startsWith('listing-')) {
    showView('home'); openBuyModal(h.slice(8)); return;
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
      <button class="icon-btn" id="dm-btn" title="Messages">💬<span class="badge-dot" id="dm-badge" style="display:none"></span></button>
      <button class="icon-btn" id="bell-btn" title="Notifications">🔔<span class="badge-dot" id="bell-badge" style="display:none"></span></button>
      <button class="avatar-btn" id="avatar-btn" title="${escapeHtml(ME.username)}">${avatar}</button>
    `;
    $('#dm-btn').onclick = () => { location.hash = 'messages'; };
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
  review: '⭐', withdrawal: '🏦', admin: '🛡', dm: '✉️',
  offer: '💰', price_drop: '📉', ending_soon: '⏰',
};

async function loadNotifications() {
  if (!ME) return;
  api('/api/dm/unread').then(d => {
    const dmBadge = $('#dm-badge');
    if (dmBadge && !d.error) {
      dmBadge.style.display = d.unread > 0 ? 'flex' : 'none';
      dmBadge.textContent = d.unread > 9 ? '9+' : d.unread;
    }
  });
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
async function loadTrending() {
  const r = await api('/api/trending');
  const rows = r.trending || [];
  const section = $('#trending-section');
  if (!rows.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  $('#trending-strip').innerHTML = rows.map(t => `
    <div class="recent-card trend-card" data-kind="${t.kind}" data-id="${t.id}">
      <div class="r-thumb" style="${t.image_url ? `background-image:url('${escapeHtml(t.image_url)}')` : ''}">${t.image_url ? '' : '📦'}</div>
      <div style="min-width:0">
        <div class="r-title">${escapeHtml(t.title)}</div>
        <div class="r-sub">👁 ${t.watchers} watching</div>
      </div>
      <div class="r-price">${t.price_cents ? money(t.price_cents) : '—'}</div>
    </div>
  `).join('');
  $('#trending-strip').querySelectorAll('.trend-card').forEach(c => c.onclick = () => {
    if (c.dataset.kind === 'auction') openAuction(c.dataset.id); else openBuyModal(c.dataset.id);
  });
}

async function loadRecentSales() {
  const r = await api('/api/recent-sales');
  const sales = r.sales || [];
  const section = $('#recent-trades-section');
  if (!sales.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  $('#recent-strip').innerHTML = sales.map(s => `
    <div class="recent-card">
      <div class="r-thumb" style="${s.image_url ? `background-image:url('${escapeHtml(s.image_url)}')` : ''}">${s.image_url ? '' : '📦'}</div>
      <div style="min-width:0">
        <div class="r-title">${escapeHtml(s.title || 'Item')}</div>
        <div class="r-sub">${timeAgo(s.created_at)}</div>
      </div>
      <div class="r-price">${money(s.amount_cents)}</div>
    </div>
  `).join('');
}

// ---------- Image lightbox: click any modal thumb to view it full-size ----------
function openLightbox(url) {
  const ov = document.createElement('div');
  ov.className = 'lightbox';
  ov.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
  const esc = (e) => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
}
['bid-thumb', 'buy-thumb'].forEach(id => {
  $('#' + id).addEventListener('click', function () {
    const bg = this.style.backgroundImage;
    const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
    if (m) openLightbox(m[1]);
  });
});

// ---------- "/" focuses the nearest search box ----------
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.target.matches('input, textarea')) return;
  const view = document.querySelector('.view.active');
  const box = view && view.querySelector('input[type="search"]');
  if (box) { e.preventDefault(); box.focus(); }
});

// Scroll-to-top button
const scrollTopBtn = $('#scroll-top');
window.addEventListener('scroll', () => scrollTopBtn.classList.toggle('show', window.scrollY > 600), { passive: true });
scrollTopBtn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

function renderTicker() {
  const items = AUCTIONS.slice(0, 8).map(a => `
    <span class="tick"><span class="dot"></span> <b>${escapeHtml(a.title)}</b> <span class="amt">${money(a.current_bid_cents || a.starting_bid_cents)}</span></span>
  `).join('') || '<span class="tick">No live activity yet — be the first to list an item.</span>';
  $('#ticker').innerHTML = items + items;
}

// ============================================================
// Auctions (browse)
// ============================================================
const auctionState = { q: '', minPrice: '', maxPrice: '', sort: 'ending_soon', category: '', page: 1, total: 0, totalPages: 1 };

function buildSearchParams(state) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.minPrice) params.set('min_price', state.minPrice);
  if (state.maxPrice) params.set('max_price', state.maxPrice);
  if (state.sort) params.set('sort', state.sort);
  if (state.category) params.set('category', state.category);
  params.set('page', state.page);
  return params;
}

// Shimmer placeholders while a grid loads for the first time.
function showSkeletons(sel, n = 4) {
  const grid = $(sel);
  if (grid && !grid.querySelector('.card')) {
    grid.innerHTML = Array(n).fill('<div class="skeleton"></div>').join('');
  }
}

async function loadAuctions({ append = false } = {}) {
  if (!append) showSkeletons('#auctions-grid');
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
      <div class="thumb" style="${a.image_url ? `background-image:url('${escapeHtml(a.image_url)}')` : ''}">${a.image_url ? '' : 'No image'}${catTag(a.category)}</div>
      <div class="card-body">
        <div class="badge"><span class="dot"></span> Live${a.buyout_cents ? ` · ⚡ ${money(a.buyout_cents)}` : ''}</div>
        <div class="card-title">${escapeHtml(a.title)}</div>
        <div class="card-meta">Seller: <a class="seller-link" href="#u/${encodeURIComponent(a.seller_name)}" onclick="event.stopPropagation()">${escapeHtml(a.seller_name)}</a> ${vbadge(a.seller_verified)}${a.current_bidder_name ? ' · High bidder: ' + escapeHtml(a.current_bidder_name) : ''}</div>
        <div class="card-foot">
          <span class="price">${money(bid)}</span>
          <span class="timer ${t.urgent ? 'urgent' : ''}" data-ends="${escapeHtml(a.ends_at)}">${t.text}</span>
        </div>
        <button class="btn btn-gold btn-full">View &amp; bid</button>
      </div>
    </div>`;
}

function renderAuctions() {
  const grid = $('#auctions-grid');
  if (!AUCTIONS.length) {
    const filtered = auctionState.q || auctionState.minPrice || auctionState.maxPrice;
    grid.innerHTML = filtered
      ? `<div class="empty">No auctions match your search.<br><button class="btn btn-small" style="margin-top:12px" onclick="document.getElementById('auctions-clear').click()">Clear filters</button></div>`
      : `<div class="empty">No live auctions right now.<br><button class="btn btn-small btn-gold" style="margin-top:12px" onclick="document.getElementById('cta-sell').click()">Start the first auction</button></div>`;
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
  $('#bid-sub').innerHTML = `Current bid <b>${money(a.current_bid_cents || a.starting_bid_cents)}</b> · <span data-ends="${escapeHtml(a.ends_at)}">${t.text}</span> · ${a.bid_count || 0} bid${a.bid_count === 1 ? '' : 's'}${a.watch_count ? ` · 👁 ${a.watch_count} watching` : ''} · Seller <a class="seller-link" href="#u/${encodeURIComponent(a.seller_name)}">${escapeHtml(a.seller_name)}</a> ${vbadge(a.seller_verified)}`;
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
  const biddable = a.status === 'live' && !isMine;
  $('#bid-field').style.display = biddable ? 'block' : 'none';
  $('#bid-actions').style.display = biddable ? 'flex' : 'none';
  $('#checkout-area').style.display = won ? 'block' : 'none';
  if (a.status !== 'live' && !won) clearInterval(bidPollTimer);

  // Quick-bid chips: the minimum next bid plus two sensible jumps.
  if (biddable) {
    const minNext = a.current_bid_cents == null
      ? a.starting_bid_cents
      : (a.current_bid_cents + a.min_increment_cents);
    const steps = [minNext, minNext + a.min_increment_cents, minNext + a.min_increment_cents * 5]
      .filter(v => !a.buyout_cents || v < a.buyout_cents);
    $('#quick-bids').innerHTML = steps.map((v, i) =>
      `<button type="button" class="quick-bid" data-v="${v}">${i === 0 ? 'Min ' : ''}${money(v)}</button>`
    ).join('');
    $$('#quick-bids .quick-bid').forEach(b => b.onclick = () => { $('#bid-amount').value = (b.dataset.v / 100).toFixed(2); });
  } else {
    $('#quick-bids').innerHTML = '';
  }

  // ⚡ Buy It Now
  const buyoutBtn = $('#bid-buyout');
  if (biddable && a.buyout_cents) {
    buyoutBtn.style.display = 'block';
    buyoutBtn.textContent = `⚡ Buy now for ${money(a.buyout_cents)} — skip the bidding`;
    buyoutBtn.onclick = async () => {
      if (!ME) return openModal('auth-overlay');
      const total = buyerTotal(a.buyout_cents);
      if (!await vaultConfirm(`The auction ends instantly and you pay ${money(total)}${total !== a.buyout_cents ? ` (${money(a.buyout_cents)} + buyer fee)` : ''}.`, { title: 'Buy it now?', okText: `⚡ Buy for ${money(a.buyout_cents)}`, icon: '⚡' })) return;
      buyoutBtn.classList.add('loading');
      const r2 = await api(`/api/auctions/${a.id}/buyout`, { method: 'POST' });
      buyoutBtn.classList.remove('loading');
      if (r2.error) { $('#bid-error').textContent = r2.error; return; }
      toast('Auction is yours — pick a payment method to finish.', 'success');
      await refreshAuctionModal();
      loadAuctions();
    };
  } else {
    buyoutBtn.style.display = 'none';
  }
  $('#bid-share').onclick = () => {
    navigator.clipboard.writeText(`${location.origin}/#auction-${a.id}`).then(() => toast('Link copied — share it anywhere.', 'success'));
  };

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
  auctionState.q = ''; auctionState.minPrice = ''; auctionState.maxPrice = ''; auctionState.sort = 'ending_soon'; auctionState.category = ''; auctionState.page = 1;
  renderCatChips('#auctions-cats', auctionState, loadAuctions);
  $('#auctions-q').value = ''; $('#auctions-min-price').value = ''; $('#auctions-max-price').value = ''; $('#auctions-sort').value = 'ending_soon';
  loadAuctions();
});
$('#auctions-load-more').addEventListener('click', () => { auctionState.page += 1; loadAuctions({ append: true }); });

// ============================================================
// Listings (browse)
// ============================================================
const listingState = { q: '', minPrice: '', maxPrice: '', sort: 'newest', category: '', page: 1, total: 0, totalPages: 1 };

async function loadListings({ append = false } = {}) {
  if (!append) showSkeletons('#listings-grid');
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
      <div class="thumb" style="${l.image_url ? `background-image:url('${escapeHtml(l.image_url)}')` : ''}">${l.image_url ? '' : 'No image'}${catTag(l.category)}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(l.title)}</div>
        <div class="card-meta">Seller: <a class="seller-link" href="#u/${encodeURIComponent(l.seller_name)}" onclick="event.stopPropagation()">${escapeHtml(l.seller_name)}</a> ${vbadge(l.seller_verified)}</div>
        <div class="card-foot"><span class="price">${l.price_cents ? money(l.price_cents) : 'Auction only'}</span></div>
        <button class="btn btn-gold btn-full" data-buy="${l.id}" ${l.price_cents ? '' : 'disabled'}>Buy now</button>
      </div>
    </div>`;
}

function renderListings() {
  const grid = $('#listings-grid');
  if (!LISTINGS.length) {
    const filtered = listingState.q || listingState.minPrice || listingState.maxPrice;
    grid.innerHTML = filtered
      ? `<div class="empty">No listings match your search.<br><button class="btn btn-small" style="margin-top:12px" onclick="document.getElementById('listings-clear').click()">Clear filters</button></div>`
      : `<div class="empty">No fixed-price listings yet.<br><button class="btn btn-small btn-gold" style="margin-top:12px" onclick="document.getElementById('cta-sell').click()">List the first item</button></div>`;
    return;
  }
  grid.innerHTML = LISTINGS.map(listingCardHtml).join('');
  grid.querySelectorAll('[data-buy]:not([disabled])').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ME) return openModal('auth-overlay');
    openBuyModal(btn.dataset.buy);
  }));
}

async function openBuyModal(id, itemOverride) {
  activeListingId = id;
  // Fetch fresh — picks up price edits and the viewer's live offer.
  const r = await api(`/api/listings/${id}`);
  const l = r.listing || itemOverride || LISTINGS.find(x => String(x.id) === String(id));
  if (!l) return;
  const offer = r.my_offer || null;
  $('#buy-thumb').classList.toggle('show', !!l.image_url);
  if (l.image_url) $('#buy-thumb').style.backgroundImage = `url('${l.image_url}')`;
  $('#buy-title').textContent = l.title;

  // An accepted offer replaces the sticker price for this buyer.
  const base = offer && offer.status === 'accepted' ? offer.amount_cents : l.price_cents;
  const total = buyerTotal(base);
  $('#buy-sub').innerHTML = `<b>${money(total)}</b>${total !== base ? ` <span style="color:var(--muted)">(${money(base)} + ${(FEE.fee_bps / 100).toFixed(0)}% buyer fee)</span>` : ''}${l.watch_count ? ` · 👁 ${l.watch_count} watching` : ''} · Seller: <a class="seller-link" href="#u/${encodeURIComponent(l.seller_name)}">${escapeHtml(l.seller_name)}</a> ${vbadge(l.seller_verified)}`;
  $('#buy-desc').textContent = l.description || '';
  $('#buy-error').textContent = '';
  syncFavStar($('#buy-fav'), 'listing', l.id);

  // Offer state note + button
  const note = $('#buy-offer-note');
  const offerBtn = $('#buy-offer');
  if (offer && offer.status === 'accepted') {
    note.style.display = 'block';
    note.innerHTML = `✅ <b>Offer accepted at ${money(offer.amount_cents)}</b> — that's your price below. Check out before someone else buys it.`;
    offerBtn.style.display = 'none';
  } else if (offer && offer.status === 'countered') {
    note.style.display = 'block';
    note.innerHTML = `↩️ Seller countered your ${money(offer.amount_cents)} offer at <b>${money(offer.counter_cents)}</b> — respond from your dashboard's Offers tab.`;
    offerBtn.style.display = 'none';
  } else if (offer) {
    note.style.display = 'block';
    note.innerHTML = `⏳ Your <b>${money(offer.amount_cents)}</b> offer is waiting on the seller.`;
    offerBtn.style.display = 'none';
  } else {
    note.style.display = 'none';
    const canOffer = ME && l.status === 'active' && l.price_cents && (!ME || ME.id !== l.seller_id);
    offerBtn.style.display = canOffer ? 'block' : 'none';
    offerBtn.onclick = async () => {
      const raw = await vaultPrompt(`Asking price is ${money(l.price_cents)}. The seller can accept, decline, or counter.`, { title: 'Make an offer', placeholder: 'e.g. 20.00', okText: 'Send offer', icon: '💰' });
      if (raw === null) return;
      const dollars = parseFloat(raw);
      if (!isFinite(dollars) || dollars <= 0) return toast('Enter a valid dollar amount.', 'error');
      const r2 = await api(`/api/listings/${l.id}/offers`, { method: 'POST', body: JSON.stringify({ amount_cents: Math.round(dollars * 100) }) });
      if (r2.error) return toast(r2.error, 'error');
      toast('Offer sent — you\'ll get a notification when the seller responds.', 'success');
      openBuyModal(l.id);
    };
  }
  $('#buy-share').onclick = () => {
    navigator.clipboard.writeText(`${location.origin}/#listing-${l.id}`).then(() => toast('Link copied — share it anywhere.', 'success'));
  };

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
  listingState.q = ''; listingState.minPrice = ''; listingState.maxPrice = ''; listingState.sort = 'newest'; listingState.category = ''; listingState.page = 1;
  renderCatChips('#listings-cats', listingState, loadListings);
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
  const { kind, id, amountCents } = pendingCryptoContext;
  let r;
  if (kind === 'topup') {
    r = await api('/api/topup/crypto', { method: 'POST', body: JSON.stringify({ amount_cents: amountCents, pay_currency: currency }) });
  } else {
    const url = kind === 'auction' ? `/api/auctions/${id}/checkout/crypto` : `/api/listings/${id}/checkout/crypto`;
    r = await api(url, { method: 'POST', body: JSON.stringify({ pay_currency: currency }) });
  }
  if (r.error) { toast(r.error, 'error'); return; }
  closeModal('currency-overlay');
  closeModal('buy-overlay');
  closeModal('topup-overlay');
  showCryptoPayment(r);
});

// Advance the 3-step tracker in the crypto modal: 0 waiting, 1 seen on chain, 2 escrowed.
function setCryptoStep(n) {
  $$('#crypto-steps .estep').forEach(el => {
    const i = parseInt(el.dataset.step, 10);
    el.classList.toggle('done', i < n || (n === 2 && i === 2));
    el.classList.toggle('now', i === n && n < 2);
  });
}

// Works for both order checkouts (payment.order_id) and balance top-ups
// (payment.topup_id) — same modal, different poll endpoint + success copy.
function showCryptoPayment(payment) {
  const isTopup = !!payment.topup_id;
  $('#crypto-amount').textContent = `${payment.pay_amount} ${String(payment.pay_currency).toUpperCase()}`;
  $('#crypto-address').textContent = payment.pay_address;
  $('#crypto-status').textContent = 'Waiting for your transaction…';
  $('#crypto-status').classList.remove('paid');
  setCryptoStep(0);
  openModal('crypto-overlay');

  const renderLive = (p) => {
    if (!p) return;
    if (p.status === 'confirming' || p.status === 'confirmed' || p.status === 'sending') {
      setCryptoStep(1);
      $('#crypto-status').textContent = '⛓ Transaction detected — waiting for network confirmations…';
    } else if (p.status === 'partially_paid') {
      setCryptoStep(1);
      $('#crypto-status').textContent = `⚠ Partial payment received (${p.actually_paid} of ${p.pay_amount} ${String(p.pay_currency).toUpperCase()}). Send the remainder to the same address.`;
    } else if (p.status === 'waiting') {
      setCryptoStep(0);
      $('#crypto-status').textContent = 'Waiting for your transaction…';
    }
  };
  const succeed = (msg) => {
    setCryptoStep(2);
    $('#crypto-status').textContent = msg;
    $('#crypto-status').classList.add('paid');
    clearInterval(cryptoPollTimer);
    loadMe();
  };
  const fail = (msg) => {
    $('#crypto-status').textContent = msg;
    clearInterval(cryptoPollTimer);
  };

  clearInterval(cryptoPollTimer);
  cryptoPollTimer = setInterval(async () => {
    if (isTopup) {
      const r = await api(`/api/topup/${payment.topup_id}`);
      if (r.status === 'paid') return succeed(`✓ ${money(r.amount_cents)} added to your balance. Happy trading!`);
      if (r.status === 'failed') return fail('✕ Payment failed or expired. No funds were taken — you can retry from your wallet.');
      renderLive(r.payment);
      return;
    }
    const r = await api(`/api/orders/${payment.order_id}`);
    if (!r.order) return;
    if (['paid', 'delivered', 'completed'].includes(r.order.status)) {
      succeed('✓ Payment received — held in escrow. Open your dashboard to coordinate the trade.');
      loadListings(); loadAuctions();
      return;
    }
    if (r.order.status === 'failed') {
      return fail('✕ Payment failed or expired. No funds were taken — you can retry from the item page.');
    }
    renderLive(r.payment);
  }, 6000);
}

// ---------- Add funds (balance top-up) ----------
$('#topup-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.quick-bid');
  if (!b) return;
  $('#topup-amount').value = (b.dataset.v / 100).toFixed(2);
  $('#topup-error').textContent = '';
});
function topupAmountCents() {
  const v = parseFloat($('#topup-amount').value);
  if (!isFinite(v) || v < 5 || v > 1000) {
    $('#topup-error').textContent = 'Enter an amount between $5 and $1,000.';
    return null;
  }
  $('#topup-error').textContent = '';
  return Math.round(v * 100);
}
$('#topup-stripe').onclick = async () => {
  const cents = topupAmountCents();
  if (cents == null) return;
  $('#topup-stripe').classList.add('loading');
  const r = await api('/api/topup/stripe', { method: 'POST', body: JSON.stringify({ amount_cents: cents }) });
  $('#topup-stripe').classList.remove('loading');
  if (r.error) { $('#topup-error').textContent = r.error; return; }
  window.location.href = r.url;
};
$('#topup-crypto').onclick = () => {
  const cents = topupAmountCents();
  if (cents == null) return;
  pendingCryptoContext = { kind: 'topup', amountCents: cents };
  openModal('currency-overlay');
};

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
  updateSellPreview();
});

const DURATION_LABELS = { '60': '1h', '360': '6h', '1440': '24h', '4320': '3d', '10080': '7d' };

function updateSellPreview() {
  const title = $('#sell-title').value.trim();
  const priceCents = sellType === 'fixed'
    ? Math.round((parseFloat($('#sell-price').value) || 0) * 100)
    : Math.round((parseFloat($('#sell-start-bid').value) || 0) * 100);
  const isAuction = sellType === 'auction';

  $('#sell-preview-title').textContent = title || 'Your title here';
  $('#sell-preview-title').style.opacity = title ? '1' : '0.4';
  $('#sell-preview-price').textContent = priceCents > 0 ? money(priceCents) : '$0.00';
  $('#sell-preview-price').style.opacity = priceCents > 0 ? '1' : '0.4';
  $('#sell-preview-meta').textContent = ME ? `Seller: ${ME.username}` : '';
  $('#sell-preview-badge').style.display = isAuction ? 'inline-flex' : 'none';
  $('#sell-preview-btn').textContent = isAuction ? 'View & bid' : 'Buy now';

  if (isAuction) {
    const dur = $('#sell-duration').value;
    $('#sell-preview-timer').textContent = (DURATION_LABELS[dur] || dur + 'm') + ' left';
    $('#sell-preview-timer').style.display = 'inline';
  } else {
    $('#sell-preview-timer').style.display = 'none';
  }

  const file = $('#sell-image-file').files[0];
  const url = $('#sell-image').value.trim();
  const thumb = $('#sell-preview-thumb');
  if (file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      thumb.style.backgroundImage = `url('${e.target.result}')`;
      thumb.textContent = '';
    };
    reader.readAsDataURL(file);
  } else if (url) {
    thumb.style.backgroundImage = `url('${escapeHtml(url)}')`;
    thumb.textContent = '';
  } else {
    thumb.style.backgroundImage = '';
    thumb.textContent = 'No image';
  }
}

// Reflects the chosen file in the custom drop zone (filename + clear button).
function syncFileDrop() {
  const file = $('#sell-image-file').files[0];
  const drop = $('#sell-file-drop');
  drop.classList.toggle('has-file', !!file);
  $('#sell-file-name').textContent = file ? file.name : 'Upload';
  $('#sell-file-clear').hidden = !file;
}

// Programmatically select a file (used by paste + drag-and-drop).
function setSellImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return false;
  const dt = new DataTransfer();
  dt.items.add(file);
  $('#sell-image-file').files = dt.files;
  syncFileDrop();
  updateSellPreview();
  toast(`Image "${file.name || 'from clipboard'}" attached.`, 'success');
  return true;
}

// Paste a screenshot straight into the sell modal (Ctrl/Cmd+V)
document.addEventListener('paste', (e) => {
  if (!$('#sell-overlay').classList.contains('open')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) setSellImageFile(new File([file], file.name || `screenshot-${Date.now()}.png`, { type: file.type }));
});

// Drag & drop an image anywhere onto the sell modal
{
  const sellModal = $('#sell-overlay .modal');
  ['dragover', 'dragenter'].forEach(ev => sellModal.addEventListener(ev, (e) => {
    e.preventDefault();
    $('#sell-file-drop').classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(ev => sellModal.addEventListener(ev, (e) => {
    e.preventDefault();
    $('#sell-file-drop').classList.remove('drag-over');
  }));
  sellModal.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) setSellImageFile(file);
  });
}

['sell-title', 'sell-price', 'sell-start-bid'].forEach(id =>
  $('#' + id).addEventListener('input', updateSellPreview)
);
$('#sell-image').addEventListener('input', debounce(updateSellPreview, 400));
$('#sell-image-file').addEventListener('change', () => { syncFileDrop(); updateSellPreview(); });
$('#sell-duration').addEventListener('change', updateSellPreview);
$('#sell-file-clear').addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  $('#sell-image-file').value = '';
  syncFileDrop(); updateSellPreview();
});

// Live character counter on the description
$('#sell-desc').addEventListener('input', () => {
  const len = $('#sell-desc').value.length;
  const el = $('#sell-desc-count');
  el.textContent = len ? `${len} / 2000` : '';
  el.classList.toggle('hot', len > 1900);
});

let editingListingId = null; // when set, the sell modal saves edits instead of posting

function openSellModal(editListing) {
  if (!ME) return openModal('auth-overlay');
  editingListingId = editListing ? editListing.id : null;
  const priceLabel = $('#sell-price-field label');
  if (priceLabel) priceLabel.textContent = FEE.fee_mode === 'added'
    ? 'Price (USD) — you receive this full amount'
    : 'Price (USD)';
  ['sell-title','sell-desc','sell-image','sell-price','sell-start-bid','sell-buyout'].forEach(id => $('#' + id).value = '');
  $('#sell-image-file').value = '';
  $('#sell-error').textContent = '';
  $('#sell-desc-count').textContent = '';

  const modal = $('#sell-overlay .modal h3');
  if (editListing) {
    // Editing an active fixed-price listing: prefill, lock to fixed type.
    modal.textContent = 'Edit listing';
    sellType = 'fixed';
    $$('#sell-type .pill').forEach(p => p.classList.toggle('active', p.dataset.type === 'fixed'));
    $('#sell-type').style.display = 'none';
    $('#sell-price-field').style.display = 'block';
    $('#sell-auction-fields').style.display = 'none';
    $('#sell-title').value = editListing.title || '';
    $('#sell-desc').value = editListing.description || '';
    $('#sell-image').value = editListing.image_url || '';
    $('#sell-price').value = editListing.price_cents ? (editListing.price_cents / 100).toFixed(2) : '';
    $('#sell-category').value = editListing.category || 'other';
    $('#sell-submit').textContent = 'Save changes';
    $('#sell-desc').dispatchEvent(new Event('input'));
  } else {
    modal.textContent = 'List an item';
    $('#sell-type').style.display = 'flex';
    $('#sell-submit').textContent = sellType === 'fixed' ? 'Post listing' : 'Start auction';
  }
  syncFileDrop();
  updateSellPreview();
  openModal('sell-overlay');
}
$('#cta-sell').onclick = $('#nav-sell').onclick = $('#nav-sell-mobile').onclick = (e) => { e.preventDefault(); openSellModal(); };
$('#dash-sell').onclick = openSellModal;
$('#cta-browse').onclick = () => document.getElementById('auctions').scrollIntoView({ behavior: 'smooth' });

// Uploads the chosen image file (if any) and returns its URL, else falls back
// to the pasted URL. Returns null on failure (message already shown).
async function resolveSellImage() {
  const file = $('#sell-image-file').files[0];
  if (!file) return $('#sell-image').value.trim();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/uploads', { method: 'POST', body: fd }); // no JSON header — let the browser set multipart boundary
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) { $('#sell-error').textContent = data.error || 'Image upload failed.'; return null; }
  return data.url;
}

$('#sell-submit').onclick = async () => {
  const title = $('#sell-title').value.trim();
  const description = $('#sell-desc').value.trim();
  if (!title) { $('#sell-error').textContent = 'Title is required.'; return; }
  if (!$('#sell-image-file').files[0] && !$('#sell-image').value.trim()) {
    $('#sell-error').textContent = 'An image of your item is required — upload one or paste a URL.';
    return;
  }
  $('#sell-submit').classList.add('loading');
  const image_url = await resolveSellImage();
  if (image_url === null) { $('#sell-submit').classList.remove('loading'); return; }
  let r;
  if (editingListingId) {
    const price = parseFloat($('#sell-price').value);
    if (!price || price <= 0) { $('#sell-error').textContent = 'Enter a valid price.'; $('#sell-submit').classList.remove('loading'); return; }
    r = await api(`/api/listings/${editingListingId}`, { method: 'PATCH', body: JSON.stringify({ title, description, image_url, price_cents: Math.round(price * 100) }) });
  } else if (sellType === 'fixed') {
    const price = parseFloat($('#sell-price').value);
    if (!price || price <= 0) { $('#sell-error').textContent = 'Enter a valid price.'; $('#sell-submit').classList.remove('loading'); return; }
    r = await api('/api/listings', { method: 'POST', body: JSON.stringify({ title, description, image_url, price_cents: Math.round(price * 100), category: $('#sell-category').value }) });
  } else {
    const start = parseFloat($('#sell-start-bid').value);
    const inc = parseFloat($('#sell-increment').value) || 1;
    const buyout = parseFloat($('#sell-buyout').value);
    if (!start || start <= 0) { $('#sell-error').textContent = 'Enter a valid starting bid.'; $('#sell-submit').classList.remove('loading'); return; }
    r = await api('/api/auctions', { method: 'POST', body: JSON.stringify({
      title, description, image_url,
      starting_bid_cents: Math.round(start * 100),
      min_increment_cents: Math.round(inc * 100),
      duration_minutes: parseInt($('#sell-duration').value, 10),
      buyout_cents: buyout > 0 ? Math.round(buyout * 100) : undefined,
      category: $('#sell-category').value,
    }) });
  }
  $('#sell-submit').classList.remove('loading');
  if (r.error) { $('#sell-error').textContent = r.error; return; }
  closeModal('sell-overlay');
  toast(editingListingId ? 'Listing updated.' : sellType === 'fixed' ? 'Listing posted!' : 'Auction started!', 'success');
  if (editingListingId) { editingListingId = null; renderDashTab(); }
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
  if (o.status === 'completed' && !o.review_rating) {
    actions.push(`<button class="btn btn-small" data-review="${o.id}" data-seller="${escapeHtml(other)}">⭐ Review ${role === 'buyer' ? 'seller' : 'buyer'}</button>`);
  }
  if (o.review_rating) {
    actions.push(`<span class="stars" title="Your review">${'★'.repeat(o.review_rating)}<span class="off">${'★'.repeat(5 - o.review_rating)}</span></span>`);
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
    if (!await vaultConfirm('This releases the escrowed payment to the seller — it can\'t be undone.', { title: 'Received your item?', okText: '🔓 Release payment', icon: '📦' })) return;
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
    <div class="stat-card"><div class="val gold">${money(ov.total_earned_cents || 0)}</div><div class="lbl">Lifetime earned</div></div>
    <div class="stat-card"><div class="val">${ov.avg_rating ? ov.avg_rating + '★' : '—'}</div><div class="lbl">Rating (${ov.review_count})</div></div>
  `;
  $('#tc-purchases').textContent = ov.purchases_open || '';
  $('#tc-sales').textContent = ov.sales_open || '';
  $('#tc-selling').textContent = (ov.active_listings + ov.live_auctions) || '';
  api('/api/my/offers').then(r => {
    const actionable = (r.received || []).filter(o => o.status === 'pending' && o.listing_status === 'active').length
      + (r.sent || []).filter(o => ['accepted', 'countered'].includes(o.status) && o.listing_status === 'active').length;
    $('#tc-offers').textContent = actionable || '';
  });
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
        <div class="order-actions">${l.status === 'active' ? `
          <button class="btn btn-small" data-edit-listing="${l.id}">✏️ Edit</button>
          <button class="btn btn-small" data-cancel-listing="${l.id}" style="color:var(--danger)">Remove</button>` : ''}</div>
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
    c.querySelectorAll('[data-edit-listing]').forEach(b => b.onclick = () => {
      const l = listings.find(x => String(x.id) === String(b.dataset.editListing));
      if (l) openSellModal(l);
    });
    c.querySelectorAll('[data-cancel-listing]').forEach(b => b.onclick = async () => {
      if (!await vaultConfirm('It disappears from the marketplace immediately. You can relist it any time.', { title: 'Remove this listing?', okText: 'Remove listing', danger: true, icon: '🏷' })) return;
      const r2 = await api(`/api/listings/${b.dataset.cancelListing}/cancel`, { method: 'POST' });
      if (r2.error) return toast(r2.error, 'error');
      toast('Listing removed.', 'success'); renderDashTab(); loadListings();
    });
    c.querySelectorAll('[data-cancel-auction]').forEach(b => b.onclick = async () => {
      if (!await vaultConfirm('The auction ends immediately. This only works while it has no bids.', { title: 'Cancel this auction?', okText: 'Cancel auction', danger: true, icon: '🔨' })) return;
      const r2 = await api(`/api/auctions/${b.dataset.cancelAuction}/cancel`, { method: 'POST' });
      if (r2.error) return toast(r2.error, 'error');
      toast('Auction cancelled.', 'success'); renderDashTab(); loadAuctions();
    });
    c.querySelectorAll('[data-view-auction]').forEach(b => b.onclick = () => openAuction(b.dataset.viewAuction));
    return;
  }

  if (dashTab === 'offers') {
    const r = await api('/api/my/offers');
    const received = r.received || [], sent = r.sent || [];
    const offerBadge = (o) => {
      const map = { pending: 'offer-pending', countered: 'offer-countered', accepted: 'offer-accepted' };
      return `<span class="status-badge ${map[o.status] ? 'status-' + map[o.status] : ''}">${o.status}</span>`;
    };
    const rowHtml = (o, who) => `
      <div class="order-card">
        <div class="order-thumb" style="${o.image_url ? `background-image:url('${escapeHtml(o.image_url)}')` : ''}">${o.image_url ? '' : '💰'}</div>
        <div class="order-main">
          <div class="order-title">${escapeHtml(o.title)}</div>
          <div class="order-sub">${who} · asking ${money(o.price_cents)} · offered <b>${money(o.amount_cents)}</b>${o.status === 'countered' ? ` · countered at <b>${money(o.counter_cents)}</b>` : ''} · ${timeAgo(o.updated_at)}</div>
        </div>
        ${offerBadge(o)}
        <div class="order-actions" data-offer-actions="${o.id}"></div>
      </div>`;

    let html = `<h3 class="section-sub" style="margin-top:0">Offers on my listings</h3>`;
    html += received.length
      ? `<div class="order-list">${received.map(o => rowHtml(o, `from <a href="#u/${encodeURIComponent(o.buyer_name)}">${escapeHtml(o.buyer_name)}</a>`)).join('')}</div>`
      : `<div class="empty-block">No offers received yet.</div>`;
    html += `<h3 class="section-sub">Offers I've made</h3>`;
    html += sent.length
      ? `<div class="order-list">${sent.map(o => rowHtml(o, `to <a href="#u/${encodeURIComponent(o.seller_name)}">${escapeHtml(o.seller_name)}</a>`)).join('')}</div>`
      : `<div class="empty-block">You haven't made any offers — find something on the marketplace and hit 💰 Make an offer.</div>`;
    c.innerHTML = html;

    const offerAct = async (id, action, body) => {
      const r2 = await api(`/api/offers/${id}/${action}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      if (r2.error) return toast(r2.error, 'error');
      toast('Done.', 'success');
      renderDashTab();
    };
    received.forEach(o => {
      const slot = c.querySelector(`[data-offer-actions="${o.id}"]`);
      if (!slot || o.listing_status !== 'active') return;
      if (o.status === 'pending') {
        slot.innerHTML = `
          <button class="btn btn-small btn-gold" data-a="accept">Accept ${money(o.amount_cents)}</button>
          <button class="btn btn-small" data-a="counter">↩ Counter</button>
          <button class="btn btn-small" data-a="decline" style="color:var(--danger)">Decline</button>`;
        slot.querySelector('[data-a="accept"]').onclick = () => offerAct(o.id, 'accept');
        slot.querySelector('[data-a="decline"]').onclick = () => offerAct(o.id, 'decline');
        slot.querySelector('[data-a="counter"]').onclick = async () => {
          const raw = await vaultPrompt(`They offered ${money(o.amount_cents)}, you're asking ${money(o.price_cents)}.`, { title: 'Counter-offer', placeholder: 'e.g. 30.00', okText: 'Send counter', icon: '↩️' });
          if (raw === null) return;
          const d = parseFloat(raw);
          if (!isFinite(d) || d <= 0) return toast('Enter a valid dollar amount.', 'error');
          offerAct(o.id, 'counter', { amount_cents: Math.round(d * 100) });
        };
      } else if (o.status === 'countered') {
        slot.innerHTML = `<span class="order-sub">Waiting on the buyer</span>`;
      }
    });
    sent.forEach(o => {
      const slot = c.querySelector(`[data-offer-actions="${o.id}"]`);
      if (!slot) return;
      if (o.status === 'accepted' && o.listing_status === 'active') {
        slot.innerHTML = `<button class="btn btn-small btn-gold" data-a="buy">Buy at ${money(o.amount_cents)}</button>
          <button class="btn btn-small" data-a="withdraw" style="color:var(--danger)">Withdraw</button>`;
        slot.querySelector('[data-a="buy"]').onclick = () => openBuyModal(o.listing_id);
        slot.querySelector('[data-a="withdraw"]').onclick = () => offerAct(o.id, 'withdraw');
      } else if (o.status === 'countered' && o.listing_status === 'active') {
        slot.innerHTML = `<button class="btn btn-small btn-gold" data-a="accept">Accept ${money(o.counter_cents)}</button>
          <button class="btn btn-small" data-a="withdraw" style="color:var(--danger)">Withdraw</button>`;
        slot.querySelector('[data-a="accept"]').onclick = () => offerAct(o.id, 'accept');
        slot.querySelector('[data-a="withdraw"]').onclick = () => offerAct(o.id, 'withdraw');
      } else if (o.status === 'pending' && o.listing_status === 'active') {
        slot.innerHTML = `<button class="btn btn-small" data-a="withdraw" style="color:var(--danger)">Withdraw</button>`;
        slot.querySelector('[data-a="withdraw"]').onclick = () => offerAct(o.id, 'withdraw');
      }
    });
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
        <button class="btn btn-gold" id="open-topup">＋ Add funds</button>
        <button class="btn" id="open-withdraw">Withdraw</button>
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
    $('#open-topup').onclick = () => {
      $('#topup-amount').value = '';
      $('#topup-error').textContent = '';
      openModal('topup-overlay');
    };
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
// Traders directory
// ============================================================
function traderAvatar(name, url, cls = '') {
  return url
    ? `<img src="${escapeHtml(url)}" alt="" class="${cls}">`
    : `<div class="trader-avatar-fallback ${cls}">${escapeHtml(name[0].toUpperCase())}</div>`;
}

async function loadTraders() {
  const q = $('#traders-q').value.trim();
  const r = await api(`/api/traders?q=${encodeURIComponent(q)}`);
  const grid = $('#traders-grid');
  const ts = r.traders || [];
  if (!ts.length) { grid.innerHTML = `<div class="empty">${q ? 'No traders match your search.' : 'No traders yet.'}</div>`; return; }
  grid.innerHTML = ts.map(t => `
    <div class="trader-card" data-u="${escapeHtml(t.username)}">
      <div class="trader-top">
        ${traderAvatar(t.username, t.avatar_url)}
        <div>
          <div class="trader-name">${escapeHtml(t.username)} ${vbadge(t.is_verified)} <span class="online-dot ${t.online ? '' : 'off'}" title="${t.online ? 'Online' : 'Offline'}"></span></div>
          <div class="trader-sub">${t.avg_rating ? `★ ${t.avg_rating} (${t.review_count})` : 'No reviews yet'} · ${t.completed_sales} sale${t.completed_sales === 1 ? '' : 's'}${t.items_live ? ` · ${t.items_live} on market` : ''}</div>
        </div>
      </div>
      <div class="trader-bio">${escapeHtml(t.bio || '')}</div>
      <div class="trader-actions">
        <button class="btn btn-small" data-view="${escapeHtml(t.username)}">Profile</button>
        ${!ME || t.id !== ME.id ? `<button class="btn btn-small btn-gold" data-msg="${escapeHtml(t.username)}">💬 Message</button>` : ''}
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('.trader-card').forEach(c => c.addEventListener('click', () => { location.hash = 'u/' + encodeURIComponent(c.dataset.u); }));
  grid.querySelectorAll('[data-view]').forEach(b => b.onclick = (e) => { e.stopPropagation(); location.hash = 'u/' + encodeURIComponent(b.dataset.view); });
  grid.querySelectorAll('[data-msg]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    if (!ME) return openModal('auth-overlay');
    location.hash = 'messages/' + encodeURIComponent(b.dataset.msg);
  });
}
$('#traders-q').addEventListener('input', debounce(loadTraders, 300));

// ============================================================
// Direct messages
// ============================================================
async function loadConversations() {
  const r = await api('/api/dm/conversations');
  const side = $('#dm-sidebar');
  const convs = r.conversations || [];
  if (!convs.length) {
    side.innerHTML = `<div class="empty-block" style="padding:26px 12px;border:none">No conversations yet — find someone in the <a href="#traders" style="color:var(--gold)">trader directory</a>.</div>`;
    return;
  }
  side.innerHTML = convs.map(c => `
    <div class="dm-conv ${activeDmPartner && activeDmPartner.toLowerCase() === c.partner_name.toLowerCase() ? 'active' : ''}" data-u="${escapeHtml(c.partner_name)}">
      ${traderAvatar(c.partner_name, c.partner_avatar)}
      <div class="dm-conv-main">
        <div class="dm-conv-name">${escapeHtml(c.partner_name)} <span class="online-dot ${c.online ? '' : 'off'}"></span></div>
        <div class="dm-conv-last">${c.mine ? 'You: ' : ''}${escapeHtml(c.body)}</div>
      </div>
      <div class="dm-conv-meta">
        <span class="dm-conv-time">${timeAgo(c.created_at)}</span>
        ${c.unread ? `<span class="dm-unread">${c.unread > 9 ? '9+' : c.unread}</span>` : ''}
      </div>
    </div>
  `).join('');
  side.querySelectorAll('.dm-conv').forEach(el => el.onclick = () => { location.hash = 'messages/' + encodeURIComponent(el.dataset.u); });
}

async function openDmThread(username) {
  activeDmPartner = username;
  lastDmId = 0;
  clearInterval(dmPollTimer);
  loadConversations();
  const thread = $('#dm-thread');
  thread.innerHTML = '<div class="dm-thread-empty">Loading…</div>';
  const r = await api(`/api/dm/with/${encodeURIComponent(username)}`);
  if (r.error) { thread.innerHTML = `<div class="dm-thread-empty">${escapeHtml(r.error)}</div>`; return; }
  const p = r.partner;
  thread.innerHTML = `
    <div class="dm-thread-head">
      ${traderAvatar(p.username, p.avatar_url)}
      <div>
        <div class="name">${escapeHtml(p.username)} <span class="online-dot ${p.online ? '' : 'off'}"></span></div>
        <div class="sub">${p.online ? 'Online now' : 'Offline'}</div>
      </div>
      <div class="head-actions">
        <button class="btn btn-small" id="dm-view-profile">Profile</button>
        <button class="btn btn-small" id="dm-block" style="color:var(--danger)">${p.blocked_by_me ? 'Unblock' : 'Block'}</button>
      </div>
    </div>
    <div class="dm-box" id="dm-box"></div>
    <div class="dm-input-row">
      <input id="dm-input" placeholder="Message ${escapeHtml(p.username)}…" maxlength="1000" autocomplete="off">
      <button class="btn btn-gold" id="dm-send">Send</button>
    </div>
  `;
  $('#dm-view-profile').onclick = () => { location.hash = 'u/' + encodeURIComponent(p.username); };
  $('#dm-block').onclick = () => toggleBlock(p.username, $('#dm-block'));
  $('#dm-send').onclick = sendDm;
  $('#dm-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDm(); });
  renderDmMessages(r.messages || [], true);
  dmPollTimer = setInterval(pollDm, 4000);
}

function renderDmMessages(msgs, initial) {
  const box = $('#dm-box');
  if (!box) return;
  if (initial && !msgs.length) {
    box.innerHTML = '<div class="chat-empty">No messages yet — say hi! Keep actual trades in order chat so moderators can step in if needed.</div>';
    return;
  }
  if (msgs.length && box.querySelector('.chat-empty')) box.innerHTML = '';
  msgs.forEach(m => {
    lastDmId = Math.max(lastDmId, m.id);
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (m.sender_id === ME.id ? 'mine' : 'theirs');
    el.innerHTML = `${escapeHtml(m.body)}<div class="m-meta">${timeAgo(m.created_at)}</div>`;
    box.appendChild(el);
  });
  if (msgs.length) box.scrollTop = box.scrollHeight;
}

async function pollDm() {
  if (!activeDmPartner) return;
  const r = await api(`/api/dm/with/${encodeURIComponent(activeDmPartner)}?after=${lastDmId}`);
  if (r.error) return;
  if ((r.messages || []).length) { renderDmMessages(r.messages, false); loadConversations(); }
}

async function sendDm() {
  const input = $('#dm-input');
  const body = input.value.trim();
  if (!body || !activeDmPartner) return;
  input.value = '';
  const r = await api(`/api/dm/with/${encodeURIComponent(activeDmPartner)}`, { method: 'POST', body: JSON.stringify({ body }) });
  if (r.error) { toast(r.error, 'error'); input.value = body; return; }
  await pollDm();
  loadConversations();
}

async function toggleBlock(username, btnEl) {
  const blocking = btnEl.textContent.trim() === 'Block';
  if (blocking && !await vaultConfirm(`${username} won't be able to message you, and you can't message them, until you unblock.`, { title: 'Block this user?', okText: 'Block user', danger: true, icon: '🚫' })) return;
  const r = await api(`/api/users/${encodeURIComponent(username)}/block`, { method: 'POST' });
  if (r.error) return toast(r.error, 'error');
  btnEl.textContent = r.blocked ? 'Unblock' : 'Block';
  toast(r.blocked ? `${username} blocked.` : `${username} unblocked.`, 'success');
}

// ============================================================
// Public profile
// ============================================================
async function loadProfile(username) {
  const page = $('#profile-page');
  page.innerHTML = '<div class="empty-block">Loading profile…</div>';
  const r = await api(`/api/users/${encodeURIComponent(username)}`);
  if (r.private) {
    page.innerHTML = `
      <div class="private-profile">
        <div class="lock">🔒</div>
        <h3>${escapeHtml(r.username)} keeps their profile private</h3>
        <div>This trader has hidden their profile from the directory. Their listings still appear on the marketplace.</div>
      </div>`;
    return;
  }
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
        <h2>${escapeHtml(u.username)} ${vbadge(u.is_verified)} <span class="online-dot ${u.online ? '' : 'off'}" title="${u.online ? 'Online' : 'Offline'}"></span> ${u.is_banned ? '<span class="status-badge status-disputed">Banned</span>' : ''} ${isMe && ME.profile_hidden ? '<span class="status-badge">🔒 Hidden</span>' : ''}</h2>
        <div class="profile-meta">
          <span>${stars}</span>
          <span>·</span><span>${u.completed_sales} completed sale${u.completed_sales === 1 ? '' : 's'}</span>
          <span>·</span><span>Member since ${new Date(u.created_at + 'Z').toLocaleDateString()}</span>
        </div>
        ${u.bio ? `<p class="profile-bio" id="profile-bio-text">${escapeHtml(u.bio)}</p>` : (isMe ? '<p class="profile-bio" style="font-style:italic">No bio yet.</p>' : '')}
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          ${isMe ? `
            <button class="btn btn-small" id="edit-bio">Edit bio</button>
            <button class="btn btn-small" id="toggle-privacy">${ME.profile_hidden ? '👁 Unhide my profile' : '🕶 Hide my profile'}</button>
          ` : (ME ? `
            <button class="btn btn-small btn-gold" id="pf-message">💬 Message</button>
            <button class="btn btn-small" id="pf-block" style="color:var(--danger)">${u.blocked_by_me ? 'Unblock' : 'Block'}</button>
            <button class="btn btn-small" id="pf-report">⚑ Report</button>
          ` : '')}
        </div>
      </div>
    </div>
    ${(r.achievements || []).length ? `<div class="ach-chips">${r.achievements.map(a => `<span class="ach-chip" title="${escapeHtml(a.desc)}">${a.icon} ${escapeHtml(a.label)}</span>`).join('')}</div>` : ''}
    ${r.auctions.length ? `<h3 class="section-sub">Live auctions</h3><div class="grid" id="pf-auctions">${r.auctions.map(auctionCardHtml).join('')}</div>` : ''}
    ${r.listings.length ? `<h3 class="section-sub">Listings</h3><div class="grid" id="pf-listings">${r.listings.map(listingCardHtml).join('')}</div>` : ''}
    ${!r.auctions.length && !r.listings.length ? `<div class="empty-block" style="margin-top:22px">Nothing on the market right now.</div>` : ''}
    <h3 class="section-sub">Reviews</h3>
    ${(() => {
      const hist = r.histogram || {};
      const histTotal = [1, 2, 3, 4, 5].reduce((a, s) => a + (hist[s] || 0), 0);
      return histTotal ? `<div class="rating-histogram">${[5, 4, 3, 2, 1].map(s => {
        const cnt = hist[s] || 0;
        return `<div class="hist-row"><span class="hist-star">${s}★</span><div class="hist-bar"><i style="width:${Math.round(cnt / histTotal * 100)}%"></i></div><span class="hist-count">${cnt}</span></div>`;
      }).join('')}</div>` : '';
    })()}
    ${r.reviews.length ? `<div class="review-list">${r.reviews.map(rv => `
      <div class="review-item">
        <div class="r-head">
          ${rv.reviewer_avatar ? `<img src="${escapeHtml(rv.reviewer_avatar)}">` : ''}
          <b>${escapeHtml(rv.reviewer_name)}</b>
          <span class="stars">${'★'.repeat(rv.rating)}<span class="off">${'★'.repeat(5 - rv.rating)}</span></span>
          <span class="r-role">${rv.reviewer_role === 'buyer' ? 'bought from them' : 'sold to them'}</span>
          <span class="r-time">${timeAgo(rv.created_at)}</span>
        </div>
        ${rv.comment ? `<div class="r-body">${escapeHtml(rv.comment)}</div>` : ''}
        ${rv.reply ? `<div class="r-reply"><b>↩ ${escapeHtml(u.username)} replied</b> · ${timeAgo(rv.replied_at)}<div>${escapeHtml(rv.reply)}</div></div>` : ''}
        ${isMe && !rv.reply ? `<button class="btn btn-small" data-reply-review="${rv.id}" style="margin-top:8px">↩ Reply</button>` : ''}
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
    const bio = await vaultPrompt('Tell traders who you are (max 300 chars).', { title: 'Edit your bio', value: current || '', placeholder: 'Trusted trader since…', okText: 'Save bio', icon: '👤' });
    if (bio === null) return;
    const r2 = await api('/api/my/bio', { method: 'POST', body: JSON.stringify({ bio }) });
    if (r2.error) return toast(r2.error, 'error');
    toast('Bio updated.', 'success');
    loadProfile(username);
  };
  const tp = $('#toggle-privacy');
  if (tp) tp.onclick = async () => {
    const hiding = !ME.profile_hidden;
    if (hiding && !await vaultConfirm('You disappear from the trader directory and your profile page goes private. Your listings stay on the marketplace, and traders you\'ve already messaged can still reach you.', { title: 'Hide your profile?', okText: '🕶 Hide profile', icon: '🔒' })) return;
    const r2 = await api('/api/my/privacy', { method: 'POST', body: JSON.stringify({ hidden: hiding }) });
    if (r2.error) return toast(r2.error, 'error');
    ME.profile_hidden = hiding ? 1 : 0;
    toast(hiding ? 'Profile hidden — you\'re off the trader directory.' : 'Profile visible again.', 'success');
    loadProfile(username);
  };
  const pm = $('#pf-message');
  if (pm) pm.onclick = () => { location.hash = 'messages/' + encodeURIComponent(u.username); };
  const pb = $('#pf-block');
  if (pb) pb.onclick = () => toggleBlock(u.username, pb);
  page.querySelectorAll('[data-reply-review]').forEach(b => b.onclick = async () => {
    const reply = await vaultPrompt('Your reply is shown publicly under the review.', { title: 'Reply to this review', placeholder: 'e.g. Thanks for the smooth trade!', okText: 'Post reply', icon: '↩️' });
    if (reply === null) return;
    if (!reply) return toast('Write a reply first.', 'error');
    const r2 = await api(`/api/reviews/${b.dataset.replyReview}/reply`, { method: 'POST', body: JSON.stringify({ reply }) });
    if (r2.error) return toast(r2.error, 'error');
    toast('Reply posted.', 'success');
    loadProfile(username);
  });
  const pr = $('#pf-report');
  if (pr) pr.onclick = async () => {
    const reason = await vaultPrompt('What did this user do? A moderator will review your report.', { title: `Report ${u.username}`, placeholder: 'e.g. Scam attempt, harassment in DMs…', okText: 'Submit report', icon: '⚑' });
    if (reason === null) return;
    if (!reason) return toast('Describe what happened.', 'error');
    const r2 = await api(`/api/users/${encodeURIComponent(u.username)}/report`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (r2.error) return toast(r2.error, 'error');
    toast('Report submitted — a moderator will take a look.', 'success');
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
    <div class="stat-card"><div class="val ${r.open_reports ? 'gold' : ''}">${r.open_reports}</div><div class="lbl">Open reports</div></div>
    <div class="stat-card"><div class="val">${money(r.escrow_held_cents)}</div><div class="lbl">Held in escrow</div></div>
    <div class="stat-card"><div class="val gold">${money(r.fees_earned_cents)}</div><div class="lbl">Fees earned</div></div>
  `;
  $('#tc-reports').textContent = r.open_reports || '';
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
      const note = await vaultPrompt('Optional note shown to both parties.', { title: b.dataset.action === 'refund_buyer' ? 'Refund the buyer?' : 'Release to the seller?', okText: 'Resolve dispute', placeholder: 'e.g. Chat shows the item was never delivered', icon: '🛡' });
      if (note === null) return;
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
      if (!await vaultConfirm('Crypto leaves your NOWPayments balance immediately and can\'t be recalled.', { title: 'Send this payout?', okText: '⚡ Send payout', icon: '⚡' })) return;
      b.disabled = true; b.textContent = 'Sending…';
      const r2 = await api(`/api/admin/withdrawals/${b.dataset.sendCrypto}/send-crypto`, { method: 'POST' });
      if (r2.error) { toast(r2.error, 'error'); b.disabled = false; b.textContent = '⚡ Send via NOWPayments'; return; }
      toast('Payout submitted — it will flip to Paid when the transfer confirms.', 'success');
      loadAdmin();
    });
    c.querySelectorAll('[data-wd]').forEach(b => b.onclick = async () => {
      const note = await vaultPrompt('Optional note shown to the user.', { title: b.dataset.action === 'paid' ? 'Mark as sent?' : 'Reject & refund?', okText: b.dataset.action === 'paid' ? 'Mark sent' : 'Reject withdrawal', icon: '🏦' });
      if (note === null) return;
      b.disabled = true;
      const r2 = await api(`/api/admin/withdrawals/${b.dataset.wd}`, { method: 'POST', body: JSON.stringify({ action: b.dataset.action, note }) });
      if (r2.error) { toast(r2.error, 'error'); b.disabled = false; return; }
      toast('Withdrawal updated.', 'success');
      loadAdmin();
    });
    return;
  }

  if (adminTab === 'content') {
    c.innerHTML = `
      <div class="search-bar" style="margin-bottom:14px"><div class="search-input-wrap" style="flex:1">
        <input type="search" id="admin-content-q" placeholder="Search live listings & auctions…" autocomplete="off" style="width:100%">
      </div></div>
      <div id="admin-content-list"></div>`;
    const renderContent = async () => {
      const q = $('#admin-content-q').value.trim();
      const r = await api(`/api/admin/listings?q=${encodeURIComponent(q)}`);
      const rows = [
        ...(r.listings || []).map(l => ({ ...l, kind: 'listing', price: l.price_cents })),
        ...(r.auctions || []).map(a => ({ ...a, kind: 'auction', price: a.current_bid_cents || a.starting_bid_cents })),
      ];
      if (!rows.length) { $('#admin-content-list').innerHTML = '<div class="empty-block">No live content.</div>'; return; }
      $('#admin-content-list').innerHTML = `<div class="order-list">` + rows.map(it => `
        <div class="order-card">
          <div class="order-thumb" style="${it.image_url ? `background-image:url('${escapeHtml(it.image_url)}')` : ''}">${it.image_url ? '' : (it.kind === 'auction' ? '🔨' : '🏷')}</div>
          <div class="order-main">
            <div class="order-title">${escapeHtml(it.title)} <span class="status-badge status-active">${it.kind}</span></div>
            <div class="order-sub">by <a href="#u/${encodeURIComponent(it.seller_name)}">${escapeHtml(it.seller_name)}</a> · ${money(it.price)}</div>
          </div>
          <div class="order-actions">
            <button class="btn btn-small" data-takedown="${it.kind}" data-id="${it.id}" style="color:var(--danger)">Take down</button>
          </div>
        </div>`).join('') + `</div>`;
      $('#admin-content-list').querySelectorAll('[data-takedown]').forEach(b => b.onclick = async () => {
        if (!await vaultConfirm('The seller (and any bidders) will be notified.', { title: 'Take down this item?', okText: 'Take it down', danger: true, icon: '🚫' })) return;
        b.disabled = true;
        const path = b.dataset.takedown === 'auction' ? 'auctions' : 'listings';
        const r2 = await api(`/api/admin/${path}/${b.dataset.id}/remove`, { method: 'POST' });
        if (r2.error) { toast(r2.error, 'error'); b.disabled = false; return; }
        toast('Item taken down.', 'success');
        renderContent(); loadListings(); loadAuctions();
      });
    };
    $('#admin-content-q').addEventListener('input', debounce(renderContent, 300));
    renderContent();
    return;
  }

  if (adminTab === 'reports') {
    const r = await api('/api/admin/reports');
    const reports = r.reports || [];
    if (!reports.length) { c.innerHTML = '<div class="empty-block">No open reports. 🎉</div>'; return; }
    c.innerHTML = `<div class="order-list">` + reports.map(rp => `
      <div class="order-card" style="align-items:flex-start">
        <div class="order-main">
          <div class="order-title">⚑ <a href="#u/${encodeURIComponent(rp.reported_name)}">${escapeHtml(rp.reported_name)}</a> ${rp.reported_banned ? '<span class="status-badge status-disputed">Banned</span>' : ''}</div>
          <div class="order-sub">Reported by <a href="#u/${encodeURIComponent(rp.reporter_name)}">${escapeHtml(rp.reporter_name)}</a> · ${timeAgo(rp.created_at)}</div>
          <div class="inline-note danger" style="margin-bottom:0">“${escapeHtml(rp.reason)}”</div>
        </div>
        <div class="order-actions" style="flex-direction:column;align-items:stretch">
          <button class="btn btn-small" data-view-user="${escapeHtml(rp.reported_name)}">View profile</button>
          <button class="btn btn-small btn-gold" data-resolve-report="${rp.id}">Mark resolved</button>
        </div>
      </div>`).join('') + `</div>`;
    c.querySelectorAll('[data-view-user]').forEach(b => b.onclick = () => { location.hash = 'u/' + encodeURIComponent(b.dataset.viewUser); });
    c.querySelectorAll('[data-resolve-report]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const r2 = await api(`/api/admin/reports/${b.dataset.resolveReport}/resolve`, { method: 'POST' });
      if (r2.error) { toast(r2.error, 'error'); b.disabled = false; return; }
      toast('Report resolved.', 'success');
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
          <td><a href="#u/${encodeURIComponent(u.username)}" style="color:var(--gold)">${escapeHtml(u.username)}</a> ${vbadge(u.is_verified)}${u.is_admin ? ' 🛡' : ''}</td>
          <td class="mono">${money(u.site_credit_cents)}</td>
          <td>${timeAgo(u.created_at)}</td>
          <td>${u.is_banned ? '<span class="status-badge status-disputed">Banned</span>' : '<span class="status-badge status-active">Active</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-small btn-gold" data-credit="${u.id}" data-name="${escapeHtml(u.username)}">＋ Credit</button>
            <button class="btn btn-small" data-verify="${u.id}">${u.is_verified ? 'Unverify' : '✓ Verify'}</button>
            ${u.is_admin ? '' : (u.is_banned
              ? `<button class="btn btn-small" data-unban="${u.id}">Unban</button>`
              : `<button class="btn btn-small" data-ban="${u.id}" style="color:var(--danger)">Ban</button>`)}
          </td>
        </tr>`).join('')}
      </table></div>`;
      $('#admin-users-table').querySelectorAll('[data-credit]').forEach(b => b.onclick = async () => {
        const raw = await vaultPrompt(`Dollars to add to ${b.dataset.name}'s balance — negative to remove.`, { title: 'Adjust balance', placeholder: 'e.g. 25 or -10', okText: 'Next', icon: '◈' });
        if (raw == null) return;
        const dollars = parseFloat(raw);
        if (!isFinite(dollars) || dollars === 0) return toast('Enter a non-zero dollar amount.', 'error');
        const note = await vaultPrompt('Optional note shown to the user.', { title: `${dollars > 0 ? 'Add' : 'Remove'} $${Math.abs(dollars).toFixed(2)}?`, okText: 'Apply', placeholder: 'e.g. Giveaway winnings', icon: '◈' });
        if (note === null) return;
        const r2 = await api(`/api/admin/users/${b.dataset.credit}/credit`, {
          method: 'POST',
          body: JSON.stringify({ amount_cents: Math.round(dollars * 100), note }),
        });
        if (r2.error) return toast(r2.error, 'error');
        toast(`Balance updated to ${money(r2.balance_cents)}.`, 'success');
        await loadMe(); // refresh nav balance in case an admin credited themselves
        renderUsers();
      });
      $('#admin-users-table').querySelectorAll('[data-verify]').forEach(b => b.onclick = async () => {
        const r2 = await api(`/api/admin/users/${b.dataset.verify}/verify`, { method: 'POST' });
        if (r2.error) return toast(r2.error, 'error');
        toast(r2.verified ? 'Verified badge granted.' : 'Verified badge removed.', 'success');
        renderUsers();
      });
      $('#admin-users-table').querySelectorAll('[data-ban]').forEach(b => b.onclick = async () => {
        if (!await vaultConfirm('Their active listings are pulled off the market and they lose access immediately.', { title: 'Ban this user?', okText: 'Ban user', danger: true, icon: '🔨' })) return;
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
  loadTrending();
  loadRecentSales();
  renderCatChips('#auctions-cats', auctionState, loadAuctions);
  renderCatChips('#listings-cats', listingState, loadListings);
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
  if (params.get('topup') === 'success') {
    toast('Payment received — the funds will appear in your balance momentarily.', 'success');
    history.replaceState({}, '', '/#dashboard');
    route();
    setTimeout(loadMe, 4000); // give the webhook a beat, then refresh the balance chip
  } else if (params.get('topup') === 'cancelled') {
    toast('Top-up cancelled — no charge was made.', 'info');
    history.replaceState({}, '', '/');
  }
  if (params.get('auth_error')) {
    toast('Sign-in failed: ' + params.get('auth_error'), 'error');
    history.replaceState({}, '', '/');
  }

  setInterval(() => { if ($('#view-home').classList.contains('active')) { loadAuctions(); } }, 60000);
})();
