// Tiny localStorage wrapper: swallows quota/privacy errors and coerces types.
// Booleans are stored as 'true'/'false'; numbers as their string form.
//
// Pure, dependency-free helper shared across the app. Reads never throw (a
// blocked or full localStorage just yields the fallback), so callers can treat
// persisted settings as best-effort.
export const Store = {
    get(key, fallback = null) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
        catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
    },
    num(key, fallback) {
        const n = parseFloat(this.get(key));
        return Number.isFinite(n) ? n : fallback;
    },
    bool(key, fallback) {
        const v = this.get(key);
        return v === null ? fallback : (v === 'true' || v === '1');
    },
    json(key, fallback) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
        catch { return fallback; }
    },
};
