// TimeWindows — the one owner of the app's three time windows and the frozen
// chart clock, extracted from app.js where the same derivations (display
// cutoff, RAM-window sizing, frozen-now fallback, select-value parsing) were
// spelled inline at ~50 call sites:
//
//   • retentionMs (Auto-remove / HASH_LIFETIME): data older than this is
//     permanently deleted; Infinity = keep everything.
//   • displayMs (Display / DISPLAY_LIFETIME): how far back the views look;
//     Infinity = "All". INVARIANT: a finite Display may not exceed a finite
//     retention — allowsDisplay() is the single place that rule lives.
//   • renderBudgetMs: how much recent history RAM must hold for rendering.
//   • frozenAt: the chart clock freezes here while not collecting (imported /
//     paused sessions render against this instead of the wall clock);
//     null = live.
//
// Pure (no DOM/browser deps) — unit-tested in test/time-windows.test.js.

export class TimeWindows {
    #retentionMs;
    #displayMs;
    #renderBudgetMs;
    #frozenAt;

    constructor({ retentionMs = 15 * 60 * 1000, displayMs = Infinity,
                  renderBudgetMs = 60 * 60 * 1000, frozenAt = Date.now() } = {}) {
        this.#retentionMs = retentionMs;
        this.#displayMs = displayMs;
        this.#renderBudgetMs = renderBudgetMs;
        this.#frozenAt = frozenAt;
    }

    get retentionMs()    { return this.#retentionMs; }
    set retentionMs(v)   { this.#retentionMs = v; }
    get displayMs()      { return this.#displayMs; }
    set displayMs(v)     { this.#displayMs = v; }
    get renderBudgetMs() { return this.#renderBudgetMs; }
    get frozenAt()       { return this.#frozenAt; }
    set frozenAt(v)      { this.#frozenAt = v; }

    // Parse an Auto-remove/Display <select> value: 'Infinity' or 'all' mean
    // unbounded; anything else is seconds.
    static msFromSelect(v) {
        return (v === 'all' || v === 'Infinity') ? Infinity : +v * 1000;
    }

    // The chart time reference: the frozen clock while not collecting, else now.
    now() { return this.#frozenAt ?? Date.now(); }

    // Display-window cutoff. 0 (falsy) = unbounded — callers use `if (cutoff)`.
    displayCutoff() {
        return isFinite(this.#displayMs) ? Date.now() - this.#displayMs : 0;
    }

    // The Display ≤ Auto-remove invariant: is a Display span of `ms` allowed
    // under the current retention? "All" (Infinity) is always allowed — it
    // simply means "as far back as Auto-remove keeps".
    allowsDisplay(ms) {
        if (!isFinite(ms) || !isFinite(this.#retentionMs)) return true;
        return ms <= this.#retentionMs;
    }

    // How much recent history to keep in RAM. Until the store finishes opening
    // there is no disk to fall back to, so keep everything that should be
    // visible (bounded by retention, else the display window, else unbounded).
    // Once ready, RAM is bounded by the render budget.
    ramWindowMs(storeReady) {
        if (!storeReady) {
            if (isFinite(this.#retentionMs)) return this.#retentionMs;
            if (isFinite(this.#displayMs)) return this.#displayMs;
            return Infinity;
        }
        const ret  = isFinite(this.#retentionMs) ? this.#retentionMs : Infinity;
        const disp = isFinite(this.#displayMs) ? this.#displayMs : 0;
        return Math.min(Math.max(disp, this.#renderBudgetMs), ret);
    }
}
