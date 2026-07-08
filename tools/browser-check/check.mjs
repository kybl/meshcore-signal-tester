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
    return { csv: rows.join('\n'), total: specs.reduce((a, s) => a + s.n, 0), order: specs.map(s => s.id),
             contactCount: contacts.length };
}

// ---- assertions ------------------------------------------------------------
let failures = 0;
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

    // 4) Clear data empties the table and resets the counter.
    await page.getByText('Clear data', { exact: false }).first().click();
    await page.waitForTimeout(1500);
    check('Clear data resets Total RX to 0', (await page.textContent('#totalRx'))?.trim() === '0');
    check('Clear data removes repeater columns', (await page.$$('#msgTableHead th.msg-col-rep')).length === 0);

    check('no uncaught page errors during the run', pageErrors.length === 0, pageErrors.join(' | '));

    await browser.close();
    srv.close();
    fs.unlinkSync(csvPath);

    console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing check(s)\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
