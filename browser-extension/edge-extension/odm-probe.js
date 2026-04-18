/**
 * ODM Probe — passive content script
 *
 * Loaded on every page. Stays tiny. Responsibilities:
 *   1. Decide whether the page looks like a media host.
 *   2. If yes, tell the background to inject the heavy capture module.
 *   3. Serve as the SCAN_STREAMS target so the popup can request a scan at any time.
 *
 * The heavy module (odm-capture.js) is injected on demand via
 * chrome.scripting.executeScript by the background service worker.
 */
(() => {
    if (window.__odmProbeLoaded) return;
    window.__odmProbeLoaded = true;

    const MEDIA_HOST_HINTS = [
        'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 't.co',
        'instagram.com', 'tiktok.com', 'facebook.com', 'fb.watch',
        'vimeo.com', 'twitch.tv', 'dailymotion.com', 'soundcloud.com',
        'reddit.com', 'v.redd.it', 'streamable.com', 'bilibili.com',
        'kick.com', 'rumble.com', 'ok.ru', 'vk.com'
    ];

    const host = (location.hostname || '').toLowerCase();
    const looksLikeMediaHost = MEDIA_HOST_HINTS.some(hint => host.includes(hint));

    const sendToBackground = (message) => {
        try {
            chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
        } catch (_) {
            /* extension context may be invalidated; ignore */
        }
    };

    const scanDom = () => {
        const streams = [];
        const mediaElements = document.querySelectorAll('video[src], audio[src], source[src]');
        mediaElements.forEach((element) => {
            const src = element.src || element.currentSrc || '';
            if (!src || src.startsWith('blob:') || src.startsWith('data:')) return;
            streams.push({
                url: src,
                type: element.tagName === 'AUDIO' ? 'audio' : 'video',
                title: document.title || '',
                source: 'dom_probe',
                timestamp: Date.now()
            });
        });
        return streams;
    };

    const announceReady = () => {
        sendToBackground({
            action: 'CONTENT_SCRIPT_READY',
            url: location.href,
            timestamp: Date.now(),
            needsCapture: looksLikeMediaHost,
            probeVersion: 1
        });
    };

    const reportScanResults = () => {
        const streams = scanDom();
        streams.forEach((streamInfo) => {
            sendToBackground({
                action: 'STREAM_INFO_DETECTED',
                streamInfo,
                url: location.href,
                timestamp: Date.now()
            });
        });
        return streams;
    };

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || message.action !== 'SCAN_STREAMS') return false;
        try {
            const streams = reportScanResults();
            sendResponse({ success: true, streams });
        } catch (error) {
            sendResponse({ success: false, error: String(error && error.message || error) });
        }
        return true;
    });

    let lastUrl = location.href;
    const onNavigation = () => {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        sendToBackground({
            action: 'NAVIGATION_CHANGED',
            url: location.href,
            timestamp: Date.now()
        });
    };
    window.addEventListener('popstate', onNavigation);
    window.addEventListener('hashchange', onNavigation);
    const navigationObserver = new MutationObserver(onNavigation);
    navigationObserver.observe(document.documentElement, { subtree: true, childList: true });
    setTimeout(() => navigationObserver.disconnect(), 30000);

    announceReady();

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(reportScanResults, 1500);
    } else {
        window.addEventListener('load', () => setTimeout(reportScanResults, 1500), { once: true });
    }
})();
