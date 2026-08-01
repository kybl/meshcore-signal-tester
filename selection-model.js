// SelectionModel — the one owner of the two competing repeater narrowings,
// extracted from app.js where they lived as two loose fields read at ~70 sites:
//
//   • the SELECTION (one column, toggled by clicking a row/column/dot) — dims
//     everything else and narrows the packet table to that repeater;
//   • the FILTER (comma-separated ID prefixes) — restricts every view.
//
// PRECEDENCE: a selection wins over a filter for the table narrowing (it always
// hides rows lacking that exact repeater, even within an active filter), and
// applying a filter clears any selection (a stale selection under a new filter
// used to page the wrong repeater with no visible cue — its notice is hidden
// while a filter is active). Both rules live HERE now, not in call sites.
//
// matchesFilter() is the single matching semantic: prefix-based, both ways
// ("3E" matches "3E2F1234" and vice versa), per component for "a/b" collision
// columns. Unit-tested in test/selection-model.test.js.

export class SelectionModel {
    #col = null;         // selected column key, or null
    #terms = [];         // filter terms, upper-case display prefixes
    #deps;               // { displayId: colComponent => display string }

    constructor(deps) { this.#deps = deps; }

    get col() { return this.#col; }
    get filterTerms() { return this.#terms; }
    get filterActive() { return this.#terms.length > 0; }

    // Select a column (null to deselect). Returns true when the value changed.
    select(col) {
        const v = col ?? null;
        if (v === this.#col) return false;
        this.#col = v;
        return true;
    }

    // Replace the filter terms. Applying a non-empty filter clears the
    // selection (see the precedence note above); returns true when it did.
    setFilterTerms(terms) {
        this.#terms = terms;
        if (this.#terms.length && this.#col) { this.#col = null; return true; }
        return false;
    }

    // Does a column pass the active filter? (No filter ⇒ everything passes.)
    // Collision keys like "1234/5678" match if either component does.
    matchesFilter(col) {
        if (!this.#terms.length) return true;
        const ids = col.includes('/') ? col.split('/') : [col];
        return ids.some(id => {
            const display = this.#deps.displayId(id).toUpperCase();
            return this.#terms.some(term =>
                display.startsWith(term) || term.startsWith(display)
            );
        });
    }

    // The column predicate that narrows which packets the table shows, or null
    // when it shows everything. A SELECTION takes precedence over a filter.
    narrowFn() {
        if (this.#col) { const s = this.#col; return c => c === s; }
        if (this.#terms.length) return c => this.matchesFilter(c);
        return null;
    }

    // Identity of the current narrowing (for staleness checks / repagination).
    narrowKey() {
        if (this.#col) return 's:' + this.#col;
        if (this.#terms.length) return 'f:' + this.#terms.join('\x1f');
        return '';
    }
}
