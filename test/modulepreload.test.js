// Keeps the <link rel="modulepreload"> block in index.html in sync with the
// real ES-module import graph. The block only helps if every href matches its
// import specifier EXACTLY (?v= cache buster included): a stale or missing
// entry silently costs a download or a waterfall level, which no other test
// would ever notice. This test crawls the graph the way the browser does —
// starting from the <script type="module"> entry, following static/dynamic
// import specifiers and the importmap — and asserts the preload list is
// exactly that set. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

// --- pieces of index.html -----------------------------------------------------

function preloadHrefs() {
    return [...html.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"/g)]
        .map(m => m[1]);
}

function moduleScriptSrcs() {
    return [...html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)]
        .map(m => m[1]);
}

function importMap() {
    const m = html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/);
    assert.ok(m, 'importmap present in index.html');
    return JSON.parse(m[1]).imports;
}

// --- import-graph crawl ---------------------------------------------------------

// URL identity is "path relative to the site root, query string included" —
// that is what the browser keys its module map and preload cache on.
function resolve(specifier, importerUrl, imports) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        const mapped = imports[specifier];
        assert.ok(mapped, `bare specifier '${specifier}' (from ${importerUrl}) is in the importmap`);
        return resolve(mapped, 'index.html', imports);
    }
    const dir = importerUrl.replace(/\?.*$/, '').split('/').slice(0, -1);
    const parts = specifier.split('/');
    for (const p of parts) {
        if (p === '.') continue;
        else if (p === '..') assert.ok(dir.pop() !== undefined, `'${specifier}' escapes the site root`);
        else dir.push(p);
    }
    return dir.join('/');
}

// Static imports (incl. multi-line named lists), bare imports, re-exports and
// dynamic import() with a literal — the forms a browser fetches eagerly enough
// for a preload to matter.
const IMPORT_RE = [
    /^import\s+[\w$*,{}\s]+?from\s+['"]([^'"]+)['"]/gm,
    /^import\s+['"]([^'"]+)['"]/gm,
    /^export\s+[\w$*,{}\s]+?from\s+['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function specifiersOf(url) {
    const src = readFileSync(join(root, url.replace(/\?.*$/, '')), 'utf8');
    const out = [];
    for (const re of IMPORT_RE)
        for (const m of src.matchAll(re)) out.push(m[1]);
    return out;
}

function crawl() {
    const imports = importMap();
    const entries = moduleScriptSrcs();
    assert.equal(entries.length, 1, 'exactly one <script type="module"> entry point');
    const reached = new Set();            // url-with-query
    const byFile = new Map();             // file path → Set of urls it was imported as
    const queue = [...entries];
    while (queue.length) {
        const url = queue.shift();
        const file = url.replace(/\?.*$/, '');
        if (!byFile.has(file)) byFile.set(file, new Set());
        byFile.get(file).add(url);
        if (reached.has(url)) continue;
        reached.add(url);
        for (const spec of specifiersOf(url))
            queue.push(resolve(spec, url, imports));
    }
    return { reached, byFile };
}

// --- the actual guarantees -------------------------------------------------------

test('modulepreload list equals the reachable module graph, ?v= included', () => {
    const { reached } = crawl();
    const preloads = preloadHrefs();
    assert.deepEqual(
        [...preloads].sort(),
        [...reached].sort(),
        'index.html <link rel="modulepreload"> must list exactly the modules the ' +
        'entry script reaches, each with the exact URL it is imported as'
    );
    assert.equal(new Set(preloads).size, preloads.length, 'no duplicate preload entries');
});

test('every module is imported under a single URL (no double-download)', () => {
    const { byFile } = crawl();
    for (const [file, urls] of byFile)
        assert.equal(urls.size, 1,
            `${file} is imported as ${[...urls].join(' AND ')} — mismatched ?v= ` +
            'cache busters make the browser fetch the file twice');
});

test('all reachable module files exist on disk', () => {
    const { reached } = crawl();
    for (const url of reached) {
        const file = url.replace(/\?.*$/, '');
        assert.doesNotThrow(() => readFileSync(join(root, file)), `${file} exists`);
    }
});
