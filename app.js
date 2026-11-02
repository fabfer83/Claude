// myTV — cross-platform TV/Radio streaming PWA
const APP_VERSION = '14 (02/11/2026)';   // da alzare con app.js?v= in index.html e la cache in sw.js
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

const STORAGE_KEY = 'mytv.listUrl';
const CHANNELS_KEY = 'mytv.channels';
const FAV_KEY = 'mytv.favs';
const TAB_KEY = 'mytv.tab';            // 'tv' | 'radio' | 'apps'
const ORDER_KEY = 'mytv.order';        // { tv: [id,...], radio: [id,...] }
const HIDDEN_KEY = 'mytv.hidden';      // [id,...]
const RENAME_KEY = 'mytv.renames';     // { id: "Nuovo nome" }
const GIST_TOKEN_KEY = 'mytv.gistToken';
const GIST_ID_KEY = 'mytv.gistId';
const SYNC_TS_KEY = 'mytv.syncTs';
// Chiavi nuove del restyling (solo aggiunte, le vecchie restano valide)
const VIEW_KEY = 'mytv.view';          // 'grid' | 'list'
const CHIP_KEY = 'mytv.chip';          // categoria TV scelta
const LAST_KEY = 'mytv.lastPlayed';    // { name, kind }

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
const TV_LCN = window.TV_LCN || {};
const APPS = window.APPS_CATALOG || [];

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

// Nome da mostrare: toglie risoluzione, [Geo-blocked], "(Italy)" e i residui di attributi M3U
// finiti nel nome con le vecchie liste. Non cambia l'ID del canale (ordine, nascosti, nomi restano validi).
function cleanName(raw) {
  let s = raw || '';
  const q = s.lastIndexOf('",');
  if (q !== -1) s = s.slice(q + 2);
  s = s.replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\(\s*\d{3,4}p\s*\)/gi, '')
    .replace(/\s*\((Italy|Italia|IT)\)/gi, '')
    .replace(/\s+(HD|SD|FHD)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  return s || raw;
}
const cleanKeyCache = new Map();
function cleanKey(ch) {
  let k = cleanKeyCache.get(ch.name);
  if (k === undefined) { k = normName(cleanName(ch.name)); cleanKeyCache.set(ch.name, k); }
  return k;
}

// Link che nel browser non partono: i "relinker" ufficiali RAI (mediapolis.rai.it) rifiutano
// le richieste da altri siti, i link http:// sono bloccati su una pagina https.
// Se per lo stesso canale c'è un link migliore, vince quello.
function streamScore(url) {
  if (/mediapolis(event)?\.rai\.it\/relinker/i.test(url || '')) return 0;
  if (/^http:\/\//i.test(url || '')) return 0;
  return 1;
}

// Con il player nativo (iPhone, iPad, Safari) il relinker RAI parte: il blocco riguarda solo
// hls.js. Per questi canali il link ufficiale va per primo e gli altri restano di riserva.
// Rai 2: il link CloudFront delle liste pubbliche ha l'80% dei quadri fermi (scatti), misurato
// il 02/11/2026; quello ufficiale RAI lo 0%.
const NATIVE_FIRST = {
  'rai 2': 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308718&output=7&forceUserAgent=rainet/4.0.5',
};
const isSafari = /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|Brave/.test(navigator.userAgent);
const nativeHls = () => isIOS || $('#video').canPlayType('application/vnd.apple.mpegurl') !== '';
// Nome breve della sorgente, mostrato sotto il canale e nel menu (per capire quale link è in uso)
function sourceLabel(url) {
  const u = url || '';
  if (/mediapolis(event)?\.rai\.it|akamaized\.net\/hls\/live\/\d+\/rai/i.test(u)) return 'RAI ufficiale';
  if (/mediaset\.net/i.test(u)) return 'Mediaset ufficiale';
  if (/cloudfront\.net/i.test(u)) return 'CloudFront';
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'link'; }
}

// Tutti i link del canale nell'ordine in cui provarli (_alt è l'indice qui dentro)
function streamList(ch) {
  const list = [ch.stream, ...(ch.alts || [])].filter(Boolean);
  const first = NATIVE_FIRST[channelId(ch)];
  if (!first || !nativeHls()) return list;
  return [first, ...list.filter(u => u !== first)];
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
let currentKind = 'tv';
let favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
let order = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
let hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'));
let renames = JSON.parse(localStorage.getItem(RENAME_KEY) || '{}');
let searchQuery = '';
let editMode = false;
let viewMode = localStorage.getItem(VIEW_KEY) || 'grid';
let currentChip = localStorage.getItem(CHIP_KEY) || 'all';
let zapList = [];          // canali nell'ordine mostrato, per ‹ ›

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
        // Il nome segue la prima virgola FUORI dalle virgolette (alcuni attributi,
        // es. http-user-agent, contengono virgole)
        const masked = line.replace(/"[^"]*"/g, m => '"' + '_'.repeat(m.length - 2) + '"');
        const comma = masked.indexOf(',');
        const logoMatch = line.match(/tvg-logo="([^"]+)"/);
        const countryMatch = line.match(/tvg-country="([^"]+)"/);
        const groupMatch = line.match(/group-title="([^"]+)"/);
        const rawName = comma !== -1 ? line.slice(comma + 1).trim() : 'Canale';
        // Free-TV/IPTV usa suffissi tipo "Ⓖ" (geo-locked label). Li rimuovo dal display.
        const cleanNm = rawName.replace(/[①-⓿☀-➿⬀-⯿️★]/g, '').replace(/\s+/g, ' ').trim();
        pending = {
          name: cleanNm || rawName,
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

// ---------- Categorie ----------
const CATEGORIES = [
  { id: 'all',    label: 'Tutti' },
  { id: 'favs',   label: 'Preferiti' },
  { id: 'gen',    label: 'Generalisti' },
  { id: 'kids',   label: 'Bambini' },
  { id: 'news',   label: 'News' },
  { id: 'sport',  label: 'Sport' },
  { id: 'cinema', label: 'Cinema e serie' },
  { id: 'music',  label: 'Musica' },
  { id: 'local',  label: 'Regionali e altri' },
];
const catCache = new Map();
function categoryOf(ch) {
  const key = ch.name + '|' + (ch.group || '');
  if (catCache.has(key)) return catCache.get(key);
  const n = cleanKey(ch);
  const g = (ch.group || '').toLowerCase();
  let c = 'local';
  if (/kids|animation/.test(g) || /^(boing|cartoonito|rai gulp|rai yoyo|frisbee|k2|super|super .+|nick.*|nickelodeon.*|dea kids|man ?ga|mr bean.*|teenage mutant.*|bejoykids|iunior tv|pluto tv teen.*)$/.test(n)) c = 'kids';
  else if (/news|business|legislative/.test(g) || /\b(news|tg|tg24|tgcom|tgcom24|tgs|telegiornale|euronews|cnbc|adnkronos|senato|camera dei deputati)\b/.test(n)) c = 'news';
  else if (/sport/.test(g) || /(sport|calcio|tennis|milan tv|inter tv|lazio style|motori|aci |fifa|horse tv|caccia|pesca|nautical)/.test(n)) c = 'sport';
  else if (/movies|series|classic/.test(g) || /(movie|cine|cinema|film|iris|rakuten|pluto tv|giallo|top crime|crime|serie)/.test(n)) c = 'cinema';
  else if (/music/.test(g) || /(radio|rtl 1025|deejay|m2o|kiss kiss|virgin|r101|music|rds )/.test(n)) c = 'music';
  else if (TV_LCN[n]) c = 'gen';
  catCache.set(key, c);
  return c;
}

// ---------- Ordering / hide / rename ----------
function lcnOf(ch) { return TV_LCN[cleanKey(ch)] || 1000; }
function applyOrder(items, tabKey) {
  const ord = order[tabKey];
  if (!Array.isArray(ord) || !ord.length) {
    // Nessun ordine scelto: prima i canali nazionali per numero del telecomando, poi gli altri
    if (tabKey !== 'tv') return items;
    return items.map((c, i) => [c, lcnOf(c), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(x => x[0]);
  }
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
  return cleanName(ch.name);
}

// Preferiti: si salvano per nome (come prima). Un canale è preferito anche se il nome
// salvato differisce solo per "(720p)", "HD" ecc. (es. "Rai 1" e "Rai 1 (720p)").
function isFav(ch) {
  if (favs.has(ch.name)) return true;
  const id = channelId(ch);
  for (const f of favs) if (normName(f) === id) return true;
  return false;
}

function persistOrder(tabKey, newIdsOrder) {
  order[tabKey] = newIdsOrder;
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  scheduleSync();
}
// Riordino di una parte della lista: gli altri canali restano dove sono
function persistSubsetOrder(tabKey, subsetIds) {
  const full = applyOrder(tabItems(tabKey), tabKey).map(channelId);
  const inSubset = new Set(subsetIds);
  let i = 0;
  const merged = full.map(id => inSubset.has(id) ? subsetIds[i++] : id);
  persistOrder(tabKey, merged);
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

function tabItems(tab) { return tab === 'radio' ? RADIO_STATIONS : channels; }
function kindOf(ch) { return RADIO_STATIONS.some(r => r.name === ch.name) ? 'radio' : 'tv'; }

// Canali visibili della sezione, ordinati e senza doppioni (stesso nome pulito)
function visibleItems(tab) {
  const items = tabItems(tab).filter(c => editMode || !hidden.has(channelId(c)));
  const ordered = applyOrder(items, tab);
  const best = new Map();
  const quality = c => (c.name.includes('",') ? 0 : 2) + (c.stream ? 1 : 0);
  for (const c of ordered) {
    const k = cleanKey(c);
    const prev = best.get(k);
    if (!prev || quality(c) > quality(prev)) best.set(k, c);
  }
  return ordered.filter(c => best.get(cleanKey(c)) === c);
}

// ---------- Rendering ----------
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6C19 16.5 12 21 12 21z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>';
const HEART_FULL = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6C19 16.5 12 21 12 21z" fill="currentColor"/></svg>';

function render() {
  const app = $('#app');
  app.classList.toggle('view-list', viewMode === 'list' || editMode);
  app.classList.toggle('section-apps', currentTab === 'apps');
  $('#sectionTitle').textContent = currentTab === 'tv' ? 'TV' : currentTab === 'radio' ? 'Radio' : 'App';
  $('#searchInput').placeholder = currentTab === 'tv' ? 'Cerca un canale' : currentTab === 'radio' ? 'Cerca una radio' : 'Cerca un\'app';
  $('#editDoneBtn').hidden = !editMode;

  const list = $('#channelList');
  const appsPanel = $('#appsPanel');
  if (currentTab === 'apps') {
    list.hidden = true; appsPanel.hidden = false;
    renderApps();
    updateSyncStatusUI();
    return;
  }
  list.hidden = false; appsPanel.hidden = true;
  list.innerHTML = '';

  const all = visibleItems(currentTab);
  renderChips(all);

  if (currentTab === 'tv' && loadedChannels.length === 0) {
    const n = document.createElement('div');
    n.className = 'notice';
    n.innerHTML = 'Caricamento della lista canali… Se non parte, apri <strong>Impostazioni</strong> e tocca «Ripristina lista predefinita».';
    list.appendChild(n);
  }

  let sections = [];
  if (editMode) {
    const b = document.createElement('div');
    b.className = 'edit-banner';
    b.textContent = 'Trascina ⠿ per cambiare l\'ordine, ✎ per rinominare, 👁 per nascondere. Tocca «Fine» quando hai finito.';
    list.appendChild(b);
    sections = [{ title: null, items: filterSearch(all) }];
  } else if (searchQuery) {
    const res = filterSearch(all);
    sections = [{ title: res.length ? 'Risultati' : null, items: res }];
    if (!res.length) list.insertAdjacentHTML('beforeend', '<div class="empty">Nessun risultato per «' + escapeHtml(searchQuery) + '».</div>');
  } else if (currentTab === 'radio') {
    const fav = all.filter(isFav);
    if (fav.length) sections.push({ title: 'Preferiti', items: fav });
    sections.push({ title: 'Tutte le radio', items: all });
  } else if (currentChip === 'all') {
    const fav = all.filter(isFav);
    if (fav.length) sections.push({ title: 'Preferiti', items: fav, chip: 'favs' });
    for (const cat of CATEGORIES.slice(2)) {
      const items = all.filter(c => categoryOf(c) === cat.id);
      if (items.length) sections.push({ title: cat.label, items, chip: cat.id });
    }
  } else if (currentChip === 'favs') {
    const fav = all.filter(isFav);
    sections = [{ title: null, items: fav }];
    if (!fav.length) list.insertAdjacentHTML('beforeend', '<div class="empty">Ancora nessun preferito.<br>Tieni premuto un canale (o usa ♥ nel player) per aggiungerlo.</div>');
  } else {
    sections = [{ title: null, items: all.filter(c => categoryOf(c) === currentChip) }];
  }

  // ‹ › seguono l'ordine completo in "Tutti", altrimenti quello mostrato (categoria o ricerca)
  const zapFull = currentTab === 'tv' && currentChip === 'all' && !searchQuery && !editMode;
  zapList = zapFull ? all.slice() : [];
  const asList = viewMode === 'list' || editMode;
  for (const sec of sections) {
    if (sec.title) {
      const h = document.createElement('div');
      h.className = 'section-head';
      h.innerHTML = '<span>' + escapeHtml(sec.title) + ' <span class="n">' + sec.items.length + '</span></span>';
      if (sec.chip && sec.items.length > 12 && currentChip === 'all') {
        const more = document.createElement('button');
        more.textContent = 'Vedi tutti';
        more.addEventListener('click', () => setChip(sec.chip));
        h.appendChild(more);
      }
      list.appendChild(h);
    }
    const wrap = document.createElement('div');
    wrap.className = asList ? 'list' : 'grid';
    // In "Tutti" ogni categoria mostra le prime 12 tessere: il resto con "Vedi tutti"
    const items = (!asList && currentChip === 'all' && !searchQuery && sec.chip && sec.chip !== 'favs' && currentTab === 'tv') ? sec.items.slice(0, 12) : sec.items;
    for (const ch of items) {
      wrap.appendChild(asList ? buildRow(ch) : buildTile(ch));
      if (!zapFull && !zapList.includes(ch)) zapList.push(ch);
    }
    list.appendChild(wrap);
  }
  updateNowFav();
  // toast eventuale stato sync
  updateSyncStatusUI();
}

function filterSearch(items) {
  if (!searchQuery) return items;
  return items.filter(c => displayName(c).toLowerCase().includes(searchQuery) || c.name.toLowerCase().includes(searchQuery));
}

function renderChips(all) {
  const chips = $('#chips');
  chips.innerHTML = '';
  if (currentTab !== 'tv' || editMode) { chips.hidden = true; return; }
  chips.hidden = false;
  for (const cat of CATEGORIES) {
    const n = cat.id === 'all' ? all.length : cat.id === 'favs' ? all.filter(isFav).length : all.filter(c => categoryOf(c) === cat.id).length;
    if (!n && cat.id !== 'favs') continue;
    const b = document.createElement('button');
    b.className = 'chip' + (currentChip === cat.id ? ' active' : '');
    b.setAttribute('role', 'tab');
    b.innerHTML = escapeHtml(cat.label) + ' <span class="n">' + n + '</span>';
    b.addEventListener('click', () => setChip(cat.id));
    chips.appendChild(b);
  }
}

function setChip(id) {
  currentChip = id;
  localStorage.setItem(CHIP_KEY, id);
  render();
  $('#scroller').scrollTop = 0;
  const active = $('#chips .chip.active');
  if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

function logoNode(ch, cls) {
  if (ch.logo) {
    const img = document.createElement('img');
    img.src = ch.logo; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.onerror = () => { img.replaceWith(initialsNode(ch)); };
    checkDarkLogo(img, ch.logo);
    return img;
  }
  return initialsNode(ch);
}

// Loghi neri o molto scuri (es. TV8) spariscono sul fondo scuro: li misuro una volta
// su canvas e, se serve, gli do un fondino chiaro. Esito salvato in mytv.darkLogos.
const DARK_KEY = 'mytv.darkLogos';
let darkLogos = {};
try { darkLogos = JSON.parse(localStorage.getItem(DARK_KEY) || '{}') || {}; } catch (e) {}
const darkPending = {};
function markDark(img) {
  img.classList.add('dark-logo');
  if (img.parentElement) img.parentElement.classList.add('dark-logo');
}
function checkDarkLogo(img, url) {
  if (darkLogos[url] === 1) { img.addEventListener('load', () => markDark(img)); return; }
  if (darkLogos[url] === 0) return;
  img.addEventListener('load', () => {
    measureLogo(url).then(dark => { if (dark) markDark(img); }, () => {});
  }, { once: true });
}
function measureLogo(url) {
  if (darkPending[url]) return darkPending[url];
  darkPending[url] = new Promise((resolve, reject) => {
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      try {
        const w = 48, h = Math.max(1, Math.round(48 * probe.naturalHeight / (probe.naturalWidth || 1)));
        const c = document.createElement('canvas');
        c.width = w; c.height = Math.min(h, 96);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(probe, 0, 0, c.width, c.height);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        let sum = 0, n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 128) continue;
          sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
          n++;
        }
        // solo loghi con buona parte trasparente: un logo opaco ha già il suo fondo
        const opaque = n / (px.length / 4);
        const dark = n > 0 && opaque < 0.9 && sum / n < 0.18;
        darkLogos[url] = dark ? 1 : 0;
        try { localStorage.setItem(DARK_KEY, JSON.stringify(darkLogos)); } catch (e) {}
        resolve(dark);
      } catch (e) { reject(e); } // canvas "sporcato" (niente CORS): lascio com'è
    };
    probe.onerror = reject;
    probe.src = url;
  });
  return darkPending[url];
}
function initialsNode(ch) {
  const d = document.createElement('span');
  d.className = 'initials';
  d.style.background = ch.color || colorFor(ch.name);
  d.textContent = initials(displayName(ch));
  return d;
}

function isPlaying(ch) { return currentItem && currentItem.name === ch.name; }

function buildTile(ch) {
  const el = document.createElement('button');
  el.className = 'tile';
  el.dataset.id = channelId(ch);
  if (isPlaying(ch)) el.classList.add('playing');
  if (!ch.stream && currentTab === 'tv') el.classList.add('no-stream');
  const logo = document.createElement('span');
  logo.className = 'tile-logo';
  logo.appendChild(logoNode(ch));
  el.appendChild(logo);
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = displayName(ch);
  el.appendChild(name);
  if (isFav(ch)) el.insertAdjacentHTML('beforeend', '<span class="tile-fav">' + HEART_FULL + '</span>');
  attachPress(el, ch);
  return el;
}

function buildRow(ch) {
  const li = document.createElement('div');
  li.className = 'row channel-item';
  const id = channelId(ch);
  li.dataset.id = id;
  if (isPlaying(ch)) li.classList.add('playing');
  if (hidden.has(id)) li.classList.add('hidden-channel');

  // drag handle (visibile solo in edit mode)
  const handle = document.createElement('div');
  handle.className = 'drag-handle';
  handle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6h2v2H9zM13 6h2v2h-2zM9 11h2v2H9zM13 11h2v2h-2zM9 16h2v2H9zM13 16h2v2h-2z" fill="currentColor"/></svg>';
  handle.addEventListener('pointerdown', (e) => startDrag(e, li));
  li.appendChild(handle);

  const logo = document.createElement('div');
  logo.className = 'logo';
  logo.appendChild(logoNode(ch));
  li.appendChild(logo);

  const name = document.createElement('div');
  name.className = 'channel-name';
  name.textContent = displayName(ch);
  li.appendChild(name);

  // Azioni normali (fav)
  const favBtn = document.createElement('button');
  favBtn.className = 'icon-btn fav-btn' + (isFav(ch) ? ' on' : '');
  favBtn.setAttribute('aria-label', 'Preferito');
  favBtn.innerHTML = HEART;
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

  if (!editMode) attachPress(li, ch);
  return li;
}

// Tocco = guarda; tieni premuto (o tasto destro) = menu del canale
function attachPress(el, ch) {
  let timer = null, startX = 0, startY = 0, longFired = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    longFired = false; startX = e.clientX; startY = e.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => { longFired = true; if (navigator.vibrate) navigator.vibrate(10); openSheet(ch); }, 480);
  });
  el.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) clearTimeout(timer); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, () => clearTimeout(timer)));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(timer); longFired = true; openSheet(ch); });
  el.addEventListener('click', (e) => {
    if (longFired) { e.preventDefault(); longFired = false; return; }
    choose(ch);
  });
}

function choose(ch) {
  if (!ch.stream) { toast('Nessuno stream disponibile per «' + displayName(ch) + '».'); return; }
  play(ch);
  if ($('#searchInput') === document.activeElement) $('#searchInput').blur();
}

// ---------- Drag & drop (dito e mouse, solo in modifica) ----------
function startDrag(e, li) {
  if (!editMode) return;
  e.preventDefault();
  const container = li.parentNode;
  const scroller = $('#scroller');
  li.classList.add('dragging');
  // Ascolto sul documento: spostare la riga nel DOM fa perdere la cattura del puntatore,
  // e con gli ascoltatori sulla maniglia il resto del trascinamento (e il salvataggio) andava perso.
  const pid = e.pointerId;
  const move = (ev) => {
    if (ev.pointerId !== pid) return;
    ev.preventDefault();
    const y = ev.clientY;
    let prev = li.previousElementSibling, next = li.nextElementSibling;
    while (prev && y < prev.getBoundingClientRect().top + prev.offsetHeight / 2) { container.insertBefore(li, prev); prev = li.previousElementSibling; }
    while (next && y > next.getBoundingClientRect().top + next.offsetHeight / 2) { container.insertBefore(next, li); next = li.nextElementSibling; }
    const r = scroller.getBoundingClientRect();
    if (y < r.top + 60) scroller.scrollTop -= 14;
    else if (y > r.bottom - 60) scroller.scrollTop += 14;
  };
  const up = (ev) => {
    if (ev.pointerId !== pid) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    li.classList.remove('dragging');
    const ids = $$('.row', container).map(r => r.dataset.id);
    persistSubsetOrder(currentTab, ids);
  };
  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

function initials(name) {
  return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 55%, 35%)`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function toggleFav(ch) {
  if (isFav(ch)) {
    const id = channelId(ch);
    for (const f of [...favs]) if (f === ch.name || normName(f) === id) favs.delete(f);
    toast('Tolto dai preferiti');
  } else {
    favs.add(ch.name);
    toast('Aggiunto ai preferiti');
  }
  persistFavs();
  render();
}
function toggleHidden(ch) {
  const id = channelId(ch);
  if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
  persistHidden();
  render();
}

// ---------- Menu del canale ----------
let sheetCh = null;
function openSheet(ch) {
  sheetCh = ch;
  $('#sheetTitle').textContent = displayName(ch);
  $('#sheetLogo').style.backgroundImage = ch.logo ? `url("${ch.logo}")` : '';
  $('#sheetFav').textContent = isFav(ch) ? 'Togli dai preferiti' : 'Aggiungi ai preferiti';
  $('#sheetHide').textContent = hidden.has(channelId(ch)) ? 'Mostra di nuovo' : 'Nascondi';
  $('#sheet').classList.remove('hidden');
}
function closeSheet() { $('#sheet').classList.add('hidden'); sheetCh = null; }

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
  if (currentItem) updateNowPlaying(currentItem);
}

// ---------- Sezione App ----------
const ARROW = '<svg class="arrow" viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function renderApps() {
  const p = $('#appsPanel');
  const q = searchQuery;
  const apps = APPS.filter(a => !q || a.name.toLowerCase().includes(q));
  p.innerHTML = '';
  p.insertAdjacentHTML('beforeend', '<p class="apps-intro">Tocca un servizio: si apre la sua app ufficiale (se è installata) o il suo sito. Accedi lì una volta sola: il login resta salvato nell\'app o nel browser, myTV non chiede e non conserva password.</p>');
  const grid = document.createElement('div');
  grid.className = 'apps-grid';
  for (const a of apps) {
    const t = document.createElement('a');
    t.className = 'app-tile' + (a.dark ? ' dark-text' : '');
    t.href = a.url; t.target = '_blank'; t.rel = 'noopener noreferrer';
    t.style.background = a.bg;
    t.style.color = a.fg;
    t.innerHTML = ARROW + '<span class="app-mark' + (a.font === 'heavy' ? ' heavy' : '') + '">' + escapeHtml(a.mark) + '</span><span class="app-sub">' + escapeHtml(a.name) + '</span>';
    if (a.accent) t.querySelector('.app-mark').style.textShadow = `0 0 24px ${a.accent}55`;
    grid.appendChild(t);
  }
  p.appendChild(grid);
  if (!apps.length) p.insertAdjacentHTML('beforeend', '<div class="empty">Nessuna app trovata.</div>');
  p.insertAdjacentHTML('beforeend', '<div class="apps-note"><strong>Perché non si guardano dentro myTV?</strong> Netflix, Prime Video, Disney+ e gli altri proteggono i video con il DRM e vietano di essere aperti dentro altri siti. Per questo myTV li apre nella loro app o nel loro sito, dove resti collegato.<ul><li><strong>iPhone e iPad:</strong> con l\'app del servizio installata si apre l\'app; altrimenti il sito.</li><li><strong>Mac:</strong> si apre il sito in una finestra del browser, già collegato dopo il primo accesso.</li></ul></div>');
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
  const md = { title: displayName(ch), artist: 'myTV', album: currentKind === 'radio' ? 'Radio' : 'TV' };
  if (ch.logo) md.artwork = [
    { src: ch.logo, sizes: '96x96',  type: 'image/png' },
    { src: ch.logo, sizes: '192x192', type: 'image/png' },
    { src: ch.logo, sizes: '512x512', type: 'image/png' },
  ];
  try { navigator.mediaSession.metadata = new MediaMetadata(md); } catch {}
  const v = $('#video');
  navigator.mediaSession.setActionHandler('play',  () => { v.play().catch(()=>{}); });
  navigator.mediaSession.setActionHandler('pause', () => v.pause());
  navigator.mediaSession.setActionHandler('stop',  () => stopPlayback());
  try {
    navigator.mediaSession.setActionHandler('previoustrack', () => zap(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => zap(1));
  } catch {}
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
      // playhead fermo: se più di 10s, prova reload. Il link ufficiale RAI all'avvio può metterci
      // più di 10 s (redirect, chiave, segmenti da 10 s): gli do 25 s prima di passare alla riserva
      const slowStart = t === 0 && sourceLabel(streamList(currentItem)[currentItem._alt || 0]) === 'RAI ufficiale';
      if (Date.now() - lastPlayheadAt > (slowStart ? 25000 : 10000)) {
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
  const wasMini = $('#app').classList.contains('mini') && !autoMini;
  currentItem = ch;
  currentKind = kindOf(ch);
  updateNowPlaying(ch);
  const video = $('#video');
  if (hls) { hls.destroy(); hls = null; }
  clearTimeout(recoveryTimer);

  const url = streamList(ch)[ch._alt || 0];
  const isHls = /\.m3u8(\?|$)/i.test(url);
  const safariCanPlayHLS = video.canPlayType('application/vnd.apple.mpegurl') !== '';
  if (currentKind !== 'radio') {
    const src = sourceLabel(url) + (ch._alt ? ' (riserva)' : '');
    $('#nowSub').textContent = 'Avvio in corso… · ' + src;
    video.addEventListener('playing', () => { if (currentItem === ch) $('#nowSub').textContent = 'In diretta · ' + src; }, { once: true });
  }

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
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ name: ch.name, kind: currentKind })); } catch {}

  if (window.mytvBridge) window.mytvBridge.sendNowPlaying(displayName(ch));
  // Un canale scelto apre il player grande (se era ridotto in automatico per la ricerca)
  if (!wasMini) setMini(false);
  markPlaying();
}
// Ricarica ripartendo dal link principale: se anche le riserve non sono andate,
// non si resta bloccati sull'ultima (es. relinker RAI, che nel browser non parte mai)
function reloadStream() { if (currentItem) play(currentItem._alt ? { ...currentItem, _alt: 0 } : currentItem); }
// Passa al link di riserva successivo del canale. false se non ce ne sono altri.
function tryNextStream() {
  const ch = currentItem;
  const next = (ch && ch._alt || 0) + 1;
  if (!ch || next >= streamList(ch).length) return false;
  console.warn('Stream non disponibile, provo il link di riserva', next);
  play({ ...ch, _alt: next });
  return true;
}

function stopPlayback() {
  const v = $('#video'); v.pause(); v.removeAttribute('src'); v.load();
  if (hls) { hls.destroy(); hls = null; }
  clearInterval(stallTimer);
  clearTimeout(recoveryTimer);
  releaseWakeLock();
  currentItem = null;
  const app = $('#app');
  app.classList.remove('has-player', 'playing', 'paused', 'mini');
  $('#playerWrap').dataset.state = 'idle';
  $('#playerWrap').classList.remove('loading');
  $('#nowPlaying').textContent = '';
  if (window.mytvBridge) window.mytvBridge.sendNowPlaying(null);
  markPlaying();
}

function updateNowPlaying(ch) {
  const app = $('#app');
  const stage = $('#playerWrap');
  app.classList.add('has-player', 'playing');
  stage.dataset.state = 'playing';
  stage.dataset.kind = currentKind;
  stage.classList.remove('has-resume');
  $('#resumeBtn').hidden = true;
  $('#nowPlaying').textContent = displayName(ch);
  $('#nowSub').textContent = currentKind === 'radio' ? 'Radio in diretta' : 'In diretta';
  setLogoBox($('#nowLogo'), ch);
  setLogoBox($('#radioLogo'), ch);
  updateNowFav();
}
function setLogoBox(box, ch) {
  box.textContent = '';
  box.style.backgroundImage = ch.logo ? `url("${ch.logo}")` : '';
  if (!ch.logo) box.textContent = initials(displayName(ch));
}
function updateNowFav() {
  const b = $('#nowFavBtn');
  if (!b) return;
  const on = !!(currentItem && isFav(currentItem));
  b.classList.toggle('on', on);
  b.innerHTML = on ? HEART_FULL : HEART;
}
function markPlaying() {
  $$('#channelList .tile, #channelList .row').forEach(el => {
    el.classList.toggle('playing', !!currentItem && el.dataset.id === channelId(currentItem));
  });
}

// Cambio canale ‹ › nell'ordine mostrato
function zap(dir) {
  if (!currentItem) return;
  let pool = zapList.filter(c => kindOf(c) === currentKind && c.stream);
  let i = pool.findIndex(c => c.name === currentItem.name);
  if (i === -1) { pool = visibleItems(currentKind).filter(c => c.stream); i = pool.findIndex(c => c.name === currentItem.name); }
  if (!pool.length) return;
  const next = pool[(i + dir + pool.length) % pool.length];
  play(next);
  const el = $(`#channelList [data-id="${CSS.escape(channelId(next))}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Mini-player su telefono
let autoMini = false;
function setMini(on, auto = false) {
  const app = $('#app');
  if (!app.classList.contains('has-player') && on) return;
  app.classList.toggle('mini', on);
  autoMini = on && auto;
}

// "Riprendi" l'ultimo canale guardato (senza partire da solo: iPhone blocca l'audio automatico)
function showResume() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch {}
  if (!last) return;
  const pool = last.kind === 'radio' ? RADIO_STATIONS : channels;
  const ch = pool.find(c => c.name === last.name) || pool.find(c => normName(c.name) === normName(last.name));
  if (!ch || !ch.stream || currentItem) return;
  const stage = $('#playerWrap');
  $('#resumeName').textContent = displayName(ch);
  $('#resumeBtn').hidden = false;
  $('#resumeBtn').onclick = () => play(ch);
  stage.classList.add('has-resume');
  stage.dataset.kind = last.kind;
  setLogoBox($('#radioLogo'), ch);
  $('#nowPlaying').textContent = displayName(ch);
  $('#nowSub').textContent = 'Ultimo canale guardato';
  setLogoBox($('#nowLogo'), ch);
  // Su telefono il riquadro "Riprendi" occupa spazio solo come mini-player
  $('#app').classList.add('has-player');
  if (!window.matchMedia('(min-width: 600px)').matches) setMini(true, true);
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
    if (p.listUrl.startsWith('merged:')) loadMergedDefaults().catch(()=>{});
    else loadFromUrl(p.listUrl).catch(()=>{});
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
  if (!['tv', 'radio', 'apps'].includes(tab)) tab = 'tv';
  currentTab = tab;
  localStorage.setItem(TAB_KEY, tab);
  $$('.rail-btn[data-section]').forEach(t => t.classList.toggle('active', t.dataset.section === tab));
  if (editMode && tab === 'apps') toggleEditMode();
  render();
  $('#scroller').scrollTop = 0;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function openModal() { $('#modal').classList.remove('hidden'); const u = localStorage.getItem(STORAGE_KEY) || ''; $('#listUrl').value = u.startsWith('merged:') ? '' : u; setTimeout(()=>$('#listUrl').focus(), 100); }
function closeModal() { $('#modal').classList.add('hidden'); }
function openMenu() { $('#sideMenu').classList.remove('hidden'); $('#gistTokenInput').value = localStorage.getItem(GIST_TOKEN_KEY) || ''; updateSyncStatusUI(); updateAbout(); }
// Impostazioni → Informazioni: versione, player e sorgente del canale in onda
async function updateAbout() {
  let cache = '';
  try { cache = (await caches.keys()).filter(k => k.startsWith('mytv-')).join(', '); } catch {}
  const lines = ['Versione ' + APP_VERSION + (cache ? ' · cache ' + cache : ''),
    'Player: ' + (!nativeHls() ? 'hls.js' : (isIOS || isSafari) ? 'nativo di Apple' : 'nativo del browser')];
  if (currentItem && currentKind !== 'radio') {
    lines.push('In onda: ' + displayName(currentItem) + ' da ' + sourceLabel(streamList(currentItem)[currentItem._alt || 0]) + (currentItem._alt ? ' (riserva)' : ''));
  }
  $('#aboutInfo').textContent = lines.join('\n');
}
function closeMenu() { $('#sideMenu').classList.add('hidden'); }
function clearSearch() {
  searchQuery = ''; $('#searchInput').value = ''; $('#closeSearch').hidden = true; render();
}
function toggleEditMode() {
  editMode = !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  $('#editModeBtn').textContent = editMode ? 'Esci da modifica' : 'Modifica lista (ordina, nascondi, rinomina)';
  if (editMode && currentTab === 'apps') { currentTab = 'tv'; setTab('tv'); return; }
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
  if (!CATEGORIES.some(c => c.id === currentChip)) currentChip = 'all';
  setTab(currentTab);
  showResume();
  loadDefaultListIfNeeded().then(() => { if (!currentItem && $('#resumeBtn').hidden) showResume(); });
  // pull iniziale se sync configurato
  if (localStorage.getItem(GIST_TOKEN_KEY)) {
    pullSync().catch(e => setSyncStatus('Errore sync: ' + e.message, 'err'));
  }

  $$('.rail-btn[data-section]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.section === currentTab) { $('#scroller').scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (searchQuery) { searchQuery = ''; $('#searchInput').value = ''; $('#closeSearch').hidden = true; }
    setTab(b.dataset.section);
  }));

  $('#addBtn').addEventListener('click', () => { closeMenu(); openModal(); });
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
    $('#reloadBtn').textContent = 'Aggiornamento…';
    try {
      if (!url || url.startsWith('merged:')) await loadMergedDefaults();
      else await loadFromUrl(url);
      toast('Lista aggiornata');
    } catch (e) { alert('Errore: ' + e.message); }
    finally { $('#reloadBtn').textContent = 'Aggiorna la lista'; }
    if (localStorage.getItem(GIST_TOKEN_KEY)) pullSync().catch(()=>{});
  });

  $('#menuBtn').addEventListener('click', openMenu);
  $('#closeMenuBtn').addEventListener('click', closeMenu);
  $('#closeMenuX').addEventListener('click', closeMenu);
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

  // Ricerca sempre visibile
  const si = $('#searchInput');
  si.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    $('#closeSearch').hidden = !e.target.value;
    render();
  });
  si.addEventListener('focus', () => {
    // Su telefono la tastiera copre metà schermo: il player si riduce
    if (!window.matchMedia('(min-width: 600px)').matches && currentItem) setMini(true, true);
  });
  si.addEventListener('blur', () => { if (autoMini && !searchQuery && currentItem) setMini(false); });
  si.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = zapList.find(c => c.stream); if (first) { choose(first); } }
    if (e.key === 'Escape') { clearSearch(); si.blur(); }
  });
  $('#closeSearch').addEventListener('click', (e) => { e.preventDefault(); clearSearch(); });

  $('#viewBtn').addEventListener('click', () => {
    viewMode = viewMode === 'grid' ? 'list' : 'grid';
    localStorage.setItem(VIEW_KEY, viewMode);
    render();
  });
  $('#editDoneBtn').addEventListener('click', toggleEditMode);

  // Player
  const v = $('#video');
  const stage = $('#playerWrap');
  const setPaused = () => $('#app').classList.toggle('paused', v.paused);
  v.addEventListener('play', setPaused);
  v.addEventListener('pause', setPaused);
  v.addEventListener('waiting', () => stage.classList.add('loading'));
  v.addEventListener('loadstart', () => { if (currentItem) stage.classList.add('loading'); });
  ['playing', 'canplay', 'emptied', 'error'].forEach(t => v.addEventListener(t, () => stage.classList.remove('loading')));
  $('#playPauseBtn').addEventListener('click', () => { if (!currentItem) { $('#resumeBtn').click(); return; } if (v.paused) v.play(); else v.pause(); });
  $('#reloadStreamBtn').addEventListener('click', reloadStream);
  $('#fullscreenBtn').addEventListener('click', enterFullscreen);
  $('#prevBtn').addEventListener('click', () => zap(-1));
  $('#nextBtn').addEventListener('click', () => zap(1));
  $('#nowFavBtn').addEventListener('click', () => { if (currentItem) toggleFav(currentItem); });
  $('#miniBtn').addEventListener('click', () => setMini(!$('#app').classList.contains('mini')));
  $('#closePlayer').addEventListener('click', stopPlayback);
  // Mini-player: toccandolo si riapre grande
  stage.addEventListener('click', (e) => {
    if (!$('#app').classList.contains('mini') || e.target.closest('button')) return;
    if (!currentItem) { $('#resumeBtn').click(); return; }
    setMini(false);
  });

  // AirPlay (Apple TV, smart TV, auto compatibili con "AirPlay in auto")
  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    v.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => { $('#castBtn').hidden = e.availability !== 'available'; });
    $('#castBtn').addEventListener('click', () => { try { v.webkitShowPlaybackTargetPicker(); } catch {} });
  }
  // Picture in Picture
  const canPip = document.pictureInPictureEnabled || (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture'));
  if (canPip) {
    $('#pipBtn').hidden = false;
    $('#pipBtn').addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (v.requestPictureInPicture) await v.requestPictureInPicture();
        else v.webkitSetPresentationMode('picture-in-picture');
      } catch {}
    });
  }

  // Menu del canale
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#sheetCancel').addEventListener('click', closeSheet);
  $('#sheetPlay').addEventListener('click', () => { const c = sheetCh; closeSheet(); if (c) choose(c); });
  $('#sheetFav').addEventListener('click', () => { const c = sheetCh; closeSheet(); if (c) toggleFav(c); });
  $('#sheetRename').addEventListener('click', () => { const c = sheetCh; closeSheet(); if (c) openRenameModal(c); });
  $('#sheetHide').addEventListener('click', () => { const c = sheetCh; closeSheet(); if (c) { toggleHidden(c); toast(hidden.has(channelId(c)) ? 'Canale nascosto (lo ritrovi in Modifica lista)' : 'Canale di nuovo visibile'); } });

  // Scorciatoie da tastiera (Mac)
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); si.focus(); }
    else if (e.key === 'ArrowUp' && currentItem) { e.preventDefault(); zap(-1); }
    else if (e.key === 'ArrowDown' && currentItem) { e.preventDefault(); zap(1); }
    else if ((e.key === 'f' || e.key === 'F') && currentItem) enterFullscreen();
    else if (e.key === ' ' && currentItem && document.activeElement === document.body) { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
    else if (e.key === 'Escape') { closeSheet(); closeMenu(); }
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
    const refresh = () => { wlBtn.textContent = localStorage.getItem('mytv.wakeLockDisabled') === '1' ? 'Wake Lock OFF (lo schermo si spegne)' : 'Wake Lock ON (schermo acceso durante la riproduzione)'; };
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
  $('#renameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveRename(); });

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
    // Al ritorno in primo piano (app sulla Home che resta in memoria) controllo se c'è una versione nuova
    navigator.serviceWorker.register('sw.js').then(reg => {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(()=>{}); });
    }).catch(()=>{});
    // Versione nuova attiva: ricarico subito se non si sta guardando niente, altrimenti avviso
    const hadController = !!navigator.serviceWorker.controller;
    let swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || swReloaded) return;
      swReloaded = true;
      if (!currentItem || $('#video').paused) location.reload();
      else toast('myTV aggiornata: la nuova versione parte alla prossima apertura');
    });
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
    window.mytvBridge.onStop(() => stopPlayback());
  }
});
