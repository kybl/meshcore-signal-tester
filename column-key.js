// Repeater "column" key semantics, extracted as PURE functions so the collision
// logic has ONE tested implementation instead of ad-hoc string parsing spread
// across app.js and signal3d.js (which is what produced a recurring class of
// "someone forgot to split on '/'" bugs). No browser globals — unit-testable
// with `node --test` (see test/column-key.test.js).
//
// A column key is one of:
//   - a bare repeater-id prefix, high-byte-first hex ("5E", "5E9F", …)
//   - the pseudo-columns "direct" / "unknown"
//   - a collision key "a/b[/c…]" — sorted, "/"-joined component prefixes,
//     created when a short id is ambiguous across several specific siblings.

// Precision = how many bytes of the id are known. Pseudo/collision keys are
// treated as fully precise (4 bytes) for the purposes of matching.
export function idPrecision(id) {
    if (id === 'direct' || id === 'unknown' || id.includes('/')) return 4;
    return Math.ceil(id.length / 2);
}

// The first `bytes` bytes of an id. IDs are high-byte-first, so compare from the
// left.
export function idSuffix(id, bytes) {
    return id.slice(0, bytes * 2).toUpperCase();
}

// The first component of a (possibly collision) key — its representative for
// suffix comparisons.
export function colHead(col) {
    return col.split('/')[0];
}

// Component prefixes of a (possibly collision) key. Pseudo-cols have none.
export function components(key) {
    if (!key || key === 'direct' || key === 'unknown') return [];
    return key.split('/').filter(s => s && s !== 'direct' && s !== 'unknown');
}

// Two column keys refer to the same repeater when equal or sharing any
// "/"-segment (a collision component).
export function colsOverlap(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const sb = b.split('/');
    return a.split('/').some(x => sb.includes(x));
}

// Effective minimum precision of a column: the stored minPrecision (shortest
// rawId ever seen for it) when known, else the precision of its first component.
export function colMinPrecision(col, storedMinPrec) {
    if (col === 'direct') return 4;
    return storedMinPrec ?? idPrecision(colHead(col));
}

// Does `rawId` belong to `col`, comparing at the shorter of their precisions?
// `storedMinPrec` is the column's stored minPrecision (or undefined) — matches
// findOrCreateColumn's promote/split matcher (a promoted column still catches
// siblings that share its original shorter prefix).
export function colMatchesRawId(col, rawId, storedMinPrec) {
    if (col === 'direct' || col === 'unknown') return false;
    const minP = Math.min(idPrecision(rawId), colMinPrecision(col, storedMinPrec));
    return idSuffix(colHead(col), minP) === idSuffix(rawId, minP);
}

// Read-only matcher without stored-minPrec knowledge: compares at the shorter of
// rawId's precision and the head component's precision. Matches app's
// _resolveColReadonly (used to colour/attribute disk-loaded points without
// mutating the column model).
export function colMatchesRawIdReadonly(col, rawId) {
    if (col === 'direct' || col === 'unknown') return false;
    const head = colHead(col);
    const p = Math.min(idPrecision(rawId), idPrecision(head));
    return idSuffix(head, p) === idSuffix(rawId, p);
}

// Read-only projection: which EXISTING column a rawId belongs to, WITHOUT
// creating/promoting/splitting. Used to attribute disk-loaded observations to
// the live column model (point colours, the packet-table narrow index, stats).
// Must agree with resolveColumn on collisions: an id ambiguous over several
// specific siblings belongs in their collision key "a/b" — returning the first
// prefix match instead made the collision column a "ghost" with no rows, so
// selecting its header narrowed the table to nothing (and it vanished).
export function resolveColumnReadonly(rawId, columns) {
    if (rawId === 'direct' || rawId === 'unknown') return rawId;
    if (columns.includes(rawId)) return rawId;
    const matches = columns.filter(col => colMatchesRawIdReadonly(col, rawId));
    if (!matches.length) return rawId;
    const specifics = matches.filter(m => !m.includes('/'));
    // Ambiguous over ≥2 specific siblings → their collision key (if it exists).
    if (specifics.length >= 2) {
        const ck = specifics.slice().sort().join('/');
        if (columns.includes(ck)) return ck;
    }
    // Specific enough to name exactly one column → that column.
    if (specifics.length === 1) return specifics[0];
    // Only collision keys match → the id belongs in one.
    return matches.find(m => m.includes('/')) ?? matches[0];
}

// Pure mirror of app's findOrCreateColumn DECISION. Operates on a COPY of the
// column list and returns:
//   { key, events } — the resolved column key for `rawId`, plus the ordered
//   side-effect events the caller must apply to migrate real data:
//     { type: 'rename', from, to }        — renameColumnKey(from, to)
//     { type: 'split',  existing, collisionKey } — _splitColumn(existing, key)
//     { type: 'add',    key }             — repeaterColumns.push(key)
// The events are recorded in the exact order they must be applied; replaying
// them through the real (side-effecting) methods reproduces the full app state.
// `minPrecOf(col)` returns a column's stored minPrecision (or undefined); it is
// read only for the initial match, before any mutation, so deferring the real
// side effects to after this returns does not change the decision.
export function resolveColumn(rawId, columns, minPrecOf = () => undefined) {
    const cols = columns.slice();
    const events = [];
    const has = k => cols.includes(k);
    const add = k => { if (!has(k)) { cols.push(k); events.push({ type: 'add', key: k }); } };
    const rename = (from, to) => {
        const oi = cols.indexOf(from);
        if (oi < 0) return;
        if (cols.indexOf(to) >= 0) cols.splice(oi, 1); else cols[oi] = to;
        events.push({ type: 'rename', from, to });
    };
    const split = (existing, collisionKey) => {
        if (!has(collisionKey)) cols.push(collisionKey);
        events.push({ type: 'split', existing, collisionKey });
    };

    if (rawId === 'direct') { add('direct'); return { key: 'direct', events }; }
    if (has(rawId)) return { key: rawId, events };

    const rawPrec = idPrecision(rawId);
    const matches = cols.filter(col => col !== 'direct' && colMatchesRawId(col, rawId, minPrecOf(col)));

    if (matches.length === 0) { add(rawId); return { key: rawId, events }; }

    const specificMatches  = matches.filter(m => !m.includes('/'));
    const collisionMatches = matches.filter(m =>  m.includes('/'));

    // Multiple distinct specific siblings → ambiguous over all of them: use (or
    // create) the canonical collision key, folding any subset collision into it.
    if (specificMatches.length >= 2) {
        const collisionKey = specificMatches.slice().sort().join('/');
        if (!has(collisionKey)) {
            const subsets = collisionMatches.filter(ck =>
                ck.split('/').every(comp => specificMatches.includes(comp)));
            for (const sub of subsets) rename(sub, collisionKey);
            add(collisionKey);
        }
        return { key: collisionKey, events };
    }

    // Exactly one specific match — promote / split, plus refining components
    // inside any matched collision keys.
    if (specificMatches.length === 1) {
        const existing = specificMatches[0];
        const existingPrec = idPrecision(existing);
        const commonPrec   = Math.min(rawPrec, existingPrec);
        const compatibleAtCommon = idSuffix(rawId, commonPrec) === idSuffix(existing, commonPrec);

        if (compatibleAtCommon) {
            if (rawPrec > existingPrec) {
                // Optimistically promote to the more-precise label, mirroring the
                // promote into every collision key that has `existing` as a
                // component (scan all — a component may not be the first).
                rename(existing, rawId);
                for (const ck of cols.slice()) {
                    if (!ck.includes('/')) continue;
                    const comps = ck.split('/');
                    if (!comps.includes(existing)) continue;
                    const newKey = comps.map(c => c === existing ? rawId : c).sort().join('/');
                    if (newKey !== ck) rename(ck, newKey);
                }
                return { key: rawId, events };
            }
            return { key: existing, events };
        }

        // Match at minPrec but conflict at full precision → split: ambiguous
        // (shorter-rawId) packets move to the collision key; the new rawId
        // becomes its own specific column.
        const collisionKey = [existing, rawId].slice().sort().join('/');
        split(existing, collisionKey);
        add(rawId);
        return { key: rawId, events };
    }

    // No specific match, only collision key(s): refine a component, add a new
    // sibling, or (short ambiguous id) belong in the existing collision key.
    let dest = collisionMatches[0];
    let isNewSibling = false;
    for (const ck of collisionMatches) {
        const comps = ck.split('/');
        const minCompPrec = Math.min(...comps.map(c => idPrecision(c)));
        const refined = comps.find(comp => {
            const cPrec = idPrecision(comp);
            return rawPrec > cPrec && idSuffix(rawId, cPrec) === idSuffix(comp, cPrec);
        });
        if (refined) {
            const newKey = comps.map(c => c === refined ? rawId : c).sort().join('/');
            if (newKey !== ck) { rename(ck, newKey); if (ck === dest) dest = newKey; }
        } else if (rawPrec >= minCompPrec) {
            add(rawId);
            const newKey = [...comps, rawId].sort().join('/');
            if (newKey !== ck) { rename(ck, newKey); if (ck === dest) dest = newKey; }
            isNewSibling = true;
        }
        // rawPrec < minCompPrec: short ambiguous id — dest unchanged.
    }
    return { key: isNewSibling ? rawId : dest, events };
}
