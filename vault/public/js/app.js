let ME = null;
let FEE = { fee_bps: 600, fee_mode: 'added' };
function feeOnTop(baseCents) { return FEE.fee_mode === 'added' ? Math.round(baseCents * myFeeBps() / 10000) : 0; }
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
let ticketPollTimer = null;
let activeTicketId = null;
let lastTicketMsgId = 0;
let tchatPollTimer = null;
let activeTourneyId = null;
let lastTchatMsgId = 0;
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
// Vault Pro subscriber badge.
function probadge(isPro) {
  return isPro ? '<span class="pro-badge" title="Vault Pro subscriber">PRO</span>' : '';
}
// The buyer fee rate that applies to the signed-in user (Pro pays less).
function myFeeBps() {
  return ME && ME.pro && ME.pro.active ? (FEE.pro_fee_bps ?? FEE.fee_bps) : FEE.fee_bps;
}

// Admin-managed — loaded from /api/categories at boot and after admin edits.
let CATEGORY_LABELS = { other: 'Other' };
async function loadCategories() {
  const r = await api('/api/categories');
  if (!r.categories) return;
  CATEGORY_LABELS = Object.fromEntries(r.categories.map(c => [c.slug, c.label]));
  const opts = r.categories.map(c => ({ value: c.slug, label: c.label }));
  ['#sell-category', '#trade-category', '#tourney-category', '#wanted-category', '#wfl-category'].forEach(id => { const el = $(id); if (el) setSelectOptions(el, opts); });
  renderCatChips('#auctions-cats', auctionState, loadAuctions);
  renderCatChips('#listings-cats', listingState, loadListings);
  renderCatChips('#wanted-cats', wantedState, loadWanted);
  if ($('#view-trading').classList.contains('active')) renderCatChips('#trades-cats', tradeState, loadTradePosts);
}
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
  if (id === 'ticket-overlay') { clearInterval(ticketPollTimer); activeTicketId = null; }
  if (id === 'tchat-overlay') { clearInterval(tchatPollTimer); activeTourneyId = null; }
  if (id === 'lobbyroom-overlay') { clearInterval(lobbyPollTimer); clearInterval(lobbyChatTimer); activeLobbyId = null; }
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
    // Delegated so options can be rebuilt at runtime (admin-managed categories)
    sel.querySelector('.cs-dropdown').addEventListener('click', (e) => {
      const opt = e.target.closest('.cs-option');
      if (!opt) return;
      e.stopPropagation();
      sel.dataset.value = opt.dataset.value;
      sel.querySelector('.cs-label').textContent = opt.textContent;
      sel.querySelectorAll('.cs-option').forEach(o => o.classList.toggle('active', o === opt));
      sel.classList.remove('open');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// Replace a custom select's option list (label/active synced to current value).
function setSelectOptions(sel, options) {
  sel.querySelector('.cs-dropdown').innerHTML = options.map(o =>
    `<div class="cs-option ${o.value === sel.dataset.value ? 'active' : ''}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</div>`
  ).join('');
  const active = options.find(o => o.value === sel.dataset.value) || options[options.length - 1];
  if (active) { sel.dataset.value = active.value; sel.querySelector('.cs-label').textContent = active.label; }
}
function closeAllSelects() {
  document.querySelectorAll('.custom-select.open').forEach(s => s.classList.remove('open'));
}
document.addEventListener('click', closeAllSelects);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllSelects(); });
initCustomSelects();

$$('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
$$('.overlay').forEach(ov => ov.addEventListener('click', e => {
  if (e.target === ov) closeModal(ov.id);
}));

// ---------- Mobile nav ----------
$('#nav-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  closeDropdowns();
  $('#mobile-nav').classList.toggle('open');
});
$$('#mobile-nav a').forEach(a => a.addEventListener('click', () => $('#mobile-nav').classList.remove('open')));
// Tap outside the open menu closes it.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#mobile-nav') && !e.target.closest('#nav-toggle')) $('#mobile-nav').classList.remove('open');
});

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
  if (name !== 'server') { clearInterval(serverPollTimer); clearInterval(serverSummaryTimer); }
  syncNavActive(name);
  if (typeof updateDock === 'function') updateDock(name);
  window.scrollTo({ top: 0 });
}

function syncNavActive(view) {
  const h = location.hash.replace(/^#/, '');
  $$('#main-nav a, #mobile-nav a').forEach(a => {
    const target = (a.getAttribute('href') || '').replace(/^#/, '');
    const on = target && (view === 'home' ? (target === h) : (target === view || (view === 'messages' && target === 'messages')));
    a.classList.toggle('active', !!on);
  });
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
  if (h === 'trading') { showView('trading'); renderCatChips('#trades-cats', tradeState, loadTradePosts); loadTradePosts(); return; }
  if (h === 'tournaments') { showView('tournaments'); loadTournaments(); return; }
  if (h === 'traders-center') { showView('wfl'); loadWfl(); return; }
  if (h === 'lobbies') { showView('lobbies'); loadLobbies(); return; }
  if (h === 'server') { showView('server'); loadServer(); return; }
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
      <a class="btn btn-small dash-btn" href="#dashboard">📊 Dashboard</a>
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
$('#menu-pro').onclick = () => { closeDropdowns(); openProModal(); };

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
  offer: '💰', price_drop: '📉', ending_soon: '⏰', mm: '⚖️',
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
    <div class="stat"><b data-count="${r.live_auctions}">0</b><span>Live auctions</span></div>
    <div class="stat"><b data-count="${r.active_listings}">0</b><span>Listings</span></div>
    <div class="stat"><b data-count="${r.completed_trades}">0</b><span>Trades settled</span></div>
    <div class="stat"><b data-count="${r.traders}">0</b><span>Traders</span></div>
  `;
  countUp('#hero-stats [data-count]');
}

// Roll numbers up from 0 — the hero stats tick alive instead of popping in.
function countUp(sel) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $$(sel).forEach(el => { el.textContent = el.dataset.count; });
    return;
  }
  $$(sel).forEach(el => {
    const target = parseInt(el.dataset.count, 10) || 0;
    if (!target) { el.textContent = '0'; return; }
    const t0 = performance.now(), dur = 900;
    const tick = (t) => {
      const p = Math.min((t - t0) / dur, 1);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3)))); // ease-out cubic
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
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
    <div class="card ${a.seller_pro ? 'pro-featured' : ''}" data-auction-id="${a.id}">
      <div class="thumb" style="${a.image_url ? `background-image:url('${escapeHtml(a.image_url)}')` : ''}">${a.image_url ? '' : 'No image'}${catTag(a.category)}</div>
      <div class="card-body">
        <div class="badge"><span class="dot"></span> Live${a.buyout_cents ? ` · ⚡ ${money(a.buyout_cents)}` : ''}</div>
        <div class="card-title">${escapeHtml(a.title)}</div>
        <div class="card-meta">Seller: <a class="seller-link" href="#u/${encodeURIComponent(a.seller_name)}" onclick="event.stopPropagation()">${escapeHtml(a.seller_name)}</a> ${vbadge(a.seller_verified)}${probadge(a.seller_pro)}${a.current_bidder_name ? ' · High bidder: ' + escapeHtml(a.current_bidder_name) : ''}</div>
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
    <div class="card ${l.seller_pro ? 'pro-featured' : ''}" data-listing-id="${l.id}">
      <div class="thumb" style="${l.image_url ? `background-image:url('${escapeHtml(l.image_url)}')` : ''}">${l.image_url ? '' : 'No image'}${catTag(l.category)}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(l.title)}</div>
        <div class="card-meta">Seller: <a class="seller-link" href="#u/${encodeURIComponent(l.seller_name)}" onclick="event.stopPropagation()">${escapeHtml(l.seller_name)}</a> ${vbadge(l.seller_verified)}${probadge(l.seller_pro)}</div>
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
  $('#buy-sub').innerHTML = `<b>${money(total)}</b>${total !== base ? ` <span style="color:var(--muted)">(${money(base)} + ${(myFeeBps() / 100).toFixed(0)}% buyer fee${ME && ME.pro && ME.pro.active ? ' ⭐' : ''})</span>` : ''}${l.watch_count ? ` · 👁 ${l.watch_count} watching` : ''} · Seller: <a class="seller-link" href="#u/${encodeURIComponent(l.seller_name)}">${escapeHtml(l.seller_name)}</a> ${vbadge(l.seller_verified)}${probadge(l.seller_pro)}`;
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
  } else if (kind === 'pro') {
    r = await api('/api/pro/subscribe', { method: 'POST', body: JSON.stringify({ method: 'crypto', pay_currency: currency }) });
  } else {
    const url = kind === 'auction' ? `/api/auctions/${id}/checkout/crypto` : `/api/listings/${id}/checkout/crypto`;
    r = await api(url, { method: 'POST', body: JSON.stringify({ pay_currency: currency }) });
  }
  if (r.error) { toast(r.error, 'error'); return; }
  closeModal('currency-overlay');
  closeModal('buy-overlay');
  closeModal('topup-overlay');
  closeModal('pro-overlay');
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
  const isPro = !!payment.pro_purchase_id;
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
    if (isPro) {
      const r = await api(`/api/pro/purchases/${payment.pro_purchase_id}`);
      if (r.status === 'paid') { succeed('⭐ Welcome to Vault Pro — your reduced fee is live!'); loadListings(); loadAuctions(); return; }
      if (r.status === 'failed') return fail('✕ Payment failed or expired. No funds were taken — you can retry from the ⭐ Vault Pro menu.');
      renderLive(r.payment);
      return;
    }
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

// ---------- Draft autosave (QoL) ----------
// Half-typed listings/trades survive accidental closes, refreshes, and crashes.
// Saved to localStorage on input, restored on reopen, cleared on submit.
const SELL_DRAFT_FIELDS = ['sell-title', 'sell-desc', 'sell-image', 'sell-price', 'sell-start-bid', 'sell-increment', 'sell-buyout'];
const TRADE_DRAFT_FIELDS = ['trade-offering', 'trade-wants', 'trade-notes', 'trade-image'];

function saveDraft(key, fields, extra = {}) {
  const data = { ...extra };
  fields.forEach(id => { data[id] = $('#' + id).value; });
  const hasContent = Object.values(data).some(v => v && String(v).trim());
  if (hasContent) localStorage.setItem(key, JSON.stringify(data));
  else localStorage.removeItem(key);
}
function restoreDraft(key, fields) {
  let data;
  try { data = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  if (!data) return null;
  fields.forEach(id => { if (data[id] != null) $('#' + id).value = data[id]; });
  return data;
}
const saveSellDraft = debounce(() => {
  if (editingListingId) return; // edits shouldn't clobber the new-listing draft
  saveDraft('vault-sell-draft', SELL_DRAFT_FIELDS, { type: sellType, category: $('#sell-category').value, duration: $('#sell-duration').value });
}, 400);
const saveTradeDraft = debounce(() => saveDraft('vault-trade-draft', TRADE_DRAFT_FIELDS, { category: $('#trade-category').value }), 400);
SELL_DRAFT_FIELDS.forEach(id => $('#' + id).addEventListener('input', saveSellDraft));
TRADE_DRAFT_FIELDS.forEach(id => $('#' + id).addEventListener('input', saveTradeDraft));
$('#sell-category').addEventListener('change', saveSellDraft);
$('#sell-duration').addEventListener('change', saveSellDraft);
$('#trade-category').addEventListener('change', saveTradeDraft);

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
    const draft = restoreDraft('vault-sell-draft', SELL_DRAFT_FIELDS);
    if (draft) {
      if (draft.type && draft.type !== sellType) {
        sellType = draft.type;
        $$('#sell-type .pill').forEach(p => p.classList.toggle('active', p.dataset.type === sellType));
        $('#sell-price-field').style.display = sellType === 'fixed' ? 'block' : 'none';
        $('#sell-auction-fields').style.display = sellType === 'auction' ? 'block' : 'none';
      }
      if (draft.category) $('#sell-category').value = draft.category;
      if (draft.duration) $('#sell-duration').value = draft.duration;
      $('#sell-desc').dispatchEvent(new Event('input'));
      toast('Draft restored — pick up where you left off.', 'info');
    }
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
  if (!editingListingId) localStorage.removeItem('vault-sell-draft');
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
  api('/api/mm/tickets').then(r => {
    const waiting = (r.tickets || []).filter(t => ME && t.middleman_id === ME.id && t.status === 'assigned').length;
    $('#tc-trades').textContent = waiting || '';
  });
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

  if (dashTab === 'trades') {
    const [tk, tp] = await Promise.all([api('/api/mm/tickets'), api('/api/trades')]);
    const tickets = tk.tickets || [];
    const myPosts = (tp.trades || []).filter(t => ME && t.user_id === ME.id);
    const badge = (st) => {
      const map = { assigned: 'status-paid', active: 'status-active', completed: 'status-completed', cancelled: '', unavailable: 'status-disputed' };
      return `<span class="status-badge ${map[st] || ''}">${st}</span>`;
    };
    let html = '';

    // Middleman panel
    if (tk.middleman_status === 'approved') {
      html += `<div class="inline-note">⚖️ You're an <b>approved middleman</b>. Tickets assigned to you appear below — respond within 2 minutes or they rotate.</div>`;
    } else if (tk.middleman_status === 'pending') {
      html += `<div class="inline-note">⏳ Your middleman application is waiting for admin review.</div>`;
    } else {
      html += `<div class="inline-note">Want to help traders and build reputation? <button class="btn btn-small btn-gold" id="apply-mm" style="margin-left:6px">⚖️ Apply to be a middleman</button></div>`;
    }

    html += `<h3 class="section-sub">Middleman tickets</h3>`;
    html += tickets.length ? `<div class="order-list">` + tickets.map(t => {
      const iAmMM = ME && t.middleman_id === ME.id;
      const isParty = ME && (t.requester_id === ME.id || t.partner_id === ME.id);
      return `
      <div class="order-card">
        <div class="order-main">
          <div class="order-title">#${t.id} · ${escapeHtml(t.offering)} ⇄ ${escapeHtml(t.wants)}${t.tip_cents ? ` <span class="status-badge status-offer-accepted">💰 ${money(t.tip_cents)} tip</span>` : ''}</div>
          <div class="order-sub">${escapeHtml(t.requester_name)} + ${escapeHtml(t.partner_name)}${t.middleman_name ? ` · MM: <b>${escapeHtml(t.middleman_name)}</b>` : ''} · ${timeAgo(t.updated_at)}</div>
        </div>
        ${badge(t.status)}
        <div class="order-actions">
          ${['assigned','active','completed'].includes(t.status) && t.middleman_id ? `<button class="btn btn-small ${t.status === 'active' ? 'btn-gold' : ''}" data-tk-room="${t.id}">Ticket room</button>` : ''}
          ${iAmMM && t.status === 'assigned' ? `
            <button class="btn btn-small btn-gold" data-tk-accept="${t.id}">Accept</button>
            <button class="btn btn-small" data-tk-decline="${t.id}" style="color:var(--danger)">Pass</button>` : ''}
          ${iAmMM && t.status === 'active' ? `
            <button class="btn btn-small btn-gold" data-tk-complete="${t.id}">Mark completed</button>` : ''}
          ${isParty && ['assigned','active','unavailable'].includes(t.status) ? `<button class="btn btn-small" data-tk-cancel="${t.id}" style="color:var(--danger)">Cancel</button>` : ''}
        </div>
      </div>`;
    }).join('') + `</div>` : `<div class="empty-block">No middleman tickets yet — request one from any trade post when you've matched with someone.</div>`;

    html += `<h3 class="section-sub">My trade posts</h3>`;
    html += myPosts.length ? `<div class="order-list">` + myPosts.map(t => `
      <div class="order-card">
        <div class="order-main">
          <div class="order-title">${escapeHtml(t.offering)} ⇄ ${escapeHtml(t.wants)}</div>
          <div class="order-sub">${CATEGORY_LABELS[t.category] || t.category} · posted ${timeAgo(t.created_at)}</div>
        </div>
        <div class="order-actions"><button class="btn btn-small" data-close-post="${t.id}" style="color:var(--danger)">Close</button></div>
      </div>`).join('') + `</div>` : `<div class="empty-block">No open trade posts — post one from the <a href="#trading" style="color:var(--gold)">Trading</a> board.</div>`;

    c.innerHTML = html;

    const am = $('#apply-mm');
    if (am) am.onclick = async () => {
      if (!await vaultConfirm('Middlemen hold both sides of a trade so neither trader can scam. You\'ll get ticket requests while online and must respond within 2 minutes. An admin reviews your application.', { title: 'Apply to be a middleman?', okText: '⚖️ Apply', icon: '⚖️' })) return;
      const r2 = await api('/api/middleman/apply', { method: 'POST' });
      if (r2.error) return toast(r2.error, 'error');
      toast('Application sent — an admin will review it.', 'success');
      ME.middleman_status = 'pending';
      renderDashTab();
    };
    const act = (id, action) => async () => {
      const r2 = await api(`/api/mm/tickets/${id}/${action}`, { method: 'POST' });
      if (r2.error) return toast(r2.error, 'error');
      toast(action === 'accept' ? 'Ticket accepted — the shared room is open, say hi to both traders.' : 'Done.', 'success');
      renderDashTab();
    };
    c.querySelectorAll('[data-tk-accept]').forEach(b => b.onclick = act(b.dataset.tkAccept, 'accept'));
    c.querySelectorAll('[data-tk-decline]').forEach(b => b.onclick = act(b.dataset.tkDecline, 'decline'));
    c.querySelectorAll('[data-tk-complete]').forEach(b => b.onclick = act(b.dataset.tkComplete, 'complete'));
    c.querySelectorAll('[data-tk-cancel]').forEach(b => b.onclick = act(b.dataset.tkCancel, 'cancel'));
    c.querySelectorAll('[data-tk-room]').forEach(b => b.onclick = () => openTicketRoom(b.dataset.tkRoom));
    c.querySelectorAll('[data-close-post]').forEach(b => b.onclick = async () => {
      const r2 = await api(`/api/trades/${b.dataset.closePost}/close`, { method: 'POST' });
      if (r2.error) return toast(r2.error, 'error');
      renderDashTab();
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
    const w = ME.wallet;
    c.innerHTML = `
      <div class="order-card" style="justify-content:space-between">
        <div><div class="order-title">Available balance</div><div class="order-sub">Escrow releases and refunds land here. Withdraw any time (min ${money(r.min_cents || 500)}).</div></div>
        <div class="order-price" style="font-size:1.4rem;color:var(--gold)">${money(ME.site_credit_cents)}</div>
        <button class="btn btn-gold" id="open-topup">＋ Add funds</button>
        <button class="btn" id="open-send">Send</button>
        <button class="btn" id="open-withdraw">Withdraw</button>
      </div>
      <div class="wallet-card ${w ? 'connected' : ''}">
        <div class="wallet-card-main">
          <div class="wallet-ico">${w ? '🔗' : '👛'}</div>
          <div>
            <div class="order-title">${w ? 'Connected wallet' : 'No wallet connected'}</div>
            <div class="order-sub">${w
              ? `<span class="wd-badge">${CUR_LABELS[w.currency] || w.currency}</span> <span class="mono">${shortAddr(w.address)}</span> · withdrawals go straight here ⚡`
              : 'Connect a crypto wallet and withdrawals get sent straight to it — instant within the payout caps.'}</div>
          </div>
        </div>
        <div class="order-actions">
          ${w
            ? `<button class="btn btn-small btn-gold" id="wallet-payout">⚡ Withdraw to wallet</button>
               <button class="btn btn-small" id="wallet-change">Change</button>
               <button class="btn btn-small" id="wallet-disconnect" style="color:var(--danger)">Disconnect</button>`
            : `<button class="btn btn-gold" id="wallet-connect">🔗 Connect wallet</button>`}
        </div>
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
      <h3 class="section-sub">Transfers</h3>
      <div id="wallet-transfers"><div class="empty-block">Loading…</div></div>
    `;
    api('/api/my/transfers').then(tr => {
      const ts = tr.transfers || [];
      $('#wallet-transfers').innerHTML = ts.length ? `<div class="table-wrap"><table class="data">
        <tr><th></th><th>Who</th><th>Amount</th><th>When</th></tr>
        ${ts.map(t => `<tr>
          <td>${t.outgoing ? '↗ Sent' : '↘ Received'}</td>
          <td><a href="#u/${encodeURIComponent(t.outgoing ? t.recipient_name : t.sender_name)}" style="color:var(--gold-2)">${escapeHtml(t.outgoing ? t.recipient_name : t.sender_name)}</a>${t.note ? ` · <span style="color:var(--muted)">${escapeHtml(t.note)}</span>` : ''}</td>
          <td class="mono" style="color:${t.outgoing ? 'var(--danger)' : 'var(--live)'}">${t.outgoing ? '−' + money(t.amount_cents) : '+' + money(t.received_cents)}</td>
          <td>${timeAgo(t.created_at)}</td>
        </tr>`).join('')}
      </table></div>` : '<div class="empty-block">No transfers yet.</div>';
    });
    $('#open-send').onclick = openTransferModal;
    $('#open-topup').onclick = () => {
      $('#topup-amount').value = '';
      $('#topup-error').textContent = '';
      openModal('topup-overlay');
    };
    const openWithdraw = () => {
      $('#withdraw-balance').textContent = `Available: ${money(ME.site_credit_cents)} · min ${money(r.min_cents || 500)}`;
      $('#withdraw-amount').value = '';
      $('#withdraw-dest').value = '';
      $('#withdraw-error').textContent = '';
      syncWithdrawMethodUi();
      openModal('withdraw-overlay');
    };
    $('#open-withdraw').onclick = openWithdraw;
    const connectBtn = $('#wallet-connect') || $('#wallet-change');
    if (connectBtn) connectBtn.onclick = openWalletModal;
    if ($('#wallet-payout')) $('#wallet-payout').onclick = openWithdraw;
    if ($('#wallet-disconnect')) $('#wallet-disconnect').onclick = async () => {
      if (!await vaultConfirm('Withdrawals go back to asking for a destination each time.', { title: 'Disconnect this wallet?', okText: 'Disconnect', icon: '👛' })) return;
      const r2 = await api('/api/my/wallet', { method: 'DELETE' });
      if (r2.error) return toast(r2.error, 'error');
      toast('Wallet disconnected.', 'info');
      await loadMe(); renderDashTab();
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

  if (dashTab === 'developer') {
    await renderDeveloperTab(c);
    return;
  }
}

// ---------- Developer / API keys ----------
async function renderDeveloperTab(c) {
  const origin = location.origin;
  const r = await api('/api/keys');
  const keys = r.keys || [];
  c.innerHTML = `
    <div class="dev-intro">
      <div class="order-title">🔑 API keys</div>
      <div class="order-sub">Drive your account over HTTP — list items, edit prices, check orders. Send your key as a Bearer token. 60 requests/min per key.</div>
    </div>
    <div class="dev-newkey">
      <input id="dev-key-label" placeholder="Key label — e.g. my bot" maxlength="40">
      <button class="btn btn-gold" id="dev-key-create">＋ Generate key</button>
    </div>
    <div id="dev-key-reveal"></div>
    ${keys.length ? `<div class="table-wrap"><table class="data">
      <tr><th>Label</th><th>Key</th><th>Last used</th><th>Status</th><th></th></tr>
      ${keys.map(k => `<tr>
        <td>${escapeHtml(k.label)}</td>
        <td class="mono">${escapeHtml(k.prefix)}…${k.revoked ? '' : ''}</td>
        <td>${k.last_used_at ? timeAgo(k.last_used_at) : 'never'}</td>
        <td>${k.revoked ? '<span class="status-badge status-disputed">Revoked</span>' : '<span class="status-badge status-active">Active</span>'}</td>
        <td>${k.revoked ? '' : `<button class="btn btn-small" data-revoke-key="${k.id}" style="color:var(--danger)">Revoke</button>`}</td>
      </tr>`).join('')}
    </table></div>` : '<div class="empty-block" style="margin-top:14px">No keys yet — generate one to get started.</div>'}

    <h3 class="section-sub">Quick start</h3>
    <div class="dev-docs">
      <div class="dev-doc-line"><span class="dev-verb get">GET</span> <code>${origin}/api/v1/me</code> — your account + balance</div>
      <div class="dev-doc-line"><span class="dev-verb get">GET</span> <code>/api/v1/listings</code> — your active listings</div>
      <div class="dev-doc-line"><span class="dev-verb post">POST</span> <code>/api/v1/listings</code> — create a listing</div>
      <div class="dev-doc-line"><span class="dev-verb patch">PATCH</span> <code>/api/v1/listings/:id</code> — edit title/price/image</div>
      <div class="dev-doc-line"><span class="dev-verb post">POST</span> <code>/api/v1/listings/:id/close</code> — take it down</div>
      <div class="dev-doc-line"><span class="dev-verb get">GET</span> <code>/api/v1/orders</code> · <code>/api/v1/notifications</code></div>
      <pre class="dev-curl"># List an item from the command line
curl -X POST ${origin}/api/v1/listings \\
  -H "Authorization: Bearer vlt_live_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Neon Shadow Dragon","price_usd":54.99,"category":"adopt-me","image_url":"https://i.imgur.com/x.png"}'</pre>
      <div class="order-sub">Full endpoint index: <a href="/api/v1" target="_blank" style="color:var(--gold-2)">${origin}/api/v1</a></div>
    </div>`;

  $('#dev-key-create').onclick = async () => {
    const label = $('#dev-key-label').value.trim();
    const r2 = await api('/api/keys', { method: 'POST', body: JSON.stringify({ label }) });
    if (r2.error) return toast(r2.error, 'error');
    // Re-render the list (so the new key shows), then surface the one-time reveal.
    await renderDeveloperTab(c);
    $('#dev-key-reveal').innerHTML = `
      <div class="dev-reveal">
        <div class="order-title">✅ Key created — copy it now, it won't be shown again</div>
        <div class="dev-key-row"><code class="mono">${escapeHtml(r2.key)}</code><button class="btn btn-small btn-gold" id="dev-copy-key">Copy</button></div>
      </div>`;
    $('#dev-copy-key').onclick = () => navigator.clipboard.writeText(r2.key).then(() => toast('Key copied.', 'success'));
  };
  c.querySelectorAll('[data-revoke-key]').forEach(b => b.onclick = async () => {
    if (!await vaultConfirm('Any bot or script using this key stops working immediately.', { title: 'Revoke this key?', okText: 'Revoke key', danger: true, icon: '🔑' })) return;
    const r2 = await api(`/api/keys/${b.dataset.revokeKey}`, { method: 'DELETE' });
    if (r2.error) return toast(r2.error, 'error');
    toast('Key revoked.', 'info');
    renderDeveloperTab(c);
  });
}

// ---------- Withdraw modal ----------
let withdrawMethod = 'paypal';
let withdrawUseWallet = false;
const CUR_LABELS = { btc: 'BTC', eth: 'ETH', usdttrc20: 'USDT · TRC20', usdterc20: 'USDT · ERC20', ltc: 'LTC', sol: 'SOL' };
const shortAddr = (a) => a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;

function syncWithdrawMethodUi() {
  // Connected wallet takes over the destination unless the user opts out.
  withdrawUseWallet = !!(ME && ME.wallet);
  $('#withdraw-wallet-row').hidden = !withdrawUseWallet;
  $('#withdraw-manual').style.display = withdrawUseWallet ? 'none' : '';
  if (withdrawUseWallet) {
    $('#withdraw-wallet-addr').textContent = `${CUR_LABELS[ME.wallet.currency] || ME.wallet.currency} · ${shortAddr(ME.wallet.address)}`;
  }
  $('#withdraw-dest-label').textContent = withdrawMethod === 'paypal' ? 'PayPal email' : 'Wallet address';
  $('#withdraw-dest').placeholder = withdrawMethod === 'paypal' ? 'you@example.com' : 'Paste the exact address for the selected coin/network';
  $('#withdraw-currency-field').style.display = withdrawMethod === 'crypto' ? 'block' : 'none';
}
$('#withdraw-other').onclick = () => {
  withdrawUseWallet = false;
  $('#withdraw-wallet-row').hidden = true;
  $('#withdraw-manual').style.display = '';
};
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
  if (!withdrawUseWallet && !destination) { $('#withdraw-error').textContent = 'Enter where to send the money.'; return; }
  $('#withdraw-submit').disabled = true;
  const r = await api('/api/my/withdrawals', { method: 'POST', body: JSON.stringify(withdrawUseWallet
    ? { amount_cents: Math.round(amount * 100), use_wallet: true }
    : {
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

// ---------- Connect payout wallet ----------
function openWalletModal() {
  $('#wallet-error').textContent = '';
  if (ME && ME.wallet) {
    $('#wallet-address').value = ME.wallet.address;
    $('#wallet-currency').value = ME.wallet.currency;
  } else {
    $('#wallet-address').value = '';
  }
  // MetaMask (or any injected EIP-1193 provider) can fill the address itself.
  $('#wallet-metamask').hidden = !window.ethereum;
  openModal('wallet-overlay');
}

$('#wallet-metamask').onclick = async () => {
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts[0]) return toast('MetaMask didn\'t return an account.', 'error');
    $('#wallet-address').value = accounts[0];
    // An injected account is an EVM address — default to ETH, they can flip to USDT-ERC20.
    if (!['eth', 'usdterc20'].includes($('#wallet-currency').value)) $('#wallet-currency').value = 'eth';
    toast('Wallet linked from MetaMask — hit Save.', 'success');
  } catch (err) {
    toast(err && err.code === 4001 ? 'MetaMask connection was declined.' : 'Could not connect to MetaMask.', 'error');
  }
};

$('#wallet-save').onclick = async () => {
  const err = $('#wallet-error');
  err.textContent = '';
  const btn = $('#wallet-save');
  btn.classList.add('loading');
  const r = await api('/api/my/wallet', {
    method: 'PUT',
    body: JSON.stringify({ address: $('#wallet-address').value.trim(), currency: $('#wallet-currency').value }),
  });
  btn.classList.remove('loading');
  if (r.error) { err.textContent = r.error; return; }
  closeModal('wallet-overlay');
  toast('🔗 Wallet connected — withdrawals now go straight to it.', 'success');
  await loadMe();
  renderDashTab();
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

// In-flight guard: the send handler polls immediately while the 4s interval
// keeps polling — two concurrent polls read the same lastChatMessageId, fetch
// the same new messages, and render them TWICE. Belt: only one poll at a
// time. Suspenders: skip any message id we've already rendered.
let chatPollBusy = false;
async function pollChat(initial) {
  if (!activeChatOrderId || chatPollBusy) return;
  chatPollBusy = true;
  try {
    const r = await api(`/api/orders/${activeChatOrderId}/messages?after=${lastChatMessageId}`);
    if (r.error) return;
    const box = $('#chat-box');
    if (initial) box.innerHTML = '';
    const msgs = (r.messages || []).filter(m => m.id > lastChatMessageId);
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
  } finally {
    chatPollBusy = false;
  }
}

let chatSending = false;
async function sendChat() {
  const input = $('#chat-input');
  const body = input.value.trim();
  if (!body || !activeChatOrderId || chatSending) return;
  chatSending = true;
  $('#chat-send').disabled = true;
  input.value = '';
  try {
    const r = await api(`/api/orders/${activeChatOrderId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
    if (r.error) { toast(r.error, 'error'); input.value = body; return; }
    await pollChat(false);
  } finally {
    chatSending = false;
    $('#chat-send').disabled = false;
    input.focus();
  }
}
$('#chat-send').onclick = sendChat;
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ============================================================
// In-game trading (item-for-item posts + middleman tickets)
// ============================================================
const tradeState = { category: '' };

async function loadTradePosts() {
  const q = $('#trades-q').value.trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (tradeState.category) params.set('category', tradeState.category);
  const r = await api(`/api/trades?${params}`);
  const grid = $('#trades-grid');
  const posts = r.trades || [];
  if (!posts.length) {
    grid.innerHTML = `<div class="empty">No open trades${q || tradeState.category ? ' match your filters' : ' yet'}.<br><button class="btn btn-small btn-gold" style="margin-top:12px" onclick="document.getElementById('post-trade-btn').click()">Post the first trade</button></div>`;
    return;
  }
  grid.innerHTML = posts.map(t => `
    <div class="trade-card" data-id="${t.id}">
      ${t.image_url ? `<div class="trade-img" style="background-image:url('${escapeHtml(t.image_url)}')"></div>` : ''}
      <div class="trade-body">
        <div class="trade-pair">
          <div class="trade-side"><span class="trade-lbl">Has</span><b>${escapeHtml(t.offering)}</b></div>
          <span class="trade-arrow">⇄</span>
          <div class="trade-side"><span class="trade-lbl">Wants</span><b>${escapeHtml(t.wants)}</b></div>
        </div>
        ${t.notes ? `<div class="trade-notes">${escapeHtml(t.notes)}</div>` : ''}
        <div class="trade-meta">
          ${t.category !== 'other' ? `<span class="thumb-tag" style="position:static">${CATEGORY_LABELS[t.category] || t.category}</span>` : ''}
          <a class="seller-link" href="#u/${encodeURIComponent(t.username)}">${escapeHtml(t.username)}</a> ${vbadge(t.is_verified)}
          <span class="online-dot ${t.online ? '' : 'off'}"></span>
          <span style="color:var(--muted);font-size:0.74rem">· ${timeAgo(t.created_at)}</span>
        </div>
        <div class="trade-actions">
          ${ME && ME.id === t.user_id
            ? `<button class="btn btn-small" data-close-trade="${t.id}" style="color:var(--danger)">Close</button>`
            : `<button class="btn btn-small btn-gold" data-dm-trade="${escapeHtml(t.username)}">💬 Message</button>`}
          ${ME ? `<button class="btn btn-small" data-ticket="${t.id}" title="Optional — a trusted middleman holds the trade together">⚖️ Request middleman</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('[data-dm-trade]').forEach(b => b.onclick = () => {
    if (!ME) return openModal('auth-overlay');
    location.hash = 'messages/' + encodeURIComponent(b.dataset.dmTrade);
  });
  grid.querySelectorAll('[data-close-trade]').forEach(b => b.onclick = async () => {
    if (!await vaultConfirm('This removes your trade post from the board.', { title: 'Close this trade?', okText: 'Close trade', danger: true, icon: '🔁' })) return;
    const r2 = await api(`/api/trades/${b.dataset.closeTrade}/close`, { method: 'POST' });
    if (r2.error) return toast(r2.error, 'error');
    toast('Trade post closed.', 'success');
    loadTradePosts();
  });
  grid.querySelectorAll('[data-ticket]').forEach(b => b.onclick = () => {
    const post = posts.find(x => String(x.id) === String(b.dataset.ticket));
    requestTicket(post.id, post.username, ME && ME.id === post.user_id);
  });
}
$('#trades-q').addEventListener('input', debounce(loadTradePosts, 300));

async function requestTicket(postId, ownerName, iAmOwner) {
  if (!ME) return openModal('auth-overlay');
  // The partner is obvious when you're on someone else's post — it's the
  // poster. Owners name whoever they matched with in DMs.
  let partner;
  if (iAmOwner) {
    partner = await vaultPrompt('Who did you match with? A random ONLINE middleman is assigned — if they don\'t respond in 2 minutes it rotates. Middlemen are optional; you can always trade directly in game.', { title: '⚖️ Request a middleman', placeholder: 'Trade partner\'s username', okText: 'Next', icon: '⚖️' });
    if (partner === null) return;
    if (!partner) return toast('Enter your trade partner\'s username.', 'error');
  } else {
    partner = ownerName;
  }
  // Optional tip — informational only, shown to the middleman as a promise
  // of gratitude. Nothing is held or charged.
  const tipRaw = await vaultPrompt(`Trading with ${partner}. Optionally promise the middleman a tip as a way to show gratitude — it's just shown to them with the request, you settle it yourselves. Leave empty to skip.`, { title: '💰 Tip the middleman?', placeholder: 'e.g. 2.00 — optional, leave empty to skip', okText: '⚖️ Find middleman', icon: '⚖️' });
  if (tipRaw === null) return;
  let tip_cents;
  if (tipRaw !== '') {
    const dollars = parseFloat(tipRaw);
    if (!isFinite(dollars) || dollars < 0) return toast('Enter a valid tip amount, or leave it empty.', 'error');
    tip_cents = Math.round(dollars * 100);
  }
  const r = await api(`/api/trades/${postId}/ticket`, { method: 'POST', body: JSON.stringify({ partner, tip_cents }) });
  if (r.error && !r.id) return toast(r.error, 'error');
  if (r.error) return toast(r.error, 'info');
  toast(`⚖️ ${r.middleman} was requested${tip_cents ? ` with a ${money(tip_cents)} tip promised` : ''} — you'll be notified when they accept.`, 'success');
}

// Post-a-trade modal
$('#post-trade-btn').onclick = () => {
  if (!ME) return openModal('auth-overlay');
  ['trade-offering','trade-wants','trade-notes','trade-image'].forEach(id => $('#' + id).value = '');
  $('#trade-error').textContent = '';
  const draft = restoreDraft('vault-trade-draft', TRADE_DRAFT_FIELDS);
  if (draft) {
    if (draft.category) $('#trade-category').value = draft.category;
    toast('Draft restored — pick up where you left off.', 'info');
  }
  openModal('trade-overlay');
};
$('#trade-submit').onclick = async () => {
  const offering = $('#trade-offering').value.trim();
  const wants = $('#trade-wants').value.trim();
  if (!offering || !wants) { $('#trade-error').textContent = 'Fill in what you have and what you want.'; return; }
  $('#trade-submit').classList.add('loading');
  const r = await api('/api/trades', { method: 'POST', body: JSON.stringify({
    offering, wants,
    category: $('#trade-category').value,
    notes: $('#trade-notes').value.trim() || undefined,
    image_url: $('#trade-image').value.trim() || undefined,
  }) });
  $('#trade-submit').classList.remove('loading');
  if (r.error) { $('#trade-error').textContent = r.error; return; }
  closeModal('trade-overlay');
  localStorage.removeItem('vault-trade-draft');
  toast('Trade posted — traders will DM you with offers.', 'success');
  loadTradePosts();
};

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
          <div class="trader-name">${escapeHtml(t.username)} ${vbadge(t.is_verified)}${probadge(t.pro)} <span class="online-dot ${t.online ? '' : 'off'}" title="${t.online ? 'Online' : 'Offline'}"></span></div>
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
    if (m.id <= lastDmId) return; // already rendered (concurrent poll race)
    lastDmId = Math.max(lastDmId, m.id);
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (m.sender_id === ME.id ? 'mine' : 'theirs');
    el.innerHTML = `${escapeHtml(m.body)}<div class="m-meta">${timeAgo(m.created_at)}</div>`;
    box.appendChild(el);
  });
  if (msgs.length) box.scrollTop = box.scrollHeight;
}

let dmPollBusy = false;
async function pollDm() {
  if (!activeDmPartner || dmPollBusy) return;
  dmPollBusy = true;
  try {
    const r = await api(`/api/dm/with/${encodeURIComponent(activeDmPartner)}?after=${lastDmId}`);
    if (r.error) return;
    const fresh = (r.messages || []).filter(m => m.id > lastDmId);
    if (fresh.length) { renderDmMessages(fresh, false); loadConversations(); }
  } finally {
    dmPollBusy = false;
  }
}

let dmSending = false;
async function sendDm() {
  const input = $('#dm-input');
  const body = input.value.trim();
  if (!body || !activeDmPartner || dmSending) return;
  dmSending = true;
  const btn = $('#dm-send');
  if (btn) btn.disabled = true;
  input.value = '';
  try {
    const r = await api(`/api/dm/with/${encodeURIComponent(activeDmPartner)}`, { method: 'POST', body: JSON.stringify({ body }) });
    if (r.error) { toast(r.error, 'error'); input.value = body; return; }
    await pollDm();
    loadConversations();
  } finally {
    dmSending = false;
    if (btn) btn.disabled = false;
    input.focus();
  }
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
// Middleman ticket room — one shared thread for both traders + the MM
// ============================================================
let ticketPollBusy = false;

async function openTicketRoom(ticketId) {
  activeTicketId = ticketId;
  lastTicketMsgId = 0;
  $('#ticket-box').innerHTML = '<div class="chat-empty">Loading…</div>';
  openModal('ticket-overlay');
  await pollTicketRoom(true);
  clearInterval(ticketPollTimer);
  ticketPollTimer = setInterval(() => pollTicketRoom(false), 4000);
}

async function pollTicketRoom(initial) {
  if (!activeTicketId || ticketPollBusy) return;
  ticketPollBusy = true;
  try {
    const r = await api(`/api/mm/tickets/${activeTicketId}/messages?after=${lastTicketMsgId}`);
    if (r.error) { if (initial) $('#ticket-box').innerHTML = `<div class="chat-empty">${escapeHtml(r.error)}</div>`; return; }
    if (initial) {
      const t = r.ticket;
      $('#ticket-title').textContent = `Ticket #${t.id} room`;
      $('#ticket-sub').innerHTML = `${escapeHtml(t.requester_name)} + ${escapeHtml(t.partner_name)}${t.middleman_name ? ` · Middleman <b>${escapeHtml(t.middleman_name)}</b>` : ''} · <span class="status-badge status-${t.status === 'active' ? 'active' : t.status === 'completed' ? 'completed' : 'paid'}">${t.status}</span>`;
      $('#ticket-input-row').style.display = ['assigned', 'active'].includes(t.status) ? 'flex' : 'none';
      $('#ticket-box').innerHTML = '';
    }
    const box = $('#ticket-box');
    const msgs = (r.messages || []).filter(m => m.id > lastTicketMsgId);
    if (initial && !msgs.length) {
      box.innerHTML = '<div class="chat-empty">The room is open — everyone in this ticket sees every message. Agree on a server link and trade order here.</div>';
      return;
    }
    if (msgs.length && box.querySelector('.chat-empty')) box.innerHTML = '';
    msgs.forEach(m => {
      lastTicketMsgId = Math.max(lastTicketMsgId, m.id);
      const el = document.createElement('div');
      el.className = 'chat-msg ' + (m.mine ? 'mine' : 'theirs') + (m.from_mm ? ' from-mm' : '');
      el.innerHTML = `${escapeHtml(m.body)}<div class="m-meta">${m.from_mm ? '⚖️ ' : ''}${escapeHtml(m.sender_name)} · ${timeAgo(m.created_at)}</div>`;
      box.appendChild(el);
    });
    if (msgs.length) box.scrollTop = box.scrollHeight;
  } finally {
    ticketPollBusy = false;
  }
}

let ticketSending = false;
async function sendTicketMsg() {
  const input = $('#ticket-input');
  const body = input.value.trim();
  if (!body || !activeTicketId || ticketSending) return;
  ticketSending = true;
  $('#ticket-send').disabled = true;
  input.value = '';
  try {
    const r = await api(`/api/mm/tickets/${activeTicketId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
    if (r.error) { toast(r.error, 'error'); input.value = body; return; }
    await pollTicketRoom(false);
  } finally {
    ticketSending = false;
    $('#ticket-send').disabled = false;
    input.focus();
  }
}
$('#ticket-send').onclick = sendTicketMsg;
$('#ticket-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTicketMsg(); });

// ============================================================
// Tournaments
// ============================================================
function prizeBadge(t) {
  if (t.prize_mode === 'mm_held') {
    return `<span class="prize-badge held" title="${t.middleman_name ? 'Prize held by middleman ' + escapeHtml(t.middleman_name) : 'A middleman will be assigned to hold the prize'}">🛡 Guaranteed payout</span>`;
  }
  if (t.prize_mode === 'unheld') return '<span class="prize-badge unheld" title="The host holds the prize — payout is not guaranteed by Vault">⚠ Not held — no guarantee</span>';
  return '<span class="prize-badge fun">🎉 Just for fun</span>';
}

async function loadTournaments() {
  const grid = $('#tourney-grid');
  const r = await api('/api/tournaments');
  const ts = r.tournaments || [];
  if (!ts.length) {
    grid.innerHTML = '<div class="empty-block">No tournaments yet — host the first one and get people together!</div>';
    return;
  }
  const statusBadge = (t) => t.status === 'open'
    ? `<span class="status-badge status-active">Signups open</span>`
    : t.status === 'ongoing' ? '<span class="status-badge status-paid">Ongoing</span>'
    : t.status === 'completed' ? '<span class="status-badge status-completed">Finished</span>'
    : '<span class="status-badge status-disputed">Cancelled</span>';
  grid.innerHTML = ts.map(t => {
    const mine = ME && t.host_id === ME.id;
    const canJoin = ME && t.status === 'open' && !t.joined && t.player_count < t.player_limit;
    const full = t.status === 'open' && t.player_count >= t.player_limit;
    return `
    <div class="tourney-card ${t.status}">
      <div class="tc-top">
        <div class="tc-title">${escapeHtml(t.title)} ${catTag(t.category)}</div>
        ${statusBadge(t)}
      </div>
      <div class="tc-host">Hosted by <a href="#u/${encodeURIComponent(t.host_name)}">${escapeHtml(t.host_name)}</a>${vbadge(t.host_verified)}${probadge(t.host_pro)}${t.middleman_name ? ` · Prize with <b>${escapeHtml(t.middleman_name)}</b> ⚖️` : ''}</div>
      ${t.description ? `<div class="tc-desc">${escapeHtml(t.description)}</div>` : ''}
      <div class="tc-prize">${t.prize ? `<span class="tc-prize-text">🏆 ${escapeHtml(t.prize)}</span>` : ''}${prizeBadge(t)}</div>
      <div class="tc-meta">
        <span>👥 ${t.player_count}/${t.player_limit} players</span>
        ${t.status === 'open' ? `<span>⏳ Signups close in <b data-ends="${t.signups_close_at}"></b></span>` : ''}
      </div>
      <div class="tc-actions">
        ${canJoin ? `<button class="btn btn-small btn-gold" data-tjoin="${t.id}">Sign up</button>` : ''}
        ${full && !t.joined ? '<span class="sub" style="margin:0">Full</span>' : ''}
        ${ME && t.joined && !mine && t.status === 'open' ? `<button class="btn btn-small" data-tleave="${t.id}">Leave</button>` : ''}
        ${t.joined && t.status === 'open' ? '<span class="tc-in">✓ You\'re in — chat opens at the deadline</span>' : ''}
        ${(t.joined || (ME && (ME.is_admin || t.middleman_id === ME.id))) && ['ongoing','completed'].includes(t.status) ? `<button class="btn btn-small btn-gold" data-tchat="${t.id}">💬 Group chat</button>` : ''}
        ${mine && ['open','ongoing'].includes(t.status) ? `<button class="btn btn-small" data-tcancel="${t.id}" style="color:var(--danger)">Cancel</button>` : ''}
        ${mine && t.status === 'ongoing' ? `<button class="btn btn-small" data-tcomplete="${t.id}">Mark finished</button>` : ''}
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-tjoin]').forEach(b => b.onclick = async () => {
    if (!ME) return openModal('auth-overlay');
    b.disabled = true;
    const r2 = await api(`/api/tournaments/${b.dataset.tjoin}/join`, { method: 'POST' });
    if (r2.error) { toast(r2.error, 'error'); b.disabled = false; return; }
    toast("You're signed up — the group chat opens when signups close.", 'success');
    loadTournaments();
  });
  grid.querySelectorAll('[data-tleave]').forEach(b => b.onclick = async () => {
    const r2 = await api(`/api/tournaments/${b.dataset.tleave}/leave`, { method: 'POST' });
    if (r2.error) return toast(r2.error, 'error');
    toast('You left the tournament.', 'info');
    loadTournaments();
  });
  grid.querySelectorAll('[data-tcancel]').forEach(b => b.onclick = async () => {
    if (!await vaultConfirm('Everyone who signed up will be notified.', { title: 'Cancel this tournament?', okText: 'Cancel tournament', danger: true, icon: '🏆' })) return;
    const r2 = await api(`/api/tournaments/${b.dataset.tcancel}/cancel`, { method: 'POST' });
    if (r2.error) return toast(r2.error, 'error');
    toast('Tournament cancelled.', 'info');
    loadTournaments();
  });
  grid.querySelectorAll('[data-tcomplete]').forEach(b => b.onclick = async () => {
    if (!await vaultConfirm('Players get a wrap-up notification and the chat goes read-only.', { title: 'Finish this tournament?', okText: 'Mark finished', icon: '🏆' })) return;
    const r2 = await api(`/api/tournaments/${b.dataset.tcomplete}/complete`, { method: 'POST' });
    if (r2.error) return toast(r2.error, 'error');
    toast('Tournament finished — nice one! 🏆', 'success');
    loadTournaments();
  });
  grid.querySelectorAll('[data-tchat]').forEach(b => b.onclick = () => openTourneyChat(parseInt(b.dataset.tchat, 10)));
}

// ---- Hosting ----
$('#host-tourney-btn').addEventListener('click', () => {
  if (!ME) return openModal('auth-overlay');
  $('#tourney-error').textContent = '';
  openModal('tourney-overlay');
});
$('#tourney-prize-mode').addEventListener('change', () => {
  $('#tourney-prize-field').style.display = $('#tourney-prize-mode').value === 'none' ? 'none' : 'block';
});
$('#tourney-submit').addEventListener('click', async () => {
  const err = $('#tourney-error');
  err.textContent = '';
  const btn = $('#tourney-submit');
  btn.classList.add('loading');
  const r = await api('/api/tournaments', {
    method: 'POST',
    body: JSON.stringify({
      title: $('#tourney-title').value.trim(),
      description: $('#tourney-desc').value.trim(),
      category: $('#tourney-category').value,
      prize_mode: $('#tourney-prize-mode').value,
      prize: $('#tourney-prize').value.trim(),
      player_limit: parseInt($('#tourney-limit').value, 10),
      close_hours: parseInt($('#tourney-close').value, 10),
    }),
  });
  btn.classList.remove('loading');
  if (r.error) { err.textContent = r.error; return; }
  closeModal('tourney-overlay');
  $('#tourney-title').value = ''; $('#tourney-desc').value = ''; $('#tourney-prize').value = '';
  toast('Tournament is live — signups are open!', 'success');
  location.hash = 'tournaments';
  loadTournaments();
});

// ---- Group chat ----
let tchatPollBusy = false;
async function openTourneyChat(id) {
  activeTourneyId = id;
  lastTchatMsgId = 0;
  $('#tchat-box').innerHTML = '<div class="chat-empty">Loading…</div>';
  openModal('tchat-overlay');
  await pollTourneyChat(true);
  clearInterval(tchatPollTimer);
  tchatPollTimer = setInterval(() => pollTourneyChat(false), 4000);
}

async function pollTourneyChat(initial) {
  if (!activeTourneyId || tchatPollBusy) return;
  tchatPollBusy = true;
  try {
    const r = await api(`/api/tournaments/${activeTourneyId}/messages?after=${lastTchatMsgId}`);
    if (r.error) { if (initial) $('#tchat-box').innerHTML = `<div class="chat-empty">${escapeHtml(r.error)}</div>`; return; }
    if (initial) {
      const t = r.tournament;
      $('#tchat-title').textContent = t.title;
      $('#tchat-sub').innerHTML = `Hosted by <b>${escapeHtml(t.host_name)}</b> · ${t.player_count} players${t.middleman_name ? ` · Prize with <b>${escapeHtml(t.middleman_name)}</b> ⚖️` : ''}${t.prize ? ` · 🏆 ${escapeHtml(t.prize)}` : ''}`;
      $('#tchat-input-row').style.display = t.status === 'ongoing' ? 'flex' : 'none';
      $('#tchat-box').innerHTML = '';
    }
    const box = $('#tchat-box');
    const msgs = (r.messages || []).filter(m => m.id > lastTchatMsgId);
    if (initial && !msgs.length) {
      box.innerHTML = '<div class="chat-empty">The chat is open — say hi, agree on rules, and set up the bracket.</div>';
      return;
    }
    if (msgs.length && box.querySelector('.chat-empty')) box.innerHTML = '';
    msgs.forEach(m => {
      lastTchatMsgId = Math.max(lastTchatMsgId, m.id);
      const el = document.createElement('div');
      el.className = 'chat-msg ' + (m.mine ? 'mine' : 'theirs') + (m.from_mm ? ' from-mm' : '');
      const tag = m.from_host ? '👑 ' : m.from_mm ? '⚖️ ' : '';
      el.innerHTML = `${escapeHtml(m.body)}<div class="m-meta">${tag}${escapeHtml(m.sender_name)} · ${timeAgo(m.created_at)}</div>`;
      box.appendChild(el);
    });
    if (msgs.length) box.scrollTop = box.scrollHeight;
  } finally {
    tchatPollBusy = false;
  }
}

let tchatSending = false;
async function sendTchatMsg() {
  const input = $('#tchat-input');
  const body = input.value.trim();
  if (!body || !activeTourneyId || tchatSending) return;
  tchatSending = true;
  $('#tchat-send').disabled = true;
  input.value = '';
  try {
    const r = await api(`/api/tournaments/${activeTourneyId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
    if (r.error) { toast(r.error, 'error'); input.value = body; return; }
    await pollTourneyChat(false);
  } finally {
    tchatSending = false;
    $('#tchat-send').disabled = false;
    input.focus();
  }
}
$('#tchat-send').onclick = sendTchatMsg;
$('#tchat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTchatMsg(); });

// ============================================================
// Announcement banner (dismiss sticks per announcement id)
// ============================================================
async function loadAnnouncementBanner() {
  const r = await api('/api/announcements/latest');
  const a = r.announcement;
  const banner = $('#announce-banner');
  if (!a) { banner.hidden = true; return; }
  const dismissed = parseInt(localStorage.getItem('vault-ann-dismissed') || '0', 10);
  if (a.id <= dismissed) { banner.hidden = true; return; }
  $('#announce-text').textContent = a.message;
  banner.dataset.annId = a.id;
  banner.hidden = false;
}
$('#announce-close').addEventListener('click', () => {
  const banner = $('#announce-banner');
  localStorage.setItem('vault-ann-dismissed', banner.dataset.annId || '0');
  banner.hidden = true;
});

// ============================================================
// Vault Pro
// ============================================================
async function openProModal() {
  if (!ME) return openModal('auth-overlay');
  $('#pro-error').textContent = '';
  const r = await api('/api/pro');
  if (r.error) return toast(r.error, 'error');
  $('#pro-price').textContent = money(r.price_cents);
  $('#pro-fee-line').textContent = `${(r.pro_fee_bps / 100).toFixed(0)}% instead of ${(r.fee_bps / 100).toFixed(0)}% on everything you buy — heavy buyers earn it back fast.`;
  const status = $('#pro-status');
  if (r.active) {
    status.hidden = false;
    status.innerHTML = `⭐ <b>You're Pro!</b> Active until <b>${new Date(r.until).toLocaleDateString()}</b> — subscribing again adds ${r.days} more days.`;
    $('#pro-renew-row').hidden = false;
    const tgl = $('#pro-renew-toggle');
    tgl.classList.toggle('on', r.auto_renew);
    tgl.setAttribute('aria-checked', String(r.auto_renew));
  } else {
    status.hidden = true;
    $('#pro-renew-row').hidden = true;
  }
  openModal('pro-overlay');
}

$('#pro-crypto').onclick = () => {
  pendingCryptoContext = { kind: 'pro' };
  openModal('currency-overlay');
};
$('#pro-balance').onclick = async () => {
  const btn = $('#pro-balance');
  btn.classList.add('loading');
  const r = await api('/api/pro/subscribe', { method: 'POST', body: JSON.stringify({ method: 'balance' }) });
  btn.classList.remove('loading');
  if (r.error) { $('#pro-error').textContent = r.error; return; }
  closeModal('pro-overlay');
  toast('⭐ Welcome to Vault Pro — your reduced fee is live!', 'success');
  await loadMe();
  loadListings(); loadAuctions();
};
$('#pro-renew-toggle').onclick = async () => {
  const tgl = $('#pro-renew-toggle');
  const enable = !tgl.classList.contains('on');
  const r = await api('/api/pro/auto-renew', { method: 'POST', body: JSON.stringify({ enabled: enable }) });
  if (r.error) return toast(r.error, 'error');
  tgl.classList.toggle('on', r.auto_renew);
  tgl.setAttribute('aria-checked', String(r.auto_renew));
  toast(r.auto_renew ? 'Auto-renew is on — renews from your site balance.' : 'Auto-renew turned off.', 'info');
};

// One-time promo popup after signing in (per browser, until they've seen it).
function maybeShowProPromo() {
  if (!ME || (ME.pro && ME.pro.active)) return;
  if (localStorage.getItem('vault-pro-promo-v1')) return;
  localStorage.setItem('vault-pro-promo-v1', '1');
  setTimeout(openProModal, 800); // let the page settle first
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
        <h2>${escapeHtml(u.username)} ${vbadge(u.is_verified)}${probadge(u.pro)} <span class="online-dot ${u.online ? '' : 'off'}" title="${u.online ? 'Online' : 'Offline'}"></span> ${u.is_banned ? '<span class="status-badge status-disputed">Banned</span>' : ''} ${isMe && ME.profile_hidden ? '<span class="status-badge">🔒 Hidden</span>' : ''}</h2>
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
    <div class="stat-card"><div class="val">${r.new_users_7d || 0}</div><div class="lbl">New users · 7d</div></div>
    <div class="stat-card"><div class="val">${r.trades_7d || 0}</div><div class="lbl">Sales · 7d</div></div>
    <div class="stat-card"><div class="val gold">${money(r.volume_7d_cents || 0)}</div><div class="lbl">Volume · 7d</div></div>
  `;
  $('#tc-reports').textContent = r.open_reports || '';
  api('/api/admin/middlemen').then(m => { $('#tc-mm').textContent = (m.pending || []).length || ''; });
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
      <h3 class="section-sub" style="margin-top:0">Game categories</h3>
      <div class="inline-note" style="margin-top:0">The Roblox market moves fast — add or remove games here and every picker, filter, and tag updates instantly. Items in a removed game move to <b>Other</b>.</div>
      <div class="cat-chips" id="admin-cat-list" style="margin-bottom:10px"></div>
      <div class="search-bar" style="margin-bottom:22px">
        <input id="admin-cat-name" placeholder="Game name, e.g. Fisch" maxlength="40" style="flex:1;background:rgba(10,13,20,0.6);border:1px solid var(--border);color:var(--text);padding:10px 12px;border-radius:9px;font-size:0.88rem">
        <button class="btn btn-gold" id="admin-cat-add">+ Add game</button>
      </div>
      <h3 class="section-sub">Live content</h3>
      <div class="search-bar" style="margin-bottom:14px"><div class="search-input-wrap" style="flex:1">
        <input type="search" id="admin-content-q" placeholder="Search live listings & auctions…" autocomplete="off" style="width:100%">
      </div></div>
      <div id="admin-content-list"></div>`;

    const renderCats = async () => {
      const rc = await api('/api/categories');
      $('#admin-cat-list').innerHTML = (rc.categories || []).map(cat => `
        <span class="cat-chip active" style="display:inline-flex;align-items:center;gap:7px">${escapeHtml(cat.label)}
          ${cat.slug !== 'other' ? `<button data-del-cat="${escapeHtml(cat.slug)}" title="Remove" style="background:none;border:none;color:rgba(255,255,255,0.7);font-size:0.72rem;padding:0;cursor:pointer">✕</button>` : ''}
        </span>`).join('');
      $('#admin-cat-list').querySelectorAll('[data-del-cat]').forEach(b => b.onclick = async () => {
        const slug = b.dataset.delCat;
        if (!await vaultConfirm(`Every listing, auction, and trade post in "${CATEGORY_LABELS[slug] || slug}" moves to Other.`, { title: 'Remove this category?', okText: 'Remove', danger: true, icon: '🏷' })) return;
        const r2 = await api(`/api/admin/categories/${encodeURIComponent(slug)}/delete`, { method: 'POST' });
        if (r2.error) return toast(r2.error, 'error');
        toast('Category removed.', 'success');
        await loadCategories();
        renderCats();
      });
    };
    $('#admin-cat-add').onclick = async () => {
      const label = $('#admin-cat-name').value.trim();
      if (!label) return toast('Enter the game name.', 'error');
      const r2 = await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ label }) });
      if (r2.error) return toast(r2.error, 'error');
      $('#admin-cat-name').value = '';
      toast(`"${r2.label}" added — it's live in every picker now.`, 'success');
      await loadCategories();
      renderCats();
    };
    $('#admin-cat-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#admin-cat-add').click(); });
    renderCats();
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

  if (adminTab === 'middlemen') {
    const r = await api('/api/admin/middlemen');
    const pending = r.pending || [], approved = r.approved || [];
    let html = `<h3 class="section-sub" style="margin-top:0">Applications</h3>`;
    html += pending.length ? `<div class="order-list">` + pending.map(u => `
      <div class="order-card">
        <div class="order-main">
          <div class="order-title"><a href="#u/${encodeURIComponent(u.username)}" style="color:var(--gold)">${escapeHtml(u.username)}</a></div>
          <div class="order-sub">Member ${timeAgo(u.created_at)}</div>
        </div>
        <div class="order-actions">
          <button class="btn btn-small btn-gold" data-mm-approve="${u.id}">✓ Approve</button>
          <button class="btn btn-small" data-mm-reject="${u.id}" style="color:var(--danger)">Reject</button>
        </div>
      </div>`).join('') + `</div>` : `<div class="empty-block">No pending applications.</div>`;
    html += `<h3 class="section-sub">Approved middlemen</h3>`;
    html += approved.length ? `<div class="order-list">` + approved.map(u => `
      <div class="order-card">
        <div class="order-main">
          <div class="order-title">⚖️ <a href="#u/${encodeURIComponent(u.username)}" style="color:var(--gold)">${escapeHtml(u.username)}</a></div>
          <div class="order-sub">${u.completed_tickets} completed ticket${u.completed_tickets === 1 ? '' : 's'}</div>
        </div>
        <div class="order-actions"><button class="btn btn-small" data-mm-revoke="${u.id}" style="color:var(--danger)">Revoke</button></div>
      </div>`).join('') + `</div>` : `<div class="empty-block">No approved middlemen yet.</div>`;
    c.innerHTML = html;
    const mmAct = (id, action) => async () => {
      if (action === 'revoke' && !await vaultConfirm('They stop receiving middleman tickets immediately.', { title: 'Revoke middleman status?', okText: 'Revoke', danger: true, icon: '⚖️' })) return;
      const r2 = await api(`/api/admin/middlemen/${id}`, { method: 'POST', body: JSON.stringify({ action }) });
      if (r2.error) return toast(r2.error, 'error');
      toast('Done.', 'success');
      loadAdmin();
    };
    c.querySelectorAll('[data-mm-approve]').forEach(b => b.onclick = mmAct(b.dataset.mmApprove, 'approve'));
    c.querySelectorAll('[data-mm-reject]').forEach(b => b.onclick = mmAct(b.dataset.mmReject, 'reject'));
    c.querySelectorAll('[data-mm-revoke]').forEach(b => b.onclick = mmAct(b.dataset.mmRevoke, 'revoke'));
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
          <td><a href="#u/${encodeURIComponent(u.username)}" style="color:var(--gold)">${escapeHtml(u.username)}</a> ${vbadge(u.is_verified)}${probadge(u.is_pro)}${u.is_admin ? ' 🛡' : ''}</td>
          <td class="mono">${money(u.site_credit_cents)}</td>
          <td>${timeAgo(u.created_at)}</td>
          <td>${u.is_banned ? '<span class="status-badge status-disputed">Banned</span>' : '<span class="status-badge status-active">Active</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-small btn-gold" data-credit="${u.id}" data-name="${escapeHtml(u.username)}">＋ Credit</button>
            <button class="btn btn-small" data-verify="${u.id}">${u.is_verified ? 'Unverify' : '✓ Verify'}</button>
            ${u.is_pro ? `<button class="btn btn-small" data-prorevoke="${u.id}" data-name="${escapeHtml(u.username)}" style="color:var(--danger)">Revoke Pro</button>` : ''}
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
      $('#admin-users-table').querySelectorAll('[data-prorevoke]').forEach(b => b.onclick = async () => {
        if (!await vaultConfirm(`${b.dataset.name} loses their Pro perks immediately — no refund is issued automatically.`, { title: 'Revoke Vault Pro?', okText: 'Revoke Pro', danger: true, icon: '⭐' })) return;
        const r2 = await api(`/api/admin/users/${b.dataset.prorevoke}/pro-revoke`, { method: 'POST' });
        if (r2.error) return toast(r2.error, 'error');
        toast('Pro subscription revoked.', 'success');
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

  if (adminTab === 'log') {
    const [r, ra] = await Promise.all([api('/api/admin/log'), api('/api/admin/announcements')]);
    const anns = ra.announcements || [];
    const annBlock = `
      <h3 class="section-sub" style="margin-top:0">Announcements</h3>
      ${anns.length ? `<div class="order-list" style="margin-bottom:22px">${anns.map(a => `
        <div class="order-card">
          <div class="order-main">
            <div class="order-title">📣 ${escapeHtml(a.message)}</div>
            <div class="order-sub">${escapeHtml(a.admin_name)} · ${timeAgo(a.created_at)}</div>
          </div>
          <div class="order-actions"><button class="btn btn-small" data-del-ann="${a.id}" style="color:var(--danger)">Delete</button></div>
        </div>`).join('')}</div>`
        : '<div class="inline-note" style="margin-bottom:22px">No announcements yet — the 📣 button up top sends one to every member.</div>'}
      <h3 class="section-sub">Audit log</h3>`;
    const rows = r.log || [];
    if (!rows.length) {
      c.innerHTML = annBlock + '<div class="empty-block">No admin actions recorded yet.</div>';
    }
    const label = (a) => ({
      dispute_resolved: 'Dispute resolved', payout_sent: 'Payout sent', withdrawal_paid: 'Withdrawal marked paid',
      withdrawal_rejected: 'Withdrawal rejected', user_banned: 'User banned', user_unbanned: 'User unbanned',
      credit_adjusted: 'Balance adjusted', user_verified: 'User verified', user_unverified: 'Badge removed',
      category_added: 'Category added', category_removed: 'Category removed', middleman_approve: 'Middleman approved',
      middleman_reject: 'Middleman rejected', middleman_revoke: 'Middleman revoked', report_resolved: 'Report resolved',
      listing_removed: 'Listing removed', auction_removed: 'Auction removed', announcement: 'Announcement sent',
      announcement_deleted: 'Announcement deleted', pro_revoked: 'Pro revoked',
    })[a] || a;
    if (rows.length) {
      c.innerHTML = annBlock + `
        <div class="inline-note" style="margin-top:0">Every admin action is recorded here — the most recent 200 entries.</div>
        <div class="table-wrap"><table class="data">
          <tr><th>When</th><th>Admin</th><th>Action</th><th>Detail</th></tr>
          ${rows.map(l => `<tr>
            <td style="white-space:nowrap">${timeAgo(l.created_at)}</td>
            <td><a href="#u/${encodeURIComponent(l.admin_name)}" style="color:var(--gold)">${escapeHtml(l.admin_name)}</a></td>
            <td style="white-space:nowrap">${escapeHtml(label(l.action))}</td>
            <td style="max-width:420px;overflow-wrap:anywhere;color:var(--text-dim)">${escapeHtml(l.detail || '')}</td>
          </tr>`).join('')}
        </table></div>`;
    }
    c.querySelectorAll('[data-del-ann]').forEach(b => b.onclick = async () => {
      if (!await vaultConfirm('The banner disappears for everyone and unread 📣 notifications are withdrawn.', { title: 'Delete this announcement?', okText: 'Delete announcement', danger: true, icon: '📣' })) return;
      const r2 = await api(`/api/admin/announcements/${b.dataset.delAnn}`, { method: 'DELETE' });
      if (r2.error) return toast(r2.error, 'error');
      toast('Announcement deleted.', 'success');
      loadAnnouncementBanner();
      renderAdminTab();
    });
    return;
  }
}

$('#admin-announce').addEventListener('click', async () => {
  const msg = await vaultPrompt('Sent as a notification to every member of the site — keep it short.', {
    title: 'Site-wide announcement', okText: 'Next', placeholder: 'e.g. Middleman applications are open this weekend!', icon: '📣',
  });
  if (msg === null) return;
  const text = msg.trim();
  if (!text) return toast('Announcement can\'t be empty.', 'error');
  if (!await vaultConfirm(`“${text}” — this notifies every user (you can delete it later from the Log tab).`, { title: 'Send to everyone?', okText: '📣 Send announcement', icon: '📣' })) return;
  const r = await api('/api/admin/announce', { method: 'POST', body: JSON.stringify({ message: text }) });
  if (r.error) return toast(r.error, 'error');
  toast(`Announcement sent to ${r.recipients} users.`, 'success');
  if (adminTab === 'log') renderAdminTab();
});

// ============================================================
// Looking For (want-to-buy board)
// ============================================================
const wantedState = { category: '' };

async function loadWanted() {
  const grid = $('#wanted-grid');
  const params = new URLSearchParams();
  if (wantedState.category) params.set('category', wantedState.category);
  const r = await api('/api/wanted?' + params);
  const rows = r.wanted || [];
  if (!rows.length) {
    grid.innerHTML = '<div class="empty-block">Nobody\'s hunting anything here yet — post the first request.</div>';
    return;
  }
  grid.innerHTML = rows.map(w => `
    <div class="wanted-card">
      <div class="wc-item">🔎 ${escapeHtml(w.item)} ${catTag(w.category)}</div>
      ${w.budget_cents ? `<div class="wc-budget">Paying up to ${money(w.budget_cents)}</div>` : ''}
      ${w.notes ? `<div class="wc-notes">${escapeHtml(w.notes)}</div>` : ''}
      <div class="wc-foot">
        <span><a href="#u/${encodeURIComponent(w.username)}">${escapeHtml(w.username)}</a>${vbadge(w.is_verified)}${probadge(w.pro)} · ${timeAgo(w.created_at)}</span>
        ${ME && ME.id === w.user_id
          ? `<button class="btn btn-small" data-wclose="${w.id}">Close</button>`
          : `<button class="btn btn-small btn-gold" data-wdm="${escapeHtml(w.username)}">I have this</button>`}
      </div>
    </div>`).join('');
  grid.querySelectorAll('[data-wdm]').forEach(b => b.onclick = () => {
    if (!ME) return openModal('auth-overlay');
    location.hash = 'messages/' + encodeURIComponent(b.dataset.wdm);
  });
  grid.querySelectorAll('[data-wclose]').forEach(b => b.onclick = async () => {
    const r2 = await api(`/api/wanted/${b.dataset.wclose}/close`, { method: 'POST' });
    if (r2.error) return toast(r2.error, 'error');
    toast('Request closed — happy hunting.', 'success');
    loadWanted();
  });
}

$('#post-wanted-btn').addEventListener('click', () => {
  if (!ME) return openModal('auth-overlay');
  $('#wanted-error').textContent = '';
  openModal('wanted-overlay');
});
$('#wanted-submit').addEventListener('click', async () => {
  const err = $('#wanted-error');
  err.textContent = '';
  const budgetRaw = $('#wanted-budget').value.trim();
  const r = await api('/api/wanted', {
    method: 'POST',
    body: JSON.stringify({
      item: $('#wanted-item').value.trim(),
      category: $('#wanted-category').value,
      budget_cents: budgetRaw ? Math.round(parseFloat(budgetRaw) * 100) : null,
      notes: $('#wanted-notes').value.trim(),
    }),
  });
  if (r.error) { err.textContent = r.error; return; }
  closeModal('wanted-overlay');
  $('#wanted-item').value = ''; $('#wanted-budget').value = ''; $('#wanted-notes').value = '';
  toast('Request posted — sellers who have it will DM you.', 'success');
  loadWanted();
});

// ============================================================
// Game pulse — volume + demand per game
// ============================================================
// A ranked horizontal bar chart: one measure (volume), one hue, value
// labels at the bar ends, live/looking as muted sub-text per row.
async function loadGameStats() {
  const r = await api('/api/game-stats');
  const games = (r.games || []).filter(g => g.volume_30d_cents || g.items_live || g.looking_count);
  const sec = $('#game-pulse-section');
  if (!games.length) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  const max = Math.max(...games.map(g => g.volume_30d_cents), 1);
  $('#game-pulse').innerHTML = games.slice(0, 8).map(g => `
    <div class="pc-row" title="${escapeHtml(g.label)}: ${money(g.volume_30d_cents)} traded in 30 days · ${g.items_live} live · ${g.looking_count} looking">
      <div class="pc-label">
        <span class="pc-name">${escapeHtml(g.label)}</span>
        <span class="pc-meta">${g.items_live} live · ${g.looking_count} looking</span>
      </div>
      <div class="pc-track"><i class="pc-fill" data-w="${Math.max(1.5, g.volume_30d_cents / max * 100)}"></i></div>
      <div class="pc-value">${money(g.volume_30d_cents)}</div>
    </div>`).join('');
  // Bars grow in on the next frame so the width transition runs.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$('#game-pulse .pc-fill').forEach(el => { el.style.width = el.dataset.w + '%'; });
  }));
}

// ============================================================
// Send balance (P2P transfer, 5% fee)
// ============================================================
let TRANSFER_FEE_BPS = 500;
function openTransferModal() {
  if (!ME) return openModal('auth-overlay');
  $('#transfer-balance').textContent = `Your balance: ${money(ME.site_credit_cents)}`;
  $('#transfer-to').value = ''; $('#transfer-amount').value = ''; $('#transfer-note').value = '';
  $('#transfer-error').textContent = '';
  $('#transfer-breakdown').hidden = true;
  openModal('transfer-overlay');
}
function updateTransferBreakdown() {
  const amt = Math.round(parseFloat($('#transfer-amount').value) * 100);
  const bd = $('#transfer-breakdown');
  if (!amt || amt < 100) { bd.hidden = true; return; }
  const fee = Math.round(amt * TRANSFER_FEE_BPS / 10000);
  $('#tb-fee-label').textContent = `Fee (${(TRANSFER_FEE_BPS / 100).toFixed(0)}%)`;
  $('#tb-fee').textContent = money(fee);
  $('#tb-receive').textContent = money(amt - fee);
  bd.hidden = false;
}
$('#transfer-amount').addEventListener('input', updateTransferBreakdown);
$('#transfer-submit').onclick = async () => {
  const err = $('#transfer-error');
  err.textContent = '';
  const to = $('#transfer-to').value.trim();
  const amount = parseFloat($('#transfer-amount').value);
  if (!to) { err.textContent = 'Enter who to send to.'; return; }
  if (!amount || amount <= 0) { err.textContent = 'Enter a valid amount.'; return; }
  const cents = Math.round(amount * 100);
  const fee = Math.round(cents * TRANSFER_FEE_BPS / 10000);
  if (!await vaultConfirm(`${to} receives ${money(cents - fee)} (you're charged ${money(cents)} incl. a ${money(fee)} fee).`, { title: 'Send balance?', okText: 'Send ' + money(cents), icon: '💸' })) return;
  $('#transfer-submit').disabled = true;
  const r = await api('/api/my/transfer', { method: 'POST', body: JSON.stringify({ to, amount_cents: cents, note: $('#transfer-note').value.trim() || undefined }) });
  $('#transfer-submit').disabled = false;
  if (r.error) { err.textContent = r.error; return; }
  closeModal('transfer-overlay');
  toast(`Sent ${money(r.received_cents)} to ${escapeHtml(r.recipient)}. 💸`, 'success');
  await loadMe();
  renderDashTab();
};

// ============================================================
// Vault Server — Discord-style hub (text channels + voice channels)
// ============================================================
const SERVER_CHAN_DESC = {
  general: 'Chat with the whole Vault community',
  giveaways: 'Giveaways, drops, and events',
  clips: 'Share your best trades and plays',
  help: 'Stuck? Ask the community',
  'off-topic': 'Anything goes (keep it civil)',
};
let serverRoom = 'general';
let serverPollTimer = null;
let serverPollBusy = false;
let lastServerMsgId = 0;
let serverSlowTimer = null;

async function loadServer() {
  loadServerSummary();
  clearInterval(serverSummaryTimer); serverSummaryTimer = setInterval(loadServerSummary, 20000);
  switchServerChannel(serverRoom);
}
let serverSummaryTimer = null;

async function loadServerSummary() {
  const r = await api('/api/server/summary');
  if (r.error) return;
  $('#server-online').textContent = `· ${r.online} online`;
  $('#server-online-n').textContent = r.online;
  Object.entries(r.voice || {}).forEach(([ch, n]) => {
    const el = document.querySelector(`[data-vc-count="${ch}"]`);
    if (el) el.textContent = n ? `· ${n}` : '';
  });
  document.querySelectorAll('[data-vc-count]').forEach(el => { if (!(r.voice && r.voice[el.dataset.vcCount])) el.textContent = ''; });
  $('#server-members').innerHTML = (r.members || []).map(m => `
    <a class="member-row" href="#u/${encodeURIComponent(m.username)}">
      ${m.avatar_url ? `<img src="${escapeHtml(m.avatar_url)}" alt="">` : `<span class="member-av">${escapeHtml(m.username[0].toUpperCase())}</span>`}
      <span class="member-dot"></span><span>${escapeHtml(m.username)}${probadge(m.pro)}</span>
    </a>`).join('') || '<div class="sub" style="padding:8px">Nobody around right now.</div>';
}

function switchServerChannel(room) {
  serverRoom = room;
  lastServerMsgId = 0;
  $$('#text-channels .chan').forEach(c => c.classList.toggle('active', c.dataset.chan === room));
  $('#server-chan-name').textContent = '# ' + room;
  $('#server-chan-desc').textContent = `${SERVER_CHAN_DESC[room] || ''} · 5s slowmode`;
  $('#server-input').placeholder = `Message #${room}…`;
  $('#server-box').innerHTML = '<div class="chat-empty">Loading…</div>';
  clearInterval(serverPollTimer);
  pollServer(true);
  serverPollTimer = setInterval(() => pollServer(false), 4000);
}

async function pollServer(initial) {
  if (serverPollBusy) return;
  serverPollBusy = true;
  try {
    const r = await api(`/api/rooms/${serverRoom}/messages?after=${lastServerMsgId}`);
    if (r.error) { if (initial) $('#server-box').innerHTML = `<div class="chat-empty">${escapeHtml(r.error)}</div>`; return; }
    const box = $('#server-box');
    if (initial) box.innerHTML = '';
    const msgs = (r.messages || []).filter(m => m.id > lastServerMsgId);
    if (initial && !msgs.length) { box.innerHTML = `<div class="chat-empty">No messages in #${serverRoom} yet — say hi!</div>`; return; }
    if (msgs.length && box.querySelector('.chat-empty')) box.innerHTML = '';
    msgs.forEach(m => {
      lastServerMsgId = Math.max(lastServerMsgId, m.id);
      const el = document.createElement('div');
      el.className = 'srv-msg';
      el.innerHTML = `<span class="srv-who">${escapeHtml(m.sender_name)}</span>${vbadge(m.is_verified)}${probadge(m.pro)}<span class="srv-time">${timeAgo(m.created_at)}</span><div class="srv-body">${escapeHtml(m.body)}</div>`;
      box.appendChild(el);
    });
    if (msgs.length) box.scrollTop = box.scrollHeight;
  } finally { serverPollBusy = false; }
}

function serverSlowmode(seconds) {
  const btn = $('#server-send');
  clearInterval(serverSlowTimer);
  let left = seconds; btn.disabled = true; btn.textContent = `${left}s`;
  serverSlowTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(serverSlowTimer); btn.disabled = false; btn.textContent = 'Send'; return; }
    btn.textContent = `${left}s`;
  }, 1000);
}
let serverSending = false;
async function sendServerMsg() {
  if (!ME) return openModal('auth-overlay');
  const input = $('#server-input');
  const body = input.value.trim();
  if (!body || serverSending || $('#server-send').disabled) return;
  serverSending = true;
  input.value = '';
  try {
    const r = await api(`/api/rooms/${serverRoom}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
    if (r.error) { toast(r.error, 'error'); input.value = body; if (r.retry_in) serverSlowmode(r.retry_in); return; }
    await pollServer(false);
    serverSlowmode(r.slowmode_seconds || 5);
  } finally { serverSending = false; input.focus(); }
}
$('#server-send').onclick = sendServerMsg;
$('#server-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendServerMsg(); });
$('#text-channels').addEventListener('click', (e) => {
  const c = e.target.closest('.chan');
  if (c) switchServerChannel(c.dataset.chan);
});
$('#voice-channels').addEventListener('click', async (e) => {
  const c = e.target.closest('.chan');
  if (!c) return;
  if (!ME) return openModal('auth-overlay');
  const r = await api(`/api/server/voice/${c.dataset.vc}/join`, { method: 'POST' });
  if (r.error) return toast(r.error, 'error');
  openLobbyRoom(r.id);
  loadServerSummary();
});

// ============================================================
// Lobbies — play together + voice chat
// ============================================================
const REGION_LABELS = { any: 'Any region', 'na-east': 'NA East', 'na-west': 'NA West', eu: 'Europe', asia: 'Asia', oceania: 'Oceania', sa: 'South America' };
let activeLobbyId = null;
let lobbyPollTimer = null;
let lobbyChatTimer = null;
let lobbyChatBusy = false;
let lastLobbyMsgId = 0;

async function loadLobbies() {
  const grid = $('#lobby-grid');
  const r = await api('/api/lobbies');
  const ls = r.lobbies || [];
  if (!ls.length) {
    grid.innerHTML = '<div class="empty-block">No open lobbies — create one and get a squad together. 🎮</div>';
    return;
  }
  grid.innerHTML = ls.map(l => {
    const full = l.player_count >= l.max_players;
    return `
    <div class="lobby-card">
      <div class="lobby-top">
        <div class="lobby-game">🎮 ${escapeHtml(l.game)}</div>
        ${l.private ? '<span class="lobby-tag private">🔒 Private</span>' : ''}
        <span class="lobby-tag">${escapeHtml(REGION_LABELS[l.region] || l.region)}</span>
      </div>
      <div class="lobby-title">${escapeHtml(l.title)}</div>
      ${l.notes ? `<div class="lobby-notes">${escapeHtml(l.notes)}</div>` : ''}
      <div class="lobby-foot">
        <span class="lobby-host">Host <a href="#u/${encodeURIComponent(l.host_name)}">${escapeHtml(l.host_name)}</a>${probadge(l.host_pro)}</span>
        <span class="lobby-count ${full ? 'full' : ''}">👥 ${l.player_count}/${l.max_players}</span>
      </div>
      ${l.joined
        ? `<button class="btn btn-small btn-gold" data-lobby-open="${l.id}">Open lobby</button>`
        : full ? `<button class="btn btn-small" disabled>Full</button>`
        : `<button class="btn btn-small btn-gold" data-lobby-join="${l.id}" data-private="${l.private ? 1 : 0}">${l.private ? '🔒 Join with code' : 'Join lobby'}</button>`}
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-lobby-join]').forEach(b => b.onclick = async () => {
    if (!ME) return openModal('auth-overlay');
    let code;
    if (b.dataset.private === '1') {
      code = await vaultPrompt('Enter the join code the host shared with you.', { title: 'Private lobby', okText: 'Join', placeholder: 'e.g. A1B2C3', icon: '🔒' });
      if (code === null) return;
    }
    const r2 = await api(`/api/lobbies/${b.dataset.lobbyJoin}/join`, { method: 'POST', body: JSON.stringify({ code: code || undefined }) });
    if (r2.error) return toast(r2.error, 'error');
    openLobbyRoom(parseInt(b.dataset.lobbyJoin, 10));
  });
  grid.querySelectorAll('[data-lobby-open]').forEach(b => b.onclick = () => openLobbyRoom(parseInt(b.dataset.lobbyOpen, 10)));
}

// ---- Create ----
let lobbyPrivate = false;
$('#lobby-private-toggle').onclick = () => {
  lobbyPrivate = !lobbyPrivate;
  $('#lobby-private-toggle').classList.toggle('on', lobbyPrivate);
  $('#lobby-private-toggle').setAttribute('aria-checked', String(lobbyPrivate));
};
$('#host-lobby-btn').addEventListener('click', () => {
  if (!ME) return openModal('auth-overlay');
  $('#lobby-error').textContent = '';
  openModal('lobby-overlay');
});
$('#lobby-submit').addEventListener('click', async () => {
  const err = $('#lobby-error');
  err.textContent = '';
  const btn = $('#lobby-submit');
  btn.classList.add('loading');
  const r = await api('/api/lobbies', {
    method: 'POST',
    body: JSON.stringify({
      title: $('#lobby-title').value.trim(),
      game: $('#lobby-game').value.trim(),
      notes: $('#lobby-notes').value.trim(),
      max_players: parseInt($('#lobby-max').value, 10),
      region: $('#lobby-region').value,
      private: lobbyPrivate,
    }),
  });
  btn.classList.remove('loading');
  if (r.error) { err.textContent = r.error; return; }
  closeModal('lobby-overlay');
  $('#lobby-title').value = ''; $('#lobby-game').value = ''; $('#lobby-notes').value = '';
  if (r.join_code) {
    await vaultConfirm(`Share this code with people you want to let in:\n\n${r.join_code}`, { title: '🔒 Private lobby created', okText: 'Got it', icon: '🔒' });
  }
  openLobbyRoom(r.id);
});

// ---- Lobby room ----
async function openLobbyRoom(id) {
  activeLobbyId = id;
  lastLobbyMsgId = 0;
  $('#lr-box').innerHTML = '<div class="chat-empty">Loading…</div>';
  $('#lr-roster').innerHTML = '';
  openModal('lobbyroom-overlay');
  await refreshLobbyRoom();
  await pollLobbyChat(true);
  clearInterval(lobbyPollTimer); lobbyPollTimer = setInterval(refreshLobbyRoom, 6000);
  clearInterval(lobbyChatTimer); lobbyChatTimer = setInterval(() => pollLobbyChat(false), 4000);
}

async function refreshLobbyRoom() {
  if (!activeLobbyId) return;
  const r = await api(`/api/lobbies/${activeLobbyId}`);
  if (r.error || !r.lobby) return;
  const l = r.lobby;
  if (l.status !== 'open' && !l.joined) {
    toast('This lobby has closed.', 'info');
    return closeModal('lobbyroom-overlay');
  }
  $('#lr-title').textContent = l.title;
  $('#lr-sub').innerHTML = `🎮 <b>${escapeHtml(l.game)}</b> · ${escapeHtml(REGION_LABELS[l.region] || l.region)} · ${l.player_count}/${l.max_players} players · host ${escapeHtml(l.host_name)}`;
  if (l.voice_url) $('#lr-voice-btn').href = l.voice_url;
  $('#lr-roster').innerHTML = `<div class="lr-roster-head">In the lobby (${(l.members || []).length})</div>` + (l.members || []).map(m => `
    <a class="lr-member" href="#u/${encodeURIComponent(m.username)}">
      ${m.avatar_url ? `<img src="${escapeHtml(m.avatar_url)}" alt="">` : `<span class="lr-av-fallback">${escapeHtml(m.username[0].toUpperCase())}</span>`}
      <span>${escapeHtml(m.username)}${m.id === l.host_id ? ' 👑' : ''}${probadge(m.pro)}</span>
    </a>`).join('');
}

async function pollLobbyChat(initial) {
  if (!activeLobbyId || lobbyChatBusy) return;
  lobbyChatBusy = true;
  try {
    const r = await api(`/api/lobbies/${activeLobbyId}/messages?after=${lastLobbyMsgId}`);
    if (r.error) { if (initial) $('#lr-box').innerHTML = `<div class="chat-empty">${escapeHtml(r.error)}</div>`; return; }
    const box = $('#lr-box');
    const msgs = (r.messages || []).filter(m => m.id > lastLobbyMsgId);
    if (initial && !msgs.length) { box.innerHTML = '<div class="chat-empty">Say hi, then jump in voice 🎙</div>'; return; }
    if (initial || box.querySelector('.chat-empty')) box.innerHTML = '';
    msgs.forEach(m => {
      lastLobbyMsgId = Math.max(lastLobbyMsgId, m.id);
      const el = document.createElement('div');
      el.className = 'chat-msg ' + (m.mine ? 'mine' : 'theirs');
      el.innerHTML = `${escapeHtml(m.body)}<div class="m-meta">${m.from_host ? '👑 ' : ''}${escapeHtml(m.sender_name)} · ${timeAgo(m.created_at)}</div>`;
      box.appendChild(el);
    });
    if (msgs.length) box.scrollTop = box.scrollHeight;
  } finally { lobbyChatBusy = false; }
}

let lobbySending = false;
async function sendLobbyMsg() {
  const input = $('#lr-input');
  const body = input.value.trim();
  if (!body || !activeLobbyId || lobbySending) return;
  lobbySending = true;
  $('#lr-send').disabled = true;
  input.value = '';
  try {
    const r = await api(`/api/lobbies/${activeLobbyId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
    if (r.error) { toast(r.error, 'error'); input.value = body; return; }
    await pollLobbyChat(false);
  } finally { lobbySending = false; $('#lr-send').disabled = false; input.focus(); }
}
$('#lr-send').onclick = sendLobbyMsg;
$('#lr-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLobbyMsg(); });
$('#lr-leave').onclick = async () => {
  if (!activeLobbyId) return;
  const r = await api(`/api/lobbies/${activeLobbyId}/leave`, { method: 'POST' });
  if (r.error) return toast(r.error, 'error');
  closeModal('lobbyroom-overlay');
  toast('Left the lobby.', 'info');
  if ($('#view-lobbies').classList.contains('active')) loadLobbies();
};

// ============================================================
// Traders Center — W / F / L
// ============================================================
async function loadWfl() {
  const grid = $('#wfl-grid');
  const r = await api('/api/wfl');
  const posts = r.posts || [];
  if (!posts.length) {
    grid.innerHTML = '<div class="empty-block">No trades posted yet — drop yours and find out if it was a W.</div>';
    return;
  }
  grid.innerHTML = posts.map(p => {
    const total = p.w_count + p.f_count + p.l_count;
    const pct = (n) => total ? Math.round(n / total * 100) : 0;
    const verdict = !total ? '' : p.w_count >= p.f_count && p.w_count >= p.l_count
      ? '<span class="wfl-verdict w">Community says W</span>'
      : p.l_count >= p.f_count ? '<span class="wfl-verdict l">Community says L</span>'
      : '<span class="wfl-verdict f">Community says fair</span>';
    const mine = ME && p.user_id === ME.id;
    return `
    <div class="wfl-card">
      <div class="wfl-top">
        <span><a href="#u/${encodeURIComponent(p.username)}">${escapeHtml(p.username)}</a>${vbadge(p.is_verified)}${probadge(p.pro)} · ${timeAgo(p.created_at)} ${catTag(p.category)}</span>
        ${mine || (ME && ME.is_admin) ? `<button class="btn btn-small" data-wfl-del="${p.id}" style="color:var(--danger)">Delete</button>` : ''}
      </div>
      <div class="wfl-body">${escapeHtml(p.body)}</div>
      ${p.image_url ? `<div class="wfl-img" style="background-image:url('${escapeHtml(p.image_url)}')" data-lightbox="${escapeHtml(p.image_url)}"></div>` : ''}
      <div class="wfl-votes" data-wfl="${p.id}" data-mine="${mine ? 1 : 0}">
        <button class="wfl-btn w ${p.my_vote === 'w' ? 'active' : ''}" data-v="w">W <b>${p.w_count}</b></button>
        <button class="wfl-btn f ${p.my_vote === 'f' ? 'active' : ''}" data-v="f">F <b>${p.f_count}</b></button>
        <button class="wfl-btn l ${p.my_vote === 'l' ? 'active' : ''}" data-v="l">L <b>${p.l_count}</b></button>
        ${verdict}
      </div>
      ${total ? `<div class="wfl-meter"><i class="w" style="width:${pct(p.w_count)}%"></i><i class="f" style="width:${pct(p.f_count)}%"></i><i class="l" style="width:${pct(p.l_count)}%"></i></div>` : ''}
    </div>`;
  }).join('');

  grid.querySelectorAll('.wfl-votes button').forEach(b => b.onclick = async () => {
    if (!ME) return openModal('auth-overlay');
    const wrap = b.closest('.wfl-votes');
    if (wrap.dataset.mine === '1') return toast('You can\'t rate your own trade — let the people speak.', 'info');
    const r2 = await api(`/api/wfl/${wrap.dataset.wfl}/vote`, { method: 'POST', body: JSON.stringify({ vote: b.dataset.v }) });
    if (r2.error) return toast(r2.error, 'error');
    loadWfl();
  });
  grid.querySelectorAll('[data-wfl-del]').forEach(b => b.onclick = async () => {
    if (!await vaultConfirm('The post and all its votes disappear.', { title: 'Delete this trade post?', okText: 'Delete post', danger: true, icon: '🗑' })) return;
    const r2 = await api(`/api/wfl/${b.dataset.wflDel}`, { method: 'DELETE' });
    if (r2.error) return toast(r2.error, 'error');
    loadWfl();
  });
  grid.querySelectorAll('[data-lightbox]').forEach(el => el.onclick = () => openLightbox(el.dataset.lightbox));
}

$('#post-wfl-btn').addEventListener('click', () => {
  if (!ME) return openModal('auth-overlay');
  $('#wfl-error').textContent = '';
  openModal('wfl-overlay');
});
$('#wfl-image-file').addEventListener('change', () => {
  const f = $('#wfl-image-file').files[0];
  $('#wfl-file-name').textContent = f ? f.name.slice(0, 18) : 'Upload';
});
$('#wfl-submit').addEventListener('click', async () => {
  const err = $('#wfl-error');
  err.textContent = '';
  const btn = $('#wfl-submit');
  btn.classList.add('loading');
  let image_url = $('#wfl-image').value.trim();
  const file = $('#wfl-image-file').files[0];
  if (file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/uploads', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { btn.classList.remove('loading'); err.textContent = data.error || 'Image upload failed.'; return; }
    image_url = data.url;
  }
  const r = await api('/api/wfl', {
    method: 'POST',
    body: JSON.stringify({ body: $('#wfl-body').value.trim(), category: $('#wfl-category').value, image_url: image_url || null }),
  });
  btn.classList.remove('loading');
  if (r.error) { err.textContent = r.error; return; }
  closeModal('wfl-overlay');
  $('#wfl-body').value = ''; $('#wfl-image').value = ''; $('#wfl-image-file').value = ''; $('#wfl-file-name').textContent = 'Upload';
  toast('Posted — let\'s see what the people say.', 'success');
  loadWfl();
});

// ============================================================
// Section chat rooms (slowmode 5s, everyone welcome)
// ============================================================
const ROOM_BY_VIEW = { home: 'marketplace', trading: 'trading', tournaments: 'tournaments' };
const ROOM_LABELS = { marketplace: 'Marketplace chat', trading: 'Trading chat', tournaments: 'Tournament chat' };
let dockRoom = null;
let dockOpen = false;
let dockPollTimer = null;
let dockPollBusy = false;
let lastDockMsgId = 0;
let dockSlowTimer = null;

function updateDock(view) {
  const room = ROOM_BY_VIEW[view] || null;
  const dock = $('#chat-dock');
  if (!room) {
    dock.hidden = true;
    closeDockPanel();
    dockRoom = null;
    return;
  }
  dock.hidden = false;
  if (room !== dockRoom) {
    dockRoom = room;
    $('#dock-label').textContent = ROOM_LABELS[room];
    $('#dock-title').textContent = ROOM_LABELS[room];
    if (dockOpen) { lastDockMsgId = 0; $('#dock-box').innerHTML = '<div class="chat-empty">Loading…</div>'; pollDock(true); }
  }
}

function closeDockPanel() {
  dockOpen = false;
  $('#dock-panel').hidden = true;
  clearInterval(dockPollTimer);
}

$('#dock-toggle').onclick = async () => {
  if (dockOpen) return closeDockPanel();
  dockOpen = true;
  $('#dock-panel').hidden = false;
  lastDockMsgId = 0;
  $('#dock-box').innerHTML = '<div class="chat-empty">Loading…</div>';
  await pollDock(true);
  clearInterval(dockPollTimer);
  dockPollTimer = setInterval(() => pollDock(false), 4000);
  $('#dock-input').focus();
};
$('#dock-close').onclick = closeDockPanel;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dockOpen) closeDockPanel(); });

async function pollDock(initial) {
  if (!dockRoom || dockPollBusy || !dockOpen) return;
  dockPollBusy = true;
  try {
    const r = await api(`/api/rooms/${dockRoom}/messages?after=${lastDockMsgId}`);
    if (r.error) { if (initial) $('#dock-box').innerHTML = `<div class="chat-empty">${escapeHtml(r.error)}</div>`; return; }
    const box = $('#dock-box');
    if (initial) box.innerHTML = '';
    const msgs = (r.messages || []).filter(m => m.id > lastDockMsgId);
    if (initial && !msgs.length) {
      box.innerHTML = '<div class="chat-empty">Quiet in here — say hi!</div>';
      return;
    }
    if (msgs.length && box.querySelector('.chat-empty')) box.innerHTML = '';
    msgs.forEach(m => {
      lastDockMsgId = Math.max(lastDockMsgId, m.id);
      const el = document.createElement('div');
      el.className = 'dock-msg' + (m.mine ? ' mine' : '');
      el.innerHTML = `<span class="dm-who">${escapeHtml(m.sender_name)}</span>${vbadge(m.is_verified)}${probadge(m.pro)} ${escapeHtml(m.body)}<span class="dm-time">${timeAgo(m.created_at)}</span>`;
      box.appendChild(el);
    });
    if (msgs.length) box.scrollTop = box.scrollHeight;
  } finally {
    dockPollBusy = false;
  }
}

function startSlowmode(seconds) {
  const btn = $('#dock-send');
  clearInterval(dockSlowTimer);
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `${left}s`;
  dockSlowTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(dockSlowTimer); btn.disabled = false; btn.textContent = 'Send'; return; }
    btn.textContent = `${left}s`;
  }, 1000);
}

let dockSending = false;
async function sendDockMsg() {
  if (!ME) return openModal('auth-overlay');
  const input = $('#dock-input');
  const body = input.value.trim();
  if (!body || !dockRoom || dockSending || $('#dock-send').disabled) return;
  dockSending = true;
  input.value = '';
  try {
    const r = await api(`/api/rooms/${dockRoom}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
    if (r.error) {
      toast(r.error, 'error');
      input.value = body;
      if (r.retry_in) startSlowmode(r.retry_in);
      return;
    }
    await pollDock(false);
    startSlowmode(r.slowmode_seconds || 5);
  } finally {
    dockSending = false;
    input.focus();
  }
}
$('#dock-send').onclick = sendDockMsg;
$('#dock-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDockMsg(); });

// ============================================================
// Ambience: header depth, card spotlight, scroll reveals
// ============================================================

// Header casts a shadow once the page scrolls under it.
window.addEventListener('scroll', () => {
  document.querySelector('header').classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

// Cursor spotlight: cards glow where the mouse is (drives the --mx/--my
// custom props the ::before radial gradient reads).
document.addEventListener('mousemove', (e) => {
  const card = e.target.closest?.('.card, .tourney-card');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${e.clientX - r.left}px`);
  card.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });

// Scroll reveals for the static home sections.
(function initReveals() {
  const targets = $$('.section-head, .discord-banner, #how-it-works .card, .footer-grid');
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  targets.forEach((el) => { el.classList.add('reveal'); io.observe(el); });
})();

// ============================================================
// Init
// ============================================================
(async function init() {
  const params = new URLSearchParams(location.search);
  api('/api/config').then(c => { if (c.fee_bps) FEE = c; if (c.transfer_fee_bps != null) TRANSFER_FEE_BPS = c.transfer_fee_bps; });
  await loadMe();
  loadSiteStats();
  loadCategories();
  loadAnnouncementBanner();
  setInterval(loadAnnouncementBanner, 5 * 60000);
  maybeShowProPromo();
  loadTrending();
  loadRecentSales();
  renderCatChips('#auctions-cats', auctionState, loadAuctions);
  renderCatChips('#listings-cats', listingState, loadListings);
  renderCatChips('#wanted-cats', wantedState, loadWanted);
  loadAuctions();
  loadListings();
  loadWanted();
  loadGameStats();
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
