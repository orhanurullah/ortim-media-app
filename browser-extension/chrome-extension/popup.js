/**
 * ODM Popup — IDM-style stream list and queue actions.
 *
 * Talks only to the background script via chrome.runtime messages. The
 * background owns the bridge connection, the per-tab stream cache, and the
 * download orchestration.
 */

const els = {
    bridgeStatus: document.getElementById('bridge-status'),
    statusDot: document.querySelector('#bridge-status .odm-status__dot'),
    statusText: document.querySelector('#bridge-status .odm-status__text'),
    reconnectBtn: document.getElementById('reconnect-btn'),
    streamsCount: document.getElementById('streams-count'),
    streamsList: document.getElementById('streams-list'),
    streamsEmpty: document.getElementById('streams-empty'),
    scanBtn: document.getElementById('scan-btn'),
    queueActive: document.getElementById('queue-active'),
    queuePending: document.getElementById('queue-pending'),
    undelivered: document.getElementById('undelivered'),
    bridgeHint: document.getElementById('bridge-hint'),
    rowTemplate: document.getElementById('stream-row-template'),
};

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

// --- i18n: the popup mirrors the desktop app's language, relayed by the bridge.
const MESSAGES = {
    tr: {
        connecting: 'bağlanıyor…', reconnecting: 'yeniden bağlanılıyor…',
        connected: 'bağlı · port {port}', disconnected: 'kopuk',
        noResponse: 'cevap yok', startFailed: 'başlatılamadı',
        bridgeVersion: 'köprü {version}', lastSeen: 'son görülen {time}',
        desktopOpen: 'masaüstü açık mı?', justNow: 'az önce',
        minAgo: '{n} dk önce', hourAgo: '{n} sa önce', dayAgo: '{n} gün önce',
        sectionTitle: 'Bu sekmedeki ortam', emptyLine1: 'Henüz ortam yakalanmadı.',
        privacyNote: 'Akışları algılamak için her sitede çalışır. Bulunanlar yalnızca bu bilgisayardaki OMM uygulamasına gider, başka hiçbir yere gönderilmez.',
        emptyLine2: 'Sayfayı yenileyin veya ', scanStart: 'tarama başlat',
        scanning: 'taranıyor…', active: 'Aktif:', pending: 'Bekleyen:',
        reconnectTitle: 'Yeniden bağlan', btnQueue: 'Kuyruğa', btnFormat: 'Format ▾',
        btnAnalyze: 'Analiz', btnTranscribe: 'Transkribe',
        titleFormat: 'İndirme formatı seç', titleAnalyze: 'Detaylı analiz et',
        titleTranscribe: "OMM'de indir + otomatik yazıya dök (Studio)",
        sending: 'gönderiliyor…', added: 'eklendi', notConnected: 'bağlı değil',
        failed: 'başarısız', opened: 'açıldı', launching: 'OMM açılıyor…',
        undelivered: '{n} iş OMM açılınca gönderilecek',
        fmtVideoBest: 'Video · En iyi', fmtVideo1080: 'Video · 1080p',
        fmtVideo720: 'Video · 720p', fmtVideo480: 'Video · 480p', fmtAudioMp3: 'Ses · MP3',
        mediaPage: 'medya sayfası', webPage: 'web sayfası', ytdlpAnalyzes: 'yt-dlp analiz eder',
        kindHls: 'HLS akışı', kindDash: 'DASH akışı', kindAudio: 'Ses', kindVideo: 'Video',
        showAll: 'Sayfadaki diğer {n} akışı göster', showLess: 'Listeyi kısalt',
        rejected: 'reddedildi',
    },
    en: {
        connecting: 'connecting…', reconnecting: 'reconnecting…',
        connected: 'connected · port {port}', disconnected: 'disconnected',
        noResponse: 'no response', startFailed: 'failed to start',
        bridgeVersion: 'bridge {version}', lastSeen: 'last seen {time}',
        desktopOpen: 'is the desktop app open?', justNow: 'just now',
        minAgo: '{n} min ago', hourAgo: '{n} h ago', dayAgo: '{n} d ago',
        sectionTitle: 'Media on this tab', emptyLine1: 'No media captured yet.',
        privacyNote: 'Runs on every site so it can detect streams. What it finds goes only to the OMM app on this computer, and nowhere else.',
        emptyLine2: 'Reload the page or ', scanStart: 'start a scan',
        scanning: 'scanning…', active: 'Active:', pending: 'Pending:',
        reconnectTitle: 'Reconnect', btnQueue: 'Queue', btnFormat: 'Format ▾',
        btnAnalyze: 'Analyze', btnTranscribe: 'Transcript',
        titleFormat: 'Choose download format', titleAnalyze: 'Analyze in detail',
        titleTranscribe: 'Download in OMM + auto-transcribe (Studio)',
        sending: 'sending…', added: 'added', notConnected: 'not connected',
        failed: 'failed', opened: 'opened', launching: 'opening OMM…',
        undelivered: '{n} waiting for OMM to open',
        fmtVideoBest: 'Video · Best', fmtVideo1080: 'Video · 1080p',
        fmtVideo720: 'Video · 720p', fmtVideo480: 'Video · 480p', fmtAudioMp3: 'Audio · MP3',
        mediaPage: 'media page', webPage: 'web page', ytdlpAnalyzes: 'yt-dlp analyzes it',
        kindHls: 'HLS stream', kindDash: 'DASH stream', kindAudio: 'Audio', kindVideo: 'Video',
        showAll: 'Show the other {n} streams on this page', showLess: 'Show fewer',
        rejected: 'rejected',
    },
};

let LANG = 'tr';

function t(key, params) {
    let text = (MESSAGES[LANG] && MESSAGES[LANG][key]) || MESSAGES.tr[key] || key;
    if (params) {
        for (const [name, value] of Object.entries(params)) {
            text = text.replace(`{${name}}`, value);
        }
    }
    return text;
}

function applyStaticI18n() {
    document.documentElement.lang = LANG;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.title = t(el.dataset.i18nTitle);
        if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', t(el.dataset.i18nTitle));
    });
}

function setLanguage(language) {
    const next = language === 'en' ? 'en' : 'tr';
    if (next === LANG) return false;
    LANG = next;
    return true;
}

const FORMAT_OPTIONS = [
    { labelKey: 'fmtVideoBest', type: 'video', quality: 'best' },
    { labelKey: 'fmtVideo1080', type: 'video', quality: '1080' },
    { labelKey: 'fmtVideo720',  type: 'video', quality: '720' },
    { labelKey: 'fmtVideo480',  type: 'video', quality: '480' },
    { divider: true },
    { labelKey: 'fmtAudioMp3', type: 'audio', quality: 'best' },
];

let activeTabId = null;
let cachedStreams = [];
let pageCapture = null;

init().catch((error) => {
    console.error('[ODM popup] init failed', error);
    setStatus('disconnected', t('startFailed'));
});

async function init() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tabs[0]?.id ?? null;

    applyStaticI18n();
    bindEventHandlers();
    chrome.runtime.onMessage.addListener(onBackgroundEvent);
    document.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest('.odm-menu') || event.target.closest('[data-role="more"]')) return;
        closeAllMenus();
    });

    await renderCachedSnapshot();
    await refresh();
}

async function renderCachedSnapshot() {
    if (!chrome.storage?.session) return;
    try {
        const stored = (await chrome.storage.session.get('odmBridgeCache'))?.odmBridgeCache;
        if (!stored?.snapshot) return;
        applyBridge(stored.snapshot, { fromCache: true, savedAt: stored.savedAt, lastConnectedAt: stored.lastConnectedAt });
    } catch {
        /* storage unavailable; ignore */
    }
}

function bindEventHandlers() {
    els.scanBtn.addEventListener('click', async () => {
        if (!Number.isInteger(activeTabId)) return;
        els.scanBtn.disabled = true;
        const before = els.scanBtn.textContent;
        els.scanBtn.textContent = t('scanning');
        await sendMessage({ action: 'POPUP_SCAN_TAB', tabId: activeTabId });
        await refresh();
        els.scanBtn.textContent = before;
        els.scanBtn.disabled = false;
    });

    els.reconnectBtn.addEventListener('click', async () => {
        await sendMessage({ action: 'POPUP_FORCE_RECONNECT' });
        setStatus('connecting', t('reconnecting'));
        setTimeout(refresh, 600);
    });
}

async function refresh() {
    const state = await sendMessage({ action: 'POPUP_GET_STATE', tabId: activeTabId });
    if (!state || !state.ok) {
        setStatus('disconnected', t('noResponse'));
        return;
    }
    applyBridge(state.bridge);
    cachedStreams = state.streams || [];
    pageCapture = state.pageCapture || null;
    renderStreams();
    refreshUndelivered();
}

// Sends made while the desktop app was closed sit in the extension until the
// bridge returns. Without this line the popup showed "Bekleyen: 0" for them,
// which reads as "nothing was sent".
async function refreshUndelivered() {
    const handoff = await sendMessage({ action: 'WAKE_GET_STATE' });
    applyUndelivered(handoff);
}

function applyUndelivered(handoff) {
    if (!els.undelivered) return;
    const count = handoff?.pending?.length || 0;
    els.undelivered.hidden = count === 0;
    els.undelivered.textContent = count === 0 ? '' : t('undelivered', { n: count });
    els.undelivered.title = count === 0 ? '' : (handoff.pending || []).join('\n');
}

let lastConnectedAt = null;

function applyBridge(bridge, meta) {
    if (!bridge) return;
    if (bridge.uiLanguage && setLanguage(bridge.uiLanguage)) {
        applyStaticI18n();
        renderStreams();
    }
    if (meta?.lastConnectedAt) lastConnectedAt = meta.lastConnectedAt;
    if (bridge.status === 'CONNECTED') {
        lastConnectedAt = Date.now();
        setStatus('connected', t('connected', { port: bridge.port }));
        els.bridgeHint.textContent = bridge.bridgeVersion ? t('bridgeVersion', { version: bridge.bridgeVersion }) : '';
        els.bridgeHint.title = '';
    } else if (bridge.status === 'CONNECTING') {
        setStatus('connecting', t('connecting'));
        els.bridgeHint.textContent = '';
        els.bridgeHint.title = '';
    } else {
        setStatus('disconnected', t('disconnected'));
        const stalePart = lastConnectedAt ? t('lastSeen', { time: formatRelativeTime(lastConnectedAt) }) : null;
        els.bridgeHint.textContent = stalePart || bridge.lastError || t('desktopOpen');
        els.bridgeHint.title = bridge.lastError || '';
    }
    els.queueActive.textContent = bridge.activeQueueCount ?? 0;
    els.queuePending.textContent = Math.max((bridge.queueCount ?? 0) - (bridge.activeQueueCount ?? 0), 0);
}

function formatRelativeTime(timestamp) {
    const deltaSec = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (deltaSec < 45) return t('justNow');
    const deltaMin = Math.round(deltaSec / 60);
    if (deltaMin < 60) return t('minAgo', { n: deltaMin });
    const deltaHr = Math.round(deltaMin / 60);
    if (deltaHr < 24) return t('hourAgo', { n: deltaHr });
    const deltaDay = Math.round(deltaHr / 24);
    return t('dayAgo', { n: deltaDay });
}

function setStatus(state, text) {
    els.statusDot.dataset.state = state;
    els.statusText.textContent = text;
}

// How many rows to show before folding the rest away. A social feed autoplays
// every video it scrolls past, so the honest count can be dozens — and a wall of
// dozens is what stopped the list being readable at all. The page row and the
// first few streams are what a user acts on; the rest stay one click away.
const COLLAPSED_ROW_LIMIT = 6;
let showAllRows = false;

function renderStreams() {
    const rows = [];
    if (pageCapture) rows.push({ ...pageCapture, _isPage: true });
    for (const stream of cachedStreams) rows.push(stream);

    els.streamsCount.textContent = rows.length;
    els.streamsList.innerHTML = '';

    if (rows.length === 0) {
        showAllRows = false;
        els.streamsList.appendChild(els.streamsEmpty);
        els.streamsEmpty.style.display = '';
        const link = els.streamsEmpty.querySelector('#scan-btn');
        if (link) {
            link.addEventListener('click', () => els.scanBtn.click(), { once: true });
        }
        return;
    }

    assignDisplayLabels(rows);

    const collapsed = !showAllRows && rows.length > COLLAPSED_ROW_LIMIT;
    const visible = collapsed ? rows.slice(0, COLLAPSED_ROW_LIMIT) : rows;
    for (const row of visible) {
        els.streamsList.appendChild(renderRow(row));
    }

    if (rows.length > COLLAPSED_ROW_LIMIT) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'odm-link odm-list__toggle';
        toggle.textContent = collapsed
            ? t('showAll', { n: rows.length - COLLAPSED_ROW_LIMIT })
            : t('showLess');
        toggle.addEventListener('click', () => {
            showAllRows = !showAllRows;
            renderStreams();
        });
        els.streamsList.appendChild(toggle);
    }
}

/**
 * Give every row a label a person can tell apart.
 *
 * A stream sniffed off the network carries no title of its own — only an opaque
 * CDN file name — so the list read as fifty variations of `1080p.mp4`. The page
 * it was captured from is the label that means something; where several streams
 * share one page, the file name is appended so they stay distinguishable.
 */
function assignDisplayLabels(rows) {
    const counts = new Map();
    for (const row of rows) {
        const base = baseLabelFor(row);
        row._label = base;
        counts.set(base, (counts.get(base) || 0) + 1);
    }
    for (const row of rows) {
        if (row._isPage || counts.get(row._label) === 1) continue;
        const discriminator = (row.fileName || '').trim();
        if (discriminator) {
            row._label = `${row._label} · ${truncate(discriminator, 28)}`;
        }
    }
}

function baseLabelFor(row) {
    const own = (row.title || '').trim();
    if (own) return own;
    const page = (row.pageTitle || '').trim();
    if (page) return page;
    return (row.fileName || '').trim() || row.url;
}

function truncate(value, max) {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function renderRow(stream) {
    const fragment = els.rowTemplate.content.cloneNode(true);
    const root = fragment.querySelector('.odm-row');
    const icon = root.querySelector('[data-role="icon"]');
    const title = root.querySelector('[data-role="title"]');
    const meta = root.querySelector('[data-role="meta"]');
    const queueBtn = root.querySelector('[data-role="queue"]');
    const moreBtn = root.querySelector('[data-role="more"]');
    const analyzeBtn = root.querySelector('[data-role="analyze"]');
    const transcribeBtn = root.querySelector('[data-role="transcribe"]');
    const menuEl = root.querySelector('[data-role="menu"]');

    queueBtn.textContent = t('btnQueue');
    moreBtn.textContent = t('btnFormat');
    moreBtn.title = t('titleFormat');
    analyzeBtn.textContent = t('btnAnalyze');
    analyzeBtn.title = t('titleAnalyze');
    transcribeBtn.textContent = t('btnTranscribe');
    transcribeBtn.title = t('titleTranscribe');

    // Remembered so a transient state (sending / rejected) can hand the button
    // its own tooltip back afterwards instead of leaving it bare.
    for (const button of [queueBtn, moreBtn, analyzeBtn, transcribeBtn]) {
        button.dataset.defaultTitle = button.title;
    }

    if (stream._isPage) {
        icon.dataset.kind = 'page';
        icon.textContent = '⎘';
    } else {
        icon.dataset.kind = stream.type === 'audio' ? 'audio' : 'video';
        icon.textContent = stream.type === 'audio' ? '♪' : '▶';
    }

    title.textContent = stream._label || stream.title?.trim() || stream.fileName || stream.url;
    title.title = stream.url;

    meta.textContent = formatMeta(stream);

    queueBtn.addEventListener('click', () => onQueue(stream, queueBtn));
    moreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFormatMenu(menuEl, stream, queueBtn);
    });

    // Analyze/Transcribe run yt-dlp page extraction, which only makes sense for
    // the page itself. A raw captured stream is downloaded directly, so those
    // actions would just fail on its CDN URL — offer them on the page row only.
    if (stream._isPage) {
        analyzeBtn.addEventListener('click', () => onAnalyze(stream, analyzeBtn));
        transcribeBtn.addEventListener('click', () => onTranscribe(stream, transcribeBtn));
    } else {
        analyzeBtn.remove();
        transcribeBtn.remove();
    }

    return fragment;
}

function toggleFormatMenu(menuEl, stream, queueBtn) {
    const wasOpen = !menuEl.hidden;
    closeAllMenus();
    if (wasOpen) return;

    menuEl.innerHTML = '';
    for (const option of FORMAT_OPTIONS) {
        if (option.divider) {
            const divider = document.createElement('div');
            divider.className = 'odm-menu__divider';
            menuEl.appendChild(divider);
            continue;
        }
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'odm-menu__item' + (option.type === 'audio' ? ' odm-menu__item--audio' : '');
        item.textContent = t(option.labelKey);
        item.addEventListener('click', () => {
            closeAllMenus();
            onQueue(stream, queueBtn, option);
        });
        menuEl.appendChild(item);
    }
    menuEl.hidden = false;
}

function closeAllMenus() {
    document.querySelectorAll('.odm-menu:not([hidden])').forEach((el) => {
        el.hidden = true;
        el.innerHTML = '';
    });
}

function formatMeta(stream) {
    if (stream._isPage) {
        const parts = [stream.isMediaHost ? t('mediaPage') : t('webPage')];
        parts.push(t('ytdlpAnalyzes'));
        return parts.join(' · ');
    }
    const parts = [describeKind(stream)];
    if (stream.quality && stream.quality !== 'unknown') parts.push(stream.quality);
    if (stream.sizeBytes) parts.push(formatBytes(stream.sizeBytes));
    // Where it came from (the page's host, or the CDN's when the page is not
    // known) is the difference between "some mp4" and "the video on this page",
    // and it is the one fact every sniffed stream actually has.
    if (stream.pageHost) parts.push(stream.pageHost);
    return parts.filter(Boolean).join(' · ');
}

function describeKind(stream) {
    if (stream.streamKind === 'hls') return t('kindHls');
    if (stream.streamKind === 'dash') return t('kindDash');
    if (stream.extension && stream.extension !== 'unknown') return stream.extension.toUpperCase();
    return stream.type === 'audio' ? t('kindAudio') : t('kindVideo');
}

function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '';
    let value = Number(bytes);
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`;
}

async function onQueue(stream, button, option) {
    const chosenType = option?.type || stream.type || 'video';
    const chosenQuality = option?.quality || stream.quality || 'best';
    setButtonState(button, 'busy', t('sending'));
    const result = await sendMessage({
        action: 'POPUP_QUEUE_DOWNLOAD',
        tabId: activeTabId,
        url: stream.url,
        downloadType: chosenType === 'audio' ? 'AUDIO' : 'VIDEO',
        streamType: chosenType,
        quality: chosenQuality,
        audioFormat: option?.audioFormat || null,
        title: stream.title || '',
    });
    if (result?.ok) {
        setButtonState(button, 'ok', t('added'));
        setTimeout(() => setButtonState(button, null, t('btnQueue')), 1400);
    } else if (result?.reason === 'launching') {
        setButtonState(button, 'busy', t('launching'));
        setTimeout(() => setButtonState(button, null, t('btnQueue')), 2200);
    } else {
        const reason = result?.reason || result?.error || 'hata';
        // The app usually said *why* it refused; the button only had room for
        // "failed", and the detail used to be dropped on the floor. It goes on
        // the tooltip, which is where a one-line reason can actually fit.
        button.title = describeFailure(result) || '';
        setButtonState(button, 'error', reason === 'not_connected' ? t('notConnected') : t('failed'));
        setTimeout(() => setButtonState(button, null, t('btnQueue')), 1800);
    }
}

async function onAnalyze(stream, button) {
    setButtonState(button, 'busy', t('sending'));
    const result = await sendMessage({
        action: 'POPUP_ANALYZE_URL',
        tabId: activeTabId,
        url: stream.url,
        title: stream.title || '',
    });
    if (result?.ok) {
        setButtonState(button, 'ok', t('opened'));
        setTimeout(() => setButtonState(button, null, t('btnAnalyze')), 1400);
    } else if (result?.reason === 'launching') {
        setButtonState(button, 'busy', t('launching'));
        setTimeout(() => setButtonState(button, null, t('btnAnalyze')), 2200);
    } else {
        const reason = result?.reason || result?.error || 'hata';
        // The app usually said *why* it refused; the button only had room for
        // "failed", and the detail used to be dropped on the floor. It goes on
        // the tooltip, which is where a one-line reason can actually fit.
        button.title = describeFailure(result) || '';
        setButtonState(button, 'error', reason === 'not_connected' ? t('notConnected') : t('failed'));
        setTimeout(() => setButtonState(button, null, t('btnAnalyze')), 1800);
    }
}

async function onTranscribe(stream, button) {
    setButtonState(button, 'busy', t('sending'));
    const result = await sendMessage({
        action: 'POPUP_ANALYZE_URL',
        tabId: activeTabId,
        url: stream.url,
        title: stream.title || '',
        transcribe: true,
    });
    if (result?.ok) {
        setButtonState(button, 'ok', t('opened'));
        setTimeout(() => setButtonState(button, null, t('btnTranscribe')), 1400);
    } else if (result?.reason === 'launching') {
        setButtonState(button, 'busy', t('launching'));
        setTimeout(() => setButtonState(button, null, t('btnTranscribe')), 2200);
    } else {
        const reason = result?.reason || result?.error || 'hata';
        // The app usually said *why* it refused; the button only had room for
        // "failed", and the detail used to be dropped on the floor. It goes on
        // the tooltip, which is where a one-line reason can actually fit.
        button.title = describeFailure(result) || '';
        setButtonState(button, 'error', reason === 'not_connected' ? t('notConnected') : t('failed'));
        setTimeout(() => setButtonState(button, null, t('btnTranscribe')), 1800);
    }
}

/** The desktop app's own rejection reason, in one line.
 *  The bridge answers `{ success: false, error }`, where `error` is often a
 *  JSON-encoded command error carrying the actionable message. */
function describeFailure(result) {
    const raw = result?.body?.error ?? result?.error ?? null;
    let text = typeof raw === 'string' ? raw.trim() : '';
    if (text.startsWith('{') && text.endsWith('}')) {
        try {
            const parsed = JSON.parse(text);
            text = String(parsed?.message || parsed?.code || text).trim();
        } catch {
            /* not the structured shape; show it verbatim */
        }
    }
    if (!text && result?.status) text = `HTTP ${result.status}`;
    return text ? `${t('rejected')}: ${text.slice(0, 240)}` : '';
}

function setButtonState(button, state, label) {
    // Any state other than the failure itself puts the button's own tooltip back,
    // so a rejection reason never outlives what it explains — and the standing
    // "what does this button do" hint is not lost along with it.
    if (state !== 'error') button.title = button.dataset.defaultTitle || '';
    if (state) button.dataset.state = state;
    else delete button.dataset.state;
    if (label) button.textContent = label;
}

function onBackgroundEvent(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'BRIDGE_STATUS' && message.snapshot) {
        applyBridge(message.snapshot);
    } else if (message.type === 'HANDOFF_UPDATE') {
        applyUndelivered(message.state);
    } else if (message.type === 'TAB_STREAMS_UPDATED' && message.tabId === activeTabId) {
        cachedStreams = message.streams || [];
        renderStreams();
    }
}

function sendMessage(payload) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(payload, (response) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                    return;
                }
                resolve(response);
            });
        } catch {
            resolve(null);
        }
    });
}
