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

const FORMAT_OPTIONS = [
    { label: 'Video · En iyi', type: 'video', quality: 'best' },
    { label: 'Video · 1080p', type: 'video', quality: '1080' },
    { label: 'Video · 720p',  type: 'video', quality: '720' },
    { label: 'Video · 480p',  type: 'video', quality: '480' },
    { divider: true },
    { label: 'Ses · MP3', type: 'audio', quality: 'best' },
];

let activeTabId = null;
let cachedStreams = [];
let pageCapture = null;

init().catch((error) => {
    console.error('[ODM popup] init failed', error);
    setStatus('disconnected', 'başlatılamadı');
});

async function init() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tabs[0]?.id ?? null;

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
        els.scanBtn.textContent = 'taranıyor…';
        await sendMessage({ action: 'POPUP_SCAN_TAB', tabId: activeTabId });
        await refresh();
        els.scanBtn.textContent = before;
        els.scanBtn.disabled = false;
    });

    els.reconnectBtn.addEventListener('click', async () => {
        await sendMessage({ action: 'POPUP_FORCE_RECONNECT' });
        setStatus('connecting', 'yeniden bağlanılıyor…');
        setTimeout(refresh, 600);
    });
}

async function refresh() {
    const state = await sendMessage({ action: 'POPUP_GET_STATE', tabId: activeTabId });
    if (!state || !state.ok) {
        setStatus('disconnected', 'cevap yok');
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
    if (meta?.lastConnectedAt) lastConnectedAt = meta.lastConnectedAt;
    if (bridge.status === 'CONNECTED') {
        lastConnectedAt = Date.now();
        setStatus('connected', `bağlı · port ${bridge.port}`);
        els.bridgeHint.textContent = bridge.bridgeVersion ? `bridge ${bridge.bridgeVersion}` : '';
        els.bridgeHint.title = '';
    } else if (bridge.status === 'CONNECTING') {
        setStatus('connecting', 'bağlanıyor…');
        els.bridgeHint.textContent = '';
        els.bridgeHint.title = '';
    } else {
        setStatus('disconnected', 'kopuk');
        const stalePart = lastConnectedAt ? `son görülen ${formatRelativeTime(lastConnectedAt)}` : null;
        els.bridgeHint.textContent = stalePart || bridge.lastError || 'masaüstü açık mı?';
        els.bridgeHint.title = bridge.lastError || '';
    }
    els.queueActive.textContent = bridge.activeQueueCount ?? 0;
    els.queuePending.textContent = Math.max((bridge.queueCount ?? 0) - (bridge.activeQueueCount ?? 0), 0);
}

function formatRelativeTime(timestamp) {
    const deltaSec = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (deltaSec < 45) return 'az önce';
    const deltaMin = Math.round(deltaSec / 60);
    if (deltaMin < 60) return `${deltaMin} dk önce`;
    const deltaHr = Math.round(deltaMin / 60);
    if (deltaHr < 24) return `${deltaHr} sa önce`;
    const deltaDay = Math.round(deltaHr / 24);
    return `${deltaDay} gün önce`;
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
    const menuEl = root.querySelector('[data-role="menu"]');

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
    analyzeBtn.addEventListener('click', () => onAnalyze(stream, analyzeBtn));
    moreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFormatMenu(menuEl, stream, queueBtn);
    });

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
        item.textContent = option.label;
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
        const parts = [stream.isMediaHost ? 'medya sayfası' : 'web sayfası'];
        parts.push('yt-dlp analiz eder');
        return parts.join(' · ');
    }
    const parts = [];
    if (stream.quality && stream.quality !== 'unknown') parts.push(stream.quality);
    if (stream.extension && stream.extension !== 'unknown') parts.push(stream.extension.toUpperCase());
    if (stream.sizeBytes) parts.push(formatBytes(stream.sizeBytes));
    if (stream.source) parts.push(stream.source);
    return parts.join(' · ');
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
    setButtonState(button, 'busy', 'gönderiliyor…');
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
        setButtonState(button, 'ok', 'eklendi');
        setTimeout(() => setButtonState(button, null, 'Kuyruğa'), 1400);
    } else {
        const reason = result?.reason || result?.error || 'hata';
        setButtonState(button, 'error', reason === 'not_connected' ? 'bağlı değil' : 'başarısız');
        setTimeout(() => setButtonState(button, null, 'Kuyruğa'), 1800);
    }
}

async function onAnalyze(stream, button) {
    setButtonState(button, 'busy', 'gönderiliyor…');
    const result = await sendMessage({
        action: 'POPUP_ANALYZE_URL',
        tabId: activeTabId,
        url: stream.url,
        title: stream.title || '',
    });
    if (result?.ok) {
        setButtonState(button, 'ok', 'açıldı');
        setTimeout(() => setButtonState(button, null, 'Analiz'), 1400);
    } else {
        const reason = result?.reason || result?.error || 'hata';
        setButtonState(button, 'error', reason === 'not_connected' ? 'bağlı değil' : 'başarısız');
        setTimeout(() => setButtonState(button, null, 'Analiz'), 1800);
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
