// myTV — cross-platform TV/Radio streaming PWA
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

const STORAGE_KEY = 'mytv.listUrl';
const CHANNELS_KEY = 'mytv.channels';
const FAV_KEY = 'mytv.favs';
const TAB_KEY = 'mytv.tab';
const ORDER_KEY = 'mytv.order';        // { tv: [id,...], radio: [id,...] }
const HIDDEN_KEY = 'mytv.hidden';      // [id,...]
const RENAME_KEY = 'mytv.renames';     // { id: "Nuovo nome" }
const GIST_TOKEN_KEY = 'mytv.gistToken';
const GIST_ID_KEY = 'mytv.gistId';
const SYNC_TS_KEY = 'mytv.syncTs';

// Liste predefinite (in ordine di priorità per gli stream):
//   1) Free-TV/IPTV — URL Mediaset/La7/Sky TG24/RaiNews24/TGCom24 in chiaro, niente DRM/geo-block
//   2) iptv-org/iptv/countries/it.m3u — coda lunga di canali italiani regionali e tematici
// Il merge sceglie sempre lo stream Free-TV quando esiste (è quello che funziona davvero).
const DEFAULT_LIST_URLS = [
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
  'https://iptv-org.github.io/iptv/countries/it.m3u',
];
// Compat: prima versione caricava solo iptv-org
const DEFAULT_LIST_URL = DEFAULT_LIST_URLS[1];

const RADIO_STATIONS = window.RADIO_CATALOG || [];
const TV_CATALOG = window.TV_CATALOG || [];

// Init preferiti di default al primo avvio
if (!localStorage.getItem('mytv.favsInit') && Array.isArray(window.DEFAULT_FAVS)) {
  localStorage.setItem(FAV_KEY, JSON.stringify(window.DEFAULT_FAVS));
  localStorage.setItem('mytv.favsInit', '1');
}

// ---------- Normalizzazione nome (matching robusto) ----------
function normName(s) {
  return (s || '')
    .toLowerCase()
    // rimuovi simboli/emoji Unicode (es. "Ⓖ", "Ⓢ", "★")
    .replace(/[①-⓿☀-➿⬀-⯿️]/g, '')
    // rimuovi suffissi di qualità/stato
    .replace(/\s*\(\s*\d{2,4}p\s*\)/gi, '')
    .replace(/\s*\[\s*(geo[\s-]?blocked|not\s*24\/7|geo\s*-?\s*blocked)\s*\]/gi, '')
    .replace(/\s+hd\b/gi, '')
    .replace(/\s+sd\b/gi, '')
    .replace(/\s+4k\b/gi, '')
    .replace(/\s+\d{2,4}p\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

// Link che nel browser non partono: i "relinker" ufficiali RAI (mediapolis.rai.it) rifiutano
// le richieste da altri siti, i link http:// sono bloccati su una pagina https.
// Se per lo stesso canale c'è un link migliore, vince quello.
function streamScore(url) {
  if (/mediapolis(event)?\.rai\.it\/relinker/i.test(url || '')) return 0;
  if (/^http:\/\//i.test(url || '')) return 0;
  return 1;
}

// ID stabile del canale per ordinamento/hide/rename
function channelId(c) { return normName(c.name); }

// Unisce la lista caricata col catalogo statico (per loghi).
// Se la lista caricata esiste, mantieni SOLO i canali che hanno stream.
function mergeWithCatalog(loaded) {
  const byKey = new Map();
  for (const c of TV_CATALOG) byKey.set(normName(c.name), { ...c, _fromCatalog: true });
  for (const c of (loaded || [])) {
    const key = normName(c.name);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, { ...existing, ...c, logo: c.logo || existing.logo, _fromCatalog: false });
    } else {
      byKey.set(key, { ...c, _fromCatalog: false });
    }
  }
  const all = [...byKey.values()];
  // Se ho stream da iptv-org, scarto i canali placeholder del catalog senza stream
  if ((loaded || []).length > 0) return all.filter(c => c.stream);
  return all;
}

let hls = null;
let loadedChannels = [];
let channels = mergeWithCatalog([]);
let currentTab = localStorage.getItem(TAB_KEY) || 'tv';
let currentItem = null;
let favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
let order = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
let hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'));
let renames = JSON.parse(localStorage.getItem(RENAME_KEY) || '{}');
let showOnlyFavs = false;
let searchQuery = '';
let editMode = false;

// ---------- List loading ----------
async function loadFromUrl(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const text = await resp.text();
  let list = parseList(text);
  if (!list || !list.length) throw new Error('Lista vuota o formato non riconosciuto');
  loadedChannels = list;
  channels = mergeWithCatalog(list);
  localStorage.setItem(STORAGE_KEY, url);
  localStorage.setItem(CHANNELS_KEY, JSON.stringify(list));
  render();
}

function parseList(text) {
  text = text.trim();
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const arr = Array.isArray(data) ? data : (data.channels || data.list || data.items || []);
      return arr.map(normalizeChannel).filter(c => c.stream);
    } catch (e) {}
  }
  if (text.startsWith('#EXTM3U')) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let pending = null;
    for (const line of lines) {
      if (line.startsWith('#EXTINF')) {
        const nameMatch = line.match(/,(.+)$/);
        const logoMatch = line.match(/tvg-logo="([^"]+)"/);
        const countryMatch = line.match(/tvg-country="([^"]+)"/);
        const groupMatch = line.match(/group-title="([^"]+)"/);
        const rawName = nameMatch ? nameMatch[1].trim() : 'Canale';
        // Free-TV/IPTV usa suffissi tipo "Ⓖ" (geo-locked label). Li rimuovo dal display.
        const cleanName = rawName.replace(/[①-⓿☀-➿⬀-⯿️★]/g, '').replace(/\s+/g, ' ').trim();
        pending = {
          name: cleanName || rawName,
          logo: logoMatch ? logoMatch[1] : null,
          country: countryMatch ? countryMatch[1] : null,
          group: groupMatch ? groupMatch[1] : null,
        };
      } else if (line && !line.startsWith('#')) {
        if (pending) {
          pending.stream = line.trim();
          out.push(pending);
          pending = null;
        }
      }
    }
    return out;
  }
  return null;
}

function normalizeChannel(c) {
  return {
    name: c.name || c.title || c.channel || 'Canale',
    stream: c.stream || c.url || c.src || c.manifest || c.hls || '',
    logo: c.logo || c.image || c.icon || null,
    color: c.color || null,
  };
}

function loadCached() {
  const cached = localStorage.getItem(CHANNELS_KEY);
  if (cached) {
    try { loadedChannels = JSON.parse(cached); } catch (e) { loadedChannels = []; }
  }
  channels = mergeWithCatalog(loadedChannels);
}

// ---------- Ordering / hide / rename ----------
function applyOrder(items, tabKey) {
  const ord = order[tabKey];
  if (!Array.isArray(ord) || !ord.length) return items;
  const indexOfId = new Map(ord.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ia = indexOfId.has(channelId(a)) ? indexOfId.get(channelId(a)) : 9999 + items.indexOf(a);
    const ib = indexOfId.has(channelId(b)) ? indexOfId.get(channelId(b)) : 9999 + items.indexOf(b);
    return ia - ib;
  });
}

function displayName(ch) {
  const id = channelId(ch);
  if (renames[id]) return renames[id];
  return ch.name;
}

function persistOrder(tabKey, newIdsOrder) {
  order[tabKey] = newIdsOrder;
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  scheduleSync();
}
function persistHidden() {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  scheduleSync();
}
function persistRenames() {
  localStorage.setItem(RENAME_KEY, JSON.stringify(renames));
  scheduleSync();
}
function persistFavs() {
  localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  scheduleSync();
}

// ---------- Rendering ----------
function render() {
  const list = $('#channelList');
  list.innerHTML = '';
  const items = currentTab === 'tv' ? channels : RADIO_STATIONS;
  let filtered = items.filter(c => {
    const id = channelId(c);
    if (!editMode && hidden.has(id)) return false;
    if (showOnlyFavs && !favs.has(c.name)) return false;
    if (searchQuery) {
      const dn = displayName(c).toLowerCase();
      if (!dn.includes(searchQuery) && !c.name.toLowerCase().includes(searchQuery)) return false;
    }
    return true;
  });
  filtered = applyOrder(filtered, currentTab);

  if (currentTab === 'tv' && loadedChannels.length === 0) {
    const banner = document.createElement('li');
    banner.style.cssText = 'list-style:none;padding:12px 14px;margin:0 0 8px;background:#2a1a05;color:#ffb35a;border-radius:12px;font-size:14px';
    banner.innerHTML = 'Nessuna lista canali caricata. I loghi sono visibili, ma per riprodurre i canali tocca <strong>+</strong> e inserisci l\'URL della tua lista (JSON o M3U).';
    list.appendChild(banner);
  }

  for (const ch of filtered) {
    const li = document.createElement('li');
    li.className = 'channel-item';
    const id = channelId(ch);
    li.dataset.id = id;
    if (currentItem && currentItem.name === ch.name) li.classList.add('playing');
    if (hidden.has(id)) li.classList.add('hidden-channel');

    // drag handle (visibile solo in edit mode)
    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6h2v2H9zM13 6h2v2h-2zM9 11h2v2H9zM13 11h2v2h-2zM9 16h2v2H9zM13 16h2v2h-2z" fill="currentColor"/></svg>';
    li.appendChild(handle);

    const logo = document.createElement('div');
    logo.className = 'logo';
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = ch.logo; img.alt = ch.name;
      img.onerror = () => { logo.textContent = initials(displayName(ch)); };
      logo.appendChild(img);
    } else {
      logo.style.background = ch.color || colorFor(ch.name);
      logo.textContent = initials(displayName(ch));
    }
    li.appendChild(logo);

    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = displayName(ch);
    li.appendChild(name);

    // Azioni normali (fav)
    const favBtn = document.createElement('button');
    favBtn.className = 'icon-btn channel-actions';
    favBtn.setAttribute('aria-label', 'Preferito');
    favBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6C19 16.5 12 21 12 21z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>';
    if (favs.has(ch.name)) favBtn.style.color = 'var(--accent)';
    favBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(ch); });
    li.appendChild(favBtn);

    // Azioni edit (rinomina / nascondi)
    const editActions = document.createElement('div');
    editActions.className = 'channel-edit-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'icon-btn small';
    renameBtn.setAttribute('aria-label', 'Rinomina');
    renameBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16v4z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>';
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); openRenameModal(ch); });
    const hideBtn = document.createElement('button');
    hideBtn.className = 'icon-btn small';
    hideBtn.setAttribute('aria-label', hidden.has(id) ? 'Mostra' : 'Nascondi');
    hideBtn.innerHTML = hidden.has(id)
      ? '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A11 11 0 0 1 22 12s-1.7 3-5 5M6.7 6.7C3.6 8.6 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
    hideBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHidden(ch); });
    editActions.appendChild(renameBtn);
    editActions.appendChild(hideBtn);
    li.appendChild(editActions);

    if (editMode) {
      li.draggable = true;
      li.addEventListener('dragstart', onDragStart);
      li.addEventListener('dragover', onDragOver);
      li.addEventListener('dragleave', onDragLeave);
      li.addEventListener('drop', onDrop);
      li.addEventListener('dragend', onDragEnd);
    } else if (!ch.stream && currentTab === 'tv') {
      li.style.opacity = '0.55';
      li.addEventListener('click', () => alert('Nessuno stream disponibile per "' + displayName(ch) + '". Carica una lista canali con il tasto +.'));
    } else {
      li.addEventListener('click', () => play(ch));
    }
    list.appendChild(li);
  }
  // toast eventuale stato sync
  updateSyncStatusUI();
}

// ---------- Drag & drop ----------
let dragSrcId = null;
function onDragStart(e) {
  dragSrcId = this.dataset.id;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragSrcId);
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drop-target');
}
function onDragLeave() { this.classList.remove('drop-target'); }
function onDrop(e) {
  e.preventDefault();
  this.classList.remove('drop-target');
  const targetId = this.dataset.id;
  if (!dragSrcId || dragSrcId === targetId) return;
  // Calcola il nuovo ordine completo dal DOM
  const all = $$('#channelList .channel-item').map(li => li.dataset.id);
  const src = all.indexOf(dragSrcId);
  const tgt = all.indexOf(targetId);
  all.splice(tgt, 0, all.splice(src, 1)[0]);
  persistOrder(currentTab, all);
  render();
}
function onDragEnd() { $$('.channel-item').forEach(li => { li.classList.remove('dragging'); li.classList.remove('drop-target'); }); dragSrcId = null; }

function initials(name) {
  return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 55%, 35%)`;
}

function toggleFav(ch) {
  if (favs.has(ch.name)) favs.delete(ch.name); else favs.add(ch.name);
  persistFavs();
  render();
}
function toggleHidden(ch) {
  const id = channelId(ch);
  if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
  persistHidden();
  render();
}

// ---------- Rename modal ----------
let renameTargetId = null;
function openRenameModal(ch) {
  renameTargetId = channelId(ch);
  $('#renameInput').value = displayName(ch);
  $('#renameModal').classList.remove('hidden');
  setTimeout(() => $('#renameInput').focus(), 80);
}
function closeRenameModal() { $('#renameModal').classList.add('hidden'); renameTargetId = null; }
function saveRename() {
  if (!renameTargetId) return;
  const v = $('#renameInput').value.trim();
  if (v) renames[renameTargetId] = v;
  else delete renames[renameTargetId];
  persistRenames();
  closeRenameModal();
  render();
}

// ---------- Player (stabile su iOS + recovery automatico) ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let recoveryTimer = null;
let stallTimer = null;
let lastPlayheadAt = 0;
let lastPlayheadTime = 0;
let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (localStorage.getItem('mytv.wakeLockDisabled') === '1') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* fallback silenzioso */ }
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

function setupMediaSession(ch) {
  if (!('mediaSession' in navigator)) return;
  const md = { title: displayName(ch), artist: 'myTV', album: currentTab === 'radio' ? 'Radio' : 'TV' };
  if (ch.logo) md.artwork = [
    { src: ch.logo, sizes: '96x96',  type: 'image/png' },
    { src: ch.logo, sizes: '192x192', type: 'image/png' },
    { src: ch.logo, sizes: '512x512', type: 'image/png' },
  ];
  try { navigator.mediaSession.metadata = new MediaMetadata(md); } catch {}
  const v = $('#video');
  navigator.mediaSession.setActionHandler('play',  () => { v.play().catch(()=>{}); });
  navigator.mediaSession.setActionHandler('pause', () => v.pause());
  navigator.mediaSession.setActionHandler('stop',  () => { v.pause(); v.removeAttribute('src'); v.load(); if (hls) { hls.destroy(); hls = null; } currentItem = null; releaseWakeLock(); render(); });
}

function startStallWatch(video) {
  clearInterval(stallTimer);
  lastPlayheadAt = Date.now();
  lastPlayheadTime = video.currentTime || 0;
  stallTimer = setInterval(() => {
    if (!currentItem) { clearInterval(stallTimer); return; }
    if (video.paused) { lastPlayheadAt = Date.now(); return; }
    const t = video.currentTime || 0;
    if (Math.abs(t - lastPlayheadTime) < 0.05) {
      // playhead fermo: se più di 10s, prova reload
      if (Date.now() - lastPlayheadAt > 10000) {
        console.warn('Stream stallato, ricarico…');
        if (!(t === 0 && tryNextStream())) reloadStream();
      }
    } else {
      lastPlayheadTime = t;
      lastPlayheadAt = Date.now();
    }
  }, 2000);
}

function play(ch) {
  currentItem = ch;
  $('#nowPlaying').textContent = displayName(ch);
  const video = $('#video');
  if (hls) { hls.destroy(); hls = null; }
  clearTimeout(recoveryTimer);

  const url = ch._alt ? ch.alts[ch._alt - 1] : ch.stream;
  const isHls = /\.m3u8(\?|$)/i.test(url);
  const safariCanPlayHLS = video.canPlayType('application/vnd.apple.mpegurl') !== '';

  // Su iOS Safari il player nativo è MOLTO più stabile di HLS.js per HLS live.
  if (isHls && (isIOS || safariCanPlayHLS)) {
    video.src = url;
    video.play().catch(()=>{});
  } else if (isHls && window.Hls && Hls.isSupported()) {
    hls = new Hls({
      lowLatencyMode: false,           // disattivo: causa freeze su live italiani
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 10,
      manifestLoadingTimeOut: 12000,
      manifestLoadingMaxRetry: 4,
      fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 6,
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(()=>{}));
    hls.on(Hls.Events.ERROR, (_, data) => {
      console.warn('HLS event', data.type, data.details);
      if (!data.fatal) return;
      if (/^manifest(Load|Parsing)/.test(data.details) && tryNextStream()) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          hls.startLoad(); break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hls.recoverMediaError(); break;
        default:
          // fatal non recuperabile → link di riserva, altrimenti full reload dopo 3s
          if (!tryNextStream()) recoveryTimer = setTimeout(() => reloadStream(), 3000);
      }
    });
  } else {
    video.src = url;
    video.play().catch(()=>{});
  }

  // Recovery anche su <video> events nativi
  video.onerror = () => { if (!tryNextStream()) recoveryTimer = setTimeout(() => reloadStream(), 3000); };
  video.onended = () => { if (currentItem) reloadStream(); };
  video.onstalled = () => { /* gestito da stall watchdog */ };
  startStallWatch(video);
  setupMediaSession(ch);
  acquireWakeLock();

  if (window.mytvBridge) window.mytvBridge.sendNowPlaying(displayName(ch));
  render();
}
function reloadStream() { if (currentItem) play(currentItem); }
// Passa al link di riserva successivo del canale (alts). false se non ce ne sono altri.
function tryNextStream() {
  const ch = currentItem;
  const next = (ch && ch._alt || 0) + 1;
  if (!ch || !ch.alts || next > ch.alts.length) return false;
  console.warn('Stream non disponibile, provo il link di riserva', next);
  play({ ...ch, _alt: next });
  return true;
}

// ---------- Sync via GitHub Gist ----------
const SYNC_FILENAME = 'mytv-prefs.json';
let syncTimer = null;
let lastSyncStatus = '';

function scheduleSync() {
  if (!localStorage.getItem(GIST_TOKEN_KEY)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => pushSync().catch(e => setSyncStatus('Errore sync: ' + e.message, 'err')), 1500);
}

function collectPrefs() {
  return {
    favs: [...favs],
    order, hidden: [...hidden], renames,
    listUrl: localStorage.getItem(STORAGE_KEY) || null,
    updatedAt: Date.now(),
  };
}

async function gistGet() {
  const token = localStorage.getItem(GIST_TOKEN_KEY);
  const id = localStorage.getItem(GIST_ID_KEY);
  if (!token || !id) return null;
  const r = await fetch(`https://api.github.com/gists/${id}`, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }
  });
  if (!r.ok) throw new Error('GET gist HTTP ' + r.status);
  const j = await r.json();
  const file = j.files && j.files[SYNC_FILENAME];
  if (!file) return null;
  try { return JSON.parse(file.content); } catch (e) { return null; }
}

async function gistCreate(prefs) {
  const token = localStorage.getItem(GIST_TOKEN_KEY);
  const r = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'myTV preferences sync', public: false,
      files: { [SYNC_FILENAME]: { content: JSON.stringify(prefs, null, 2) } }
    })
  });
  if (!r.ok) throw new Error('CREATE gist HTTP ' + r.status);
  const j = await r.json();
  localStorage.setItem(GIST_ID_KEY, j.id);
  return j;
}

async function gistUpdate(prefs) {
  const token = localStorage.getItem(GIST_TOKEN_KEY);
  const id = localStorage.getItem(GIST_ID_KEY);
  const r = await fetch(`https://api.github.com/gists/${id}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [SYNC_FILENAME]: { content: JSON.stringify(prefs, null, 2) } } })
  });
  if (!r.ok) throw new Error('UPDATE gist HTTP ' + r.status);
}

async function findExistingGist() {
  const token = localStorage.getItem(GIST_TOKEN_KEY);
  const r = await fetch('https://api.github.com/gists?per_page=100', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }
  });
  if (!r.ok) throw new Error('LIST gists HTTP ' + r.status);
  const arr = await r.json();
  const match = arr.find(g => g.files && g.files[SYNC_FILENAME]);
  if (match) { localStorage.setItem(GIST_ID_KEY, match.id); return match.id; }
  return null;
}

async function pullSync({ silent = false } = {}) {
  if (!localStorage.getItem(GIST_TOKEN_KEY)) return;
  if (!localStorage.getItem(GIST_ID_KEY)) await findExistingGist();
  if (!localStorage.getItem(GIST_ID_KEY)) return;
  setSyncStatus('Sync in corso…', '');
  const remote = await gistGet();
  if (!remote) { setSyncStatus('Gist vuoto, push iniziale…', ''); await pushSync(); return; }
  const localTs = parseInt(localStorage.getItem(SYNC_TS_KEY) || '0', 10);
  if ((remote.updatedAt || 0) > localTs) {
    applyPrefs(remote);
    localStorage.setItem(SYNC_TS_KEY, String(remote.updatedAt || Date.now()));
    if (!silent) render();
    setSyncStatus('Sync ricevuto ✓', 'ok');
  } else if (localTs > (remote.updatedAt || 0)) {
    await pushSync();
  } else {
    setSyncStatus('Sync aggiornato ✓', 'ok');
  }
}

async function pushSync() {
  if (!localStorage.getItem(GIST_TOKEN_KEY)) return;
  setSyncStatus('Push in corso…', '');
  const prefs = collectPrefs();
  if (!localStorage.getItem(GIST_ID_KEY)) await findExistingGist();
  if (!localStorage.getItem(GIST_ID_KEY)) await gistCreate(prefs);
  else await gistUpdate(prefs);
  localStorage.setItem(SYNC_TS_KEY, String(prefs.updatedAt));
  setSyncStatus('Sync salvato ✓', 'ok');
}

function applyPrefs(p) {
  if (Array.isArray(p.favs)) { favs = new Set(p.favs); localStorage.setItem(FAV_KEY, JSON.stringify(p.favs)); }
  if (p.order && typeof p.order === 'object') { order = p.order; localStorage.setItem(ORDER_KEY, JSON.stringify(order)); }
  if (Array.isArray(p.hidden)) { hidden = new Set(p.hidden); localStorage.setItem(HIDDEN_KEY, JSON.stringify(p.hidden)); }
  if (p.renames && typeof p.renames === 'object') { renames = p.renames; localStorage.setItem(RENAME_KEY, JSON.stringify(renames)); }
  if (p.listUrl && p.listUrl !== localStorage.getItem(STORAGE_KEY)) {
    loadFromUrl(p.listUrl).catch(()=>{});
  }
}

function setSyncStatus(text, cls) {
  lastSyncStatus = text + '|' + (cls || '');
  updateSyncStatusUI();
}
function updateSyncStatusUI() {
  const el = $('#syncStatus');
  if (!el) return;
  const [text, cls] = lastSyncStatus.split('|');
  el.textContent = text || (localStorage.getItem(GIST_TOKEN_KEY) ? 'Sync attivo' : 'Sync non configurato');
  el.className = 'sync-status ' + (cls || '');
}

// ---------- UI wiring ----------
function setTab(tab) {
  currentTab = tab;
  localStorage.setItem(TAB_KEY, tab);
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  render();
}

function openModal() { $('#modal').classList.remove('hidden'); $('#listUrl').value = localStorage.getItem(STORAGE_KEY) || ''; setTimeout(()=>$('#listUrl').focus(), 100); }
function closeModal() { $('#modal').classList.add('hidden'); }
function openMenu() { $('#sideMenu').classList.remove('hidden'); $('#gistTokenInput').value = localStorage.getItem(GIST_TOKEN_KEY) || ''; updateSyncStatusUI(); }
function closeMenu() { $('#sideMenu').classList.add('hidden'); }
function toggleSearch() {
  const bar = $('#searchBar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) $('#searchInput').focus();
  else { searchQuery = ''; $('#searchInput').value = ''; render(); }
}
function toggleEditMode() {
  editMode = !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  $('#editModeBtn').textContent = editMode ? 'Esci da modifica' : 'Modifica lista (ordina/nascondi/rinomina)';
  render();
}

async function enterFullscreen() {
  const el = $('#video');
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (e) {}
}

// Carica la lista predefinita combinando Free-TV (priorità sugli stream principali in chiaro)
// e iptv-org (coda lunga). Free-TV vince in caso di match per gli stream.
async function loadMergedDefaults() {
  const fetched = await Promise.all(DEFAULT_LIST_URLS.map(async (url) => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return [];
      const t = await r.text();
      return parseList(t) || [];
    } catch (e) { console.warn('Default list fail', url, e.message); return []; }
  }));
  const [freeTv, iptvOrg] = fetched;
  // Free-TV è multi-paese: tieni solo Italia
  const freeTvIt = freeTv.filter(c => {
    const country = (c.country || '').toUpperCase();
    const group = (c.group || '').toLowerCase();
    return country === 'IT' || group === 'italy' || group === 'italia';
  });
  // Merge: parto da iptv-org, poi sovrascrivo con Free-TV (stream migliori)
  const byKey = new Map();
  for (const c of iptvOrg) byKey.set(normName(c.name), { ...c });
  for (const c of freeTvIt) {
    const k = normName(c.name);
    const existing = byKey.get(k);
    if (existing) {
      // Stream Free-TV vince, logo del primo trovato (entrambi solitamente buoni),
      // ma un relinker RAI non sostituisce mai un link che funziona nel browser
      // Il link scartato resta come riserva in alts: se il primo non parte, play() prova il successivo
      const pool = [existing.stream, ...(existing.alts || [])];
      if (streamScore(c.stream) < streamScore(existing.stream)) {
        if (!pool.includes(c.stream)) byKey.set(k, { ...existing, alts: [...(existing.alts || []), c.stream] });
        continue;
      }
      byKey.set(k, { ...existing, stream: c.stream, alts: pool.filter(u => u && u !== c.stream), name: existing.name, logo: existing.logo || c.logo });
    } else {
      // Canale presente solo in Free-TV (es. Sky TG24)
      byKey.set(k, c);
    }
  }
  const list = [...byKey.values()].filter(c => c.stream);
  if (!list.length) throw new Error('Nessuna default list disponibile');
  loadedChannels = list;
  channels = mergeWithCatalog(list);
  localStorage.setItem(STORAGE_KEY, 'merged:default-v2');
  localStorage.setItem(CHANNELS_KEY, JSON.stringify(list));
  render();
}

async function loadDefaultListIfNeeded() {
  const stored = localStorage.getItem(STORAGE_KEY);
  // Se l'utente ha caricato un URL custom proprio, non sovrascrivere
  if (stored && !stored.startsWith('merged:') && stored !== DEFAULT_LIST_URL) return;
  if (localStorage.getItem('mytv.defaultTried_v4')) return;
  localStorage.setItem('mytv.defaultTried_v4', '1');
  try { await loadMergedDefaults(); }
  catch (e) { console.warn('Default merged fail:', e.message); try { await loadFromUrl(DEFAULT_LIST_URL); } catch {} }
}

document.addEventListener('DOMContentLoaded', () => {
  loadCached();
  setTab(currentTab);
  loadDefaultListIfNeeded();
  // pull iniziale se sync configurato
  if (localStorage.getItem(GIST_TOKEN_KEY)) {
    pullSync().catch(e => setSyncStatus('Errore sync: ' + e.message, 'err'));
  }

  $('#addBtn').addEventListener('click', openModal);
  $('#cancelBtn').addEventListener('click', closeModal);
  $('#loadBtn').addEventListener('click', async () => {
    const url = $('#listUrl').value.trim();
    if (!url) return;
    $('#loadBtn').textContent = 'Caricamento…';
    try { await loadFromUrl(url); closeModal(); scheduleSync(); }
    catch (e) { alert('Errore caricamento lista: ' + e.message); }
    finally { $('#loadBtn').textContent = 'Carica'; }
  });

  $('#reloadBtn').addEventListener('click', async () => {
    const url = localStorage.getItem(STORAGE_KEY);
    if (url) { try { await loadFromUrl(url); } catch (e) { alert('Errore: ' + e.message); } }
    if (localStorage.getItem(GIST_TOKEN_KEY)) pullSync().catch(()=>{});
  });

  $('#menuBtn').addEventListener('click', openMenu);
  $('#closeMenuBtn').addEventListener('click', closeMenu);
  $('#sideMenu').addEventListener('click', (e) => { if (e.target.id === 'sideMenu') closeMenu(); });

  $('#restoreDefaultBtn').addEventListener('click', async () => {
    $('#restoreDefaultBtn').textContent = 'Caricamento…';
    try { await loadMergedDefaults(); closeMenu(); scheduleSync(); }
    catch (e) { alert('Errore: ' + e.message); }
    finally { $('#restoreDefaultBtn').textContent = 'Ripristina lista predefinita'; }
  });
  $('#clearListBtn').addEventListener('click', () => {
    if (!confirm('Rimuovere la lista caricata?')) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CHANNELS_KEY);
    localStorage.removeItem('mytv.defaultTried');
    localStorage.removeItem('mytv.defaultTried_v3');
    localStorage.removeItem('mytv.defaultTried_v4');
    loadedChannels = [];
    channels = mergeWithCatalog([]);
    render();
    closeMenu();
    scheduleSync();
  });
  $('#resetFavBtn').addEventListener('click', () => {
    if (!confirm('Cancellare i preferiti?')) return;
    favs = new Set();
    persistFavs();
    render();
  });
  $('#resetCustomBtn').addEventListener('click', () => {
    if (!confirm('Resettare ordine personalizzato, canali nascosti e rinominati?')) return;
    order = {}; hidden = new Set(); renames = {};
    localStorage.setItem(ORDER_KEY, '{}');
    localStorage.setItem(HIDDEN_KEY, '[]');
    localStorage.setItem(RENAME_KEY, '{}');
    scheduleSync();
    render();
  });

  $('#favBtn').addEventListener('click', () => {
    showOnlyFavs = !showOnlyFavs;
    $('#favBtn').style.color = showOnlyFavs ? 'var(--accent)' : '';
    render();
  });

  $('#searchBtn').addEventListener('click', toggleSearch);
  $('#closeSearch').addEventListener('click', toggleSearch);
  $('#searchInput').addEventListener('input', (e) => { searchQuery = e.target.value.toLowerCase().trim(); render(); });

  $$('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

  $('#playPauseBtn').addEventListener('click', () => { const v = $('#video'); if (v.paused) v.play(); else v.pause(); });
  $('#reloadStreamBtn').addEventListener('click', reloadStream);
  $('#fullscreenBtn').addEventListener('click', enterFullscreen);
  $('#closePlayer').addEventListener('click', () => {
    const v = $('#video'); v.pause(); v.removeAttribute('src'); v.load();
    if (hls) { hls.destroy(); hls = null; }
    clearInterval(stallTimer);
    releaseWakeLock();
    currentItem = null; $('#nowPlaying').textContent = ''; render();
  });

  // Riprende il wake lock quando l'app torna in primo piano
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentItem && !wakeLock) {
      acquireWakeLock();
    }
  });

  // Toggle wake lock nelle impostazioni
  const wlBtn = $('#wakeLockToggle');
  if (wlBtn) {
    const refresh = () => { wlBtn.textContent = localStorage.getItem('mytv.wakeLockDisabled') === '1' ? 'Wake Lock OFF (audio si interrompe se schermo bloccato)' : 'Wake Lock ON (schermo resta acceso durante riproduzione)'; };
    refresh();
    wlBtn.addEventListener('click', () => {
      const off = localStorage.getItem('mytv.wakeLockDisabled') === '1';
      if (off) { localStorage.removeItem('mytv.wakeLockDisabled'); if (currentItem) acquireWakeLock(); }
      else { localStorage.setItem('mytv.wakeLockDisabled', '1'); releaseWakeLock(); }
      refresh();
    });
  }

  // Edit mode toggle
  $('#editModeBtn').addEventListener('click', () => { toggleEditMode(); closeMenu(); });

  // Rename modal
  $('#renameCancelBtn').addEventListener('click', closeRenameModal);
  $('#renameSaveBtn').addEventListener('click', saveRename);

  // Sync settings
  $('#saveTokenBtn').addEventListener('click', async () => {
    const tok = $('#gistTokenInput').value.trim();
    if (!tok) { localStorage.removeItem(GIST_TOKEN_KEY); localStorage.removeItem(GIST_ID_KEY); setSyncStatus('Sync disattivato', ''); return; }
    localStorage.setItem(GIST_TOKEN_KEY, tok);
    setSyncStatus('Token salvato. Sync in corso…', '');
    try { await pullSync(); } catch (e) { setSyncStatus('Errore: ' + e.message, 'err'); }
  });
  $('#manualSyncBtn').addEventListener('click', async () => {
    try { await pullSync(); } catch (e) { setSyncStatus('Errore: ' + e.message, 'err'); }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }

  // Bridge wrapper Electron
  if (window.mytvBridge) {
    const sendCatalog = () => {
      window.mytvBridge.sendCatalog({
        tv: channels.map(c => ({ name: displayName(c), stream: c.stream || null })),
        radio: RADIO_STATIONS.map(c => ({ name: c.name })),
      });
    };
    sendCatalog();
    const obs = new MutationObserver(() => sendCatalog());
    obs.observe($('#channelList'), { childList: true });
    window.mytvBridge.onPlay(({ name, kind }) => {
      const pool = kind === 'radio' ? RADIO_STATIONS : channels;
      const ch = pool.find(c => c.name === name || displayName(c) === name);
      if (ch) { setTab(kind); play(ch); }
    });
    window.mytvBridge.onToggle(() => { const v = $('#video'); if (v.paused) v.play(); else v.pause(); });
    window.mytvBridge.onStop(() => {
      const v = $('#video'); v.pause(); v.removeAttribute('src'); v.load();
      if (hls) { hls.destroy(); hls = null; }
      currentItem = null; window.mytvBridge.sendNowPlaying(null); render();
    });
  }
});
