/**
 * ODM wake page — the visible half of a cold-start hand-off.
 *
 * Why a page at all: a "Send to OMM" with the desktop app closed has to launch
 * it through the `omm://` deep link, and the only way to hand a custom scheme to
 * the OS is a navigation. The background script used to do that by opening a tab
 * straight onto `omm://wake` and closing it 1.5s later — which dropped the user
 * on a blank tab and, worse, tore down the browser's own "Open Ortim Media
 * Manager?" consent dialog mid-decision, so the app never launched.
 *
 * This page owns that navigation instead:
 *   - it triggers the deep link from a real page origin, so the browser offers
 *     the "always allow" checkbox and later wakes need no dialog at all;
 *   - the consent dialog can sit open as long as the user needs, and a manual
 *     button re-triggers it if the automatic attempt was blocked;
 *   - it reports the hand-off — launching → connected → sent/failed — so the
 *     answer to "did my download actually start?" is on screen, in the browser,
 *     instead of only inside an app the user has to go and open.
 */

const WAKE_URL = 'omm://wake';
// How long to wait for the bridge before assuming the launch did not take.
const LAUNCH_TIMEOUT_MS = 30_000;

const els = {
    spinner: document.getElementById('spinner'),
    mark: document.getElementById('mark'),
    headline: document.getElementById('headline'),
    status: document.getElementById('status'),
    jobs: document.getElementById('jobs'),
    openBtn: document.getElementById('open-btn'),
    closeBtn: document.getElementById('close-btn'),
    hint: document.getElementById('hint'),
};

const MESSAGES = {
    tr: {
        title: 'Ortim Media Manager',
        launching: 'OMM açılıyor',
        launchingBody: 'Tarayıcının onay penceresinde "Aç" deyin. Bu pencere işler gönderilince kendini kapatır.',
        waiting: 'OMM açılıyor',
        waitingBody: 'Onayınız bekleniyor. Bu arada bağlantı denenmeye devam ediyor.',
        sending: 'Gönderiliyor',
        sendingBody: 'Bağlantı kuruldu, bekleyen işler aktarılıyor…',
        doneTitle: 'OMM’ye gönderildi',
        doneBody: 'iş kuyruğa alındı. Uygulamada takip edebilirsiniz.',
        doneNoneBody: 'OMM açık ve bağlı.',
        failedTitle: 'OMM açılamadı',
        failedBody: 'Uygulama yanıt vermedi. Onay penceresini kapattıysanız aşağıdan tekrar deneyin, ya da OMM’yi elle açın — istekleriniz kaydedildi ve uygulama açılınca gönderilir.',
        rejectedTitle: 'Gönderilemedi',
        rejectedBody: 'OMM bağlandı ama isteği kabul etmedi:',
        openBtn: 'Uygulamayı aç',
        retryBtn: 'Tekrar dene',
        closeBtn: 'Kapat',
        hintAllow: 'İpucu: onay penceresindeki "Her zaman izin ver" kutusunu işaretlerseniz bir daha sorulmaz.',
    },
    en: {
        title: 'Ortim Media Manager',
        launching: 'Opening OMM',
        launchingBody: 'Choose "Open" in the browser’s confirmation dialog. This window closes itself once your items are sent.',
        waiting: 'Opening OMM',
        waitingBody: 'Waiting for your confirmation. The connection keeps retrying in the meantime.',
        sending: 'Sending',
        sendingBody: 'Connected, handing over the queued items…',
        doneTitle: 'Sent to OMM',
        doneBody: 'queued. You can follow them in the app.',
        doneNoneBody: 'OMM is open and connected.',
        failedTitle: 'OMM did not open',
        failedBody: 'The app never answered. If you dismissed the confirmation, try again below, or open OMM yourself — your requests are saved and will be sent as soon as it is running.',
        rejectedTitle: 'Could not be sent',
        rejectedBody: 'OMM connected but refused the request:',
        openBtn: 'Open the app',
        retryBtn: 'Try again',
        closeBtn: 'Close',
        hintAllow: 'Tip: tick "Always allow" in the confirmation dialog and you will not be asked again.',
    },
};

let lang = 'tr';
let phase = 'launching';
let closeTimer = null;
let launchDeadline = null;
let lastTriggerAt = 0;
let pollTimer = null;
// The browser raises its "Open Ortim Media Manager?" consent dialog once per
// navigation, so two triggers a second apart stack two dialogs on the user. One
// launch attempt stands until it has had time to fail.
const MIN_TRIGGER_INTERVAL_MS = 4_000;
// How long the browser's own consent dialog gets to be the only thing asking
// for a decision. Past this the automatic navigation evidently produced no
// dialog (a blocked navigation, a dismissed one), so the page offers its own
// way to trigger it.
const FALLBACK_BUTTON_AFTER_MS = 8_000;

const t = (key) => (MESSAGES[lang] || MESSAGES.tr)[key];

function send(payload) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(payload, (response) => {
                void chrome.runtime.lastError;
                resolve(response || null);
            });
        } catch {
            resolve(null);
        }
    });
}

/** Hand `omm://wake` to the OS. Registered → the app launches and this document
 *  is left untouched; not registered → the navigation is simply discarded. Either
 *  way the page survives, which is what lets us keep reporting status. */
function triggerDeepLink({ force = false } = {}) {
    const now = Date.now();
    if (!force && lastTriggerAt && now - lastTriggerAt < MIN_TRIGGER_INTERVAL_MS) return;
    lastTriggerAt = now;
    launchDeadline = now + LAUNCH_TIMEOUT_MS;
    try {
        window.location.href = WAKE_URL;
    } catch {
        /* blocked; the manual button is the fallback */
    }
}

function render(state) {
    const pending = state?.pending || [];
    const sent = state?.sent ?? 0;
    const failures = state?.failures || [];
    const settled = phase === 'done' || phase === 'failed' || phase === 'rejected';

    els.spinner.hidden = settled;
    els.mark.hidden = !settled;
    els.openBtn.textContent = phase === 'failed' ? t('retryBtn') : t('openBtn');
    els.closeBtn.textContent = t('closeBtn');

    // The browser raises its own "Open Ortim Media Manager?" dialog, and that
    // dialog is the action. A second, greener "Open the app" sitting behind it
    // is a competing button for the same decision — and pressing it only raises
    // another dialog. So the page keeps quiet while the browser is asking, and
    // offers its own trigger only once that has evidently led nowhere: the
    // navigation was blocked (no dialog ever appeared) or the launch failed.
    const awaitingLaunch = phase === 'launching' || phase === 'waiting';
    const attemptAge = lastTriggerAt ? Date.now() - lastTriggerAt : Infinity;
    els.openBtn.hidden = !(
        phase === 'failed' || (awaitingLaunch && attemptAge > FALLBACK_BUTTON_AFTER_MS)
    );
    els.hint.hidden = !(awaitingLaunch || phase === 'failed');
    els.hint.textContent = t('hintAllow');

    if (phase === 'done') {
        els.mark.textContent = '✓';
        els.mark.dataset.tone = 'ok';
        els.headline.textContent = t('doneTitle');
        els.status.textContent = sent > 0 ? sent + ' ' + t('doneBody') : t('doneNoneBody');
    } else if (phase === 'rejected') {
        els.mark.textContent = '!';
        els.mark.dataset.tone = 'error';
        els.headline.textContent = t('rejectedTitle');
        els.status.textContent = t('rejectedBody') + ' ' + failures.join(' · ');
    } else if (phase === 'failed') {
        els.mark.textContent = '!';
        els.mark.dataset.tone = 'error';
        els.headline.textContent = t('failedTitle');
        els.status.textContent = t('failedBody');
    } else if (phase === 'sending') {
        els.headline.textContent = t('sending');
        els.status.textContent = t('sendingBody');
    } else if (phase === 'waiting') {
        els.headline.textContent = t('waiting');
        els.status.textContent = t('waitingBody');
    } else {
        els.headline.textContent = t('launching');
        els.status.textContent = t('launchingBody');
    }

    els.jobs.innerHTML = '';
    for (const item of pending.slice(0, 6)) {
        const li = document.createElement('li');
        li.textContent = item;
        li.title = item;
        els.jobs.appendChild(li);
    }
}

function applyState(state) {
    if (!state) return;
    if (state.uiLanguage === 'en' || state.uiLanguage === 'tr') {
        lang = state.uiLanguage;
        document.documentElement.lang = lang;
        document.title = t('title');
    }

    const pendingCount = (state.pending || []).length;
    if (state.connected && pendingCount === 0 && state.failures?.length) {
        phase = 'rejected';
    } else if (state.connected && pendingCount === 0) {
        phase = 'done';
    } else if (state.connected) {
        phase = 'sending';
    } else if (launchDeadline && Date.now() > launchDeadline) {
        // Checked before CONNECTING, not after. The eager reconnect leaves the
        // bridge in CONNECTING for a slice of almost every second, so testing
        // that first meant a launch that never happened could sit in "waiting"
        // forever and never reach the state that offers a retry.
        phase = 'failed';
    } else if (state.status === 'CONNECTING') {
        phase = 'waiting';
    } else {
        phase = 'launching';
    }

    render(state);

    // Only a clean hand-off closes the window on its own; a failure stays up so
    // the user can retry or read why.
    if (phase === 'done' && !closeTimer) {
        closeTimer = setTimeout(() => send({ action: 'WAKE_DISMISS' }), 1600);
    }
}

async function poll() {
    const state = await send({ action: 'WAKE_GET_STATE' });
    // Another wake page has taken over (this one is a leftover from a duplicated
    // tab, or from before sends were single-flighted). Two identical "Open the
    // app" pages is the confusion; close quietly rather than keep polling.
    if (state?.stale) {
        if (pollTimer) window.clearInterval(pollTimer);
        void send({ action: 'WAKE_DISMISS' });
        window.close();
        return;
    }
    applyState(state);
}

els.openBtn.addEventListener('click', () => {
    // An explicit click is the user asking for exactly one more attempt, so it
    // overrides the anti-stacking interval that guards the automatic path.
    phase = 'launching';
    triggerDeepLink({ force: true });
    poll();
});
els.closeBtn.addEventListener('click', () => send({ action: 'WAKE_DISMISS' }));

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'HANDOFF_UPDATE') applyState(message.state);
});

document.documentElement.lang = lang;
// The deep link goes first so the very first paint already knows an attempt is
// in flight. Rendering before it left `lastTriggerAt` at zero, which reads as
// "the automatic attempt never ran" — and flashed the fallback button for one
// frame beside a consent dialog that was about to appear anyway.
triggerDeepLink();
render({});
poll();
// The background pushes updates, but a service worker that was evicted mid-wake
// pushes nothing — so also ask on a slow tick, which is what turns a launch that
// never happened into a visible failure instead of a spinner forever.
pollTimer = setInterval(poll, 1000);
