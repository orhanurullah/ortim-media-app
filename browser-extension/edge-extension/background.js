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
} from './stream-store.js';

const KEEP_ALIVE_ALARM = 'odm-keep-alive';
const KEEP_ALIVE_INTERVAL_MIN = 0.4; // ~24 seconds; under Chrome's 30s suspend
const MEDIA_URL_HINTS = [
    '.m3u8', '.mpd', '.mp4', '.webm', '.mkv', '.m4a', '.mp3', '.ts', '.aac', '.flac', '.mov',
    '/videoplayback', 'googlevideo.com', 'cdninstagram.com', 'fbcdn.net',
    'ttvnw.net', 'twimg.com/amplify_video', '/hls/', '/dash/',
];
const MEDIA_TYPE_HINTS = ['video/', 'audio/', 'application/x-mpegurl', 'application/vnd.apple.mpegurl', 'application/dash+xml'];

const PAGE_CAPTURE_HOSTS = [
    'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'instagram.com',
    'tiktok.com', 'facebook.com', 'fb.watch', 'vimeo.com', 'twitch.tv',
    'dailymotion.com', 'soundcloud.com', 'reddit.com', 'v.redd.it',
    'streamable.com', 'bilibili.com', 'kick.com', 'rumble.com',
];

console.log('[ODM] background service worker boot, ext id =', chrome.runtime?.id);
bridgeClient.start();

bridgeClient.addEventListener('status-changed', () => {
    broadcastBridgeStatus();
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
    const tabId = details.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const url = details.url || '';
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
    });
}

async function queueDownload(message) {
    const tabId = message.tabId;
    const url = message.url;
    if (!url) return { ok: false, error: 'no_url' };

    const stored = (Number.isInteger(tabId) && findStream(tabId, url)) || null;
    const chosenType = message.streamType || stored?.type || 'video';
    const chosenQuality = message.quality || stored?.quality || null;

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
}

function safeBroadcast(message) {
    try {
        chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
        /* no popup open; ignore */
    }
}
