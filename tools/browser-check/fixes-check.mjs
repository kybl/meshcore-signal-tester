// Targeted browser checks for the 1.3.2 bug-fix batch (XSS via CSV, truncated
// rows, duplicate tab vs reload, frozen-clock Display window, discover rows,
// theme recolour). Complements check.mjs. Run: node fixes-check.mjs
import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import os from 'node:os'; import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serve(dir) { return new Promise(res => { const s = http.createServer((rq, rs) => { const rel = decodeURIComponent(rq.url.split('?')[0]); const f = path.join(dir, rel === '/' ? '/index.html' : rel); if (!f.startsWith(dir)) { rs.writeHead(403).end(); return; } fs.readFile(f, (e, b) => { if (e) { rs.writeHead(404).end(); return; } rs.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); rs.end(b); }); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
function findChromium() { for (const r of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean)) { let d = []; try { d = fs.readdirSync(r).filter(x => x.startsWith('chromium-') && !x.includes('headless')); } catch { continue; } for (const x of d.sort().reverse()) { const e = `${r}/${x}/chrome-linux/chrome`; if (fs.existsSync(e)) return e; } } return null; }

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const HDR = 'time,type,hash,repeater,snr,uplink_snr,rssi,raw_hex,lat,lon,text,sender';
const iso = t => new Date(t).toISOString();
const tmp = (name, text) => { const p = path.join(os.tmpdir(), `mc-fix-${process.pid}-${name}.csv`); fs.writeFileSync(p, text); return p; };

async function openPage(ctx, url) {
    const page = await ctx.newPage();
    const errors = [], dialogs = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForFunction(() => window.__mcApp?.model?.ready, null, { timeout: 15000 });
    return { page, errors, dialogs };
}
async function importCsv(page, file) {
    await (await page.$('input[type=file]')).setInputFiles(file);
    await page.waitForFunction(() => document.getElementById('importCsvBtn')?.textContent.trim() === 'Import CSV'
        && !document.getElementById('importCsvBtn').disabled, null, { timeout: 20000 });
    await page.waitForTimeout(800);
}

const exe = findChromium();
const srv = await serve(ROOT);
const base = `http://127.0.0.1:${srv.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=swiftshader'] });
console.log('\nMeshCore Signal Tester — 1.3.2 fix checks\n');

// ---- 1+5: XSS via CSV and a truncated row -------------------------------------
{
    const ctx = await browser.newContext();
    const { page, errors, dialogs } = await openPage(ctx, base);
    const now = Date.now();
    const csv = [HDR,
        `${iso(now - 60000)},Flood Advert,abcd01,5E,3,,-90,,,,,`,
        `${iso(now - 50000)},Flood Advert,abcd02,<img src=x onerror="window.__xss=1">,3,,-90,,,,,`,
        `${iso(now - 40000)},"x"" onmouseover=""window.__xss=2",abcd03,5E,3,,-90,,,,,`,
        `${iso(now - 30000)},Flood Advert`,                       // truncated
    ].join('\n');
    await importCsv(page, tmp('xss', csv));
    await page.hover('#msgTableBody tr');                          // would fire an injected onmouseover
    await page.waitForTimeout(300);
    const xss = await page.evaluate(() => window.__xss);
    check('CSV with script in repeater / type does not execute', xss === undefined, `window.__xss=${xss}`);
    check('malformed rows reported to the user', dialogs.some(m => /malformed row/.test(m)), JSON.stringify(dialogs));
    const rows = await page.$$eval('#msgTableBody tr[id^="row-"]', t => t.length);
    check('valid rows still imported (2 of 4)', rows === 2, `rows=${rows}`);
    const btn = await page.$eval('#importCsvBtn', b => ({ t: b.textContent.trim(), d: b.disabled }));
    check('Import button restored after the import', btn.t === 'Import CSV' && !btn.d, JSON.stringify(btn));
    const typeTitle = await page.$eval('#msgTableBody .rx-type[title*="onmouseover"]', e => e.getAttribute('title')).catch(() => null);
    check('quote in type stays inside the title attribute', typeTitle == null || typeTitle.includes('onmouseover'));
    check('no page errors (XSS/truncated import)', errors.length === 0, errors.join(' | '));
    await ctx.close();
}

// ---- 7: duplicate tab starts fresh; a plain reload keeps its session ---------
{
    const ctx = await browser.newContext();
    const a = await openPage(ctx, base);
    const now = Date.now();
    await importCsv(a.page, tmp('dup', [HDR, `${iso(now - 60000)},Flood Advert,dd0001,5E,3,,-90,,,,,`].join('\n')));
    await a.page.waitForTimeout(5000);                             // registry heartbeat / flush
    const idA = await a.page.evaluate(() => window.__mcApp._tabId);
    // "Duplicate tab": a second page whose sessionStorage carries A's id.
    const bPage = await ctx.newPage();
    const bDialogs = [];
    bPage.on('dialog', d => { bDialogs.push(d.message()); d.dismiss(); });   // decline any resume prompt
    await bPage.addInitScript(id => { try { sessionStorage.setItem('mc_tab', id); } catch (_) {} }, idA);
    await bPage.goto(base, { waitUntil: 'networkidle' });
    await bPage.waitForFunction(() => window.__mcApp?.model?.ready, null, { timeout: 15000 });
    const idB = await bPage.evaluate(() => window.__mcApp._tabId);
    check('duplicated tab gets its own session', idB && idB !== idA, `A=${idA} B=${idB}`);
    check('duplicated tab was not offered the live tab\'s session', !bDialogs.some(m => /Load previously captured/.test(m)), JSON.stringify(bDialogs));
    const dbs = await a.page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
    check('original tab\'s database survives', dbs.includes('meshcore-capture-' + idA), JSON.stringify(dbs));
    await bPage.close();
    // Reload A: its previous document is gone → it must keep (be offered) its session.
    await a.page.reload({ waitUntil: 'networkidle' });
    await a.page.waitForFunction(() => window.__mcApp?.model?.ready, null, { timeout: 15000 });
    const idA2 = await a.page.evaluate(() => window.__mcApp._tabId);
    check('plain reload keeps the same session (no false duplicate)', idA2 === idA, `before=${idA} after=${idA2}`);
    await a.page.waitForTimeout(1500);
    const rx = (await a.page.textContent('#totalRx'))?.trim();
    check('reloaded tab still shows its data', rx === '1', `Total RX=${rx}`);
    await ctx.close();
}

// ---- 9: frozen-clock Display window (yesterday's data, Display = 1 h) ----------
{
    const ctx = await browser.newContext();
    const { page, errors } = await openPage(ctx, base);
    const y = Date.now() - 26 * 3600 * 1000;
    const rows = []; for (let i = 0; i < 20; i++) rows.push(`${iso(y + i * 60000)},Flood Advert,ee${String(i).padStart(4, '0')},5E,3,,-90,,,,,`);
    await importCsv(page, tmp('old', [HDR, ...rows].join('\n')));
    await page.selectOption('#hideSelect', '3600');
    await page.waitForTimeout(2500);
    const n = await page.$$eval('#msgTableBody tr[id^="row-"]', t => t.length);
    check('yesterday\'s data with Display = 1 h is shown (not purged by the wall clock)', n === 20, `rows=${n}`);
    const pts = await page.evaluate(() => window.__mcApp.charts.renderPoints().length);
    check('…and the chart has points', pts > 0, `points=${pts}`);
    check('no page errors (frozen window)', errors.length === 0, errors.join(' | '));
    await ctx.close();
}

// ---- 9b: the same through a RESUMED session (reload → accept the prompt) -------
{
    const ctx = await browser.newContext();
    const { page } = await openPage(ctx, base);
    const y = Date.now() - 26 * 3600 * 1000;
    const rows = []; for (let i = 0; i < 20; i++) rows.push(`${iso(y + i * 60000)},Flood Advert,ef${String(i).padStart(4, '0')},5E,3,,-90,,,,,`);
    await importCsv(page, tmp('resume', [HDR, ...rows].join('\n')));
    await page.selectOption('#hideSelect', '3600');
    await page.waitForTimeout(5000);                                // persist + registry heartbeat
    await page.reload({ waitUntil: 'networkidle' });                // dialog handler accepts "Load previously captured data?"
    await page.waitForFunction(() => window.__mcApp?.model?.ready, null, { timeout: 15000 });
    await page.waitForTimeout(3000);
    const n = await page.$$eval('#msgTableBody tr[id^="row-"]', t => t.length);
    const disp = await page.$eval('#hideSelect', e => e.value);
    check('resumed yesterday\'s session with Display = 1 h shows its data', n === 20, `rows=${n}, display=${disp}`);
    await ctx.close();
}

// ---- 15: discover rows keep their type across import; detail doesn't decode ----
{
    const ctx = await browser.newContext();
    const { page, errors } = await openPage(ctx, base);
    const now = Date.now();
    const frame = '8e' + '00'.repeat(3) + 'aa'.repeat(32) + '11'.repeat(8);   // companion 0x8E frame
    await importCsv(page, tmp('dsc', [HDR, `${iso(now - 30000)},Repeater DSC,DSC:1,${'ab'.repeat(32)},4,6,-88,${frame},,,,`].join('\n')));
    const title = await page.$eval('#msgTableBody .rx-type', e => e.getAttribute('title')).catch(() => null);
    check('imported discover row keeps type "Repeater DSC"', title === 'Repeater DSC', `type=${title}`);
    await page.click('#msgTableBody td.sig-snr');
    await page.waitForTimeout(400);
    const detail = await page.$eval('#msgTableBody tr.detail-row', e => e.textContent).catch(() => '');
    check('discover detail is not decoded as a bogus Ack', !/Ack/i.test(detail), detail.slice(0, 120));
    check('no page errors (discover rows)', errors.length === 0, errors.join(' | '));
    await ctx.close();
}

// ---- theme toggle recolours the SNR/RSSI cells --------------------------------
{
    const ctx = await browser.newContext();
    const { page } = await openPage(ctx, base);
    const now = Date.now();
    await importCsv(page, tmp('theme', [HDR, `${iso(now - 30000)},Flood Advert,ff0001,5E,3,,-110,,,,,`].join('\n')));
    const before = await page.$eval('#msgTableBody td.sig-rssi', e => e.style.color);
    await page.click('#themeToggleBtn');
    await page.waitForTimeout(300);
    const after = await page.$eval('#msgTableBody td.sig-rssi', e => e.style.color);
    check('SNR/RSSI cell colour changes with the theme', before && after && before !== after, `${before} → ${after}`);
    await ctx.close();
}

await browser.close(); srv.close();
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${failures} failing check(s)`);
process.exit(failures ? 1 : 0);
