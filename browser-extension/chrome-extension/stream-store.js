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

// Query parameters that only version a single logical asset (byte ranges,
// segment numbers, cache-busters). Stripping them collapses the dozens of
// near-identical variant requests one stream emits into a single row.
const VOLATILE_PARAMS = ['range', 'rn', 'rbuf', 'sq', 'dur', 'keepalive', 'mt', 'ei', 'ip', 'clen', 'gir'];

/**
 * Transport-level noise a person never downloads directly: HLS/DASH media
 * segments, byte-range chunks, init segments and encryption keys, plus the
 * YouTube/Google delivery URLs (those pages are handled by the page → yt-dlp
 * path). Dropping these is what keeps one video from flooding the list with
 * hundreds of rows and evicting the manifest that is actually downloadable.
 */
export function isTransportNoise(url) {
    if (!url) return true;
    const u = url.toLowerCase();
    if (u.includes('googlevideo.com') || u.includes('/videoplayback')) return true;
    if (/\.ts(?:[?#]|$)/.test(u)) return true;
    if (/\.m4s(?:[?#]|$)/.test(u)) return true;
    if (/(?:[/_.-])init(?:[/_.-]|\.mp4|\.m4s|$)/.test(u)) return true;
    if (/\.key(?:[?#]|$)/.test(u)) return true;
    if (/[?&](?:range|sq|segment|seg|frag|chunk)=/.test(u)) return true;
    // e.g. "seg-12", "segment_001", "chunk5" — a segment index, not a title
    // that merely contains the word "segment".
    if (/[/_-](?:seg|segment|frag|chunk)[-_.]?\d/.test(u)) return true;
    return false;
}

/**
 * Classify a URL into the kinds we surface, most-actionable first, or null if
 * it is not a recognisable downloadable media entry. `hls`/`dash` are the
 * master manifests; `video`/`audio` are whole files.
 */
export function classifyMedia(url, contentType) {
    const u = (url || '').toLowerCase();
    const ct = (contentType || '').toLowerCase();
    if (/\.m3u8(?:[?#]|$)/.test(u) || ct.includes('mpegurl')) return 'hls';
    if (/\.mpd(?:[?#]|$)/.test(u) || ct.includes('dash+xml')) return 'dash';
    if (/\.(?:mp4|webm|mkv|mov|m4v|flv|avi)(?:[?#]|$)/.test(u) || ct.startsWith('video/')) return 'video';
    if (/\.(?:mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/.test(u) || ct.startsWith('audio/')) return 'audio';
    return null;
}

/** URL stripped of volatile params and hash, so variant requests collapse. */
function canonicalUrl(url) {
    try {
        const parsed = new URL(url);
        for (const param of VOLATILE_PARAMS) parsed.searchParams.delete(param);
        const query = parsed.searchParams.toString();
        return parsed.origin + parsed.pathname + (query ? `?${query}` : '');
    } catch {
        return (url || '').split('#')[0];
    }
}

function signatureFor(stream) {
    const kind = stream.streamKind || stream.type || 'video';
    return `${kind}|${canonicalUrl(stream.url)}`;
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
    if (isTransportNoise(raw.url)) return null;

    // Only keep recognisable, downloadable media. This is the single chokepoint
    // every detection path (webRequest, fetch/XHR hooks, DOM scan) flows
    // through, so filtering here cleans up the list everywhere at once.
    const kind = classifyMedia(raw.url, raw.contentType);
    if (!kind) return null;

    const stream = {
        url: raw.url,
        streamKind: kind,
        type: kind === 'audio' ? 'audio' : 'video',
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
