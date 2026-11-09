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
function findChromium() { for (const r of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean)) { let d = []; try { d = fs.readdirSync(r).filter(x => x.startsWith('chromium-') && !x.includes('headless')); } catch { continue; } for (const x of d.sort().reverse()) { for (const e of [`${r}/${x}/chrome-linux/chrome`, `${r}/${x}/chrome-linux64/chrome`]) if (fs.existsSync(e)) return e; } } return null; }

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
    // The periodic cleanup must measure the RAM window from the frozen chart
    // clock too, or it expires yesterday's packets and the stats go empty.
    await page.evaluate(() => window.__mcApp.cleanup());
    await page.waitForTimeout(800);
    const st = await page.evaluate(() => ({ ram: window.__mcApp.model.recentSize,
        active: document.getElementById('activeHashes').textContent,
        reps: document.getElementById('totalRepeaters').textContent }));
    check('cleanup() keeps the frozen session\'s RAM set and stats', st.ram === 20 && st.active === '20' && st.reps === '1', JSON.stringify(st));
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
    const st = await page.evaluate(() => ({ ram: window.__mcApp.model.recentSize,
        active: document.getElementById('activeHashes').textContent,
        reps: document.getElementById('totalRepeaters').textContent }));
    check('…with its RAM window replayed (stats not empty)', st.ram === 20 && st.active === '20' && st.reps === '1', JSON.stringify(st));
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

// ---- RX sound recovers from a stuck AudioContext -----------------------------
// Android can leave the context 'running' with a frozen clock for good; the
// beeps (and the disconnect alarm) used to stay silent until an app restart.
{
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
        window.__audio = { made: [], freeze: false, startSuspended: false };
        class FakeParam { setValueAtTime() {} exponentialRampToValueAtTime() {} cancelScheduledValues() {} set value(v) {} }
        class FakeNode { constructor() { this.gain = new FakeParam(); this.frequency = new FakeParam(); this.Q = new FakeParam(); } connect() {} }
        class FakeCtx {
            constructor() {
                this.id = window.__audio.made.length; this.started = 0; this.frozenAt = null;
                this.state = window.__audio.startSuspended ? 'suspended' : 'running';
                this.destination = new FakeNode(); window.__audio.made.push(this);
            }
            get currentTime() {
                const t = performance.now() / 1000;
                if (window.__audio.freeze) { this.frozenAt ??= t; return this.frozenAt; }
                return t;
            }
            resume() { return Promise.resolve(); }   // no-op, like a stuck context
            close() { this.state = 'closed'; return Promise.resolve(); }
            createGain() { return new FakeNode(); }
            createBiquadFilter() { return new FakeNode(); }
            createOscillator() { const n = new FakeNode(); n.start = () => { this.started++; }; n.stop = () => {}; return n; }
        }
        window.AudioContext = FakeCtx;
    });
    const { page, errors } = await openPage(ctx, base);
    const beep = () => page.evaluate(() => window.__mcApp._playRxSound(3, true));
    const st = () => page.evaluate(() => window.__audio.made.map(c => ({ id: c.id, state: c.state, started: c.started })));
    await page.evaluate(() => { const s = document.getElementById('soundSelect'); s.value = 'short'; });
    await beep(); await page.waitForTimeout(300); await beep();
    let a = await st();
    check('beeps play on a healthy context', a.length === 1 && a[0].started > 0, JSON.stringify(a));
    await page.evaluate(() => { window.__audio.freeze = true; });
    await beep();                                   // clock sampled (frozen from here on)
    await page.waitForTimeout(2300);
    await beep();                                   // >2 s frozen → stall
    await page.evaluate(() => { window.__audio.freeze = false; });
    a = await st();
    check('a frozen context is replaced and the beep plays on a fresh one',
        a.length === 2 && a[0].state === 'closed' && a[1].started > 0, JSON.stringify(a));
    await page.waitForTimeout(300); await beep();
    a = await st();
    check('…and later beeps keep playing on it', a.length === 2 && a[1].started >= 12, JSON.stringify(a));
    // A context that never ran (autoplay-blocked / still starting) is not churned.
    await page.evaluate(() => { window.__mcApp._dropAudioContext(); window.__audio.startSuspended = true; });
    await beep(); await beep(); await beep();
    a = await st();
    check('a never-started context is not replaced over and over', a.length === 3 && a[2].state === 'suspended', JSON.stringify(a));
    check('no page errors (sound)', errors.length === 0, errors.join(' | '));
    await ctx.close();
}

// ---- #21: a packet filter that matches nothing keeps its input ----------------
{
    const ctx = await browser.newContext();
    const { page, errors } = await openPage(ctx, base);
    const now = Date.now();
    const rows = []; for (let i = 0; i < 10; i++) rows.push(`${iso(now - 60000 + i * 1000)},Flood Advert,ab${String(i).padStart(4, '0')},5E,3,,-90,,,,,`);
    await importCsv(page, tmp('flt', [HDR, ...rows].join('\n')));
    const st = () => page.evaluate(() => ({
        bar: !document.getElementById('msgFilterBar').classList.contains('hidden'),
        rows: document.querySelectorAll('#msgTableBody tr[id^="row-"]').length,
        empty: document.getElementById('msgTableEmpty').textContent,
        count: document.getElementById('msgFilterCount').textContent }));
    await page.fill('#msgFilter', 'zzzzqq'); await page.waitForTimeout(1200);
    let a = await st();
    check('#21 filter bar stays visible when the filter matches nothing', a.bar && a.rows === 0, JSON.stringify(a));
    check('#21 …and says the filter matched nothing (not "Waiting for data")', /packet filter/.test(a.empty) && a.count.startsWith('0 /'), JSON.stringify(a));
    await page.fill('#msgFilter', ''); await page.waitForTimeout(1200);
    a = await st();
    check('#21 clearing the filter brings the rows back', a.bar && a.rows === 10, JSON.stringify(a));
    check('no page errors (#21)', errors.length === 0, errors.join(' | '));
    await ctx.close();
}

// ---- #20: repeater console (fake USB repeater) ---------------------------------
{
    const ctx = await browser.newContext();
    const { page, errors, dialogs } = await openPage(ctx, base);
    // A fake serial port that behaves like the repeater CLI: echoes each line,
    // then answers "  -> <reply>". Lines are fed back through _onSerialBytes.
    await page.evaluate(() => {
        const app = window.__mcApp, enc = new TextEncoder(), dec = new TextDecoder();
        window.__sent = [];
        const replies = { 'ver': '  -> v1.10.0-abc (Build: 1 Nov 2026)', 'get tx': '  -> > 22',
                          'neighbors': '  -> 5E9F1234:12:40\n1A2B3C4D:300:-12' };
        const port = { writable: { getWriter: () => ({ write: async b => {
            const txt = dec.decode(b); window.__sent.push(txt);
            for (const l of txt.split('\r\n').filter(Boolean)) {
                setTimeout(() => {
                    const out = l + '\r\n' + (replies[l] ? replies[l] + '\r\n' : (l === 'log' ? 'EOF\r\n' : ''));
                    app._onSerialBytes(enc.encode(out));
                }, 30);
            }
        }, releaseLock() {} }) } };
        app.serialPort = port;
        app.conn.setMode('repeater');
        app._showRepeaterConsole(true);
        app._startRepeaterPolling();
    });
    const wrapVisible = await page.$eval('#cliWrap', e => !e.classList.contains('hidden'));
    check('#20 console appears for a repeater', wrapVisible);
    const send = async c => { await page.fill('#cliInput', c); await page.press('#cliInput', 'Enter'); await page.waitForTimeout(1500); };
    await send('ver');
    await send('neighbors');
    const log = await page.$eval('#cliLog', e => e.innerText);
    check('#20 reply shown without the echo and "->" prefix', /> ver\n.*v1\.10\.0-abc/.test(log) && !/\nver\n/.test(log), JSON.stringify(log));
    check('#20 multi-line reply shown in full', /5E9F1234:12:40\n1A2B3C4D:300:-12/.test(log), JSON.stringify(log));
    check('#20 background poll output is not mirrored', !/EOF/.test(log), JSON.stringify(log));
    // History
    await page.focus('#cliInput'); await page.press('#cliInput', 'ArrowUp');
    check('#20 ↑ recalls the last command', await page.inputValue('#cliInput') === 'neighbors');
    // Risky command needs confirmation (the harness accepts dialogs) — and the
    // page must never render device text as HTML.
    await page.fill('#cliInput', 'log stop'); await page.press('#cliInput', 'Enter'); await page.waitForTimeout(300);
    check('#20 "log stop" asks for confirmation', dialogs.some(d => /log stop/.test(d)), JSON.stringify(dialogs));
    await page.evaluate(() => { const a = window.__mcApp; a._cliPending = { cmd: 'x', sentAt: 0, until: performance.now() + 2000, hardStop: performance.now() + 2000, echoed: true, got: 0 };
        a._onSerialBytes(new TextEncoder().encode('  -> <img src=x onerror="window.__cliXss=1">\r\n')); });
    await page.waitForTimeout(300);
    check('#20 replies are shown as text, never HTML', await page.evaluate(() => !window.__cliXss && !document.querySelector('#cliLog img')));
    await page.evaluate(() => { const a = window.__mcApp; a._stopRepeaterPolling(); a._showRepeaterConsole(false); });
    check('#20 console hides when the repeater disconnects', await page.$eval('#cliWrap', e => e.classList.contains('hidden')));
    check('no page errors (#20)', errors.length === 0, errors.join(' | '));
    await ctx.close();
}

// ---- #20: companion Radio tools + console (fake companion) ---------------------
{
    const ctx = await browser.newContext();
    const { page, errors } = await openPage(ctx, base);
    // A fake companion behind _sendFrame: answers like the firmware does.
    await page.evaluate(() => {
        const app = window.__mcApp;
        window.__frames = [];
        window.__fw = { ver: 14, tx: 20, max: 22, traceOk: true, hashBytes: 1 };
        const reply = b => setTimeout(() => app.handlePayload(Uint8Array.from(b)), 20);
        app._sendFrame = async bytes => {
            const f = Array.from(bytes); window.__frames.push(f);
            const fw = window.__fw;
            switch (f[0]) {
                case 22: reply([0x0d, fw.ver]); break;
                case 12: { const v = f[1] > 127 ? f[1] - 256 : f[1];
                           if (v >= -9 && v <= fw.max) { fw.tx = v; reply([0]); } else reply([1, 6]); break; }
                case 66: { const cmd = new TextDecoder().decode(Uint8Array.from(f.slice(1)));
                           const txt = cmd === 'get radio.rxgain' ? '> on' : cmd === 'set radio.rxgain off' ? 'OK' : 'Unknown command';
                           reply([29, ...new TextEncoder().encode(txt)]); break; }
                case 36: { const tag = f.slice(1, 5), flags = f[9], path = f.slice(10);
                           reply([6, 0, ...tag, 0xe8, 0x03, 0, 0]);            // est 1000 ms
                           if (!fw.traceOk) break;
                           const hs = 1 << (flags & 3), hops = path.length / hs;
                           const snrs = Array.from({ length: hops }, (_, i) => (7 - i) * 4);   // 7, 6, … dB
                           setTimeout(() => app.handlePayload(Uint8Array.from(
                               [0x89, 0, path.length, flags, ...tag, 0, 0, 0, 0, ...path, ...snrs, 0xf6 /* -2.5 dB */])), 200);
                           break; }
                case 56: reply([1, 1]); break;          // old-firmware ERR to the stats poll
            }
        };
        app.conn.setMode('companion');
        app._canSend = () => true;
        app._collecting = true;            // a real connect starts collecting
        // SELF_INFO: tx power 20, max 22
        const si = new Uint8Array(58); si[0] = 5; si[2] = 20; si[3] = 22;
        app.handlePayload(si);
    });
    await page.waitForTimeout(800);
    let st = await page.evaluate(() => ({
        tools: !document.getElementById('toolsWrap').classList.contains('hidden'),
        cli: !document.getElementById('cliWrap').classList.contains('hidden'),
        title: document.getElementById('cliTitle').textContent,
        tx: document.getElementById('txPowerInput').value, max: document.getElementById('txPowerInput').max }));
    check('#20 Radio tools appear for a companion, TX power read from SELF_INFO', st.tools && st.tx === '20' && st.max === '22', JSON.stringify(st));
    check('#20 companion console appears on firmware v14+', st.cli && st.title === 'Companion console', JSON.stringify(st));
    check('#20 no firmware warning on v14+', await page.$eval('#fwNote', e => e.classList.contains('hidden')));

    await page.fill('#txPowerInput', '17'); await page.click('#txPowerSet'); await page.waitForTimeout(800);
    let note = await page.textContent('#txPowerNote');
    check('#20 TX power set', note.includes('17 dBm') && await page.evaluate(() => window.__fw.tx === 17), note);
    await page.fill('#txPowerInput', '30'); await page.click('#txPowerSet'); await page.waitForTimeout(500);
    note = await page.textContent('#txPowerNote');
    check('#20 TX power above the radio max is refused locally', /from -9 to 22/.test(note) && await page.evaluate(() => window.__fw.tx === 17), note);

    // Console over the companion protocol, while the (old-fw ERR) stats poll also runs.
    await page.evaluate(() => window.__mcApp._sendFrame(new Uint8Array([56, 1])));
    await page.fill('#cliInput', 'get radio.rxgain'); await page.press('#cliInput', 'Enter'); await page.waitForTimeout(900);
    const log = await page.$eval('#cliLog', e => e.innerText);
    check('#20 companion console sends CMD_RUN_CLI_COMMAND and shows the reply', /> get radio\.rxgain\n> on/.test(log), JSON.stringify(log));

    // Trace: single ID = round trip
    await page.fill('#traceInput', '5e'); await page.click('#traceBtn');
    await page.waitForFunction(() => document.getElementById('traceBtn').textContent === 'Trace', null, { timeout: 10000 });
    let tr = await page.textContent('#traceResult');
    check('#20 trace to one repeater shows ↑ and ↓ SNR', /5E heard you: \+7\.00 dB/.test(tr) && /you heard 5E: -2\.50 dB/.test(tr), tr);
    const row = await page.evaluate(() => [...window.__mcApp.model.recentEntries()].some(([h, d]) => h.startsWith('TR:') && d.repeaters.has('5E')));
    check('#20 trace also lands as a Trace row under 5E', row);
    // Multi-hop with 2-byte IDs
    await page.fill('#traceInput', '5E9F,8A01,5E9F'); await page.click('#traceBtn');
    await page.waitForFunction(() => document.getElementById('traceBtn').textContent === 'Trace', null, { timeout: 10000 });
    tr = await page.textContent('#traceResult');
    const flags = await page.evaluate(() => window.__frames.filter(f => f[0] === 36).pop()[9]);
    check('#20 2-byte multi-hop trace: flags=1 and per-hop lines', flags === 1
        && /you → 5E9F\s+\+7\.00 dB/.test(tr) && /5E9F → 8A01\s+\+6\.00 dB/.test(tr) && /5E9F → you\s+-2\.50 dB/.test(tr), `flags=${flags} ${tr}`);
    // Bad input / no answer
    await page.fill('#traceInput', '5E,8A01'); await page.click('#traceBtn'); await page.waitForTimeout(200);
    check('#20 mixed ID lengths are rejected', /same length/.test(await page.textContent('#traceResult')));
    await page.evaluate(() => { window.__fw.traceOk = false; });
    await page.fill('#traceInput', '5E'); await page.click('#traceBtn');
    await page.waitForFunction(() => document.getElementById('traceBtn').textContent === 'Trace', null, { timeout: 15000 });
    check('#20 a trace with no answer times out with a message', /No answer within/.test(await page.textContent('#traceResult')));

    // Old firmware: no console
    await page.evaluate(() => { const a = window.__mcApp; a._hideCompanionTools(); a._showRepeaterConsole(false); window.__fw.ver = 9;
        const si = new Uint8Array(58); si[0] = 5; si[2] = 20; si[3] = 22; a.handlePayload(si); });
    await page.waitForTimeout(800);
    st = await page.evaluate(() => ({ tools: !document.getElementById('toolsWrap').classList.contains('hidden'),
        cli: !document.getElementById('cliWrap').classList.contains('hidden') }));
    check('#20 older companion firmware: tools yes, console no', st.tools && !st.cli, JSON.stringify(st));
    const fwNote = await page.$eval('#fwNote', e => e.classList.contains('hidden') ? '' : e.textContent);
    check('#20 older firmware is named, with what is unavailable', /Older companion firmware \(protocol v9\)/.test(fwNote) && /console/.test(fwNote), fwNote);
    check('no page errors (#20 companion)', errors.length === 0, errors.join(' | '));
    await ctx.close();
}

await browser.close(); srv.close();
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${failures} failing check(s)`);
process.exit(failures ? 1 : 0);
