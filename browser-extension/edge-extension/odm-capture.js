/**
 * ODM Capture — DOM watcher injected on demand
 *
 * Injected by the background service worker via chrome.scripting.executeScript
 * on known media hosts, or when the user explicitly requests a scan.
 *
 * Responsibilities:
 *   1. Watch for <video>/<audio> elements, including ones added later.
 *   2. Report hits to the background via STREAM_INFO_DETECTED.
 *
 * What it deliberately does *not* do any more is hook `fetch` and
 * `XMLHttpRequest`. It used to, and those hooks never fired once: an
 * `executeScript` without `world: 'MAIN'` runs in the isolated world, whose
 * `window.fetch` and `XMLHttpRequest.prototype` are different objects from the
 * page's. The patches therefore intercepted only this script's own requests — of
 * which there are none — while still wrapping two hot paths on every media page
 * and implying a network coverage that did not exist. The coverage is real, just
 * elsewhere: `chrome.webRequest` in the background sees every request the page
 * makes, and is where captures actually come from.
 */
(() => {
    if (window.__odmCaptureLoaded) return;
    window.__odmCaptureLoaded = true;

    const MEDIA_EXTENSIONS = [
        '.mp4', '.webm', '.mkv', '.mov', '.m4v', '.flv', '.avi',
        '.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac',
        '.m3u8', '.mpd', '.ts'
    ];
    const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'application/x-mpegurl', 'application/vnd.apple.mpegurl', 'application/dash+xml'];
    const MIN_REPORT_INTERVAL_MS = 400;

    const reported = new Set();
    let lastReportAt = 0;

    const sendToBackground = (message) => {
        try {
            chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
        } catch (_) {
            /* context invalidated */
        }
    };

    const looksLikeMediaUrl = (url, contentType) => {
        if (!url || typeof url !== 'string') return false;
        if (url.startsWith('blob:') || url.startsWith('data:')) return false;
        const lowered = url.toLowerCase();
        if (MEDIA_EXTENSIONS.some((ext) => lowered.includes(ext))) return true;
        if (contentType) {
            const ct = contentType.toLowerCase();
            if (MEDIA_CONTENT_TYPES.some((type) => ct.startsWith(type))) return true;
        }
        return false;
    };

    const extractQuality = (url) => {
        const qualityMatch = url.match(/(\d{3,4})p/i);
        if (qualityMatch) return `${qualityMatch[1]}p`;
        const resolutionMatch = url.match(/(\d{3,4})x(\d{3,4})/);
        if (resolutionMatch) return `${resolutionMatch[2]}p`;
        return 'unknown';
    };

    const reportStream = (url, contentType, source) => {
        if (!looksLikeMediaUrl(url, contentType)) return;
        if (reported.has(url)) return;
        const now = Date.now();
        if (now - lastReportAt < MIN_REPORT_INTERVAL_MS) {
            setTimeout(() => reportStream(url, contentType, source), MIN_REPORT_INTERVAL_MS);
            return;
        }
        reported.add(url);
        lastReportAt = now;
        sendToBackground({
            action: 'STREAM_INFO_DETECTED',
            streamInfo: {
                url,
                type: (contentType || '').startsWith('audio/') ? 'audio' : 'video',
                quality: extractQuality(url),
                contentType: contentType || '',
                title: document.title || '',
                source,
                timestamp: now
            },
            url: location.href,
            timestamp: now
        });
    };

    const scanDom = () => {
        const nodes = document.querySelectorAll('video[src], audio[src], source[src]');
        nodes.forEach((element) => {
            const src = element.src || element.currentSrc || '';
            reportStream(src, element.tagName === 'AUDIO' ? 'audio/mpeg' : 'video/mp4', 'dom_scan');
        });
    };

    scanDom();

    const domObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.matches && node.matches('video, audio, source')) {
                    const src = node.src || node.getAttribute('src') || '';
                    reportStream(src, node.tagName === 'AUDIO' ? 'audio/mpeg' : 'video/mp4', 'dom_mutation');
                }
                if (node.querySelectorAll) {
                    node.querySelectorAll('video[src], audio[src], source[src]').forEach((child) => {
                        const src = child.src || child.getAttribute('src') || '';
                        reportStream(src, child.tagName === 'AUDIO' ? 'audio/mpeg' : 'video/mp4', 'dom_mutation');
                    });
                }
            }
        }
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => domObserver.disconnect(), 5 * 60 * 1000);
})();
