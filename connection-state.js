// ConnectionState + ReconnectController — the explicit owners of the
// connection lifecycle, extracted from app.js where it used to live as ~8
// loose flags on the app object (transportKind, connectionMode,
// _wasConnected, _intentionalDisconnect, _lastDropWasSurprise, _reconnecting,
// _reconnectTries, _reconnectTimer) whose correctness balanced on write
// ordering across a dozen methods. The state is #private here and every
// transition is an intent-named method, so a caller physically can't leave
// half of a transition applied.
//
// Deliberately NOT owned here: the transport handles themselves (device,
// serialPort, reader, characteristics) and their platform quirks — those stay
// in app.js next to the Web Bluetooth / Web Serial code they belong to. This
// class knows WHAT the connection is; app.js knows HOW it is carried.
//
// Unit-tested with fake timers — see test/connection-state.test.js.

export class ConnectionState {
    #transportKind = null;        // 'ble' | 'serial' | null — no transport up
    #mode = null;                 // 'companion' | 'repeater' | null — null while detecting (or idle)
    #established = false;         // a connection was fully finalised (drop ⇒ maybe surprise)
    #intentional = false;         // the teardown in progress was user-initiated
    #lastDropWasSurprise = false; // gates "reconnect when Bluetooth comes back on"

    get transportKind()       { return this.#transportKind; }
    get mode()                { return this.#mode; }
    get established()         { return this.#established; }
    get lastDropWasSurprise() { return this.#lastDropWasSurprise; }

    // A connect attempt started on `kind`. BLE always speaks the companion
    // protocol; serial stays mode-null until detection resolves it.
    beginAttempt(kind) {
        this.#transportKind = kind;
        this.#mode = kind === 'ble' ? 'companion' : null;
    }

    // Detection resolved (serial), or a probe re-routes parsing ('repeater'
    // during phase 2 — see connectToSerialPort).
    setMode(mode) { this.#mode = mode; }

    // The connection is fully set up (status shows Connected). From here an
    // uninitiated drop is a surprise. A fresh connection also clears any
    // pending teardown intent and reconnect gate from the previous one.
    finalise() {
        this.#established = true;
        this.#intentional = false;
        this.#lastDropWasSurprise = false;
    }

    // The user asked to disconnect — the upcoming drop is not a surprise.
    intendDisconnect() { this.#intentional = true; }

    // The connection dropped (any cause, any phase). Resets the per-connection
    // state and answers: was this a SURPRISE the caller should react to
    // (alarm / auto-reconnect)? While a reconnect cycle owns recovery
    // (midReconnect), the answer is always no, and the remembered
    // lastDropWasSurprise is left alone — each failed retry drops through
    // here too, and clobbering the flag would wipe the original surprise
    // intent that "reconnect when Bluetooth comes back on" depends on.
    drop({ midReconnect = false } = {}) {
        const surprise = this.#established && !this.#intentional;
        this.#established = false;
        this.#intentional = false;
        this.#transportKind = null;
        this.#mode = null;
        if (midReconnect) return false;
        this.#lastDropWasSurprise = surprise;
        return surprise;
    }
}

// The auto-reconnect cycle: try, back off, give up — extracted verbatim from
// the _startAutoReconnect/_scheduleReconnect/_tryReconnect/_cancelAutoReconnect
// quartet. Timers are injectable so tests drive the schedule synchronously.
//
// deps:
//   attempt()        — one reconnect attempt (async; errors are swallowed)
//   isBack()         — true when a connection is up again (stops the cycle)
//   onAttemptStart() — UI hook: show "Reconnecting…" (each try, incl. the first)
//   onGiveUp()       — UI hook: retries exhausted (alarm)
export class ReconnectController {
    static MAX_TRIES = 5;
    static FIRST_DELAY_MS = 500;

    #deps;
    #setTimeout;
    #clearTimeout;
    #active = false;
    #tries = 0;
    #timer = null;

    constructor(deps, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
        this.#deps = deps;
        this.#setTimeout = setTimeoutFn;
        this.#clearTimeout = clearTimeoutFn;
    }

    get active() { return this.#active; }

    start() {
        if (this.#active) return;
        this.#active = true;
        this.#tries = 0;
        this.#deps.onAttemptStart();
        this.#schedule(ReconnectController.FIRST_DELAY_MS);
    }

    cancel() {
        this.#active = false;
        this.#clearTimeout(this.#timer);
        this.#timer = null;
    }

    #schedule(delay) {
        this.#clearTimeout(this.#timer);
        this.#timer = this.#setTimeout(() => this.#tick(), delay);
    }

    async #tick() {
        if (!this.#active) return;
        if (this.#deps.isBack()) { this.cancel(); return; }   // already back (manual connect)
        this.#tries++;
        this.#deps.onAttemptStart();
        try { await this.#deps.attempt(); }
        catch (e) { console.warn('Auto-reconnect attempt failed:', e); }
        if (!this.#active) return;                            // cancelled meanwhile
        if (this.#deps.isBack()) { this.cancel(); return; }   // success
        if (this.#tries >= ReconnectController.MAX_TRIES) {
            this.cancel();
            this.#deps.onGiveUp();
            return;
        }
        // A failed attempt left the status at 'Disconnected'; the next tick's
        // onAttemptStart restores 'Reconnecting…'. Exponential backoff, capped.
        this.#deps.onAttemptStart();
        this.#schedule(Math.min(8000, 2000 * 2 ** (this.#tries - 1)));
    }
}
