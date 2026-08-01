// Guard against the APK shipping an incomplete web app: every local file
// index.html references (module preloads, scripts, stylesheet, importmap,
// favicon — and, transitively, everything the modulepreload test already
// forces into the preload list) must be covered by the copyWebApp include
// patterns in android/app/build.gradle. A hand-maintained file list once
// missed a newly added module — the APK's import failed and every button in
// the Android app went dead while the web version worked fine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const gradle = readFileSync(join(root, 'android/app/build.gradle'), 'utf8');

// Local files referenced by index.html (?v= cache busters stripped).
function referencedFiles() {
    const refs = new Set();
    const attrRe = /(?:src|href)="([^"]+)"/g;
    for (const [, url] of indexHtml.matchAll(attrRe)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url) || url.startsWith('#')) continue;   // external scheme (https, mailto, data…) or fragment
        refs.add(url.replace(/\?.*$/, ''));
    }
    // importmap values ("three": "./vendor/three.module.js?v=1")
    const im = indexHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (im) {
        for (const [, url] of im[1].matchAll(/"(\.\/[^"]+)"/g)) {
            refs.add(url.replace(/^\.\//, '').replace(/\?.*$/, ''));
        }
    }
    return [...refs];
}

// Include patterns of the copyWebApp task.
function includePatterns() {
    const block = gradle.match(/tasks\.register\('copyWebApp'[\s\S]*?\n}/);
    assert.ok(block, 'copyWebApp task not found in build.gradle');
    return [...block[0].matchAll(/include '([^']+)'/g)].map(m => m[1]);
}

function covered(file, patterns) {
    return patterns.some(p => {
        if (p.endsWith('/**')) return file.startsWith(p.slice(0, -2));
        if (p.startsWith('*.')) return !file.includes('/') && file.endsWith(p.slice(1));
        return file === p;
    });
}

test('every file index.html references is bundled into the APK', () => {
    const patterns = includePatterns();
    const refs = referencedFiles();
    assert.ok(refs.length > 10, `suspiciously few references found (${refs.length})`);
    for (const f of refs) {
        assert.ok(existsSync(join(root, f)), `index.html references missing file: ${f}`);
        assert.ok(covered(f, patterns),
            `${f} is referenced by index.html but not covered by copyWebApp includes [${patterns.join(', ')}]`);
    }
});
