/**
 * ODM Bridge Client — connection to the desktop engine.
 *
 * Single responsibility: maintain a connection to the ODM desktop bridge
 * (axum server, port 39343), bootstrap an auth token, push captures, and
 * expose status to the background script.
 *
 * Connection strategy:
 *   1. Try bootstrap (HTTP GET /odm/ext/bootstrap) — if it fails, the engine
 *      isn't running. Schedule a backoff retry.
 *   2. On bootstrap success, post captures via HTTP (the bridge accepts both
 *      WebSocket and HTTP; HTTP is simpler and works the same for the popup
 *      use case). Periodic /odm/api/stream/status polls keep the snapshot warm.
 *   3. WebSocket is optional and used only for live status pushes if available.
 *
 * Backoff: 2s → 4s → 8s → 16s → 30s (cap), reset on success.
 */

const DEFAULT_PORTS = [39343, 39344];
const BOOTSTRAP_PATH = '/odm/ext/bootstrap';
const STREAM_PATH = '/odm/api/stream';
const STATUS_PATH = '/odm/api/stream/status';
const DOWNLOAD_PATH = '/odm/ext/download';
const CAPTURE_PATH = '/odm/ext/capture';
const ANALYZE_PATH = '/odm/ext/analyze';
const STATUS_POLL_INTERVAL_MS = 8_000;
const BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

export const ConnectionStatus = Object.freeze({
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
});

class BridgeClient extends EventTarget {
    constructor() {
        super();
        this.status = ConnectionStatus.DISCONNECTED;
        this.port = null;
        this.authToken = null;
        this.bridgeVersion = null;
        this.uiLanguage = null;
        this.lastStatus = null;
        this.lastError = null;
        this._backoffIndex = 0;
        this._connectTimer = null;
        this._pollTimer = null;
    }

    start() {
        this._scheduleConnect(0);
    }

    stop() {
        if (this._connectTimer) {
            clearTimeout(this._connectTimer);
            this._connectTimer = null;
        }
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        this._setStatus(ConnectionStatus.DISCONNECTED);
    }

    /**
     * Force an immediate reconnect attempt, bypassing the current backoff wait.
     * Called right after the desktop app is woken so queued captures flush the
     * moment the bridge comes up instead of waiting out the backoff (up to 30s).
     * No-op unless idle in backoff, so it never stacks onto an in-flight connect.
     */
    kick() {
        if (this.status !== ConnectionStatus.DISCONNECTED) return;
        this._backoffIndex = 0;
        this._scheduleConnect(0);
    }

    getSnapshot() {
        return {
            status: this.status,
            port: this.port,
            bridgeVersion: this.bridgeVersion,
            uiLanguage: this.uiLanguage,
            queue: this.lastStatus?.downloadQueue || [],
            activeQueueCount: this.lastStatus?.activeQueueCount ?? 0,
            queueCount: this.lastStatus?.queueCount ?? 0,
            lastError: this.lastError,
        };
    }

    /**
     * Send a single captured stream to the engine.
     * Fire-and-forget; failures are logged and surface via getSnapshot().
     */
    async pushCapture(captureRecord) {
        return this._send(CAPTURE_PATH, {
            type: 'STREAM_DETECTED',
            data: captureRecord,
            timestamp: Date.now(),
        });
    }

    /**
     * Queue a download in the engine.
     * payload: { stream, downloadType, queueId? } or { urls/rawText, ... } batch.
     */
    async queueDownload(payload) {
        return this._send(STREAM_PATH, {
            type: payload.batch ? 'BATCH_DOWNLOAD_REQUEST' : 'DOWNLOAD_REQUEST',
            data: payload.data,
            timestamp: Date.now(),
        });
    }

    /**
     * Ask the desktop app to analyze a URL (opens CaptureView, runs yt-dlp).
     * payload: { url, title?, tabId? }
     */
    async requestAnalyze(payload) {
        return this._send(ANALYZE_PATH, payload);
    }

    /**
     * POST to the bridge, and treat "the app is not there any more" as exactly
     * that.
     *
     * Each send used to answer `request_failed` when the fetch threw, and a bare
     * `{ ok: false, status: 401 }` when the bridge rejected the token. Both mean
     * the desktop app this client believed in is gone: it was closed (loopback
     * connection refused) or it restarted and issued a new token. But only
     * `not_connected` makes background.js queue the job and wake the app, so
     * that first send was dropped with a 1.8s "failed" flash and the user had to
     * click a second time — by then the 8s status poll had noticed and moved the
     * client to DISCONNECTED, which is why the *second* click was the one that
     * launched OMM. Note the poll cannot be relied on to notice first: a
     * suspended MV3 service worker runs no timers at all.
     *
     * Dropping the connection here also clears the stale token and schedules the
     * reconnect, so the queued job flushes as soon as the app answers.
     */
    async _send(path, body) {
        if (this.status !== ConnectionStatus.CONNECTED) {
            return { ok: false, reason: 'not_connected' };
        }
        let response;
        try {
            response = await this._post(path, body);
        } catch (error) {
            this.lastError = stringifyError(error);
            this._dropConnection();
            return { ok: false, reason: 'not_connected' };
        }
        if (response.status === 401 || response.status === 403) {
            this.lastError = `auth_failed_${response.status}`;
            this._dropConnection();
            return { ok: false, reason: 'not_connected' };
        }
        const parsed = await safeJson(response);
        return { ok: response.ok, status: response.status, body: parsed };
    }

    /** Trigger an immediate status refresh. */
    async refreshStatus() {
        if (this.status !== ConnectionStatus.CONNECTED || !this.port) return null;
        try {
            const response = await fetch(this._url(STATUS_PATH), {
                method: 'GET',
                headers: this._authHeaders(),
            });
            if (response.status === 401 || response.status === 403) {
                this.lastError = `auth_failed_${response.status}`;
                this._dropConnection();
                return null;
            }
            if (!response.ok) {
                this.lastError = `status_http_${response.status}`;
                return null;
            }
            const body = await response.json();
            this.lastStatus = body;
            this.lastError = null;
            // The status poll carries the app's current language, so a change
            // made while connected is mirrored live instead of only on reconnect.
            if (
                typeof body.uiLanguage === 'string' &&
                body.uiLanguage &&
                body.uiLanguage !== this.uiLanguage
            ) {
                this.uiLanguage = body.uiLanguage;
                this._emit('language-changed', this.uiLanguage);
            }
            this._emit('status-updated', body);
            return body;
        } catch (error) {
            this.lastError = `status_fetch_${stringifyError(error)}`;
            this._dropConnection();
            return null;
        }
    }

    _scheduleConnect(delayMs) {
        if (this._connectTimer) clearTimeout(this._connectTimer);
        this._connectTimer = setTimeout(() => {
            this._connectTimer = null;
            this._connect().catch((error) => {
                this.lastError = stringifyError(error);
            });
        }, delayMs);
    }

    async _connect() {
        this._setStatus(ConnectionStatus.CONNECTING);
        console.log('[ODM] connect attempt, ports:', DEFAULT_PORTS);
        for (const port of DEFAULT_PORTS) {
            const result = await this._bootstrap(port);
            console.log(`[ODM] bootstrap port=${port}`, result);
            if (result.ok) {
                this.port = port;
                this.authToken = result.authToken;
                this.bridgeVersion = result.bridgeVersion;
                this.uiLanguage = result.uiLanguage || this.uiLanguage;
                this._backoffIndex = 0;
                this.lastError = null;
                this._setStatus(ConnectionStatus.CONNECTED);
                this._startPolling();
                this.refreshStatus();
                return;
            }
        }
        console.warn('[ODM] all bootstrap attempts failed; lastError=', this.lastError);
        this._setStatus(ConnectionStatus.DISCONNECTED);
        const delay = BACKOFF_STEPS_MS[Math.min(this._backoffIndex, BACKOFF_STEPS_MS.length - 1)];
        this._backoffIndex += 1;
        this._scheduleConnect(delay);
    }

    async _bootstrap(port) {
        const url = `http://127.0.0.1:${port}${BOOTSTRAP_PATH}`;
        console.log('[ODM] fetching', url);
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'x-odm-extension': '3.0.0' },
            });
            console.log('[ODM] fetch response', response.status);
            if (!response.ok) {
                this.lastError = `bootstrap_http_${response.status}`;
                return { ok: false };
            }
            const body = await response.json();
            if (!body || !body.success) {
                this.lastError = 'bootstrap_rejected';
                return { ok: false };
            }
            return {
                ok: true,
                authToken: body.authToken,
                bridgeVersion: body.bridgeVersion,
                uiLanguage: body.uiLanguage,
            };
        } catch (error) {
            this.lastError = `bootstrap_fetch_${stringifyError(error)}`;
            return { ok: false };
        }
    }

    _startPolling() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = setInterval(() => {
            this.refreshStatus();
        }, STATUS_POLL_INTERVAL_MS);
    }

    _dropConnection() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        this.authToken = null;
        this._setStatus(ConnectionStatus.DISCONNECTED);
        this._scheduleConnect(BACKOFF_STEPS_MS[0]);
    }

    async _post(path, body) {
        const response = await fetch(this._url(path), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this._authHeaders(),
            },
            body: JSON.stringify(body),
        });
        return response;
    }

    _authHeaders() {
        const headers = { 'x-odm-extension': '3.0.0' };
        if (this.authToken) headers['x-odm-token'] = this.authToken;
        return headers;
    }

    _url(path) {
        return `http://127.0.0.1:${this.port}${path}`;
    }

    _setStatus(next) {
        if (this.status === next) return;
        this.status = next;
        this._emit('status-changed', { status: next });
    }

    _emit(name, detail) {
        try {
            this.dispatchEvent(new CustomEvent(name, { detail }));
        } catch {
            /* CustomEvent unavailable in some service worker hosts; ignore */
        }
    }
}

function stringifyError(error) {
    if (!error) return 'unknown';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    try { return JSON.stringify(error); } catch { return String(error); }
}

async function safeJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

export const bridgeClient = new BridgeClient();
