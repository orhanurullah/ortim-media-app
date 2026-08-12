/**
 * ODM Background Service Worker — orchestration layer.
 *
 * Responsibilities:
 *   - Maintain bridge connection (delegated to bridge-client.js).
 *   - Receive stream detections from probe + capture (and webRequest).
 *   - Persist them per-tab (delegated to stream-store.js).
 *   - Inject the heavy capture script when a probe says the page needs it.
 *   - Serve the popup's RPC: get state, scan, queue download, copy URL.
 *   - Stay alive long enough between events via chrome.alarms keep-alive.
 */

import { bridgeClient, ConnectionStatus } from './bridge-client.js';
import {
    recordStream,
    listStreams,
    listAllStreams,
    clearTab,
    streamCountForTab,
    findStream,
    isTransportNoise,
} from './stream-store.js';

const KEEP_ALIVE_ALARM = 'odm-keep-alive';
const KEEP_ALIVE_INTERVAL_MIN = 0.4; // ~24 seconds; under Chrome's 30s suspend
const MEDIA_URL_HINTS = [
    '.m3u8', '.mpd', '.mp4', '.webm', '.mkv', '.m4a', '.mp3', '.aac', '.flac', '.mov',
    'cdninstagram.com', 'fbcdn.net',
    'ttvnw.net', 'twimg.com/amplify_video', '/hls/', '/dash/',
];
const MEDIA_TYPE_HINTS = ['video/', 'audio/', 'application/x-mpegurl', 'application/vnd.apple.mpegurl', 'application/dash+xml'];

const PAGE_CAPTURE_HOSTS = [
    'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'instagram.com',
    'tiktok.com', 'facebook.com', 'fb.watch', 'vimeo.com', 'twitch.tv',
    'dailymotion.com', 'soundcloud.com', 'reddit.com', 'v.redd.it',
    'streamable.com', 'bilibili.com', 'kick.com', 'rumble.com',
];

// The context menu and notifications mirror the desktop app's language, which
// the bridge relays via `bridgeClient.uiLanguage`.
const BG_MESSAGES = {
    tr: {
        sendToOmm: "OMM'ye gönder",
        queued: 'Kuyruğa gönderildi',
        analyzeOpened: 'OMM analiz için açıldı',
        notConnected: 'Masaüstü OMM uygulaması açık değil.',
        sendFailed: 'Gönderilemedi. Tekrar deneyin.',
    },
    en: {
        sendToOmm: 'Send to OMM',
        queued: 'Queued for download',
        analyzeOpened: 'Opened in OMM to analyze',
        notConnected: 'The OMM desktop app is not running.',
        sendFailed: 'Could not send. Try again.',
    },
};

function bgT(key) {
    const lang = bridgeClient.uiLanguage === 'en' ? 'en' : 'tr';
    return (BG_MESSAGES[lang] && BG_MESSAGES[lang][key]) || BG_MESSAGES.tr[key] || key;
}

console.log('[ODM] background service worker boot, ext id =', chrome.runtime?.id);
bridgeClient.start();

// Toolbar badge: green count of captured streams, per tab.
chrome.action?.setBadgeBackgroundColor?.({ color: '#16a34a' });

bridgeClient.addEventListener('status-changed', () => {
    broadcastBridgeStatus();
    // The app's language arrives with the bridge connection; refresh the menu.
    setupContextMenus();
});
bridgeClient.addEventListener('status-updated', () => {
    broadcastBridgeStatus();
});

chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: KEEP_ALIVE_INTERVAL_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM) {
        bridgeClient.refreshStatus().catch(() => undefined);
    }
});

chrome.runtime.onInstalled.addListener(() => {
    bridgeClient.start();
    setupContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
    bridgeClient.start();
});

chrome.tabs.onRemoved.addListener((tabId) => {
    clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) {
        clearTab(tabId);
        updateBadge(tabId);
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
});

if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
    chrome.webRequest.onResponseStarted.addListener(
        (details) => onWebRequest(details),
        { urls: ['<all_urls>'] },
        ['responseHeaders'],
    );
}

async function handleMessage(message, sender) {
    if (!message || typeof message !== 'object') return { ok: false, error: 'invalid_message' };
    const tabId = sender?.tab?.id;

    switch (message.action) {
        case 'CONTENT_SCRIPT_READY':
            return onContentScriptReady(message, tabId);

        case 'STREAM_INFO_DETECTED':
        case 'STREAM_INFO_DETECTED_V2': {
            if (!tabId) return { ok: false, error: 'no_tab' };
            const stream = recordStream(tabId, message.streamInfo || {});
            if (stream) {
                bridgeClient.pushCapture({ tabId, ...stream }).catch(() => undefined);
                broadcastTabStreams(tabId);
            }
            return { ok: true };
        }

        case 'NAVIGATION_CHANGED':
            if (tabId) clearTab(tabId);
            return { ok: true };

        case 'POPUP_GET_STATE':
            return getPopupState(message.tabId ?? tabId);

        case 'POPUP_SCAN_TAB':
            return scanTabActively(message.tabId);

        case 'POPUP_QUEUE_DOWNLOAD':
            return queueDownload(message);

        case 'POPUP_ANALYZE_URL':
            return analyzeUrl(message);

        case 'POPUP_FORCE_RECONNECT':
            bridgeClient.stop();
            bridgeClient.start();
            return { ok: true };

        default:
            return { ok: false, error: `unknown_action:${message.action}` };
    }
}

async function onContentScriptReady(message, tabId) {
    if (!tabId) return { ok: true };
    if (message.needsCapture) {
        injectCapture(tabId).catch(() => undefined);
    }
    return { ok: true };
}

async function injectCapture(tabId) {
    if (!chrome.scripting?.executeScript) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            files: ['odm-capture.js'],
        });
        console.log('[ODM] capture injected, tab=', tabId);
    } catch (error) {
        console.warn('[ODM] capture inject failed, tab=', tabId, error);
    }
}

function onWebRequest(details) {
    // The extension only does anything useful while the desktop app is open.
    // When it is closed, skip the per-response work entirely so the extension
    // costs the browser next to nothing on the pages the user actually visits.
    if (bridgeClient.status !== ConnectionStatus.CONNECTED) return;
    const tabId = details.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const url = details.url || '';
    if (isTransportNoise(url)) return;
    const lowered = url.toLowerCase();
    let contentType = '';
    let sizeBytes = null;
    if (Array.isArray(details.responseHeaders)) {
        for (const header of details.responseHeaders) {
            const name = (header.name || '').toLowerCase();
            if (name === 'content-type') contentType = header.value || '';
            if (name === 'content-length') sizeBytes = Number(header.value) || null;
        }
    }
    const lowerCt = contentType.toLowerCase();
    const looksMedia =
        MEDIA_URL_HINTS.some((hint) => lowered.includes(hint)) ||
        MEDIA_TYPE_HINTS.some((hint) => lowerCt.startsWith(hint));
    if (!looksMedia) return;

    const stream = recordStream(tabId, {
        url,
        contentType,
        type: lowerCt.startsWith('audio/') ? 'audio' : 'video',
        sizeBytes,
        source: 'webrequest',
    });
    if (stream) {
        bridgeClient.pushCapture({ tabId, ...stream }).catch(() => undefined);
        broadcastTabStreams(tabId);
    }
}

async function getPopupState(tabId) {
    const bridge = bridgeClient.getSnapshot();
    const streams = Number.isInteger(tabId) ? listStreams(tabId) : [];
    const pageCapture = Number.isInteger(tabId) ? await buildPageCapture(tabId) : null;
    return {
        ok: true,
        tabId: tabId ?? null,
        bridge,
        streams,
        pageCapture,
        totalCaptured: listAllStreams().length,
    };
}

async function buildPageCapture(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.url) return null;
        const url = tab.url;
        if (!/^https?:\/\//i.test(url)) return null;
        let host = '';
        try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
        const isMediaHost = PAGE_CAPTURE_HOSTS.some((hint) => host.includes(hint));
        return {
            url,
            title: tab.title || host,
            type: 'video',
            source: 'page',
            isMediaHost,
            fileName: host,
            extension: 'page',
        };
    } catch {
        return null;
    }
}

async function scanTabActively(tabId) {
    if (!Number.isInteger(tabId)) return { ok: false, error: 'no_tab' };
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'SCAN_STREAMS' });
        return { ok: true, scanned: response?.streams?.length || 0, after: streamCountForTab(tabId) };
    } catch (error) {
        return { ok: false, error: String(error?.message || error) };
    }
}

async function analyzeUrl(message) {
    const url = message.url;
    if (!url) return { ok: false, error: 'no_url' };
    return bridgeClient.requestAnalyze({
        url,
        title: message.title || null,
        tabId: Number.isInteger(message.tabId) ? message.tabId : null,
        transcribe: !!message.transcribe,
    });
}

async function queueDownload(message) {
    const tabId = message.tabId;
    const url = message.url;
    if (!url) return { ok: false, error: 'no_url' };

    const stored = (Number.isInteger(tabId) && findStream(tabId, url)) || null;
    const chosenType = message.streamType || stored?.type || 'video';
    const chosenQuality = message.quality || stored?.quality || null;

    // The page's own headers let the desktop downloader fetch a captured CDN
    // URL that would otherwise 403. The tab URL is the Referer; the browser's
    // User-Agent matches what the page itself sent.
    let referer = null;
    if (Number.isInteger(tabId)) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab?.url && /^https?:/i.test(tab.url)) referer = tab.url;
        } catch {
            /* tab gone; queue without a referer */
        }
    }

    const payload = {
        data: {
            stream: {
                url,
                type: chosenType,
                contentType: stored?.contentType || '',
                title: stored?.title || message.title || '',
                quality: chosenQuality,
                sizeBytes: stored?.sizeBytes || null,
                audioOnly: chosenType === 'audio',
                audioFormat: message.audioFormat || null,
                referer,
                userAgent: navigator.userAgent,
            },
            downloadType: message.downloadType || (chosenType === 'audio' ? 'AUDIO' : 'VIDEO'),
            queueId: message.queueId || null,
            tabId: tabId ?? null,
        },
    };

    const result = await bridgeClient.queueDownload(payload);
    if (result.ok) bridgeClient.refreshStatus().catch(() => undefined);
    return result;
}

function broadcastBridgeStatus() {
    const snapshot = bridgeClient.getSnapshot();
    safeBroadcast({ type: 'BRIDGE_STATUS', snapshot });
    persistBridgeSnapshot(snapshot).catch(() => undefined);
}

async function persistBridgeSnapshot(snapshot) {
    if (!chrome.storage?.session) return;
    const existing = (await chrome.storage.session.get('odmBridgeCache'))?.odmBridgeCache || {};
    const now = Date.now();
    const payload = {
        snapshot,
        savedAt: now,
        lastConnectedAt:
            snapshot?.status === 'CONNECTED' ? now : existing.lastConnectedAt || null,
    };
    await chrome.storage.session.set({ odmBridgeCache: payload });
}

function broadcastTabStreams(tabId) {
    safeBroadcast({ type: 'TAB_STREAMS_UPDATED', tabId, streams: listStreams(tabId) });
    updateBadge(tabId);
}

function safeBroadcast(message) {
    try {
        chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
        /* no popup open; ignore */
    }
}

// --- Toolbar badge -------------------------------------------------------
// Per-tab count of captured streams, so the user sees activity without
// opening the popup. Cleared implicitly (count → 0) on navigation.

function updateBadge(tabId) {
    if (!chrome.action?.setBadgeText || !Number.isInteger(tabId) || tabId < 0) return;
    const count = streamCountForTab(tabId);
    chrome.action
        .setBadgeText({ tabId, text: count > 0 ? String(count) : '' })
        .catch(() => undefined);
}

// --- Context menu: "Send to OMM" ----------------------------------------
// Right-click a video/audio/link/page → hand it to the desktop app without
// opening the popup. Media/link → queue download; page → analyze (CaptureView).

const CONTEXT_MENU_ID = 'omm-send';

function setupContextMenus() {
    if (!chrome.contextMenus) return;
    chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        chrome.contextMenus.create(
            {
                id: CONTEXT_MENU_ID,
                title: bgT('sendToOmm'),
                contexts: ['video', 'audio', 'link', 'page'],
            },
            () => void chrome.runtime.lastError,
        );
    });
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID) return;
    handleContextMenuClick(info, tab).catch((error) => {
        console.warn('[ODM] context menu action failed', error);
    });
});

async function handleContextMenuClick(info, tab) {
    const tabId = tab?.id ?? null;
    const mediaUrl = info.srcUrl || info.linkUrl || null;
    if (mediaUrl) {
        const result = await queueDownload({ tabId, url: mediaUrl, title: tab?.title || '' });
        notifyResult(result, mediaUrl, bgT('queued'));
    } else {
        const pageUrl = info.pageUrl || tab?.url;
        if (!pageUrl) return;
        const result = await analyzeUrl({ url: pageUrl, title: tab?.title || '', tabId });
        notifyResult(result, pageUrl, bgT('analyzeOpened'));
    }
}

// --- Notifications: context-menu action feedback ------------------------
// The context menu has no popup to show status, so confirm the outcome here.

function notifyResult(result, url, okTitle) {
    if (!chrome.notifications?.create) return;
    const ok = !!result?.ok;
    let message;
    if (ok) {
        message = shortenUrl(url);
    } else if (result?.reason === 'not_connected') {
        message = bgT('notConnected');
    } else {
        message = bgT('sendFailed');
    }
    chrome.notifications.create(
        {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon-128.png'),
            title: ok ? okTitle : 'OMM',
            message,
        },
        () => void chrome.runtime.lastError,
    );
}

function shortenUrl(url) {
    try {
        const parsed = new URL(url);
        return (parsed.hostname + parsed.pathname).slice(0, 100);
    } catch {
        return String(url).slice(0, 100);
    }
}
