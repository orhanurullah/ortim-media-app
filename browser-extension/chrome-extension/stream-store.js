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

/** Where the cache is mirrored so it survives the service worker being evicted.
 *
 *  MV3 stops the worker after a short idle, taking every in-memory Map with it.
 *  That was invisible while detection only ran with the desktop app open,
 *  because each record had already been pushed to the app. Now that detection
 *  also runs with the app closed - which is the whole point of keeping it on -
 *  the worker's memory is the only copy, and losing it means a user who browses,
 *  waits, then opens the popup finds nothing.
 *
 *  `session` rather than `local`: it lives for the browser session, is dropped
 *  on exit, and never touches disk, so nothing a user watched outlives the
 *  window they watched it in. */
const SESSION_KEY = 'ommTabStreams';
/** Writes are coalesced: a playing stream fires detections in bursts, and one
 *  write per detection would be the cost this whole change exists to avoid. */
const PERSIST_DEBOUNCE_MS = 400;
let persistTimer = null;

function schedulePersist() {
    if (!chrome?.storage?.session || persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        const plain = {};
        for (const [tabId, map] of tabStreams) {
            plain[tabId] = Array.from(map.entries());
        }
        chrome.storage.session.set({ [SESSION_KEY]: plain }).catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
}

/** Reloads the cache after a worker restart. Safe to call more than once: an
 *  entry already in memory is newer than the stored copy and wins. */
export async function restoreStreams() {
    if (!chrome?.storage?.session) return;
    try {
        const stored = await chrome.storage.session.get(SESSION_KEY);
        const plain = stored?.[SESSION_KEY];
        if (!plain || typeof plain !== 'object') return;
        for (const [tabId, entries] of Object.entries(plain)) {
            const id = Number(tabId);
            if (!Number.isInteger(id) || !Array.isArray(entries)) continue;
            if (!tabStreams.has(id)) tabStreams.set(id, new Map());
            const map = tabStreams.get(id);
            for (const [sig, record] of entries) {
                if (!map.has(sig)) map.set(sig, record);
            }
        }
    } catch {
        // A cache that will not load is not a reason to break detection.
    }
}

// Query parameters that only version a single logical asset (byte ranges,
// segment numbers, cache-busters). Stripping them collapses the dozens of
// near-identical variant requests one stream emits into a single row.
//
// The Meta CDNs (Facebook, Instagram) are the reason this list is not just
// YouTube's: they fetch a progressive MP4 as a series of byte ranges and re-sign
// every single request, so `bytestart`/`byteend` and the `_nc_*`/`oh`/`oe`
// signature carry a different value each time. Left in the signature, one 30
// second reel became one row per chunk — which is how scrolling a feed produced
// fifty indistinguishable entries. The path already identifies the asset, so the
// per-request noise can go.
const VOLATILE_PARAMS = [
    'range', 'rn', 'rbuf', 'sq', 'dur', 'keepalive', 'mt', 'ei', 'ip', 'clen', 'gir',
    'bytestart', 'byteend', 'efg', 'ccb', 'oh', 'oe', 'strext', 'vs', 'sid',
    '_nc_ohc', '_nc_ht', '_nc_cat', '_nc_gid', '_nc_sid', '_nc_zt', '_nc_oc', '_nc_rid',
];

/** Range parameters that make a URL fetch *part* of a file instead of the file.
 *  These must be stripped from what we hand the downloader, not merely from the
 *  dedup signature: the first chunk we happened to see is the one we would have
 *  stored, and downloading it yields a truncated, unplayable file. */
const RANGE_PARAMS = ['bytestart', 'byteend', 'range'];

/** The URL to actually download: the observed one, minus any byte-range slice.
 *  Everything else (the CDN signature above all) is left untouched, because the
 *  request 403s without it. */
function downloadableUrl(url) {
    try {
        const parsed = new URL(url);
        let changed = false;
        for (const param of RANGE_PARAMS) {
            if (parsed.searchParams.has(param)) {
                parsed.searchParams.delete(param);
                changed = true;
            }
        }
        return changed ? parsed.toString() : url;
    } catch {
        return url;
    }
}

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

// A site's own interface makes noises, and they are served as real media with
// real media content-types. The one that reached a user's download queue was
// `https://www.youtube.com/s/search/audio/open.mp3` — YouTube's search-box click
// sound, 6167 bytes of `audio/mpeg`. It passed every filter, inherited the page
// title, and sat in the popup looking exactly like the lecture the user wanted.
//
// Size is the reliable discriminator. Interface sounds are a few kilobytes;
// anything a person would want to keep is orders of magnitude larger. The floor
// only applies to whole files whose length the response actually declared —
// never to HLS/DASH manifests, which are legitimately tiny, and never when
// content-length is missing, where the path rule below is the fallback.
const MEDIA_SIZE_FLOOR_BYTES = 64 * 1024;

// Static/interface asset roots, for when content-length is not declared.
// `/s/` is YouTube's static asset root (`/s/search/...`, `/s/player/...`).
const INTERFACE_ASSET_PATH = /(?:^\/s\/)|\/(?:sounds?|sfx|ui|chrome|assets\/audio)\//i;

/** Whether the URL asks for a slice of a file rather than the file. Its declared
 *  length then measures the slice, which says nothing about the media. */
function isRangeRequest(url) {
    try {
        const parsed = new URL(url);
        return RANGE_PARAMS.some((param) => parsed.searchParams.has(param));
    } catch {
        return false;
    }
}

function isInterfaceAsset(url, kind, sizeBytes) {
    // Manifests describe a stream rather than containing it; their own size says
    // nothing about the media behind them.
    if (kind === 'hls' || kind === 'dash') return false;
    // Nor does the length of a byte range. A player's opening probe can be a few
    // kilobytes of a feature-length video, so applying the floor here would throw
    // away the whole asset on the strength of its first chunk.
    if (isRangeRequest(url)) return false;

    const size = Number(sizeBytes);
    if (Number.isFinite(size) && size > 0 && size < MEDIA_SIZE_FLOOR_BYTES) return true;

    try {
        return INTERFACE_ASSET_PATH.test(new URL(url).pathname);
    } catch {
        return false;
    }
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

function hostFromUrl(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
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
    if (isInterfaceAsset(raw.url, kind, raw.sizeBytes)) return null;

    const stream = {
        url: downloadableUrl(raw.url),
        streamKind: kind,
        type: kind === 'audio' ? 'audio' : 'video',
        contentType: raw.contentType || '',
        title: raw.title || '',
        // What page it was seen on. A stream sniffed off the network carries no
        // title of its own, and "1080p MP4" over an opaque CDN file name told the
        // user nothing about which of fifty rows was the video they were looking
        // at. The page it came from is the one label that always means something.
        pageTitle: raw.pageTitle || '',
        pageHost: raw.pageHost || hostFromUrl(raw.url),
        source: raw.source || 'unknown',
        quality: raw.quality || null,
        // A range request declares the length of its slice, not of the file, and
        // showing "2 MB" beside a 40-minute video is worse than showing nothing.
        sizeBytes: isRangeRequest(raw.url) ? null : raw.sizeBytes || null,
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
        if (!existing.pageTitle && stream.pageTitle) existing.pageTitle = stream.pageTitle;
        if (!existing.contentType && stream.contentType) existing.contentType = stream.contentType;
        // A later chunk usually declares a smaller content-length than the whole
        // file; the largest one seen is the closest thing to the real size.
        if (stream.sizeBytes && stream.sizeBytes > (existing.sizeBytes || 0)) {
            existing.sizeBytes = stream.sizeBytes;
        }
        schedulePersist();
        return existing;
    }

    map.set(sig, stream);

    // Evict the least *recently seen* record, not the first one inserted. The
    // old rule dropped whatever arrived earliest even if it was the manifest
    // still actively playing, because refreshing a record does not reorder a Map.
    if (map.size > MAX_PER_TAB) {
        let stalestKey;
        let stalestAt = Infinity;
        for (const [key, record] of map) {
            const seenAt = record.lastSeenAt || 0;
            if (seenAt < stalestAt) {
                stalestAt = seenAt;
                stalestKey = key;
            }
        }
        if (stalestKey !== undefined) map.delete(stalestKey);
    }

    schedulePersist();
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
    // Mirror the eviction: a closed tab whose records outlived it in session
    // storage would come back on the next worker restart.
    schedulePersist();
}

export function clearAll() {
    tabStreams.clear();
    schedulePersist();
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
