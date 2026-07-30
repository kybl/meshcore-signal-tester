// Headless-browser regression harness for the MeshCore Signal Tester web app.
//
// This is NOT part of `node --test` (it lives outside test/ and isn't named
// *.test.*) and is NOT bundled into the APK — it's an agent/local tool that
// drives the real page in Chromium so DOM-level behaviour can be verified before
// shipping a build. It covers what the pure unit tests can't: that data actually
// flows into the tables/stats and that the column sort order is right.
//
// It cannot exercise live BLE/USB capture (no device) or judge 3D-map visuals
// (software WebGL only) — those still need on-device checks. Data is injected via
// CSV import, with timestamps relative to now() so the recent-window sort key is
// deterministic.
//
// Run:  cd tools/browser-check && npm i playwright-core && node check.mjs
// Chromium is auto-detected from PLAYWRIGHT_BROWSERS_PATH / /opt/pw-browsers.

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');   // repo root (serves index.html + modules)

// ---- tiny static file server (ES modules need http, not file://) ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };
function serve(rootDir) {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split('?')[0]);
            let file = path.join(rootDir, rel === '/' ? '/index.html' : rel);
            if (!file.startsWith(rootDir)) { res.writeHead(403).end(); return; }
            fs.readFile(file, (err, buf) => {
                if (err) { res.writeHead(404).end(); return; }
                res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
                res.end(buf);
            });
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

// ---- locate the pre-installed Chromium -------------------------------------
function findChromium() {
    const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
    for (const r of roots) {
        let dirs = [];
        try { dirs = fs.readdirSync(r).filter(d => d.startsWith('chromium-') && !d.includes('headless')); } catch { continue; }
        dirs.sort();
        for (const d of dirs.reverse()) {
            const exe = path.join(r, d, 'chrome-linux', 'chrome');
            if (fs.existsSync(exe)) return exe;
        }
    }
    return null;
}

// ---- deterministic sample data --------------------------------------------
// Three repeaters with DISTINCT packet counts, every timestamp comfortably
// older than 5 min so the recent-window sort key (#1) ties at 0 for all — the
// order is then decided purely by first-page presence (#2). The lowest-count
// repeater is given the STRONGEST last RSSI, so the pre-fix behaviour (order by
// lastRssi) would rank it first; the fix must rank by first-page count instead.
function sampleCsv() {
    const H = ['time','type','hash','repeater','snr','uplink_snr','rssi','raw_hex','lat','lon','text','sender'];
    const now = Date.now();
    const specs = [
        { id: 'AAAA01', n: 30, rssi: -110 },   // most packets, weakest signal
        { id: 'BBBB02', n: 20, rssi: -90 },
        { id: 'CCCC03', n: 10, rssi: -60 },    // fewest packets, strongest signal
    ];
    // A contact (name + GPS) per repeater, pubkey starting with the repeater id so
    // _contactsByPrefix matches it — this is what "Show all repeaters" needs.
    const contacts = specs.map((s, i) => ({
        pubKeyFullHex: (s.id.toLowerCase() + '0'.repeat(64)).slice(0, 64),
        name: 'Rep-' + s.id,
        lat: (50.06 + i * 0.001).toFixed(6),
        lon: (14.41 + i * 0.001).toFixed(6),
    }));
    const rows = [];
    for (const c of contacts) rows.push('# CONTACT,' + [c.pubKeyFullHex, c.name, c.lat, c.lon].join(','));
    rows.push(H.join(','));
    let h = 0x4000;
    let step = 0;
    for (const s of specs) {
        for (let i = 0; i < s.n; i++) {
            // 10..130 min ago, spread out; always > 5 min old
            const t = new Date(now - (10 + step * 2) * 60 * 1000).toISOString();
            step++;
            const lat = (50.05 + step * 0.0004).toFixed(6);
            const lon = (14.40 + step * 0.0006).toFixed(6);
            const snr = (Math.sin(step / 4) * 6 + 3).toFixed(2);
            rows.push([t, 'RX_LOG_DATA', (h++).toString(16), s.id, snr, '', s.rssi, '', lat, lon, '', ''].join(','));
        }
    }
    // One zero-stuffed frame (20 zero bytes, then a tail): decodes as a
    // structurally "valid" packet, so only the app-side ⚠ flag marks it.
    rows.push([new Date(now - 12 * 60 * 1000).toISOString(), 'RX_LOG_DATA', 'feed', 'AAAA01',
               '3.00', '', -100, '00'.repeat(20) + 'deadbeef', '', '', '', ''].join(','));
    // One Trace packet (header path = per-hop SNR bytes 0x31/0xFA = 12.25/−1.5 dB):
    // its detail must render them as dB, not as phantom node hashes.
    rows.push([new Date(now - 11 * 60 * 1000).toISOString(), 'RX_LOG_DATA', 'trc1', 'AAAA01',
               '2.00', '', -99, '260231fa112233445566778800aabb', '', '', '', ''].join(','));
    // 110 old filler rows (all AAAA01, so the column order stays untouched)
    // push the table past one page — and hide a needle ('xyzzy-…' in the text
    // column) deep on the LAST page, where only the disk-wide message-filter
    // index can find it.
    for (let i = 0; i < 110; i++) {
        const t = new Date(now - (300 + i * 2) * 60 * 1000).toISOString();
        rows.push([t, 'RX_LOG_DATA', (0x9000 + i).toString(16), 'AAAA01', '1.00', '', -100, '',
                   '', '', i === 105 ? 'xyzzy-needle in a haystack' : '', ''].join(','));
    }
    return { csv: rows.join('\n'), total: specs.reduce((a, s) => a + s.n, 0) + 2 + 110, order: specs.map(s => s.id),
             contactCount: contacts.length };
}

// ---- assertions ------------------------------------------------------------
let failures = 0;
// Poll until `fn` returns true (async UI flows — narrow-index builds, page
// reloads — finish at unpredictable times under a loaded headless CPU; fixed
// sleeps made these checks flaky).
async function waitUntil(fn, { timeout = 8000, step = 150 } = {}) {
    const t0 = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - t0 > timeout) return false;
        await new Promise(r => setTimeout(r, step));
    }
}
function check(name, cond, detail = '') {
    if (cond) { console.log(`  ✓ ${name}`); }
    else { console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); failures++; }
}

async function main() {
    const exe = findChromium();
    if (!exe) { console.error('Chromium not found (PLAYWRIGHT_BROWSERS_PATH / /opt/pw-browsers).'); process.exit(2); }

    const { csv, total, order } = sampleCsv();
    const csvPath = path.join(os.tmpdir(), `mc-check-${process.pid}.csv`);
    fs.writeFileSync(csvPath, csv);

    const srv = await serve(ROOT);
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}/index.html`;

    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: 500, height: 1000 }, deviceScaleFactor: 2 });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('dialog', d => d.accept());   // resume / clear-data confirms

    console.log(`\nMeshCore Signal Tester — browser regression check`);
    console.log(`  chromium: ${exe}`);
    console.log(`  serving:  ${ROOT}\n`);

    // 1) Smoke: the page loads and initialises without throwing.
    await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1200);
    check('page title is correct', (await page.title()) === 'MeshCore Signal Tester');
    check('no uncaught page errors on load', pageErrors.length === 0, pageErrors.join(' | '));
    check('3D-map canvas is present', await page.$('canvas') != null);

    // 2) CSV import populates the stats and tables.
    const input = await page.$('input[type=file]');
    await input.setInputFiles(csvPath);
    await page.waitForSelector('#msgTableHead th.msg-col-rep', { timeout: 15000 });
    await page.waitForTimeout(2500);   // let sort + render + map-fit settle
    const totalRx = (await page.textContent('#totalRx'))?.trim();
    const repCount = (await page.textContent('#totalRepeaters'))?.trim();
    check(`Total RX shows imported count (${total})`, totalRx === String(total), `got ${totalRx}`);
    check('repeater count is 3', repCount === '3', `got ${repCount}`);

    // 3) Bug-2 guard: columns ranked by first-page presence, NOT by last RSSI.
    const cols = await page.$$eval('#msgTableHead th.msg-col-rep', ths => ths.map(t => t.getAttribute('data-col')));
    // Zero-stuffed frame flag: the fixture holds one frame starting with 20
    // zero bytes; it must carry the ⚠ badge in the Received Packets table.
    check('zero-stuffed frame carries the ⚠ badge',
        await page.$('#msgTableBody .zs-badge') != null);

    check('Received Packets column order = by first-page count',
        JSON.stringify(cols) === JSON.stringify(order),
        `expected ${JSON.stringify(order)}, got ${JSON.stringify(cols)}`);

    // 3b) End-to-end smoke of "Show all repeaters": with GPS contacts present the
    // button pins them and flips to "Hide all repeaters". (A fresh import keeps
    // everything in the live model, so this doesn't reproduce the RAM-pruned state
    // the original bug needed — it exercises the path, it isn't a guard for that
    // exact condition; that fix is verified by reading the code.)
    const showBtn = await page.$('#showAllRepeatersBtn');
    const beforeText = (await showBtn.textContent()).trim();
    await showBtn.click();
    await page.waitForTimeout(400);
    const afterText = (await page.textContent('#showAllRepeatersBtn')).trim();
    check('"Show all repeaters" pins them (button flips to "Hide all repeaters")',
        beforeText === 'Show all repeaters' && afterText === 'Hide all repeaters',
        `before "${beforeText}", after "${afterText}"`);

    // 3b2) Selecting a repeater: clicking a column header shows the "Selected"
    // corner notice and narrows the table to that repeater's rows; clicking it
    // again deselects. Exercises the selection fan-out end to end.
    const rowCount = () => page.$$('#msgTableWrap tbody tr:not(.detail-row)').then(r => r.length);
    const noticeVisible = () => page.$eval('#selNotice', el => !el.classList.contains('hidden'));
    const fullRows = await rowCount();
    // Select the LAST column (the least-frequent repeater, CCCC03): the first
    // one now has more rows than one page, so selecting it wouldn't shrink
    // the page-capped row count at all.
    const colHeaders = await page.$$('#msgTableHead th.msg-col-rep[data-col]');
    const selHeader = colHeaders[colHeaders.length - 1];
    const selCol = await selHeader.getAttribute('data-col');
    await selHeader.click();
    const narrowed = await waitUntil(async () => (await noticeVisible()) && (await rowCount()) < fullRows);
    const selRows = await rowCount();
    await page.click(`#msgTableHead th.msg-col-rep[data-col="${selCol}"]`);
    const restored = await waitUntil(async () => !(await noticeVisible()) && (await rowCount()) === fullRows);
    check('selecting a repeater shows the notice and narrows the table; reselect clears',
        narrowed && selRows > 0 && restored,
        `narrowed ${narrowed} (${selRows}/${fullRows} rows), restored ${restored}`);

    // 3c) Changing the Display and Auto-remove windows exercises the
    // time-window handlers (select parsing, the Display ≤ Auto-remove option
    // gating, and the wide-view rebuild). The sample data is 10–130 min old, so
    // Display=1h shows a strict subset and Display=All restores everything.
    await page.selectOption('#hideSelect', '3600');    // Display = 1 h
    const narrowed1h = await waitUntil(async () => { const n = await rowCount(); return n > 0 && n < fullRows; });
    const rows1h = await rowCount();
    await page.selectOption('#hideSelect', 'all');     // Display = All
    const restoredAll = await waitUntil(() => rowCount().then(n => n === fullRows));
    check('Display=1h narrows the table, Display=All restores it',
        narrowed1h && restoredAll, `1h → ${rows1h}/${fullRows} rows, All restored: ${restoredAll}`);
    // The loading modal exists and must not be stuck open after the rebuild
    // settles (the small fixture rebuilds under the 250 ms grace, so it never
    // shows — but a bug leaving it visible would strand the whole UI).
    const modalOk = await waitUntil(() =>
        page.$eval('#loadingModal', el => el.classList.contains('hidden')).catch(() => false));
    check('loading modal is not stuck open after a Display change', modalOk);
    await page.selectOption('#ttlSelect', '3600');     // Auto-remove = 1 h (fires its handler)
    await page.waitForTimeout(600);
    const disabledOpts = await page.$$eval('#hideSelect option', os => os.filter(o => o.disabled).map(o => o.value));
    check('Auto-remove=1h disables longer Display options (3h/12h), keeps All',
        disabledOpts.includes('10800') && disabledOpts.includes('43200') && !disabledOpts.includes('all'),
        `disabled: ${JSON.stringify(disabledOpts)}`);
    await page.selectOption('#ttlSelect', 'Infinity'); // restore
    await page.waitForTimeout(400);

    // Trace detail: opening the trace row's signal cell must show the header
    // path as per-hop dB values, not hex "hashes".
    await page.click('#row-trc1 .sig-snr');
    const traceDetail = await waitUntil(() =>
        page.$eval('#detail-trc1 .detail-trace', el => el.textContent.includes('12.25 dB') && el.textContent.includes('-1.5 dB'))
            .catch(() => false));
    check('Trace detail shows the header path as per-hop SNR in dB', traceDetail);
    await page.click('#row-trc1 .sig-snr').catch(() => {});   // close the detail again

    // Disk-wide message filter: the needle row sits on the LAST page (rows
    // 101+ newest-first); the filter must repaginate over the whole history
    // to find it — the old page-local filter showed nothing.
    const visRows = () => page.$$eval('#msgTableBody tr[id^="row-"]',
        els => els.filter(e => e.style.display !== 'none').length);
    await page.evaluate(() => {
        const i = document.getElementById('msgFilter');
        i.value = 'xyzzy';
        i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const foundNeedle = await waitUntil(async () => (await visRows()) === 1);
    check('message filter finds a row beyond the loaded page (disk-wide index)',
        foundNeedle, `visible rows ${await visRows()}`);
    await page.evaluate(() => {
        const i = document.getElementById('msgFilter');
        i.value = '';
        i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitUntil(async () => (await visRows()) > 50);

    // 4) Clear data empties the table and resets the counter.
    await page.getByText('Clear data', { exact: false }).first().click();
    const rxZero = await waitUntil(async () => (await page.textContent('#totalRx'))?.trim() === '0');
    check('Clear data resets Total RX to 0', rxZero);
    const colsGone = await waitUntil(async () =>
        (await page.$$('#msgTableHead th.msg-col-rep')).length === 0);
    check('Clear data removes repeater columns', colsGone);

    // 5) Packet-position source: switching to "MeshCore device" persists and a
    // debug-injected packet still ingests cleanly (its geotag reads the device
    // position, which is unknown here — must yield null coords, not a crash).
    await page.evaluate(() => {
        const s = document.getElementById('locSourceSelect');
        s.value = 'device';
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const locPersisted = await page.evaluate(() => localStorage.getItem('locSource'));
    await page.click('button.collapse-btn[data-target="debugBody"]');   // expand the Debug section
    await page.fill('#debugRepeater', 'AB12CD');
    await page.click('#debugInject');
    const injected = await waitUntil(async () => (await page.textContent('#totalRx'))?.trim() === '1');
    check('packet-position source "MeshCore device" persists and ingests without phone GPS',
        locPersisted === 'device' && injected, `locSource=${locPersisted}, totalRx=${await page.textContent('#totalRx')}`);
    // Not collecting (no device connected) → the no-position warning stays hidden.
    const warnHidden = await page.$eval('#locSourceWarn', el => el.classList.contains('hidden'));
    check('no-position warning stays hidden while not collecting', warnHidden);

    // End-to-end warning behavior with the device source: collecting + no
    // device position → warning shows; a position arriving → warning clears.
    // (_collecting is forced — headless has no real radio to connect.)
    const setSource = v => page.evaluate(val => {
        const s = document.getElementById('locSourceSelect');
        s.value = val;
        s.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    await setSource('device');
    const warnShown = await page.evaluate(() => {
        const app = window.__mcApp;
        app._collecting = true;
        app.signalMap?.setDeviceLocation(null, null);
        app._updateLocSourceWarning();
        return !document.getElementById('locSourceWarn').classList.contains('hidden');
    });
    const warnCleared = await page.evaluate(() => {
        const app = window.__mcApp;
        app.signalMap?.setDeviceLocation(50.08, 14.43);
        app._updateLocSourceWarning();
        const hidden = document.getElementById('locSourceWarn').classList.contains('hidden');
        app.signalMap?.setDeviceLocation(null, null);   // restore
        app._collecting = false;
        app._updateLocSourceWarning();
        return hidden;
    });
    await setSource('phone');
    check('no-position warning: shows while collecting without a device position, clears on a fix',
        warnShown && warnCleared);

    // "Center on me" is always visible; its "⚠ no position" note reflects the
    // selected source: shown with no fix (headless has none), hidden once the
    // device source has a position.
    const navUi = await page.evaluate(() => {
        const app = window.__mcApp;
        const btnVisible = !document.getElementById('centerOnMeBtn').classList.contains('hidden');
        const noteShown = !document.getElementById('centerNoPos').classList.contains('hidden');
        app.signalMap?.setPositionSource('device');
        app.signalMap?.setDeviceLocation(50.08, 14.43);
        const noteHidden = document.getElementById('centerNoPos').classList.contains('hidden');
        app.signalMap?.setDeviceLocation(null, null);   // restore
        app.signalMap?.setPositionSource('phone');
        return btnVisible && noteShown && noteHidden;
    });
    check('Center on me is always visible; its no-position note tracks the selected source', navUi);
    await page.evaluate(() => {
        const s = document.getElementById('locSourceSelect');
        s.value = 'phone';
        s.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Click every Connect button once. Headless Chromium has no BLE/serial, so
    // each path ends in an explanatory alert (auto-accepted above) — but the
    // click must SURVIVE its own code: a browser-only crash in the connect
    // path (e.g. an extracted window.setTimeout throwing "Illegal invocation"
    // inside ReconnectController) once made every Connect click do nothing,
    // while Node unit tests stayed green.
    const errsBefore = pageErrors.length;
    for (const id of ['connectBtn', 'connectUsbBtn', 'connectWifiBtn']) {
        await page.click('#' + id).catch(() => {});
        await page.waitForTimeout(150);
    }
    check('Connect buttons run without page errors',
        pageErrors.length === errsBefore, pageErrors.slice(errsBefore).join(' | '));

    check('no uncaught page errors during the run', pageErrors.length === 0, pageErrors.join(' | '));

    await browser.close();
    srv.close();
    fs.unlinkSync(csvPath);

    console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing check(s)\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
