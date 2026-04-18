/**
 * ODM Stream Store — per-tab capture cache.
 *
 * Tracks deduplicated stream records per tab. Eviction:
 *   - Tab closed → drop the tab map.
 *   - Per-tab cap of MAX_PER_TAB; oldest record evicted when exceeded.
 *
 * A record is identified by a deterministic signature so repeated detections
 * of the same URL (e.g. probe + capture both seeing the same .mp4) collapse
 * into one entry.
 */

const MAX_PER_TAB = 50;

const tabStreams = new Map(); // tabId -> Map<signature, StreamRecord>

function signatureFor(stream) {
    const url = (stream.url || '').split('#')[0];
    const type = stream.type || 'video';
    const sizeBucket = stream.sizeBytes ? Math.floor(Number(stream.sizeBytes) / 65536) : 0;
    return `${type}|${url}|${sizeBucket}`;
}

function fileNameFromUrl(url) {
    if (!url) return 'stream';
    try {
        const parsed = new URL(url);
        const last = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
        const decoded = decodeURIComponent(last);
        return decoded.length > 80 ? decoded.slice(0, 77) + '…' : decoded;
    } catch {
        return url.slice(0, 80);
    }
}

function detectExtension(url, contentType) {
    const lowered = (url || '').toLowerCase();
    const knownExtensions = ['.m3u8', '.mpd', '.mp4', '.webm', '.mkv', '.m4a', '.mp3', '.ts', '.aac', '.flac', '.wav', '.ogg', '.flv', '.mov'];
    for (const ext of knownExtensions) {
        const i = lowered.indexOf(ext);
        if (i !== -1) return ext.slice(1);
    }
    if (contentType) {
        const ct = contentType.toLowerCase();
        if (ct.includes('mpegurl')) return 'm3u8';
        if (ct.includes('dash+xml')) return 'mpd';
        if (ct.startsWith('video/')) return ct.split('/')[1].split(';')[0];
        if (ct.startsWith('audio/')) return ct.split('/')[1].split(';')[0];
    }
    return 'unknown';
}

export function recordStream(tabId, raw) {
    if (!Number.isInteger(tabId) || tabId < 0) return null;
    if (!raw || !raw.url) return null;

    const stream = {
        url: raw.url,
        type: raw.type === 'audio' ? 'audio' : 'video',
        contentType: raw.contentType || '',
        title: raw.title || '',
        source: raw.source || 'unknown',
        quality: raw.quality || null,
        sizeBytes: raw.sizeBytes || null,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
    };
    stream.fileName = fileNameFromUrl(stream.url);
    stream.extension = detectExtension(stream.url, stream.contentType);

    const sig = signatureFor(stream);
    let map = tabStreams.get(tabId);
    if (!map) {
        map = new Map();
        tabStreams.set(tabId, map);
    }

    const existing = map.get(sig);
    if (existing) {
        existing.lastSeenAt = stream.lastSeenAt;
        if (!existing.title && stream.title) existing.title = stream.title;
        if (!existing.contentType && stream.contentType) existing.contentType = stream.contentType;
        return existing;
    }

    map.set(sig, stream);

    if (map.size > MAX_PER_TAB) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) map.delete(oldestKey);
    }

    return stream;
}

export function listStreams(tabId) {
    const map = tabStreams.get(tabId);
    if (!map) return [];
    return Array.from(map.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function listAllStreams() {
    const out = [];
    for (const [tabId, map] of tabStreams.entries()) {
        for (const stream of map.values()) {
            out.push({ tabId, stream });
        }
    }
    return out.sort((a, b) => b.stream.lastSeenAt - a.stream.lastSeenAt);
}

export function clearTab(tabId) {
    tabStreams.delete(tabId);
}

export function clearAll() {
    tabStreams.clear();
}

export function streamCountForTab(tabId) {
    return tabStreams.get(tabId)?.size || 0;
}

export function findStream(tabId, url) {
    const map = tabStreams.get(tabId);
    if (!map) return null;
    for (const stream of map.values()) {
        if (stream.url === url) return stream;
    }
    return null;
}
