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
    restoreStreams,
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
        nothingToDownload: 'İndirilecek bir kaynak bulunamadı.',
        launching: 'OMM açılıyor, isteğin sıraya alındı…',
    },
    en: {
        sendToOmm: 'Send to OMM',
        queued: 'Queued for download',
        analyzeOpened: 'Opened in OMM to analyze',
        notConnected: 'The OMM desktop app is not running.',
        sendFailed: 'Could not send. Try again.',
        nothingToDownload: 'No downloadable source found here.',
        launching: 'Opening OMM, your request is queued…',
    },
};

function bgT(key) {
    const lang = bridgeClient.uiLanguage === 'en' ? 'en' : 'tr';
    return (BG_MESSAGES[lang] && BG_MESSAGES[lang][key]) || BG_MESSAGES.tr[key] || key;
}

// --- Cold-start wake + deferred delivery --------------------------------
// The bridge server lives inside the desktop app, so when the app is closed a
// "Send to OMM" action has nowhere to land. Instead of dead-ending, we persist
// the job, launch the app via its `omm://` deep link, and flush the queue the
// moment the bridge reconnects. The desktop side registers the scheme and, via
// its single-instance guard, focuses the window on wake.

const PENDING_JOBS_KEY = 'ommPendingJobs';
const PENDING_JOB_TTL_MS = 10 * 60 * 1000; // a job older than this is stale
const PENDING_JOBS_MAX = 25;
const WAKE_PAGE = 'wake.html';
const WAKE_TAB_KEY = 'ommWakeTabId';
const WAKE_TRIGGERED_AT_KEY = 'ommWakeTriggeredAt';
const HANDOFF_KEY = 'ommHandoff';
const EAGER_RECONNECT_INTERVAL_MS = 1_500;
// One launch attempt covers every job queued while it is running. Re-triggering
// the deep link inside this window is what produced a stack of "Open Ortim Media
// Manager?" dialogs: the browser raises one per navigation, so three queued rows
// meant three dialogs on top of three copies of the wake page.
const WAKE_RETRIGGER_COOLDOWN_MS = 25_000;
const EAGER_RECONNECT_WINDOW_MS = 45_000; // stop kicking after the app should be up

let eagerReconnectTimer = null;
/** The wake currently being set up. Concurrent sends await this one instead of
 *  each racing `chrome.tabs.create`, which is how two — or five — wake tabs got
 *  opened at once, all but the last of them orphaned and unclosable. */
let wakeInFlight = null;

console.log('[ODM] background service worker boot, ext id =', chrome.runtime?.id);
bridgeClient.start();

// Toolbar badge: green count of captured streams, per tab.
chrome.action?.setBadgeBackgroundColor?.({ color: '#16a34a' });

bridgeClient.addEventListener('status-changed', (event) => {
    broadcastBridgeStatus();
    // The wake page renders bridge status too, so it follows every transition
    // rather than only the final one.
    broadcastHandoff().catch(() => undefined);
    // The app's language arrives with the bridge connection; refresh the menu.
    setupContextMenus();
    // The bridge just came up (a real transition — status-changed only fires on
    // change). Stop waking and drain any jobs queued while it was closed.
    const status = event?.detail?.status || bridgeClient.status;
    if (status === ConnectionStatus.CONNECTED) {
        stopEagerReconnect();
        flushPendingJobs().catch(() => undefined);
    }
});
bridgeClient.addEventListener('status-updated', () => {
    broadcastBridgeStatus();
});
bridgeClient.addEventListener('language-changed', () => {
    // App language changed mid-connection: relocalize the context menu (the
    // popup relocalizes itself from the broadcast snapshot).
    setupContextMenus();
    broadcastBridgeStatus();
});

chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: KEEP_ALIVE_INTERVAL_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM) {
        bridgeClient.refreshStatus().catch(() => undefined);
        // A send whose app never opened would otherwise hold the "undelivered"
        // badge forever: the TTL was only ever applied at flush time, and a flush
        // needs a connection that is never coming.
        prunePendingJobs().catch(() => undefined);
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
    forgetTabContext(tabId);
    // The user closed the wake page themselves; stop trying to reuse it.
    readWakeTabId()
        .then((wakeTabId) => (wakeTabId === tabId ? forgetWakeTab() : undefined))
        .catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) {
        clearTab(tabId);
        forgetTabContext(tabId);
        updateBadge(tabId);
    }
    if (info.title || info.url) rememberTabContext(tabId, info);
});

// --- Tab context: what page a sniffed stream belongs to ------------------
// `webRequest` hands us a URL and nothing else, so a captured CDN stream had no
// name beyond an opaque file name — fifty of which are indistinguishable. The
// owning tab's title is the label that actually identifies it, but the handler
// is synchronous and `chrome.tabs.get` is not, so the title is kept warm here
// and read without awaiting.

const tabContexts = new Map(); // tabId -> { title, host }

function rememberTabContext(tabId, info) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const current = tabContexts.get(tabId) || {};
    const next = { ...current };
    if (info?.title) next.title = info.title;
    if (info?.url) {
        try {
            next.host = new URL(info.url).hostname.replace(/^www\./, '');
        } catch {
            /* not an http(s) URL; leave the host alone */
        }
    }
    tabContexts.set(tabId, next);
}

function forgetTabContext(tabId) {
    tabContexts.delete(tabId);
}

/** Best-effort page context, plus a lazy refill after a worker restart (which
 *  empties the map while the tabs themselves are still open). */
function tabContextFor(tabId) {
    const known = tabContexts.get(tabId);
    if (known) return known;
    tabContexts.set(tabId, {}); // placeholder, so one miss triggers one lookup
    chrome.tabs
        ?.get(tabId)
        .then((tab) => rememberTabContext(tabId, { title: tab?.title, url: tab?.url }))
        .catch(() => undefined);
    return {};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
});

/** Resource types a media stream can actually arrive as.
 *
 *  Everything omitted here - stylesheets, scripts, images, fonts, pings,
 *  websockets, sub-frames - cannot carry a downloadable stream, and the browser
 *  drops them *before* dispatching the event, so they cost nothing at all.
 *  Measured on a YouTube watch page's initial load: 49 responses, of which 32
 *  (67%) were script/stylesheet/image and could never have been media.
 *
 *  `xmlhttprequest` and `other` are the important ones: HLS and DASH players
 *  fetch their manifests and segments that way. `media` covers a plain
 *  <video>/<audio> load and `main_frame` a direct navigation to a file. */
const MEDIA_RESOURCE_TYPES = ['media', 'xmlhttprequest', 'other', 'object', 'main_frame'];

// The worker is restarted constantly under MV3; every start reloads what was
// detected before it was evicted, so a stream found while the desktop app was
// closed is still there when the popup finally asks.
restoreStreams().catch(() => undefined);
// Same reason: an eviction must not silently clear the "still undelivered"
// badge, which is the only at-a-glance answer to "did my send go through?".
broadcastHandoff().catch(() => undefined);

if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
    chrome.webRequest.onResponseStarted.addListener(
        (details) => onWebRequest(details),
        { urls: ['<all_urls>'], types: MEDIA_RESOURCE_TYPES },
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
            const page = tabContextFor(tabId);
            const stream = recordStream(tabId, {
                pageTitle: page.title || '',
                pageHost: page.host || '',
                ...(message.streamInfo || {}),
            });
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

        // --- wake page RPC ---
        case 'WAKE_GET_STATE': {
            // A wake page that is no longer *the* wake page is a leftover from
            // before this was single-flighted (or from a tab the user duplicated).
            // It would otherwise poll forever and never be closed, because
            // `closeWakeTab` only ever closes the one recorded id. Tell it to go.
            const currentWakeTabId = await readWakeTabId();
            if (Number.isInteger(currentWakeTabId) && Number.isInteger(tabId) && tabId !== currentWakeTabId) {
                return { stale: true };
            }
            // The page asks on a tick as well as on push, because a service
            // worker evicted mid-wake pushes nothing.
            beginEagerReconnect();
            return buildHandoffState();
        }

        case 'WAKE_DISMISS':
            await closeWakeTab(tabId);
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
    // Detection runs whether or not the desktop app is open.
    //
    // It used to stop here when the bridge was down, to keep the extension cheap.
    // That traded away almost the whole feature for almost no saving: the listener
    // is registered unconditionally with `responseHeaders`, so the browser had
    // already dispatched the event and marshalled the headers by the time this
    // line ran. What it did cost was usability - streams that passed while the app
    // was closed were never seen, so opening the app left the popup empty and the
    // page had to be reloaded.
    //
    // The saving now comes from the `types` filter at registration, which the
    // browser applies before dispatching anything (measured: 67% of a YouTube
    // page's responses never reach us at all now). So this handler is both
    // cheaper than before *and* always on.
    //
    // Only delivery is gated, further down: `pushCapture` needs an app to talk to.
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

    const page = tabContextFor(tabId);
    const stream = recordStream(tabId, {
        url,
        contentType,
        type: lowerCt.startsWith('audio/') ? 'audio' : 'video',
        sizeBytes,
        source: 'webrequest',
        pageTitle: page.title || '',
        pageHost: page.host || '',
    });
    if (stream) {
        // Recorded locally either way; only the hand-off needs the app. A stream
        // found while it was closed is still in the store when the popup opens,
        // and the user can queue it from there.
        if (bridgeClient.status === ConnectionStatus.CONNECTED) {
            bridgeClient.pushCapture({ tabId, ...stream }).catch(() => undefined);
        }
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
    const result = await bridgeClient.requestAnalyze({
        url,
        title: message.title || null,
        tabId: Number.isInteger(message.tabId) ? message.tabId : null,
        transcribe: !!message.transcribe,
    });
    if (result?.reason === 'not_connected' && !message._replay) {
        return deferJob('analyze', message);
    }
    return result;
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
    //
    // But a full-extractor site (YouTube, Vimeo, …) is resolved by yt-dlp, which
    // manages its own player client, User-Agent and cookies. Forcing the
    // browser's User-Agent there desyncs the CDN's signed media URLs and yields
    // "HTTP Error 403: Forbidden" on the video data. So page headers are
    // replayed ONLY for direct/captured CDN streams, which genuinely need them.
    const replayPageHeaders = !isExtractorSite(url);
    let referer = null;
    if (replayPageHeaders && Number.isInteger(tabId)) {
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
                userAgent: replayPageHeaders ? navigator.userAgent : null,
            },
            downloadType: message.downloadType || (chosenType === 'audio' ? 'AUDIO' : 'VIDEO'),
            queueId: message.queueId || null,
            tabId: tabId ?? null,
        },
    };

    const result = await bridgeClient.queueDownload(payload);
    if (result.ok) {
        bridgeClient.refreshStatus().catch(() => undefined);
    } else if (result.reason === 'not_connected' && !message._replay) {
        return deferJob('download', message);
    }
    return result;
}

// --- Wake + pending-queue plumbing --------------------------------------

// Persist the job, open the wake page (which launches the app), and tell the
// caller we're launching (not failing). The queued job flushes on reconnect.
// `_replay` jobs never come back here, so a flush that races a dropped bridge
// can't recurse or re-wake.
async function deferJob(kind, message) {
    const { _replay, ...clean } = message;
    void _replay;
    await enqueuePendingJob({ kind, message: clean });
    await recordHandoff({ startedAt: Date.now(), sent: 0, failures: [] });
    wakeDesktopApp().catch(() => undefined);
    return { ok: false, reason: 'launching' };
}

/**
 * Bring up the desktop app and give the user something to look at while it
 * happens.
 *
 * A service worker cannot hand a custom scheme to the OS on its own - it needs a
 * navigation. This used to open a tab straight onto `omm://wake` and remove it
 * 1.5s later, which had two failure modes: the browser's "Open Ortim Media
 * Manager?" consent dialog is tab-modal, so closing the tab out from under it
 * cancelled the launch unless the user clicked within a second and a half; and
 * until then they were staring at an unexplained blank tab.
 *
 * So we open our own page instead. It triggers the deep link itself, survives
 * whatever the OS decides to do with it, keeps the consent dialog alive for as
 * long as the user needs, and reports how the hand-off actually went.
 */
function wakeDesktopApp() {
    // Single-flight. Everything queued while a launch is being set up rides on
    // that launch; the second caller must not open a second tab or fire a second
    // deep link, because the user experiences both as duplicate prompts.
    if (wakeInFlight) return wakeInFlight;
    wakeInFlight = performWake().finally(() => {
        wakeInFlight = null;
    });
    return wakeInFlight;
}

async function performWake() {
    const reused = await focusExistingWakeTab();
    if (!reused) {
        try {
            const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(WAKE_PAGE) });
            if (Number.isInteger(tab?.id)) {
                await chrome.storage.session?.set({
                    [WAKE_TAB_KEY]: tab.id,
                    [WAKE_TRIGGERED_AT_KEY]: Date.now(),
                });
            }
        } catch (error) {
            // No page to explain itself with, so fall back to a notification -
            // and only here, because a notification saying "opening OMM" when
            // nothing was opened is exactly the lie we are removing.
            console.warn('[ODM] wake page failed to open', error);
            notifyLaunching();
        }
    }
    beginEagerReconnect();
}

/** Reuse the wake tab an earlier send opened rather than stacking up tabs.
 *
 *  It used to reload unconditionally, so that a send after a cancelled consent
 *  dialog would try to launch again. That also meant every *additional* send
 *  during a launch already in progress reloaded the page and raised another
 *  browser consent dialog — the pile-up this cooldown removes. A launch older
 *  than the cooldown is assumed not to have taken, and is retried; a fresh one is
 *  simply brought to the front, with the new job already added to its list. */
async function focusExistingWakeTab() {
    const tabId = await readWakeTabId();
    if (!Number.isInteger(tabId)) return false;
    try {
        await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        const triggeredAt = await readWakeTriggeredAt();
        if (Date.now() - triggeredAt > WAKE_RETRIGGER_COOLDOWN_MS) {
            await chrome.storage.session?.set({ [WAKE_TRIGGERED_AT_KEY]: Date.now() });
            await chrome.tabs.reload(tabId);
        }
        return true;
    } catch {
        await forgetWakeTab();
        return false;
    }
}

async function readWakeTriggeredAt() {
    if (!chrome.storage?.session) return 0;
    try {
        const stored = await chrome.storage.session.get(WAKE_TRIGGERED_AT_KEY);
        const value = stored?.[WAKE_TRIGGERED_AT_KEY];
        return Number.isFinite(value) ? value : 0;
    } catch {
        return 0;
    }
}

async function readWakeTabId() {
    if (!chrome.storage?.session) return null;
    try {
        const stored = await chrome.storage.session.get(WAKE_TAB_KEY);
        const value = stored?.[WAKE_TAB_KEY];
        return Number.isInteger(value) ? value : null;
    } catch {
        return null;
    }
}

async function forgetWakeTab() {
    try {
        await chrome.storage.session?.remove([WAKE_TAB_KEY, WAKE_TRIGGERED_AT_KEY]);
    } catch {
        /* storage unavailable */
    }
}

/** Close the wake page. `requestedTabId` is the tab that asked to be dismissed,
 *  which is what makes a stray copy able to remove *itself* rather than taking
 *  the live one down with it. */
async function closeWakeTab(requestedTabId) {
    const recordedTabId = await readWakeTabId();
    const targetTabId = Number.isInteger(requestedTabId) ? requestedTabId : recordedTabId;
    if (!Number.isInteger(targetTabId) || targetTabId === recordedTabId) {
        await forgetWakeTab();
    }
    if (!Number.isInteger(targetTabId)) return;
    try {
        await chrome.tabs.remove(targetTabId);
    } catch {
        /* already closed by the user */
    }
}

// --- Hand-off state ------------------------------------------------------
// What the wake page and the toolbar badge render. Kept in session storage
// because the service worker is evicted constantly mid-wake, and the page must
// still be able to ask "how did it go?" after a restart.

async function readHandoff() {
    if (!chrome.storage?.session) return null;
    try {
        return (await chrome.storage.session.get(HANDOFF_KEY))?.[HANDOFF_KEY] || null;
    } catch {
        return null;
    }
}

async function recordHandoff(patch) {
    if (chrome.storage?.session) {
        try {
            const current = (await readHandoff()) || {};
            await chrome.storage.session.set({ [HANDOFF_KEY]: { ...current, ...patch } });
        } catch {
            /* storage unavailable; the page falls back to bridge status alone */
        }
    }
    await broadcastHandoff();
}

/** The snapshot the wake page renders, and the source of the pending badge. */
async function buildHandoffState() {
    const pending = await readPendingJobs();
    const handoff = (await readHandoff()) || {};
    return {
        status: bridgeClient.status,
        connected: bridgeClient.status === ConnectionStatus.CONNECTED,
        uiLanguage: bridgeClient.uiLanguage === 'en' ? 'en' : 'tr',
        pending: pending.map(describePendingJob),
        sent: handoff.sent || 0,
        failures: handoff.failures || [],
    };
}

function describePendingJob(job) {
    const message = job?.message || {};
    const label = (message.title || '').trim() || shortenUrl(message.url || '');
    return (job?.kind === 'analyze' ? '⎘ ' : '↓ ') + label;
}

async function broadcastHandoff() {
    const state = await buildHandoffState();
    safeBroadcast({ type: 'HANDOFF_UPDATE', state });
    updatePendingBadge(state.pending.length);
    return state;
}

// The pending count is what answers "did my send go through?" without opening
// the app, so it takes over the toolbar badge for as long as anything is still
// undelivered - an amber count, distinct from the green per-tab capture count.
//
// A per-tab badge outranks the global one in Chrome, so entering this mode has
// to clear the per-tab capture counts and leaving it has to put them back.
let pendingBadgeCount = 0;

function updatePendingBadge(count) {
    if (!chrome.action?.setBadgeText) return;
    const wasPending = pendingBadgeCount > 0;
    pendingBadgeCount = count;

    if (count > 0) {
        chrome.action.setBadgeBackgroundColor?.({ color: '#d97706' });
        chrome.action.setBadgeText({ text: String(count) }).catch(() => undefined);
        if (!wasPending) clearPerTabBadges();
        return;
    }
    if (!wasPending) return;
    chrome.action.setBadgeBackgroundColor?.({ color: '#16a34a' });
    chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
    restorePerTabBadges();
}

function clearPerTabBadges() {
    chrome.tabs
        ?.query({})
        .then((tabs) => {
            for (const tab of tabs) {
                if (!Number.isInteger(tab.id)) continue;
                chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => undefined);
            }
        })
        .catch(() => undefined);
}

function restorePerTabBadges() {
    chrome.tabs
        ?.query({})
        .then((tabs) => tabs.forEach((tab) => updateBadge(tab.id)))
        .catch(() => undefined);
}

function beginEagerReconnect() {
    if (eagerReconnectTimer) return;
    const startedAt = Date.now();
    eagerReconnectTimer = setInterval(() => {
        if (
            bridgeClient.status === ConnectionStatus.CONNECTED ||
            Date.now() - startedAt > EAGER_RECONNECT_WINDOW_MS
        ) {
            stopEagerReconnect();
            return;
        }
        bridgeClient.kick();
    }, EAGER_RECONNECT_INTERVAL_MS);
    bridgeClient.kick(); // don't wait a full interval for the first attempt
}

function stopEagerReconnect() {
    if (eagerReconnectTimer) {
        clearInterval(eagerReconnectTimer);
        eagerReconnectTimer = null;
    }
}

async function readPendingJobs() {
    if (!chrome.storage?.local) return [];
    try {
        const stored = await chrome.storage.local.get(PENDING_JOBS_KEY);
        const list = stored?.[PENDING_JOBS_KEY];
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

async function writePendingJobs(list) {
    if (!chrome.storage?.local) return;
    try {
        await chrome.storage.local.set({ [PENDING_JOBS_KEY]: list });
    } catch {
        /* storage unavailable; the job is lost but the app is still opening */
    }
}

async function enqueuePendingJob(job) {
    const list = await readPendingJobs();
    list.push({ ...job, queuedAt: Date.now() });
    await writePendingJobs(list.slice(-PENDING_JOBS_MAX));
}

/** Drop jobs the app never came up to collect, and tell the user once. */
async function prunePendingJobs() {
    const list = await readPendingJobs();
    if (list.length === 0) return;
    const now = Date.now();
    const fresh = list.filter((job) => now - (job.queuedAt || 0) <= PENDING_JOB_TTL_MS);
    if (fresh.length === list.length) return;
    await writePendingJobs(fresh);
    await recordHandoff({});
    notifyFlushOutcome(0, [], list.length - fresh.length);
}

// Called on every bridge → CONNECTED transition. Replays fresh jobs; a job the
// bridge still can't take (it dropped again) is kept, anything else has failed
// for a reason a replay won't fix.
//
// Whatever happens is reported. Dropping a rejected job in silence is how a
// "1 item sent to OMM" notification ended up standing in for work the app never
// accepted — the one thing the user cannot check from the browser.
async function flushPendingJobs() {
    const list = await readPendingJobs();
    if (list.length === 0) return;
    const now = Date.now();
    const fresh = list.filter((job) => now - (job.queuedAt || 0) <= PENDING_JOB_TTL_MS);
    const expired = list.length - fresh.length;
    const remaining = [];
    const failures = [];
    let sent = 0;
    for (const job of fresh) {
        const message = { ...job.message, _replay: true };
        const result = job.kind === 'analyze'
            ? await analyzeUrl(message)
            : await queueDownload(message);
        if (result?.ok) {
            sent += 1;
        } else if (result?.reason === 'not_connected') {
            remaining.push(job); // bridge dropped mid-flush; try again next time
        } else {
            failures.push(describeFlushFailure(job, result));
        }
    }
    await writePendingJobs(remaining);
    await recordHandoff({ sent, failures, finishedAt: Date.now() });
    if (failures.length > 0 || expired > 0) {
        notifyFlushOutcome(sent, failures, expired);
    } else if (sent > 0) {
        notifyFlushed(sent);
    }
    // A clean hand-off has nothing left to say; let the wake page show its
    // confirmation, then take the tab away.
    if (remaining.length === 0 && failures.length === 0) {
        setTimeout(() => closeWakeTab().catch(() => undefined), 2000);
    }
}

function describeFlushFailure(job, result) {
    const label = describePendingJob(job);
    const reason = describeRejection(result) || 'unknown';
    return `${label} — ${reason.slice(0, 120)}`;
}

function notifyLaunching() {
    if (!chrome.notifications?.create) return;
    chrome.notifications.create(
        {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon-128.png'),
            title: 'OMM',
            message: bgT('launching'),
        },
        () => void chrome.runtime.lastError,
    );
}

function notifyFlushed(count) {
    if (!chrome.notifications?.create) return;
    const lang = bridgeClient.uiLanguage === 'en' ? 'en' : 'tr';
    const message = lang === 'en'
        ? `${count} item${count > 1 ? 's' : ''} sent to OMM`
        : `${count} öğe OMM'ye gönderildi`;
    chrome.notifications.create(
        {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon-128.png'),
            title: 'OMM',
            message,
        },
        () => void chrome.runtime.lastError,
    );
}

// A flush that did not go cleanly says so, and says why. The old code dropped
// rejected jobs without a word, which left the user with a success notification
// and an app that had done nothing.
function notifyFlushOutcome(sent, failures, expired) {
    if (!chrome.notifications?.create) return;
    const lang = bridgeClient.uiLanguage === 'en' ? 'en' : 'tr';
    const lines = [];
    if (sent > 0) {
        lines.push(lang === 'en' ? `${sent} sent` : `${sent} gönderildi`);
    }
    if (expired > 0) {
        lines.push(
            lang === 'en'
                ? `${expired} expired before OMM opened`
                : `${expired} öğe OMM açılmadan zaman aşımına uğradı`,
        );
    }
    for (const failure of failures.slice(0, 3)) lines.push(failure);
    chrome.notifications.create(
        {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon-128.png'),
            title: lang === 'en' ? 'OMM — not everything went through' : 'OMM — hepsi gönderilemedi',
            message: lines.join('\n').slice(0, 400),
        },
        () => void chrome.runtime.lastError,
    );
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
    // Undelivered sends outrank capture counts: while any are pending, the badge
    // belongs to them.
    if (pendingBadgeCount > 0) return;
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

// A right-click hands us up to three URLs: the clicked media element's own
// source (`srcUrl`), an anchor target (`linkUrl`), and the page (`pageUrl`).
// The catch that produced "Download failed while processing this source":
// modern players feed <video> from a MediaSource, so `srcUrl` is a `blob:`
// handle no downloader can fetch — sending it verbatim always fails. We resolve
// the click to the best *actually fetchable* source instead, mirroring the
// desktop app's own routing (see downloader::should_use_ytdlp): a real media
// file/stream is downloaded directly; a page on a site yt-dlp understands is
// queued by URL so its extractor picks the best format; anything else is opened
// for analysis so the generic extractor and the tab's sniffed streams resolve it.

// Schemes that are in-memory/handle URLs, not network resources — a downloader
// can never fetch these, so they must never be sent as a direct download.
const NON_FETCHABLE_URL = /^(?:blob:|data:|mediasource:|filesystem:|javascript:|about:|chrome:|edge:|moz-extension:|chrome-extension:)/i;
// A URL whose path is a concrete media file or adaptive manifest.
const DIRECT_MEDIA_URL = /\.(?:m3u8|mpd|mp4|webm|mkv|mov|m4v|flv|avi|ts|mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/i;
// Hosts yt-dlp extracts better than a raw GET. Kept in sync with the desktop
// `YTDLP_SITES` list; matched on label boundaries so `t.co` does not swallow
// every host ending in `t.com`.
const EXTRACTOR_HOSTS = [
    'youtube.com', 'youtube-nocookie.com', 'youtu.be', 'vimeo.com', 'twitch.tv',
    'twitter.com', 'x.com', 't.co', 'instagram.com', 'tiktok.com', 'facebook.com',
    'fb.watch', 'reddit.com', 'redd.it', 'v.redd.it', 'dailymotion.com', 'dai.ly',
    'soundcloud.com', 'bilibili.com', 'streamable.com', 'kick.com', 'rumble.com',
    'ok.ru', 'vk.com',
];

function asHttpUrl(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || NON_FETCHABLE_URL.test(trimmed)) return null;
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function isDirectMediaUrl(url) {
    try {
        const parsed = new URL(url);
        return DIRECT_MEDIA_URL.test(parsed.pathname + parsed.search);
    } catch {
        return false;
    }
}

function isExtractorSite(url) {
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        return EXTRACTOR_HOSTS.some((site) => host === site || host.endsWith(`.${site}`));
    } catch {
        return false;
    }
}

// The strongest stream already sniffed for a tab: a master manifest (the whole
// quality ladder) beats a single file, and audio is the last resort. This is
// the real media behind a blob-backed <video>, so a right-click can grab it
// directly on any site — not just the yt-dlp allowlist.
function bestCapturedStream(tabId) {
    if (!Number.isInteger(tabId)) return null;
    const streams = listStreams(tabId);
    if (streams.length === 0) return null;
    const rank = (stream) => {
        if (stream.streamKind === 'hls' || stream.streamKind === 'dash') return 3;
        if (stream.type !== 'audio') return 2;
        return 1;
    };
    return streams.slice().sort((a, b) => {
        const delta = rank(b) - rank(a);
        return delta !== 0 ? delta : (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    })[0];
}

async function handleContextMenuClick(info, tab) {
    const tabId = tab?.id ?? null;
    const title = tab?.title || '';

    // 1. The clicked media element's own network source (a real <video src>).
    //    A blob:/MediaSource src is rejected by asHttpUrl and falls through.
    const srcUrl = asHttpUrl(info.srcUrl);
    if (srcUrl) {
        const streamType = info.mediaType === 'audio' ? 'audio' : 'video';
        const result = await queueDownload({ tabId, url: srcUrl, title, streamType });
        notifyResult(result, srcUrl, bgT('queued'));
        return;
    }

    // 2. A clicked link. A direct media file or a page on a supported site is
    //    queued (the extractor resolves site pages); any other link the user
    //    explicitly pointed at is opened for analysis rather than guessed at.
    const linkUrl = asHttpUrl(info.linkUrl);
    if (linkUrl) {
        if (isDirectMediaUrl(linkUrl) || isExtractorSite(linkUrl)) {
            const result = await queueDownload({ tabId, url: linkUrl, title });
            notifyResult(result, linkUrl, bgT('queued'));
        } else {
            const result = await analyzeUrl({ url: linkUrl, title, tabId });
            notifyResult(result, linkUrl, bgT('analyzeOpened'));
        }
        return;
    }

    // 3. No fetchable clicked source: a blob-backed <video> or a bare page click.
    //    Prefer a concrete stream we already sniffed for this tab (works on any
    //    site), then the extractor for a known site, then analysis as a graceful
    //    catch-all so an unknown page never fails silently.
    const captured = bestCapturedStream(tabId);
    if (captured) {
        const result = await queueDownload({
            tabId,
            url: captured.url,
            title: captured.title || title,
            streamType: captured.type,
            quality: captured.quality || null,
        });
        notifyResult(result, captured.url, bgT('queued'));
        return;
    }

    // An embedded player (iframe) exposes its real media page as the frame URL,
    // which is more specific and extractable than the host page around it.
    const frameUrl = asHttpUrl(info.frameUrl);
    if (frameUrl && isExtractorSite(frameUrl)) {
        const result = await queueDownload({ tabId, url: frameUrl, title });
        notifyResult(result, frameUrl, bgT('queued'));
        return;
    }

    const pageUrl = asHttpUrl(info.pageUrl) || asHttpUrl(tab?.url);
    if (!pageUrl) {
        notifyResult({ ok: false, reason: 'no_url' }, '', '');
        return;
    }
    if (isExtractorSite(pageUrl)) {
        const result = await queueDownload({ tabId, url: pageUrl, title });
        notifyResult(result, pageUrl, bgT('queued'));
        return;
    }
    const result = await analyzeUrl({ url: pageUrl, title, tabId });
    notifyResult(result, pageUrl, bgT('analyzeOpened'));
}

// --- Notifications: context-menu action feedback ------------------------
// The context menu has no popup to show status, so confirm the outcome here.

function notifyResult(result, url, okTitle) {
    if (!chrome.notifications?.create) return;
    // A deferred job already surfaced its own "opening OMM…" notification via
    // wakeDesktopApp(); don't double up.
    if (result?.reason === 'launching') return;
    const ok = !!result?.ok;
    let message;
    if (ok) {
        message = shortenUrl(url);
    } else if (result?.reason === 'not_connected') {
        message = bgT('notConnected');
    } else if (result?.reason === 'no_url') {
        message = bgT('nothingToDownload');
    } else {
        // "Could not send. Try again." on its own is unactionable, and the app
        // *did* say why - it just never reached the user. Carry the reason.
        const reason = describeRejection(result);
        message = reason ? `${bgT('sendFailed')}\n${reason}` : bgT('sendFailed');
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

/**
 * The reason the desktop app refused a send, in one readable line.
 *
 * The bridge answers a rejection as `{ success: false, error: "…" }`, and that
 * `error` is often a JSON-encoded command error (`{ code, message, context }`) —
 * exactly the detail the user needs and the only thing the extension used to
 * throw away in favour of "Could not send. Try again."
 */
function describeRejection(result) {
    const raw = result?.body?.error ?? result?.error ?? null;
    let text = typeof raw === 'string' ? raw.trim() : '';
    if (text.startsWith('{') && text.endsWith('}')) {
        try {
            const parsed = JSON.parse(text);
            text = String(parsed?.message || parsed?.code || text).trim();
        } catch {
            /* not the structured shape after all; show it verbatim */
        }
    }
    if (!text && result?.status) text = `HTTP ${result.status}`;
    if (!text && result?.reason) text = String(result.reason);
    return text ? text.slice(0, 200) : '';
}

function shortenUrl(url) {
    try {
        const parsed = new URL(url);
        return (parsed.hostname + parsed.pathname).slice(0, 100);
    } catch {
        return String(url).slice(0, 100);
    }
}
