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
        emptyLine2: 'Sayfayı yenileyin veya ', scanStart: 'tarama başlat',
        scanning: 'taranıyor…', active: 'Aktif:', pending: 'Bekleyen:',
        reconnectTitle: 'Yeniden bağlan', btnQueue: 'Kuyruğa', btnFormat: 'Format ▾',
        btnAnalyze: 'Analiz', btnTranscribe: 'Transkribe',
        titleFormat: 'İndirme formatı seç', titleAnalyze: 'Detaylı analiz et',
        titleTranscribe: "OMM'de indir + otomatik yazıya dök (Studio)",
        sending: 'gönderiliyor…', added: 'eklendi', notConnected: 'bağlı değil',
        failed: 'başarısız', opened: 'açıldı',
        fmtVideoBest: 'Video · En iyi', fmtVideo1080: 'Video · 1080p',
        fmtVideo720: 'Video · 720p', fmtVideo480: 'Video · 480p', fmtAudioMp3: 'Ses · MP3',
        mediaPage: 'medya sayfası', webPage: 'web sayfası', ytdlpAnalyzes: 'yt-dlp analiz eder',
        kindHls: 'HLS akışı', kindDash: 'DASH akışı', kindAudio: 'Ses', kindVideo: 'Video',
    },
    en: {
        connecting: 'connecting…', reconnecting: 'reconnecting…',
        connected: 'connected · port {port}', disconnected: 'disconnected',
        noResponse: 'no response', startFailed: 'failed to start',
        bridgeVersion: 'bridge {version}', lastSeen: 'last seen {time}',
        desktopOpen: 'is the desktop app open?', justNow: 'just now',
        minAgo: '{n} min ago', hourAgo: '{n} h ago', dayAgo: '{n} d ago',
        sectionTitle: 'Media on this tab', emptyLine1: 'No media captured yet.',
        emptyLine2: 'Reload the page or ', scanStart: 'start a scan',
        scanning: 'scanning…', active: 'Active:', pending: 'Pending:',
        reconnectTitle: 'Reconnect', btnQueue: 'Queue', btnFormat: 'Format ▾',
        btnAnalyze: 'Analyze', btnTranscribe: 'Transcript',
        titleFormat: 'Choose download format', titleAnalyze: 'Analyze in detail',
        titleTranscribe: 'Download in OMM + auto-transcribe (Studio)',
        sending: 'sending…', added: 'added', notConnected: 'not connected',
        failed: 'failed', opened: 'opened',
        fmtVideoBest: 'Video · Best', fmtVideo1080: 'Video · 1080p',
        fmtVideo720: 'Video · 720p', fmtVideo480: 'Video · 480p', fmtAudioMp3: 'Audio · MP3',
        mediaPage: 'media page', webPage: 'web page', ytdlpAnalyzes: 'yt-dlp analyzes it',
        kindHls: 'HLS stream', kindDash: 'DASH stream', kindAudio: 'Audio', kindVideo: 'Video',
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

function renderStreams() {
    const rows = [];
    if (pageCapture) rows.push({ ...pageCapture, _isPage: true });
    for (const stream of cachedStreams) rows.push(stream);

    els.streamsCount.textContent = rows.length;
    els.streamsList.innerHTML = '';

    if (rows.length === 0) {
        els.streamsList.appendChild(els.streamsEmpty);
        els.streamsEmpty.style.display = '';
        const link = els.streamsEmpty.querySelector('#scan-btn');
        if (link) {
            link.addEventListener('click', () => els.scanBtn.click(), { once: true });
        }
        return;
    }

    for (const row of rows) {
        els.streamsList.appendChild(renderRow(row));
    }
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

    if (stream._isPage) {
        icon.dataset.kind = 'page';
        icon.textContent = '⎘';
    } else {
        icon.dataset.kind = stream.type === 'audio' ? 'audio' : 'video';
        icon.textContent = stream.type === 'audio' ? '♪' : '▶';
    }

    title.textContent = stream.title?.trim() || stream.fileName || stream.url;
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
    } else {
        const reason = result?.reason || result?.error || 'hata';
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
    } else {
        const reason = result?.reason || result?.error || 'hata';
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
    } else {
        const reason = result?.reason || result?.error || 'hata';
        setButtonState(button, 'error', reason === 'not_connected' ? t('notConnected') : t('failed'));
        setTimeout(() => setButtonState(button, null, t('btnTranscribe')), 1800);
    }
}

function setButtonState(button, state, label) {
    if (state) button.dataset.state = state;
    else delete button.dataset.state;
    if (label) button.textContent = label;
}

function onBackgroundEvent(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'BRIDGE_STATUS' && message.snapshot) {
        applyBridge(message.snapshot);
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
