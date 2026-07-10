// ContactsDirectory — the one owner of the synced contact list, extracted from
// app.js where the map, prefix matching, persistence and the incremental-sync
// marker were spread over ~30 sites. It holds, as #private state:
//
//   • the entries map  (pubKeyFullHex → {name, type, lat, lon, lastAdvert,
//     lastmod, pubKeyFullHex}), fed by the device contact sync, adverts and
//     CSV import;
//   • the incremental-sync marker (lastmod) — advanced ONLY when a full list
//     completed (END_OF_CONTACTS), never per contact (an interrupted fetch must
//     not make later reconnects skip the missing tail);
//   • the debounced persistence to the session store (KV 'contacts'), so
//     contacts survive a reload / renderer-crash rebuild.
//
// The lookup helpers are collision-aware: a column key may be a short prefix,
// a promoted longer prefix, or an "a/b" collision label — byPrefix() matches
// contacts for EITHER component (the literal "a/b" never startsWith-matches a
// pubkey), and colForPubKey() maps a full key back to the most specific live
// column. Unit-tested in test/contacts-directory.test.js.

import * as ColumnKey from './column-key.js?v=2';

export class ContactsDirectory {
    #entries = new Map();
    #lastmod = 0;
    #persistTimer = null;
    #deps;   // { ready: () => bool, persist: payload => void, onCountChanged: () => void }

    constructor(deps) { this.#deps = deps; }

    get size()    { return this.#entries.size; }
    get lastmod() { return this.#lastmod; }
    set lastmod(v){ this.#lastmod = v; }

    get(pubKeyFullHex) { return this.#entries.get(pubKeyFullHex); }
    has(pubKeyFullHex) { return this.#entries.has(pubKeyFullHex); }
    values()           { return this.#entries.values(); }

    // Insert/replace one contact: updates the count UI and schedules the
    // debounced persist. Merging with an existing entry is the caller's job
    // (each source keeps its own precedence rules — see the advert handler).
    put(contact) {
        this.#entries.set(contact.pubKeyFullHex, contact);
        this.#deps.onCountChanged();
        this.schedulePersist();
    }

    // Restore from the session store on startup — deliberately does NOT
    // re-persist what was just read.
    restore(saved) {
        if (!saved || !Array.isArray(saved.entries)) return;
        for (const c of saved.entries) if (c?.pubKeyFullHex) this.#entries.set(c.pubKeyFullHex, c);
        if (Number.isFinite(saved.lastmod)) this.#lastmod = saved.lastmod;
        this.#deps.onCountChanged();
    }

    // Persist (debounced) so contacts survive a reload; the sync marker is
    // saved too, so a reconnect resumes from it instead of re-pulling the list.
    schedulePersist() {
        if (!this.#deps.ready()) return;
        clearTimeout(this.#persistTimer);
        this.#persistTimer = setTimeout(() => {
            this.#deps.persist({ entries: [...this.#entries.values()], lastmod: this.#lastmod });
        }, 1000);
    }

    // Wipe everything and cancel any pending persist, so it can't re-write the
    // contacts after the session store has been cleared.
    clear() {
        this.#entries.clear();
        this.#lastmod = 0;
        clearTimeout(this.#persistTimer); this.#persistTimer = null;
    }

    // ---- collision-aware lookups --------------------------------------------

    // All contacts whose pubkey starts with any component of the column key
    // ("a/b" matches contacts for either a or b).
    byPrefix(colKey) {
        const segs = ColumnKey.components(colKey).map(s => s.toLowerCase());
        if (!segs.length) return [];
        const out = [];
        for (const [key, val] of this.#entries)
            if (segs.some(p => key.startsWith(p))) out.push(val);
        return out;
    }

    firstByPrefix(colKey) { return this.byPrefix(colKey)[0] ?? null; }

    // Display name for a column: the single match's name, or "a / b" for a
    // collision column with several matching contacts.
    nameForCol(colKey) {
        const matches = this.byPrefix(colKey);
        if (!matches.length) return null;
        if (matches.length === 1) return matches[0].name ?? null;
        return matches.map(c => c.name ?? '?').join(' / ');
    }

    // The column's contacts that can be shown on the map (named, with a
    // position) — drives the eye/pushpin buttons and "Show all repeaters".
    gpsFor(colKey) {
        return this.byPrefix(colKey).filter(c => c.name && (c.lat !== 0 || c.lon !== 0));
    }

    // Every named+positioned contact matching ANY of the given columns,
    // deduplicated by pubkey.
    withGps(colKeys) {
        const out = [];
        const seen = new Set();
        for (const col of colKeys) {
            for (const c of this.byPrefix(col)) {
                if (!seen.has(c.pubKeyFullHex) && c.name && (c.lat !== 0 || c.lon !== 0)) {
                    seen.add(c.pubKeyFullHex);
                    out.push(c);
                }
            }
        }
        return out;
    }

    // Map a contact's full public key back to the live repeater column it
    // belongs to. Columns are keyed by a short hash *prefix* (often 2 hex
    // chars, sometimes promoted longer, or an "a/b" collision key) — NOT by a
    // fixed 6-char pubkey slice; keying a pinned marker off slice(0,6) selects
    // a phantom column that matches no data. Picks the longest (most specific)
    // matching component; returns the ORIGINAL key (columns are upper-case,
    // pubkeys lower-case) so it still matches the rx data / selection exactly.
    // Null when no current column matches.
    colForPubKey(pubKeyHex, columns) {
        if (!pubKeyHex) return null;
        const pk = pubKeyHex.toLowerCase();
        let bestKey = null, bestLen = -1;
        for (const key of columns) {
            for (const seg of key.split('/')) {
                if (seg === 'direct' || seg === 'unknown') continue;
                const s = seg.toLowerCase();
                if (s && pk.startsWith(s) && s.length > bestLen) {
                    bestKey = key; bestLen = s.length;
                }
            }
        }
        return bestKey;
    }
}
