// MeshCore Signal Tester Application
import { MeshCoreDecoder, Utils } from './vendor/meshcore-decoder.js?v=1';
import { Signal3DMap } from './signal3d.js?v=138';
import { PacketStore } from './packet-store.js?v=17';
import { buildCsv, parseCsv } from './csv.js?v=1';
import { Store } from './storage.js?v=1';

// Single source of truth for the released app version, shown in the header (and
// forwarded to the Android wrapper). Bump this on a release alongside the
// CHANGELOG and the Android versionName. Distinct from the per-asset ?v= cache
// busters, which change on every edit.
const APP_VERSION = '1.2.1';

// Contact-sync resilience. The companion streams its whole contact list as a
// burst of frames after one CMD_GET_CONTACTS; over BLE that burst can overflow
// the device's notification queue and drop the tail, so the stream stalls
// partway and END_OF_CONTACTS never arrives. If no contact frame lands for this
// long mid-fetch we re-request and merge (contacts upsert by key), up to a cap.
const CONTACTS_STALL_MS = 4000;
const CONTACTS_MAX_RETRIES = 8;

// Per-repeater colour: hue, saturation AND lightness are all derived from the id
// hash, so different repeaters differ in all three — within bounds that keep the
// colour usable (never grey, never too dark/light). Dark theme lifts the
// lightness (except the 3D map, whose background is always light). The two
// pseudo columns 'direct'/'unknown' are drawn as white-filled rings instead.
const REP_S_MIN = 55, REP_S_MAX = 92;   // saturation range (%) — stays vivid
const REP_L_MIN = 42, REP_L_MAX = 60;   // lightness range (%) — readable band
const REP_DARK_BUMP = 18;               // dark theme adds this to lightness



// Inner padding (px) of the SVG signal charts: left (y-axis labels), right,
// top, bottom (x-axis labels). Shared by render, click hit-testing and tooltip.
const CHART_PAD = { l: 36, r: 8, t: 6, b: 24 };

class MeshCoreApp {
    constructor() {
        this.device = null;
        this.bleRxCharacteristic = null;
        // Transport abstraction: 'ble' (Nordic UART, one frame per notification)
        // or 'serial' (Web Serial, length-prefixed frames). null = disconnected.
        this.transportKind = null;
        this._serialBtnKind = 'serial';    // which connect button acts as Cancel/Disconnect: 'serial' (USB) or 'wifi'
        this.serialPort = null;
        this.serialReader = null;
        this._serialReadBuffer = new Uint8Array(0);
        this._serialClosing = false;
        this._onSerialDisconnect = null;
        // Connection mode for a serial link: 'companion' (binary frame protocol)
        // or 'repeater' (plain-text CLI). Decided by probing on connect. null
        // while detecting, and for BLE (always companion).
        this.connectionMode = null;
        this._serialTextBuffer = '';
        this._textDecoder = new TextDecoder();
        this._sawCompanionFrame = false;   // set when a companion frame is seen during detection
        this._sawRepeaterReply = false;    // set when the text CLI answers during detection
        this._sawRepeaterRaw = false;      // set if the repeater emits RAW packet dumps (logging build)
        this._repeaterStockNoticed = false;
        this._neighborSeen = new Map();    // neighbour id → last ingested heard-epoch (dedup)
        this._neighborPollTimer = null;
        this._logPollTimer = null;
        this._pendingRaw = [];             // decoded RAW dumps awaiting their summary line (logging build)
        this._showDeviceMarker = false;    // is the 3D-map device marker enabled
        this._deviceRefreshTimer = null;   // periodic SELF_INFO re-request while the device marker is shown
        this._pendingPosFields = [];       // repeater get lat/lon replies awaited, in order
        this._posQueryTimer = null;
        this.hashData = new Map();
        this.allRepeaters = new Map();
        this.repeaterColumns = []; // sorted by max RSSI descending (strongest first)
        this.totalRxCount = 0;
        this.HASH_LIFETIME    = 15 * 60 * 1000;
        this.DISPLAY_LIFETIME = Infinity; // separate display window; Infinity = same as HASH_LIFETIME
        this.cleanupInterval = null;
        this._connectionMonitor = null;
        this._monitorDelay = null;
        this.audioCtx = null;
        this.wakeLock = null;
        this.repeaterSortKey = 'lastSeen';
        this.repeaterSortDir = -1;
        this.hashCounter = 0;
        this.chartPoints = [];
        this.chartColors = new Map();
        this._sentSnrHistory = []; // { time, snr, col, label }
        this._dscSeq = 0;
        this._contacts = new Map(); // pubKeyFullHex → {name, type, lat, lon, lastAdvert, lastmod}
        this._contactsLastmod = 0;
        this._contactsReceiving = false;
        this._contactsRetries = 0;
        this._contactsLastStallSize = -1;
        this._contactsFetchedKeys = new Set();   // keys received during the current fetch
        this._contactsFetchActive = false;       // a GET_CONTACTS dump is in progress
        this._selShowMore = false;
        this._filterShowMore = false;
        this._mapPins = new Set(); // pubKeyFullHex of contacts pinned to 3D map
        this._batteryCharacteristic = null;
        this._onBatteryChanged = null;
        this._useAbbreviatedTypes = false;
        this._selectedCol = null;
        this._tooltipPinned = false;
        this._snrShowIncoming = true;
        this._snrShowOutgoing = true;
        this._rxTimestamps = [];
        this._msgFilter = '';
        this._repFilterTerms = [];
        this._collecting = false;
        this._keepScreenOn = Store.bool('keepScreenOn', true);
        this._unsavedRxCount = 0; // packets received since last CSV export
        this._chartFrozenAt = Date.now();
        this._chartZoom = null;          // {tMin,tMax} X-axis zoom window (null = auto/live)
        this._lastChartWindow = null;    // [tMin,tMax] the charts were last drawn with
        this._chartFullWindow = null;    // [tMin,tMax] un-zoomed extent (for clamping)

        // --- Durable storage (IndexedDB) ---------------------------------
        // The full session history lives on disk; RAM holds only a bounded
        // recent window for rendering. This keeps "Auto-remove: Never" from
        // growing the heap until the WebView renderer is OOM-killed, and lets
        // captured data survive a renderer crash / app restart (it is replayed
        // back from disk on startup).
        this.store = new PacketStore();
        this._storeReady = false;
        this.RENDER_BUDGET_MS = 60 * 60 * 1000;  // raw points kept in RAM (≥ this much recent history)
        this.MAX_RAW_VIEW    = 40000;            // above this a window renders downsampled
        this.DOWNSAMPLE_BUCKETS = 1500;          // time-bucket count for wide-window charts
        this._obsWriteBuf  = [];                 // pending obs records to flush to disk
        this._sentWriteBuf = [];                 // pending outgoing-SNR records
        this._hashWriteBuf = [];                 // pending per-hash payload records
        this.WRITE_FLUSH_MS = 4000;              // debounce for batching disk writes
        this._writeFlushTimer = null;
        this._wideChartPoints = [];              // chart render array, derived from the bucket cache
        this._wideSentPoints  = [];              // outgoing-SNR layer (disk) — live tail via _sentChartAt
        this._chartBase       = null;            // incremental time-bucket cache {cells: Map, width, lo}
        this._chartZoomLayer  = null;            // finer buckets over the zoom window {cells, width, lo, from, to}
        this._sentChartAt     = 0;               // time the sent layer reflects
        this._chartArrTimer   = null;            // coalesces bucket upserts into one array rebuild
        this._chartBaseBuilding = false;         // a _rebuildChartBase() is in flight (self-heal guard)
        this._chartBaseHealAt = 0;               // last self-heal attempt, to debounce retries
        this._renderCacheAt   = 0;               // time the table's disk page reflects; newer rows are the tail
        this._lastMapView     = null;            // {bbox, mpp} of the current map zoom, for live refresh
        this.MAP_TARGET_DOTS  = 2500;            // dot budget for the map grid layers
        this._wideMapBase     = null;            // RAM cell cache: full-extent map layer {cells: Map, cell, at}
        this._wideMapDetail   = null;            // finer cell layer for the zoomed-in bbox {cells, cell, bbox}
        this._wideMapKey      = null;            // identity of the last applied map view (skip same-view re-query)
        this._wideMapSentVer  = -1;              // dataVer the outgoing-SNR map layer was loaded for
        this._pendingMapUpserts = null;          // packets ingested before the base layer exists
        this._mapPushTimer    = null;            // coalesces cell upserts into one geometry push
        this._dataVer         = 0;               // bumped whenever new records land on disk
        this._tableHashCount   = 0;              // distinct hashes on disk (RAM-maintained for the pager)
        this._mapRebuildBusy   = false;          // guards the map's dot-budget escape-valve rebuild
        this._tablePageData   = new Map();       // disk-paged packet table snapshot (empty ⇒ tail alone)
        this._tablePage       = 0;
        this._tablePageSize   = 100;
        this._tablePageCount  = 1;
        // Narrowed pager: when the table is narrowed to one repeater — by a
        // repeater filter, or just a selection (which hides non-matching rows) —
        // it pages over only the hashes that repeater appears in, otherwise pages
        // full of hidden rows would render empty. Built by one obs scan in
        // _buildTableNarrowIndex, kept live at ingest, rebuilt on narrow change.
        this._tableNarrowHashes = null;          // newest-first matching hashes (null = not narrowed / stale)
        this._tableNarrowSet    = null;          // same content as a Set, for O(1) ingest checks
        this._tableNarrowKeyApplied = '';        // narrow key the current page was loaded for
        this._tableNarrowIndexKey   = '';        // narrow key the index hashes were built for

        this.initUI();
        this.startCleanupTimer();
        this._initStore();
        this._renderSavedDevices();
        this._renderRepTable();
        this._renderMsgTable();
        // Render empty chart axes immediately so the section is visible from page load
        requestAnimationFrame(() => this._scheduleChartRender());
    }

    _updatePauseBtn() {
        const btn = document.getElementById('pauseBtn');
        if (!btn) return;
        const connected = !!this.device;
        btn.disabled = !connected;
        if (this._collecting) {
            btn.textContent = '⏹ Stop';
            btn.classList.add('collecting');
            this._chartFrozenAt = null;
        } else {
            btn.textContent = '▶ Resume';
            btn.classList.remove('collecting');
            if (!this._chartFrozenAt) this._chartFrozenAt = Date.now();
        }
        // While connected, the frame is green when collecting and yellow when
        // paused (Stopped). When disconnected, leave the frame colour alone —
        // updateStatus() owns it then.
        if (connected) {
            this.statusEl.classList.remove('disconnected', 'connecting');
            this.statusEl.classList.toggle('connected', this._collecting);
            this.statusEl.classList.toggle('paused', !this._collecting);
        }
        this._syncWakeLock();
        // Keep the Android notification in step with the pause state.
        this._refreshNativeStatus();
    }

    _syncWakeLock() {
        if (this._collecting && this._keepScreenOn) this.acquireWakeLock();
        else this.releaseWakeLock();
    }

    initUI() {
        this._setupChartArea();
        this._setupCollapsibleSections();
        this._setupConnectionUi();
        this._setupTableInteractions();
        this._setupControls();
        this._setupFiltersAndNotices();
        this._initHelpSystem();
        this._initWifiModal();
        this._initSignalMap();
        this._initDebug();
    }

    _setupChartArea() {
        this.connectBtn = document.getElementById('connectBtn');
        this.statusEl = document.getElementById('status');
        this.statusTextEl = document.getElementById('statusText');
        this.connectedNameEl = document.getElementById('connectedDeviceName');
        this.batteryEl = document.getElementById('batteryStatus');
        this.rssiChartWrap = document.getElementById('rssiChartWrap');
        this.rssiChartSvg  = document.getElementById('rssiChart');
        this.snrChartWrap  = document.getElementById('snrChartWrap');
        this.snrChartSvg   = document.getElementById('snrChart');
        if (typeof ResizeObserver !== 'undefined') {
            const obs = new ResizeObserver(() => this._scheduleChartRender());
            document.querySelectorAll('.chart-svg-wrap').forEach(el => obs.observe(el));
        }

        // Custom resize handles — large touch target below each chart
        document.querySelectorAll('.chart-svg-wrap').forEach(
            wrap => this._attachResizeHandle(wrap, 'chart-resize-handle', 80));
        setInterval(() => {
            if (!this._chartFrozenAt) this._scheduleChartRender();
            if (isFinite(this.DISPLAY_LIFETIME)) {
                this.signalMap?.setDisplayCutoff?.(this._displayCutoffNow());
                this._renderRepTable();
                this._renderMsgTable();
            }
            this._updateStats();
        }, 2000);
    }

    _setupCollapsibleSections() {
        // Collapsible sections — clicking anywhere in the header row toggles
        document.querySelectorAll('.section-header').forEach(header => {
            const btn = header.querySelector('.collapse-btn');
            if (!btn) return;
            const hint = document.createElement('span');
            hint.className = 'section-hint';
            header.insertBefore(hint, btn);
            const updateHint = collapsed => { hint.textContent = collapsed ? 'Click to show' : 'Click to hide'; };
            const body = document.getElementById(btn.dataset.target);
            updateHint(body?.classList.contains('collapsed') ?? false);
            header.addEventListener('click', e => {
                if (e.target.closest('.help-icon')) return;
                if (!body) return;
                const collapsed = body.classList.toggle('collapsed');
                btn.classList.toggle('collapsed', collapsed);
                updateHint(collapsed);
            });
        });
    }

    _setupConnectionUi() {
        this.msgTableHead = document.getElementById('msgTableHead');
        this.msgTableBody = document.getElementById('msgTableBody');
        this.emptyState = document.getElementById('emptyState');
        this.activeHashesEl = document.getElementById('activeHashes');
        this.totalRxEl = document.getElementById('totalRx');
        this.totalRepeatersEl = document.getElementById('totalRepeaters');
        this.contactsCountEl = document.getElementById('contactsCount');
        this.contactsHstat = document.getElementById('contactsHstat');
        this.contactsLoadingMsg = document.getElementById('contactsLoadingMsg');
        this.repTableBody = document.getElementById('repTableBody');
        this.soundSelect = document.getElementById('soundSelect');
        this.soundSelect.value = Store.get('sound', this.soundSelect.value);
        this._updateSoundHighlight();
        this.tooltip = document.getElementById('chartTooltip');

        document.getElementById('pauseBtn')?.addEventListener('click', () => {
            if (!this.device) return;
            this._collecting = !this._collecting;
            this._updatePauseBtn();
        });

        this.connectBtn.onclick = () => this.connectBluetooth();

        this.connectUsbBtn = document.getElementById('connectUsbBtn');
        // The USB button is always shown and enabled. If Web Serial isn't
        // available, the click handler explains that — the control never
        // silently disappears (matching how the Bluetooth button behaves).
        if (this.connectUsbBtn) this.connectUsbBtn.onclick = () => this.connectUsb();

        this.connectWifiBtn = document.getElementById('connectWifiBtn');
        // Shown everywhere, but WiFi (raw TCP) only works in the native Android
        // host; in a plain browser the handler explains why and what to use.
        if (this.connectWifiBtn) this.connectWifiBtn.onclick = () => this.connectWifi();

        // Dedicated Disconnect control — only visible (via CSS) while connected.
        document.getElementById('disconnectBtn')?.addEventListener('click', () => this.disconnect());

        document.getElementById('disconnectAlarmClose')?.addEventListener('click', () => this._hideDisconnectAlarm());
    }

    _setupTableInteractions() {
        // Pair-hover: hovering RSSI or SNR highlights both cells for that repeater
        if (this.msgTableBody) {
            this.msgTableBody.addEventListener('mouseover', e => {
                const cell = e.target.closest('.sig-rssi, .sig-snr');
                if (!cell?.dataset.hash) return;
                this.msgTableBody.querySelectorAll('.sig-pair-hover').forEach(el => el.classList.remove('sig-pair-hover'));
                const { hash, col } = cell.dataset;
                this.msgTableBody.querySelectorAll(`[data-hash="${hash}"][data-col="${col}"]`)
                    .forEach(el => el.classList.add('sig-pair-hover'));
            });
            this.msgTableBody.addEventListener('mouseleave', () => {
                this.msgTableBody.querySelectorAll('.sig-pair-hover').forEach(el => el.classList.remove('sig-pair-hover'));
            });
        }

        let _resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(() => {
                if (this.chartPoints.length) this._scheduleChartRender();
                this._checkTableOverflow(true);
            }, 150);
        });

        const bindChartTooltip = (svg, type) => {
            if (!svg) return;
            // Desktop: hover shows a transient preview. A tap/click (here and on
            // touch) pins the infobox via _onChartClick — it then stays put (no
            // auto-hide) until tapped again or dismissed by clicking the infobox.
            svg.addEventListener('mousemove', e => this.showChartTooltip(e, type));
            svg.addEventListener('mouseleave', () => this.hideChartTooltip());
            svg.addEventListener('click', e => this._onChartClick(e, type));
            this._bindChartZoom(svg, type);
        };
        bindChartTooltip(this.rssiChartSvg, 'rssi');
        bindChartTooltip(this.snrChartSvg,  'snr');
        // Click the infobox itself to dismiss it.
        this.tooltip?.addEventListener('click', () => this.hideChartTooltip(true));

        const snrInCb  = document.getElementById('snrShowIncoming');
        const snrOutCb = document.getElementById('snrShowOutgoing');
        if (snrInCb)  snrInCb.addEventListener('change',  () => { this._snrShowIncoming = snrInCb.checked;  this._scheduleChartRender(); });
        if (snrOutCb) snrOutCb.addEventListener('change', () => { this._snrShowOutgoing = snrOutCb.checked; this._scheduleChartRender(); });

        document.getElementById('msgTableWrap')?.addEventListener('click', e => {
            // Detail row: close on click, or copy hex
            const detailRow = e.target.closest('tr.detail-row');
            if (detailRow) {
                const hexEl = e.target.closest('.raw-hex');
                if (hexEl) {
                    navigator.clipboard.writeText(hexEl.dataset.hex).then(() => {
                        const orig = hexEl.textContent;
                        hexEl.textContent = '✓ copied';
                        setTimeout(() => { hexEl.textContent = orig; }, 1000);
                    });
                } else if (window.getSelection()?.type !== 'Range') {
                    this._closeDetailRow(detailRow);
                }
                return;
            }
            // RSSI or SNR cell: toggle per-repeater detail
            const sigCell = e.target.closest('.sig-rssi, .sig-snr');
            if (sigCell?.dataset.hash) {
                this.toggleDetailRow(sigCell.dataset.hash, sigCell.dataset.col);
                return;
            }
            // Time/type cell: toggle detail for the left-most repeater that has
            // data in this row. Read it straight from the rendered cells (the
            // first cell carrying a data-col) so it matches what's on screen even
            // for disk-sourced columns not in the live column model.
            const rxCell = e.target.closest('.msg-col-rx');
            if (rxCell) {
                const row = rxCell.closest('tr[id^="row-"]');
                const firstSig = row?.querySelector('.sig-snr[data-col], .sig-rssi[data-col]');
                if (firstSig?.dataset.hash) this.toggleDetailRow(firstSig.dataset.hash, firstSig.dataset.col);
            }
        });

        // Click repeater row in Seen Repeaters to select it
        document.getElementById('repTableBody')?.addEventListener('click', e => {
            const row = e.target.closest('tr[data-col]');
            if (!row) return;
            const col = row.dataset.col;
            this._selectRepeater(col === this._selectedCol ? null : col);
        });

        // Click column header in Received Packets to select repeater
        document.getElementById('msgTableHead')?.addEventListener('click', e => {
            const th = e.target.closest('th.msg-col-rep[data-col]');
            if (!th) return;
            const col = th.dataset.col;
            this._selectRepeater(col === this._selectedCol ? null : col);
        });
    }

    _setupControls() {
        document.getElementById('savedDevices')?.addEventListener('click', e => {
            const quickBtn = e.target.closest('.saved-btn');
            const forgetBtn = e.target.closest('.forget-btn');
            if (quickBtn) { this._cancelAutoReconnect(); this.quickConnect(quickBtn.dataset.id).catch(e => console.error('Quick connect failed:', e)); }
            if (forgetBtn) this.forgetDevice(forgetBtn.dataset.id);
        });

        const ttlSelect  = document.getElementById('ttlSelect');
        const hideSelect = document.getElementById('hideSelect');
        if (ttlSelect) {
            const dflt = ttlSelect.value;   // HTML default (Never)
            ttlSelect.value = Store.get('ttl', dflt);
            // A stored value whose option was removed (e.g. the old 10/30 min)
            // leaves selectedIndex -1 and value "" → +""*1000 = 0 = instant
            // expiry. Fall back to the default in that case.
            if (ttlSelect.selectedIndex < 0) { ttlSelect.value = dflt; Store.set('ttl', dflt); }
            const v = ttlSelect.value;
            this.HASH_LIFETIME = v === 'Infinity' ? Infinity : +v * 1000;
            ttlSelect.addEventListener('change', () => {
                const v = ttlSelect.value;
                this.HASH_LIFETIME = v === 'Infinity' ? Infinity : +v * 1000;
                Store.set('ttl', v);
                this._updateHideSelectOptions();
            });
        }
        if (hideSelect) {
            hideSelect.value = Store.get('hide', hideSelect.value);
            this._applyHideSelect();
            hideSelect.addEventListener('change', () => {
                Store.set('hide', hideSelect.value);
                this._applyHideSelect();
            });
        }
        this._updateHideSelectOptions();

        document.getElementById('clearDataBtn')?.addEventListener('click', () => {
            if (!confirm('Delete all captured data? This cannot be undone.')) return;
            this._clearAllData();
        });

        document.getElementById('discoverBtn')?.addEventListener('click', () => this.startDiscoverSequence(0x0F).catch(e => console.error('Discover failed:', e)));

        document.getElementById('repeaterNoticeClose')?.addEventListener('click', () => document.getElementById('repeaterNotice')?.classList.add('hidden'));

        this.soundSelect?.addEventListener('change', () => {
            Store.set('sound', this.soundSelect.value);
            this._updateSoundHighlight();
            // Show/hide the speaker icon in the Android notification.
            this._refreshNativeStatus();
        });

        // Keep screen on
        const keepScreenChk = document.getElementById('keepScreenChk');
        if (keepScreenChk) {
            keepScreenChk.checked = this._keepScreenOn;
            keepScreenChk.addEventListener('change', () => {
                this._keepScreenOn = keepScreenChk.checked;
                Store.set('keepScreenOn', keepScreenChk.checked);
                this._syncWakeLock();
            });
        }

        // Auto-reconnect: retry the last device when an established connection
        // drops unexpectedly (off by default).
        const autoReconnectChk = document.getElementById('autoReconnectChk');
        const autoReconnectWrap = document.getElementById('autoReconnectWrap');
        const canAutoReconnect = this._canAutoReconnect();
        this._autoReconnect = canAutoReconnect && Store.bool('autoReconnect', false);
        // Hide the toggle entirely where a silent reconnect is impossible —
        // most notably a mobile browser over Web Bluetooth, where every
        // connection forces a user-gesture + system device picker and there is
        // no getDevices() to reconnect quietly. Showing the option there would
        // be misleading (it could never actually fire).
        if (autoReconnectWrap && !canAutoReconnect) {
            autoReconnectWrap.classList.add('hidden');
        }
        if (autoReconnectChk && canAutoReconnect) {
            autoReconnectChk.checked = this._autoReconnect;
            autoReconnectChk.addEventListener('change', () => {
                this._autoReconnect = autoReconnectChk.checked;
                Store.set('autoReconnect', autoReconnectChk.checked);
                if (!this._autoReconnect) this._cancelAutoReconnect();
            });
        }

        // UI scale
        const uiScaleSelect = document.getElementById('uiScaleSelect');
        if (uiScaleSelect) {
            const applyUiScale = v => {
                document.documentElement.classList.remove('ui-small', 'ui-large', 'ui-larger');
                if (v === 'small')  document.documentElement.classList.add('ui-small');
                if (v === 'large')  document.documentElement.classList.add('ui-large');
                if (v === 'larger') document.documentElement.classList.add('ui-larger');
            };
            const initial = Store.get('uiScale', 'normal');
            uiScaleSelect.value = initial;
            applyUiScale(initial);
            uiScaleSelect.addEventListener('change', () => {
                applyUiScale(uiScaleSelect.value);
                Store.set('uiScale', uiScaleSelect.value);
            });
        }

        // Theme toggle
        const themeBtn = document.getElementById('themeToggleBtn');
        if (themeBtn) {
            const applyTheme = light => {
                document.documentElement.classList.toggle('light-theme', light);
                themeBtn.textContent = light ? '🌙' : '☀️';
            };
            let isLight = Store.get('theme') === 'light';
            applyTheme(isLight);
            themeBtn.addEventListener('click', () => {
                isLight = !isLight;
                applyTheme(isLight);
                Store.set('theme', isLight ? 'light' : 'dark');
                this._renderCharts();
                this.signalMap?.applyTheme();
            });
        }

        // Point size controls
        this._dotSize    = Store.num('dotSize', 1);
        this._sphereSize = Store.num('sphereSize', 1);

        const dotSizeInput = document.getElementById('dotSizeInput');
        const dotSizeVal   = document.getElementById('dotSizeVal');
        if (dotSizeInput) {
            dotSizeInput.value = this._dotSize;
            if (dotSizeVal) dotSizeVal.textContent = this._dotSize;
            dotSizeInput.addEventListener('input', () => {
                this._dotSize = parseFloat(dotSizeInput.value);
                if (dotSizeVal) dotSizeVal.textContent = this._dotSize;
                Store.set('dotSize', this._dotSize);
                this._scheduleChartRender();
            });
        }

        const sphereSizeInput = document.getElementById('sphereSizeInput');
        const sphereSizeVal   = document.getElementById('sphereSizeVal');
        if (sphereSizeInput) {
            sphereSizeInput.value = this._sphereSize;
            if (sphereSizeVal) sphereSizeVal.textContent = this._sphereSize;
            sphereSizeInput.addEventListener('input', () => {
                this._sphereSize = parseFloat(sphereSizeInput.value);
                if (sphereSizeVal) sphereSizeVal.textContent = this._sphereSize;
                Store.set('sphereSize', this._sphereSize);
                this.signalMap?.setSphereSize(this._sphereSize);
            });
        }

        const repeaterHead = document.querySelector('.rep-table thead');
        if (repeaterHead) {
            repeaterHead.addEventListener('click', e => {
                if (e.target.closest('.help-icon')) return;
                const th = e.target.closest('th[data-sort-key]');
                if (!th) return;
                const key = th.dataset.sortKey;
                if (this.repeaterSortKey === key) {
                    this.repeaterSortDir *= -1;
                } else {
                    this.repeaterSortKey = key;
                    this.repeaterSortDir = key === 'id' ? 1 : -1;
                }
                repeaterHead.querySelectorAll('th').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
                th.classList.add(this.repeaterSortDir === 1 ? 'sort-asc' : 'sort-desc');
                this._renderRepTable();
            });
        }
    }

    _setupFiltersAndNotices() {
        this.packetRateEl   = document.getElementById('packetRate');
        this.msgFilterCountEl = document.getElementById('msgFilterCount');

        const msgFilterInput = document.getElementById('msgFilter');
        const msgFilterClear = document.getElementById('msgFilterClear');
        const msgFilterApplied = document.getElementById('msgFilterApplied');
        if (msgFilterInput) {
            msgFilterInput.addEventListener('input', () => {
                this._msgFilter = msgFilterInput.value;
                const active = !!this._msgFilter;
                msgFilterInput.classList.toggle('has-value', active);
                msgFilterClear?.classList.toggle('hidden', !active);
                msgFilterApplied?.classList.toggle('hidden', !active);
                this._renderMsgTable();
            });
        }
        if (msgFilterClear) {
            msgFilterClear.addEventListener('click', () => {
                this._msgFilter = '';
                if (msgFilterInput) { msgFilterInput.value = ''; msgFilterInput.classList.remove('has-value'); }
                msgFilterClear.classList.add('hidden');
                msgFilterApplied?.classList.add('hidden');
                this._renderMsgTable();
                msgFilterInput?.focus();
            });
        }
        this.exportCsvBtn = document.getElementById('exportCsvBtn');
        this.exportCsvBtn?.addEventListener('click', () => this._exportCsv());

        const importCsvInput = document.getElementById('importCsvInput');
        document.getElementById('importCsvBtn')?.addEventListener('click', () => importCsvInput?.click());
        importCsvInput?.addEventListener('change', () => {
            const file = importCsvInput.files?.[0];
            if (file) { this._importCsv(file).catch(e => console.error('CSV import failed:', e)); importCsvInput.value = ''; }
        });

        const fsBtn = document.getElementById('mapFullscreenBtn');
        if (fsBtn) {
            const mapContainer = document.querySelector('.map-container');
            fsBtn.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    // Remember where the page was scrolled so we can return there
                    // on exit — entering fullscreen resets the document scroll.
                    this._preFsScrollY = window.scrollY || window.pageYOffset || 0;
                    mapContainer?.requestFullscreen().catch(() => {});
                } else {
                    document.exitFullscreen();
                }
            });
            document.addEventListener('fullscreenchange', () => {
                const isFs = !!document.fullscreenElement;
                fsBtn.textContent = isFs ? '✕' : '⛶';
                fsBtn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
                if (!isFs) {
                    // Restore the page scroll after leaving fullscreen. The reset
                    // can land a frame or two later (especially in the Android
                    // WebView), so re-apply across a few ticks.
                    const y = this._preFsScrollY || 0;
                    const restore = () => window.scrollTo(0, y);
                    restore();
                    requestAnimationFrame(restore);
                    setTimeout(restore, 60);
                    setTimeout(restore, 200);
                }
            });
        }

        const repFilterInput = document.getElementById('repFilter');
        const repFilterClear = document.getElementById('repFilterClear');
        const repFilterApplied = document.getElementById('repFilterApplied');
        if (repFilterInput) {
            repFilterInput.addEventListener('input', () => {
                this._repFilterTerms = repFilterInput.value
                    .split(',').map(s => s.trim().toUpperCase().replace(/^!/, '')).filter(Boolean);
                const active = this._repFilterTerms.length > 0;
                repFilterInput.classList.toggle('has-value', active);
                repFilterClear?.classList.toggle('hidden', !active);
                repFilterApplied?.classList.toggle('hidden', !active);
                this._applyRepFilter();
            });
        }
        if (repFilterClear) {
            repFilterClear.addEventListener('click', () => {
                this._repFilterTerms = [];
                if (repFilterInput) { repFilterInput.value = ''; repFilterInput.classList.remove('has-value'); }
                repFilterClear.classList.add('hidden');
                repFilterApplied?.classList.add('hidden');
                this._applyRepFilter();
                repFilterInput?.focus();
            });
        }

        const repExpandCb   = document.getElementById('repExpandTable');
        const repLogScroll  = document.getElementById('repTableScroll');
        const applyRepExpand = expanded => {
            repLogScroll?.classList.toggle('expanded', expanded);
            if (repExpandCb) repExpandCb.checked = expanded;
            Store.set('repExpand', expanded);
        };
        if (repExpandCb) {
            repExpandCb.addEventListener('change', () => applyRepExpand(repExpandCb.checked));
            applyRepExpand(Store.bool('repExpand', false));
        }

        // Corner notice buttons
        // These are position:fixed. The Text-size feature puts a transform on
        // <body>, which makes <body> the containing block for fixed descendants —
        // they'd then scroll away with the page instead of staying put. Re-parent
        // them to <html> (never transformed) so they stay truly viewport-fixed.
        for (const id of ['filterNotice', 'selNotice']) {
            const el = document.getElementById(id);
            if (el) document.documentElement.appendChild(el);
        }
        document.getElementById('filterNoticeClear')?.addEventListener('click', () => {
            this._repFilterTerms = [];
            const inp = document.getElementById('repFilter');
            if (inp) { inp.value = ''; inp.classList.remove('has-value'); }
            document.getElementById('repFilterClear')?.classList.add('hidden');
            document.getElementById('repFilterApplied')?.classList.add('hidden');
            this._applyRepFilter();
        });
        document.getElementById('selNoticeFilter')?.addEventListener('click', () => {
            const col = this._selectedCol;
            if (!col) return;
            const term = this.displayId(col).toUpperCase();
            const inp = document.getElementById('repFilter');
            if (inp) { inp.value = term; inp.classList.add('has-value'); }
            document.getElementById('repFilterClear')?.classList.remove('hidden');
            document.getElementById('repFilterApplied')?.classList.remove('hidden');
            this._repFilterTerms = [term];
            this._selectRepeater(null);   // clears selection; _applyRepFilter called via _updateCornerNotices inside
            this._applyRepFilter();
        });
        document.getElementById('selNoticeClear')?.addEventListener('click', () => {
            this._selectRepeater(null);
        });

        window.addEventListener('beforeunload', e => {
            if (this._unsavedRxCount > 0) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    _initDebug() {
        const btn  = document.getElementById('debugInject');
        const inp  = document.getElementById('debugRepeater');
        const fbk  = document.getElementById('debugFeedback');
        if (!btn || !inp) return;

        const inject = () => {
            const raw = inp.value.trim();
            if (!raw) return;
            let repeater;
            if (raw.toLowerCase() === 'direct') {
                repeater = 'direct';
            } else {
                let hex = raw.replace(/^!/, '').toLowerCase();
                if (!/^[0-9a-f]+$/.test(hex)) {
                    if (fbk) { fbk.textContent = 'hex digits only'; setTimeout(() => fbk.textContent = '', 1500); }
                    return;
                }
                if (hex.length % 2) hex = '0' + hex;
                repeater = hex;
            }
            // Unique payload so each inject creates a fresh row, not a merge
            const fakeHex = 'debug-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
            const hash    = this._hashPayload(fakeHex);
            const rssi    = -60 - Math.floor(Math.random() * 50);
            const snr     = Math.round((Math.random() * 25 - 10) * 10) / 10;
            this._ingestPacket(hash, repeater, 'Flood Debug', fakeHex, snr, rssi, { debug: true }, null, { forceIngest: true, ...this._myLocation() });
            if (fbk) {
                const col = this.findOrCreateColumn(repeater);
                fbk.textContent = `→ column ${this.displayId(col)}`;
                setTimeout(() => fbk.textContent = '', 2500);
            }
        };

        btn.addEventListener('click', inject);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inject(); } });
    }

    // Append a drag-to-resize handle below `target` that adjusts its height
    // between `minHeight` and the viewport. Shared by the signal charts and the
    // 3D map container.
    _attachResizeHandle(target, handleClass, minHeight) {
        const handle = document.createElement('div');
        handle.className = handleClass;
        target.insertAdjacentElement('afterend', handle);
        let startY = 0, startH = 0;
        const onMove = e => {
            const cy = e.touches ? e.touches[0].clientY : e.clientY;
            target.style.height = Math.max(minHeight, Math.min(window.innerHeight - 80, startH + cy - startY)) + 'px';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchend', onUp);
        };
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            startY = e.clientY; startH = target.offsetHeight;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        handle.addEventListener('touchstart', e => {
            e.preventDefault();
            startY = e.touches[0].clientY; startH = target.offsetHeight;
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
        }, { passive: false });
    }

    _initSignalMap() {
        const canvas = document.getElementById('mapCanvas');
        if (!canvas) return;

        // Resize handle — same pattern as chart resize handles
        const mapContainer = document.querySelector('.map-container');
        if (mapContainer) this._attachResizeHandle(mapContainer, 'map-resize-handle', 200);

        const sourceSel = document.getElementById('mapSourceSelect');
        const savedSource = Store.get('mapSource', '');
        if (sourceSel && savedSource) sourceSel.value = savedSource;

        try {
            this.signalMap = new Signal3DMap({
                canvas,
                btnEl:         document.getElementById('enableLocationBtn'),
                statusEl:      document.getElementById('locationStatus'),
                centerBtnEl:   document.getElementById('centerOnMeBtn'),
                emptyEl:       document.getElementById('mapEmpty'),
                infoEl:        document.getElementById('mapInfo'),
                colorFor:      col => this.getRepeaterColor(col),
                displayId:     col => this.displayId(col),
                onFollowChange: on => {
                    const b = document.getElementById('centerOnMeBtn');
                    if (!b) return;
                    b.classList.toggle('active', on);
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                },
                nameForCol:    col => this._contactNameForCol(col),
                isLiveCapture: () => this._collecting,   // tiles follow the user only while live
                isDarkMode:    () => !document.documentElement.classList.contains('light-theme'),
                initialSource:  sourceSel?.value,
                initialSphereSize: this._sphereSize,
                initialPerspSize: Store.bool('perspSize', true),
                showDevice:    Store.bool('showDevice', false),
                onSelect:      col => {
                    this._selectRepeater(col);
                },
                onViewChange:  (bbox, mpp) => {
                    // Zoom/pan → re-query a finer disk grid for the now-visible
                    // region, and remember it so the live refresh keeps that zoom
                    // instead of snapping to full extent.
                    if (!this._storeReady) return;
                    // Small moves don't need a re-query: the previous detail grid
                    // over-covers the view, so only react once the camera has
                    // moved a quarter of the span or zoomed by ≥25%. (Skipped
                    // moves don't update _lastMapView, so drift accumulates and
                    // eventually crosses the threshold.)
                    const lv = this._lastMapView;
                    if (lv) {
                        const spanLat = lv.bbox.maxLat - lv.bbox.minLat;
                        const spanLon = lv.bbox.maxLon - lv.bbox.minLon;
                        const dLat = Math.abs((bbox.minLat + bbox.maxLat) - (lv.bbox.minLat + lv.bbox.maxLat)) / 2;
                        const dLon = Math.abs((bbox.minLon + bbox.maxLon) - (lv.bbox.minLon + lv.bbox.maxLon)) / 2;
                        const zoomRatio = (mpp && lv.mpp)
                            ? Math.max(mpp, lv.mpp) / Math.max(1e-9, Math.min(mpp, lv.mpp))
                            : Infinity;
                        if (zoomRatio < 1.25 && dLat < spanLat * 0.25 && dLon < spanLon * 0.25) return;
                    }
                    this._lastMapView = { bbox, mpp };
                    this._refreshWideMap(bbox, mpp);
                },
                onFilter:      col => {
                    if (!col) return;
                    const term = this.displayId(col).toUpperCase();
                    const input = document.getElementById('repFilter');
                    const clear = document.getElementById('repFilterClear');
                    const applied = document.getElementById('repFilterApplied');
                    if (input) { input.value = term; input.classList.add('has-value'); }
                    clear?.classList.remove('hidden');
                    applied?.classList.remove('hidden');
                    this._repFilterTerms = [term];
                    this._applyRepFilter();
                    document.getElementById('repeaterWrap')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                },
                onRemoveMarker: (col, pubKeyFullHex) => {
                    if (pubKeyFullHex && this._mapPins.has(pubKeyFullHex)) {
                        this._mapPins.delete(pubKeyFullHex);
                        this._updateMapPins();
                        this._updateCornerNotices();
                    }
                },
                onPinMarker: (col, pubKeyFullHex) => {
                    if (pubKeyFullHex) {
                        this._mapPins.add(pubKeyFullHex);
                        this._updateMapPins();
                        this._updateCornerNotices();
                    }
                },
                onToggleMapPin: col => this._toggleMapPinForCol(col),
            });
        } catch (_) {
            this.signalMap = null;
            document.getElementById('mapWrap')?.classList.add('map-offline');
            const emptyEl = document.getElementById('mapEmpty');
            if (emptyEl) {
                emptyEl.classList.remove('hidden');
                emptyEl.textContent = '3D map unavailable — WebGL is not supported or disabled in this browser.';
            }
            return;
        }

        // Native wrapper calls this the moment the location permission becomes
        // available (granted during the BLE/USB/WiFi connect flow). Start the
        // map's GPS watch right away so capture is geotagged from connect time —
        // no detour to the 3D map's "Enable location" button. startWatching()
        // guards against a double-start, so repeated calls are harmless.
        window.__mcLocationPermissionGranted = () => {
            this.signalMap?.startWatching?.();
        };

        sourceSel?.addEventListener('change', () => {
            this.signalMap.setMapSource(sourceSel.value);
            Store.set('mapSource', sourceSel.value);
        });

        this._setupMapSettings();
    }

    _setupMapSettings() {
        // Settings gear panel
        const settingsBtn   = document.getElementById('mapSettingsBtn');
        const settingsPanel = document.getElementById('mapSettingsPanel');
        if (settingsBtn && settingsPanel) {
            settingsBtn.addEventListener('click', e => {
                e.stopPropagation();
                settingsPanel.classList.toggle('hidden');
            });
            document.addEventListener('click', e => {
                if (!settingsPanel.contains(e.target) && e.target !== settingsBtn)
                    settingsPanel.classList.add('hidden');
            });
        }

        const showLinesChk      = document.getElementById('showLinesChk');
        const showMarkerChk     = document.getElementById('showMarkerChk');
        const showDeviceChk     = document.getElementById('showDeviceChk');
        const perspSizeChk      = document.getElementById('perspSizeChk');
        showLinesChk?.addEventListener('change', () => {
            this.signalMap?.setShowLines(showLinesChk.checked);
            Store.set('showLines', showLinesChk.checked);
        });
        showMarkerChk?.addEventListener('change', () => {
            this.signalMap?.setShowMarker(showMarkerChk.checked);
            Store.set('showMarker', showMarkerChk.checked);
        });
        showDeviceChk?.addEventListener('change', () => {
            this._showDeviceMarker = showDeviceChk.checked;
            this.signalMap?.setShowDeviceMarker(showDeviceChk.checked);
            Store.set('showDevice', showDeviceChk.checked);
            this._updateDeviceLocationRefresh();   // start/stop position polling
        });
        perspSizeChk?.addEventListener('change', () => {
            this.signalMap?.setPerspSize(perspSizeChk.checked);
            Store.set('perspSize', perspSizeChk.checked);
        });
        // Restore saved values into the controls (the map itself was already
        // constructed with the same Store-backed defaults above).
        const showLines = Store.bool('showLines', true);
        if (showLinesChk)  { showLinesChk.checked  = showLines;  this.signalMap?.setShowLines(showLines); }
        const showMarker = Store.bool('showMarker', true);
        if (showMarkerChk) { showMarkerChk.checked = showMarker; this.signalMap?.setShowMarker(showMarker); }
        const showDevice = Store.bool('showDevice', false);
        this._showDeviceMarker = showDevice;
        if (showDeviceChk) { showDeviceChk.checked = showDevice; this.signalMap?.setShowDeviceMarker(showDevice); }
        if (perspSizeChk)    perspSizeChk.checked    = Store.bool('perspSize', true);

        document.getElementById('showAllRepeatersBtn')?.addEventListener('click', () => this._toggleAllRepeatersOnMap());
        document.getElementById('centerOnMeBtn')?.addEventListener('click', () => this.signalMap?.toggleFollowUser());
    }

    _activeCols() {
        const cols = new Set();
        for (const [, data] of this.hashData) {
            for (const col of data.repeaters.keys()) cols.add(col);
        }
        return cols;
    }

    _contactsWithGps() {
        const out = [];
        const seen = new Set();
        for (const col of this._activeCols()) {
            for (const c of this._contactsByPrefix(col)) {
                if (!seen.has(c.pubKeyFullHex) && c.name && (c.lat !== 0 || c.lon !== 0)) {
                    seen.add(c.pubKeyFullHex);
                    out.push(c);
                }
            }
        }
        return out;
    }

    _allRepeatersShown() {
        const withGps = this._contactsWithGps();
        return withGps.length > 0 && withGps.every(c => this._mapPins.has(c.pubKeyFullHex));
    }

    _toggleAllRepeatersOnMap() {
        if (this._allRepeatersShown()) {
            this._mapPins.clear();
        } else {
            for (const c of this._contactsWithGps()) this._mapPins.add(c.pubKeyFullHex);
        }
        this._updateMapPins();
        this._updateCornerNotices();
        this._updateShowAllBtn();
    }

    _updateShowAllBtn() {
        const btn = document.getElementById('showAllRepeatersBtn');
        if (!btn) return;
        btn.textContent = this._allRepeatersShown() ? 'Hide all repeaters' : 'Show all repeaters';
    }

    _initHelpSystem() {
        const verEl = document.getElementById('appVersion');
        if (verEl) verEl.textContent = 'v' + APP_VERSION;
        const HELP = {
            'active':
                'Unique packets in the current display window. Data outside the window is still stored (see Auto-remove) but not shown (see Display).',
            'totalrx':
                'All packet arrivals this session. The same packet heard via two different repeaters counts as two.',
            'repeaters-count':
                'Distinct repeaters visible in the current display window. More may be stored but hidden.',
            'contacts':
                'Nodes known from the contact list synced from your device (name, public key, GPS position). Used to label repeaters, show their position on the 3D map, and resolve short IDs. Updated automatically on connect and when new adverts arrive.',
            'contact-unknown':
                'This repeater is not in the contact list and hasn\'t responded to discovery yet. If you know roughly where it is, try the "Discover nodes" button — it may respond and reveal its name and position. Connecting your device via Bluetooth and syncing contacts can also help significantly.',
            'contact-no-gps':
                'The owner of this node hasn\'t configured its position.',
            'sound':
                'off = silent. disconnect only = no per-packet sound, just an alarm if the connection drops unexpectedly. short / medium / long play a two-note bell/chime of increasing duration (long is 4× short) on each new packet. The first note (1/3 of the sound) is a fixed 700 Hz tone; the second note (2/3) shifts pitch with SNR — higher SNR → higher pitch. When a repeater filter is active, the sound plays only for packets from the filtered repeater(s). Any non-off setting also sounds an alarm when an established connection drops unexpectedly. Setting is remembered across sessions.',
            'ttl':
                'Data older than this window is permanently deleted — packets, signal history, seen repeaters, and 3D map points all expire together. Collision labels are recalculated when their evidence ages out. "Never" keeps everything for the whole session (set automatically on CSV import) — but note that when Auto-remove is "Never", the Display window below also bounds how much is held in memory, so the heap can\'t grow without limit on long runs.',
            'display':
                'How far back to look when displaying data. With a finite Auto-remove it deletes nothing — data outside this window is still stored and continues to influence repeater ID merging and collision detection. "All" shows the full storage window. When Auto-remove is "Never", anything older than this window is dropped from memory too (a finite Display window is what keeps a multi-hour session from exhausting memory and crashing). Can only be set equal to or shorter than Auto-remove.',
            'keepscreen':
                'This could be necessary in a mobile browser to keep collection running — when the screen turns off, the browser suspends JavaScript and stops capturing. In the Android app, collection runs in a background service so the screen can be off without losing data — unless the system\'s battery optimization is active and kills the service. Setting is remembered across sessions.',
            'repeater':
                '"direct" = flood-routed packet received at first hop. Otherwise the ID of the last forwarding repeater. Click a row to select that repeater — dims others in all views (charts, Received packets, 3D map); click again to deselect. Click a column header to sort by that field; click again to reverse. See "Help" → Repeater ID prefix resolution for how partial IDs and collision labels work.',
            'chart-snr':
                'Click a dot to select that repeater — dims others across both charts, Seen Repeaters, Received Packets, and the 3D map; click again or elsewhere to deselect. A notice appears top-right with options to filter or deselect. Hover or tap a point to see its exact ID, SNR/RSSI and time in a small box; click the box to dismiss it. Circles (●) = incoming SNR; stars (★) = outgoing SNR reported by the remote node via Discover. Zoom the time axis with the mouse wheel, by dragging across a region, or by pinching with two fingers; once zoomed, pan with a one-finger drag or a horizontal (or Shift+) wheel. Double-click or Reset zoom to return to the full view.',
            'chart-interact':
                'Click a dot to select that repeater — dims others across both charts, Seen Repeaters, Received Packets, and the 3D map; click again or elsewhere to deselect. A notice appears top-right with options to filter or deselect. Hover or tap a point to see its exact ID, RSSI/SNR and time in a small box; click the box to dismiss it. Zoom and pan the time axis just like the SNR chart (wheel, drag a region, or pinch; double-click or Reset zoom to reset) — both charts share one window. The shaded area shows the estimated noise floor (RSSI − SNR).',
            'rate':
                'Packets received in the last 60 seconds (rolling). Resets to 0 when the network goes quiet.',
            'rep-filter':
                'Comma-separated list of repeater IDs to keep visible. Matching is prefix-based and works either way — "3E" matches "3E2F1234" and vice versa. Affects Seen Repeaters, charts, Received Packets, and the 3D map. A notice appears top-right while a filter is active.',
            'messages':
                'Click any RSSI or SNR cell to expand full packet detail and raw hex, including reception time with millisecond precision. Click the hex string in an expanded row to copy it to the clipboard. Click a repeater column header to select that repeater — syncs with Seen Repeaters, charts, and 3D map. Repeater columns are ordered by: packets received in the last 5 min (desc), then last RSSI, last SNR, total RX count, then alphabetically.',
            'msg-filter':
                'Keeps only the packets that match what you type — a case-insensitive substring search across several fields at once: the packet type (full or abbreviated, e.g. "advert", "GT", "traceroute"), a repeater\'s short ID or its synced contact name, the decoded message text and sender (when available — most traffic is encrypted, so this is often empty), and the raw packet hex. The count next to the box shows matching / total. Clear with the ✕.',
            'msg-type':
                'Type abbreviations — AD: Advert · GT: GroupText · TR: Traceroute · RS: Response · RQ: Request · AQ: AnonRequest · PN: Ping · TX: TextMessage · PT: Path · CT: Control · PV: Private · RD: Repeater DSC (discover response, includes uplink SNR). Full type is shown in the expanded row.',
            'signal3d':
                'Interactive 3D map of received signal quality. Each dot is positioned at your GPS location at reception time; height reflects SNR (taller = higher SNR). Click a dot to select that repeater — shows an info panel and syncs the selection across Seen Repeaters, charts, and Received Packets. When the repeater\'s own position is known, the info panel offers an eye button (turn the camera toward it) and a pushpin (keep it on the map — tilted = shown only temporarily, upright = kept permanently). "Center on me" is a toggle — it recentres on your location and then follows you as you move (the camera tracks your GPS); press it again, or pan/rotate the map yourself, to stop following. "Show all repeaters" adds every known position. Use ⚙ (top right) to change map source, dot size, guide lines, your own location marker, and the connected device\'s own location (a blue antenna marker, shown when the radio or repeater reports a position). Navigation: drag to pan · scroll/pinch to zoom · two-finger twist (or right-drag) to tilt/rotate.',
            'device-location':
                'Shows the connected device\'s own position on the map (a blue antenna marker). While this is on, the app keeps asking the radio for its location, which means more constant work and can drain the battery faster. If you don\'t need it, turn it off.',
            'discover':
                'Sends an active DISCOVER_REQ broadcast — this is not passive listening, it injects traffic into the mesh. Nearby nodes with firmware ≥ v1.10 reply with their public key, name, GPS position, and the SNR they measured for your signal (uplink). Please don\'t press it more than once a minute.',
            'auto-reconnect':
                'When the connection to the device drops unexpectedly (out of range, device reset, cable unplugged), automatically retry the last device a few times before raising the disconnect alarm. This option only appears where a silent reconnect is possible: the Android app (Bluetooth, USB or WiFi) or desktop Chrome/Edge. It is hidden for Bluetooth in a mobile browser, because there the browser forces a manual device-picker confirmation on every connection for privacy reasons — so it can never reconnect on its own.',
        };

        const tipEl = document.getElementById('helpTip');
        let _tipTarget = null;

        const showTip = (icon) => {
            const text = HELP[icon.dataset.help];
            if (!text || !tipEl) return;
            tipEl.textContent = text;
            tipEl.style.display = 'block';
            // #helpTip is position:absolute inside <body>, which may carry a
            // transform: scale() (text-size / desktop zoom — always ×1.3 on
            // desktop). That makes <body> the containing block, so convert the
            // icon's viewport rect into body-local (un-scaled, scroll-included)
            // coordinates, exactly like the chart infobox does. Using viewport
            // px directly here put the tip in the wrong place under the scale.
            let scale = 1;
            const tr = getComputedStyle(document.body).transform;
            const m = tr && tr !== 'none' ? tr.match(/matrix\(([^)]+)\)/) : null;
            if (m) scale = parseFloat(m[1].split(',')[0]) || 1;
            const tipW = Math.min(260, document.body.clientWidth - 16);
            tipEl.style.maxWidth = `${tipW}px`;
            const r = icon.getBoundingClientRect();
            const tipH = tipEl.offsetHeight;
            const cx  = (r.left + r.width / 2 + window.scrollX) / scale;
            const top = (r.top  + window.scrollY) / scale;
            const bot = (r.bottom + window.scrollY) / scale;
            let left = cx - tipW / 2;
            left = Math.max(8, Math.min(left, document.body.clientWidth - tipW - 8));
            tipEl.style.left = `${left}px`;
            // Float above the icon; flip below when there isn't room (the room
            // check is in rendered viewport px, hence tipH * scale).
            if (r.top < tipH * scale + 12) {
                tipEl.style.top = `${bot + 8}px`;
                tipEl.style.transform = 'none';
            } else {
                tipEl.style.top = `${top - 8}px`;
                tipEl.style.transform = 'translateY(-100%)';
            }
            icon.classList.add('active');
        };

        const hideTip = () => {
            if (tipEl) tipEl.style.display = 'none';
            _tipTarget?.classList.remove('active');
            _tipTarget = null;
        };

        document.addEventListener('click', e => {
            const icon = e.target.closest('.help-icon');
            if (icon) {
                // Prevent the enclosing <label> from focusing its input
                e.preventDefault();
                e.stopPropagation();
                if (_tipTarget === icon) { hideTip(); return; }
                hideTip();
                _tipTarget = icon;
                showTip(icon);
                return;
            }
            if (_tipTarget) hideTip();
        });

        const helpModal = document.getElementById('helpModal');
        const openHelp = () => {
            helpModal?.classList.remove('hidden');
            helpModal?.querySelector('.help-modal')?.scrollTo(0, 0);
        };
        const closeHelp = () => {
            helpModal?.classList.add('hidden');
        };
        document.getElementById('helpBtn')?.addEventListener('click', e => {
            e.stopPropagation();
            hideTip();
            openHelp();
        });
        document.getElementById('footerHelp')?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            hideTip();
            openHelp();
        });
        document.getElementById('helpModalClose')?.addEventListener('click', e => {
            e.stopPropagation();
            closeHelp();
        });
        document.getElementById('helpModalCloseBottom')?.addEventListener('click', e => {
            e.stopPropagation();
            closeHelp();
        });
        helpModal?.addEventListener('click', e => {
            if (e.target === helpModal) closeHelp();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && helpModal && !helpModal.classList.contains('hidden')) {
                closeHelp();
            }
        });

        // Android hardware Back button (called from the native host). Close the
        // topmost open overlay instead of leaving the app; return true when we
        // handled it so the native side knows not to background the app.
        window.__mcHandleBack = () => {
            const wifiModal = document.getElementById('wifiModal');
            if (wifiModal && !wifiModal.classList.contains('hidden')) { wifiModal.classList.add('hidden'); return true; }
            if (tipEl && tipEl.style.display === 'block') { hideTip(); return true; }
            if (helpModal && !helpModal.classList.contains('hidden')) { closeHelp(); return true; }
            const settings = document.getElementById('mapSettingsPanel');
            if (settings && !settings.classList.contains('hidden')) {
                settings.classList.add('hidden');
                return true;
            }
            return false;
        };
    }

    // --- Bluetooth connection ---

    async connectBluetooth() {
        this._cancelAutoReconnect();
        if (!navigator.bluetooth) {
            alert('Web Bluetooth API is not available.\n\nRequirements:\n• Chrome or Edge browser\n• Page must be served over HTTPS or localhost');
            return;
        }
        try {
            this._beginConnectAttempt('ble');
            this.updateStatus('Scanning…', 'connecting');
            const device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'Meshtastic' },
                    { namePrefix: 'MeshCore' }
                ],
                optionalServices: [
                    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
                    '0000180f-0000-1000-8000-00805f9b34fb',
                ]
            });
            await this.connectToDevice(device);
        } catch (error) {
            this._handleConnectError(error, !!this.device);
        }
    }

    async quickConnect(deviceId, opts = {}) {
        const saved = this.getSavedDevices().find(d => d.id === deviceId);
        if (saved?.transport === 'serial') {
            return this.quickConnectSerial(saved, opts);
        }
        if (saved?.transport === 'wifi') {
            return this.quickConnectWifi(saved, opts);
        }

        // Try getDevices() for zero-friction reconnect (Chrome 85+, may need flag)
        if (navigator.bluetooth?.getDevices) {
            let device;
            try {
                const devices = await navigator.bluetooth.getDevices();
                device = devices.find(d => d.id === deviceId);
            } catch (e) {
                console.warn('getDevices failed:', e);
            }
            if (device) {
                try {
                    await this.connectToDevice(device);
                } catch (error) {
                    this._handleConnectError(error, !!this.device, opts.auto);
                }
                return;
            }
        }

        // requestDevice needs a user gesture, so an auto-reconnect can't use it
        // (it would throw a SecurityError and pop an alert on every attempt).
        if (opts.auto) return;

        // Fall back to requestDevice — use saved name as filter so picker pre-selects it
        const name = saved?.name;
        try {
            this._beginConnectAttempt('ble');
            this.updateStatus('Scanning…', 'connecting');
            const filters = (name && name !== 'Unknown')
                ? [{ name }]
                : [{ namePrefix: 'Meshtastic' }, { namePrefix: 'MeshCore' }];
            const device = await navigator.bluetooth.requestDevice({
                filters,
                optionalServices: [
                    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
                    '0000180f-0000-1000-8000-00805f9b34fb',
                ],
            });
            await this.connectToDevice(device);
        } catch (error) {
            this._handleConnectError(error, !!this.device);
        }
    }

    async quickConnectSerial(saved, opts = {}) {
        if (!navigator.serial) {
            if (!opts.auto) alert('Web Serial API is not available.\n\nRequirements:\n• Chrome, Edge, or Opera (desktop)\n• Page must be served over HTTPS or localhost');
            return;
        }
        try {
            this._beginConnectAttempt('serial');
            this.updateStatus('Scanning…', 'connecting');

            // Look for an already-authorised port matching the saved vid/pid so
            // we can skip the picker entirely. Only match when we have a real
            // USB id — otherwise distinct ports would be indistinguishable.
            let port = null;
            if (saved.usbVendorId != null || saved.usbProductId != null) {
                try {
                    const ports = await navigator.serial.getPorts();
                    port = ports.find(p => {
                        let info = {};
                        try { info = p.getInfo?.() || {}; } catch (e) {}
                        return info.usbVendorId === saved.usbVendorId
                            && info.usbProductId === saved.usbProductId;
                    }) || null;
                } catch (e) { console.warn('getPorts failed:', e); }
            }

            // No authorised match (first use on this machine, permission reset,
            // etc.) — fall back to the picker, exactly like the BLE path does.
            // The picker needs a user gesture, so skip it in auto-reconnect.
            if (!port) {
                if (opts.auto) { this._resetConnectBtn(); return; }
                port = await navigator.serial.requestPort({ filters: [] });
            }

            await this.connectToSerialPort(port);
        } catch (error) {
            this._handleConnectError(error, !!(this.serialPort || this.device), opts.auto);
        }
    }

    // Shared handler for a failed connect attempt. `hasConnection` says whether a
    // transport actually came up (tear it down) or never did (just reset the
    // button). NotFoundError = user cancelled the picker; InvalidStateError = BT
    // off (already prompted natively) — neither warrants an alert.
    _handleConnectError(error, hasConnection, silent = false) {
        if (!silent && error.name !== 'NotFoundError' && error.name !== 'InvalidStateError') {
            alert('Connection error: ' + error.message);
        }
        if (hasConnection) this.onDisconnected();
        else this._resetConnectBtn();
    }

    _resetConnectBtn() {
        this.updateStatus('Disconnected', 'disconnected');
        this._setConnectIdle();
    }

    // Idle state: every transport button offers to start a connection.
    _setConnectIdle() {
        this.connectBtn.textContent = 'Connect Bluetooth';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.connectBluetooth();
        this.connectBtn.classList.remove('hidden', 'btn-action');
        if (this.connectUsbBtn) {
            this.connectUsbBtn.textContent = 'Connect USB';
            this.connectUsbBtn.disabled = false;
            this.connectUsbBtn.onclick = () => this.connectUsb();
            this.connectUsbBtn.classList.remove('hidden', 'btn-action');
        }
        if (this.connectWifiBtn) {
            this.connectWifiBtn.textContent = 'Connect WiFi';
            this.connectWifiBtn.disabled = false;
            this.connectWifiBtn.onclick = () => this.connectWifi();
            this.connectWifiBtn.classList.remove('hidden', 'btn-action');
        }
    }

    // Start of a connection attempt: visually mark ONLY the chosen transport's
    // button (it goes disabled/greyed while scanning), leaving the other
    // transports' buttons untouched — normal colour, sub-labels still showing.
    // The modal device picker blocks page interaction, so there's no need to
    // disable the others to prevent a parallel attempt.
    _beginConnectAttempt(kind) {
        const btns = { ble: this.connectBtn, serial: this.connectUsbBtn, wifi: this.connectWifiBtn };
        if (btns[kind]) btns[kind].disabled = true;
    }

    // Make one transport's button the active Cancel/Disconnect control and hide
    // the others so a second connection can't be started during one attempt.
    _setActiveTransportBtn(kind, label, onClick) {
        const btns = { ble: this.connectBtn, serial: this.connectUsbBtn, wifi: this.connectWifiBtn };
        const active = btns[kind];
        // btn-action marks the button as showing Cancel/Disconnect (not a
        // "Connect …" label), which hides its companion/repeater sub-label.
        if (active) { active.textContent = label; active.disabled = false; active.onclick = onClick; active.classList.remove('hidden'); active.classList.add('btn-action'); }
        for (const k of Object.keys(btns)) {
            if (k === kind) continue;
            const b = btns[k];
            if (b) { b.disabled = true; b.classList.add('hidden'); b.classList.remove('btn-action'); }
        }
    }

    async connectToDevice(device) {
        this._setActiveTransportBtn('ble', 'Cancel', () => this.disconnect());
        this.updateStatus('Connecting…', 'connecting');
        this.transportKind = 'ble';
        this.connectionMode = 'companion';   // BLE is always the companion protocol
        this.device = device;

        // Nordic UART Service (NUS) — a de-facto industry standard from Nordic
        // Semiconductor for tunnelling a serial-port-style byte stream over BLE.
        // Bluetooth SIG defines no official "serial port" service, so MeshCore
        // (and Meshtastic, and most BLE IoT/mesh gear) use these fixed UUIDs.
        // RX/TX are named from the device's perspective:
        //   NUS_RX  — we WRITE to it; bytes flow into the device
        //   NUS_TX  — we get NOTIFICATIONS from it; bytes flow out of the device
        const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_RX     = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_TX     = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

        let server, service;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (!this.device) return;
            try {
                server = await device.gatt.connect();
                if (!this.device) { try { device.gatt.disconnect(); } catch (e) {} return; }
                service = await server.getPrimaryService(NUS_SERVICE);
                break;
            } catch (e) {
                if (!this.device) return;
                // BT off (native InvalidStateError) won't recover by retrying —
                // it already prompted; surface it to the caller immediately.
                if (attempt === 3 || e.name === 'InvalidStateError') throw e;
                await new Promise(r => setTimeout(r, attempt * 500));
            }
        }

        // Register the disconnect listener AFTER gatt.connect() so that any
        // lingering gattserverdisconnected event from the previous session
        // doesn't fire onDisconnected() and abort our new connection setup.
        if (!this.device) return;
        this._onGattDisconnected = () => this.onDisconnected();
        device.addEventListener('gattserverdisconnected', this._onGattDisconnected);

        if (!this.device) return;
        this.bleRxCharacteristic = await service.getCharacteristic(NUS_RX);
        if (!this.device) return;
        const txCharacteristic = await service.getCharacteristic(NUS_TX);
        if (!this.device) return;
        this.txCharacteristic = txCharacteristic;
        this._onDataReceived = e => this.handleData(e);
        // Reset Chrome's notify pipe — may retain state from a previous session
        try { await txCharacteristic.stopNotifications(); } catch (e) {}
        if (!this.device) return;
        await txCharacteristic.startNotifications();
        if (!this.device) return;
        txCharacteristic.addEventListener('characteristicvaluechanged', this._onDataReceived);

        await this.sendAppStart();
        await new Promise(r => setTimeout(r, 300));
        await this.sendGetContacts();

        // Battery is read from MeshCore opcode 0x0c (voltage in mV) — more
        // accurate than the BLE Battery Service which some devices report as 100%.

        this._setConnectedDeviceName(this.saveDevice(device));
        // Upgrade the (possibly stale) cached name to the live GAP name if the
        // device was renamed since it was saved — fire-and-forget.
        this._refreshBleName(device, server);

        this.updateStatus('Connected (companion)', 'connected');
        this._setActiveTransportBtn('ble', 'Disconnect', () => this.disconnect());
        this._updateSoundHighlight();
        this._collecting = true;
        // A fully-established connection: from here a drop we didn't initiate is
        // a surprise disconnect and should raise the alarm.
        this._wasConnected = true;
        this._intentionalDisconnect = false;
        this._updatePauseBtn();
        if (this.emptyState) {
            const p = this.emptyState.querySelector('p');
            if (p) p.textContent = 'Connected. Waiting for first RX log…';
        }
        this._startConnectionMonitor();
    }

    _startConnectionMonitor() {
        clearTimeout(this._monitorDelay);
        clearInterval(this._connectionMonitor);
        // Serial disconnects are detected by the read loop / port 'disconnect'
        // event, not by polling gatt.connected — skip the monitor for serial.
        if (this.transportKind === 'serial') return;
        // Delay first check: gatt.connected can be transiently false during GATT setup
        this._monitorDelay = setTimeout(() => {
            this._monitorDelay = null;
            this._connectionMonitor = setInterval(() => {
                if (this.device && this.device.gatt?.connected === false) {
                    this.onDisconnected();
                }
            }, 3000);
        }, 5000);
    }

    // --- USB / Web Serial connection ---

    async connectUsb() {
        this._cancelAutoReconnect();
        if (!navigator.serial) {
            alert('Web Serial API is not available.\n\nRequirements:\n• Chrome, Edge, or Opera (desktop)\n• Page must be served over HTTPS or localhost');
            return;
        }
        try {
            this._beginConnectAttempt('serial');
            this.updateStatus('Scanning…', 'connecting');
            // No filters — MeshCore companions appear behind many USB-serial
            // bridges (CP210x, CH340, native USB CDC), so we let the user pick.
            const port = await navigator.serial.requestPort({ filters: [] });
            await this.connectToSerialPort(port);
        } catch (error) {
            this._handleConnectError(error, !!(this.serialPort || this.device));
        }
    }

    async connectWifi() {
        this._cancelAutoReconnect();
        // Raw TCP can't be opened from a browser; only the native Android host
        // can. Off-app, explain why and where it works (the button is shown
        // everywhere by request).
        if (!window.__MESHCORE_NATIVE__ || typeof window.__mcMakeWifiPort !== 'function') {
            // Flash the WiFi button as the pressed/active one while the
            // explanatory message is up, then restore it — same feedback as
            // BLE/USB get, even though WiFi can't actually connect in a browser.
            this._beginConnectAttempt('wifi');
            // Let the browser paint the pressed state before the blocking alert.
            await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
            alert('WiFi connection isn’t available in the browser.\n\n'
                + 'MeshCore’s WiFi companion firmware speaks raw TCP, and browsers can’t open raw TCP '
                + 'sockets — so connecting over WiFi only works in the Android app, which opens the socket '
                + 'natively.\n\n'
                + 'Here in the browser, use Bluetooth or USB instead.\n\n'
                + 'Note: repeaters have no WiFi (and no Bluetooth) — they connect over USB only.');
            if (this.connectWifiBtn) this.connectWifiBtn.disabled = false;
            return;
        }
        this._openWifiModal();
    }

    _initWifiModal() {
        const modal = document.getElementById('wifiModal');
        if (!modal) return;
        const close = () => this._closeWifiModal();
        document.getElementById('wifiModalClose')?.addEventListener('click', close);
        document.getElementById('wifiModalCancel')?.addEventListener('click', close);
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        document.getElementById('wifiModalConnect')?.addEventListener('click', () => this._submitWifiModal());
        for (const id of ['wifiHostInput', 'wifiPortInput']) {
            document.getElementById(id)?.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); this._submitWifiModal(); }
            });
        }
    }

    _openWifiModal() {
        const modal = document.getElementById('wifiModal');
        if (!modal) return;
        const hostEl = document.getElementById('wifiHostInput');
        const portEl = document.getElementById('wifiPortInput');
        const errEl  = document.getElementById('wifiModalError');
        if (hostEl) hostEl.value = Store.get('wifiHost', '');
        if (portEl) portEl.value = Store.get('wifiPort', '5000');
        if (errEl)  { errEl.textContent = ''; errEl.classList.add('hidden'); }
        modal.classList.remove('hidden');
        setTimeout(() => hostEl?.focus(), 50);
    }

    _closeWifiModal() {
        document.getElementById('wifiModal')?.classList.add('hidden');
    }

    _submitWifiModal() {
        const host = (document.getElementById('wifiHostInput')?.value || '').trim();
        const port = parseInt(document.getElementById('wifiPortInput')?.value, 10);
        const errEl = document.getElementById('wifiModalError');
        const fail = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
        if (!host || !/^[0-9a-zA-Z.\-]+$/.test(host)) { fail('Enter a valid IP address or hostname.'); return; }
        if (!(port >= 1 && port <= 65535)) { fail('Enter a port between 1 and 65535.'); return; }
        Store.set('wifiHost', host);
        Store.set('wifiPort', String(port));
        this._closeWifiModal();
        this._doWifiConnect(host, port);
    }

    // Open a WiFi/TCP companion at host:port. Shared by the connect form and by
    // quick-reconnect of a saved WiFi device.
    async _doWifiConnect(host, port, opts = {}) {
        try {
            this._beginConnectAttempt('wifi');
            this.updateStatus('Connecting…', 'connecting');
            const port_ = window.__mcMakeWifiPort(host, port);
            await this.connectToSerialPort(port_);
        } catch (error) {
            if (!opts.auto) alert('WiFi connection failed: ' + (error.message || error));
            if (this.serialPort || this.device) this.onDisconnected();
            else this._resetConnectBtn();
        }
    }

    async quickConnectWifi(saved, opts = {}) {
        if (!window.__MESHCORE_NATIVE__ || typeof window.__mcMakeWifiPort !== 'function') {
            if (!opts.auto) alert('This is a saved WiFi device — WiFi connection only works in the Android app.');
            return;
        }
        await this._doWifiConnect(saved.host, saved.port, opts);
    }

    async connectToSerialPort(port) {
        // A WiFi/TCP companion is a serial-like port (same frame protocol) but
        // surfaced through the native host; track which so the right button acts
        // as Cancel/Disconnect and so we can tailor messaging.
        let isWifi = false;
        try { isWifi = !!port.getInfo?.().wifi; } catch (e) {}
        this._serialBtnKind = isWifi ? 'wifi' : 'serial';

        this._setActiveTransportBtn(this._serialBtnKind, 'Cancel', () => this.disconnect());
        this.updateStatus('Connecting…', 'connecting');

        await port.open({ baudRate: 115200 });

        this.transportKind = 'serial';
        this.connectionMode = null;        // unknown until detection completes
        this.serialPort = port;
        // A lightweight stand-in for the BLE device object so that the many
        // `this.device` "are we connected?" guards across the app keep working.
        this.device = { kind: 'serial' };
        this._serialReadBuffer = new Uint8Array(0);
        this._serialTextBuffer = '';
        this._serialClosing = false;
        this._sawCompanionFrame = false;
        this.serialReader = port.readable.getReader();

        // Physical unplug fires a 'disconnect' event on the port.
        this._onSerialDisconnect = () => this.onDisconnected();
        port.addEventListener('disconnect', this._onSerialDisconnect);

        this._startSerialReadLoop(port);

        // --- Device-type detection (three-way) ---
        // 1) Companion: answers our binary frames with 0x3e (radio→app) replies.
        //    APP_START alone may not self-reply, so we also send a contacts
        //    request, which a companion always answers.
        // 2) Repeater: speaks a plain-text CLI — it answers 'ver' with a "  -> "
        //    reply. (A companion radio usually speaks the companion protocol only
        //    over Bluetooth, so a companion plugged in by USB answers neither and
        //    must be reported as an error, not a fake connection.)
        this.updateStatus('Detecting device…', 'connecting');

        // Phase 1 — companion probe.
        await this.sendAppStart();
        await new Promise(r => setTimeout(r, 200));
        if (this.serialPort === port && !this._sawCompanionFrame) {
            try { await this._sendFrame(new Uint8Array([0x04])); } catch (e) {}  // CMD_GET_CONTACTS
        }
        for (let i = 0; i < 14 && !this._sawCompanionFrame && this.serialPort === port; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (this.serialPort !== port) return;   // disconnected mid-detection
        if (this._sawCompanionFrame) { await this._finishCompanionConnect(port); return; }

        // WiFi only ever reaches a companion (repeaters have no WiFi), and the
        // text CLI probe below is meaningless over TCP — so stop here with a
        // WiFi-specific message rather than falling through to the repeater path.
        if (isWifi) {
            this.updateStatus('No MeshCore companion found', 'disconnected');
            alert('No MeshCore companion answered at that WiFi address.\n\n'
                + 'Check that:\n'
                + '• the IP and port are correct,\n'
                + '• the device runs the WiFi companion firmware,\n'
                + '• your phone is on the same WiFi network.');
            this.onDisconnected();
            return;
        }

        // Phase 2 — repeater probe over the text CLI.
        this.connectionMode = 'repeater';   // route the read loop to the text parser
        this._serialReadBuffer = new Uint8Array(0);
        this._serialTextBuffer = '';
        this._sawRepeaterReply = false;
        await this._serialWriteText('\r\n');
        await new Promise(r => setTimeout(r, 150));
        await this._serialWriteText('ver\r\n');
        for (let i = 0; i < 14 && !this._sawRepeaterReply && this.serialPort === port; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (this.serialPort !== port) return;

        if (this._sawRepeaterReply) {
            await this._finishRepeaterConnect(port);
        } else {
            // Phase 3 — neither protocol answered.
            this.updateStatus('Unsupported device', 'disconnected');
            alert('This USB serial device didn\'t respond as a MeshCore companion or repeater.\n\n'
                + 'Note: connecting a companion radio over USB usually requires a special USB firmware build. '
                + 'Some companion devices do have this firmware, so if yours does, it should work here. '
                + 'Standard companion radios connect via Bluetooth. '
                + 'USB is also supported for MeshCore repeaters.');
            this.onDisconnected();
        }
    }

    // Finalise a companion (binary frame protocol) serial connection.
    async _finishCompanionConnect(port) {
        this.connectionMode = 'companion';
        await this.sendGetContacts();
        this._setConnectedDeviceName(this.saveSerialPort(port));
        this.updateStatus('Connected (companion)', 'connected');
        this._setActiveTransportBtn(this._serialBtnKind || 'serial', 'Disconnect', () => this.disconnect());
        this._updateSoundHighlight();
        this._collecting = true;
        // A fully-established connection: from here a drop we didn't initiate is
        // a surprise disconnect and should raise the alarm.
        this._wasConnected = true;
        this._intentionalDisconnect = false;
        this._updatePauseBtn();
        if (this.emptyState) {
            const p = this.emptyState.querySelector('p');
            if (p) p.textContent = 'Connected. Waiting for first RX log…';
        }
    }

    // Finalise a repeater (text CLI) serial connection: switch serial parsing to
    // line mode, flush the binary probe junk out of the repeater's command
    // buffer, then start packet logging.
    async _finishRepeaterConnect(port) {
        this.connectionMode = 'repeater';
        // From here the stream is text; drop whatever the frame detector held.
        this._serialReadBuffer = new Uint8Array(0);
        this._serialTextBuffer = '';
        // A leading newline terminates the leftover APP_START bytes sitting in
        // the repeater's CLI buffer (run as one bogus command, harmlessly), so
        // the following 'log start' parses cleanly.
        await this._serialWriteText('\r\n');
        await new Promise(r => setTimeout(r, 150));
        await this._serialWriteText('log start\r\n');   // enable packet logging to file
        await this._serialWriteText('log erase\r\n');   // drop stale backlog; we timestamp at reception

        this._neighborSeen = new Map();
        this._pendingRaw = [];
        this._startRepeaterPolling();
        // Read the repeater's own configured position once, a moment after the
        // connect-time command burst settles (the CLI serialises writes loosely).
        setTimeout(() => { if (this.connectionMode === 'repeater') this._queryRepeaterLocation(); }, 600);

        this._setConnectedDeviceName(this.saveSerialPort(port));
        this.updateStatus('Connected (repeater)', 'connected');
        this._setActiveTransportBtn('serial', 'Disconnect', () => this.disconnect());   // repeaters are USB-only
        this._updateSoundHighlight();
        this._collecting = true;
        // A fully-established connection: from here a drop we didn't initiate is
        // a surprise disconnect and should raise the alarm.
        this._wasConnected = true;
        this._intentionalDisconnect = false;
        this._updatePauseBtn();
        if (this.emptyState) {
            const p = this.emptyState.querySelector('p');
            if (p) p.textContent = 'Connected to a repeater. Waiting for RX log lines…';
        }
    }

    // Write plain text to the serial port (repeater CLI commands).
    async _serialWriteText(text) {
        if (!this.serialPort) return;
        const writer = this.serialPort.writable.getWriter();
        try { await writer.write(new TextEncoder().encode(text)); }
        finally { try { writer.releaseLock(); } catch (e) {} }
    }

    async _startSerialReadLoop(port) {
        try {
            while (this.serialPort === port) {
                const { value, done } = await this.serialReader.read();
                if (done) break;
                if (value && value.length) this._onSerialBytes(value);
            }
        } catch (e) {
            // TypeError is expected when the reader lock is released on disconnect.
            if (!this._serialClosing && !(e instanceof TypeError)) {
                console.warn('Serial read error:', e);
            }
        }
        // Read loop ended unexpectedly (cable pulled / device reset) — tear down.
        if (this.serialPort === port && !this._serialClosing) this.onDisconnected();
    }

    // Reassemble length-prefixed serial frames from a (possibly partial) byte
    // chunk. Frame = [type, lenLSB, lenMSB, ...payload]; type 0x3e ('>') is
    // radio→app, 0x3c ('<') is app→radio. Unknown leading bytes are skipped to
    // resynchronise after any corruption.
    _onSerialBytes(chunk) {
        // Repeater links speak text, not binary frames.
        if (this.connectionMode === 'repeater') { this._onSerialText(chunk); return; }
        if (this._serialReadBuffer.length) {
            const merged = new Uint8Array(this._serialReadBuffer.length + chunk.length);
            merged.set(this._serialReadBuffer, 0);
            merged.set(chunk, this._serialReadBuffer.length);
            this._serialReadBuffer = merged;
        } else {
            this._serialReadBuffer = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        }

        const buf = this._serialReadBuffer;
        const HDR = 3;
        let offset = 0;
        while (buf.length - offset >= HDR) {
            const type = buf[offset];
            if (type !== 0x3e && type !== 0x3c) { offset++; continue; }
            const len = buf[offset + 1] | (buf[offset + 2] << 8);
            if (len === 0) { offset++; continue; }
            if (buf.length - offset < HDR + len) break; // wait for the rest of the frame
            const frame = buf.slice(offset + HDR, offset + HDR + len);
            offset += HDR + len;
            // Only 0x3e (radio→app) frames come from a companion. 0x3c (app→radio)
            // seen on the read side is a repeater echoing our probe back — ignore
            // it, and use a genuine 0x3e frame as proof this is a companion.
            if (type === 0x3e) {
                this._sawCompanionFrame = true;
                try { this.handlePayload(frame); }
                catch (e) { console.error('Frame handling error:', e); }
            }
        }
        this._serialReadBuffer = offset > 0 ? buf.slice(offset) : buf;
    }

    // --- Repeater text-CLI parsing ---

    // Accumulate the serial byte stream and dispatch complete text lines.
    _onSerialText(chunk) {
        this._serialTextBuffer += this._textDecoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = this._serialTextBuffer.indexOf('\n')) >= 0) {
            const line = this._serialTextBuffer.slice(0, nl).replace(/\r$/, '').trim();
            this._serialTextBuffer = this._serialTextBuffer.slice(nl + 1);
            if (line) {
                try { this._handleRepeaterLine(line); }
                catch (e) { console.error('Repeater line error:', e, line); }
            }
        }
    }

    _handleRepeaterLine(line) {
        // RAW packet dump (MESH_PACKET_LOGGING builds): decode for full path /
        // last-hop, hold it until the matching summary line brings SNR/RSSI.
        const raw = line.match(/U RAW:\s*([0-9A-Fa-f]+)/);
        if (raw) { this._sawRepeaterReply = true; this._handleRepeaterRaw(raw[1]); return; }

        // Packet-log summary line, e.g.:
        //  12:34:56 - 1/6/2026 U: RX, len=22 (type=2, route=D, payload_len=20) SNR=13 RSSI=-5 score=1000 [C7 -> 43]
        const m = line.match(/^(\d{2}):(\d{2}):(\d{2}) - (\d{1,2})\/(\d{1,2})\/(\d{4}) U: (RX|TX|TX FAIL!), len=(\d+) \(type=(\d+), route=([DF]), payload_len=(\d+)\)(?:\s+SNR=(-?\d+)\s+RSSI=(-?\d+)\s+score=(-?\d+))?(?:\s*\[([0-9A-Fa-f]{2}) -> ([0-9A-Fa-f]{2})\])?/);
        if (m) { this._sawRepeaterReply = true; this._handleRepeaterLogLine(m); return; }

        // CLI reply text — strip the "  -> " prefix the repeater puts on line 1.
        const body = line.replace(/^->\s*/, '');
        // A "  -> ..." prefixed line is a CLI reply → this really is a repeater.
        if (body !== line) this._sawRepeaterReply = true;

        // End of a 'log' dump → erase the file so the next dump is only-new.
        if (body === 'EOF') { this._serialWriteText('log erase\r\n').catch(() => {}); return; }

        // Reply to our get lat / get lon location probe. The firmware answers
        // each with a bare "> <decimal>" carrying no field name, so we map the
        // replies to fields in the order we asked (lat first, then lon).
        if (this._pendingPosFields && this._pendingPosFields.length) {
            const pm = body.match(/^>\s*(-?\d+(?:\.\d+)?)$/);
            if (pm) {
                this._sawRepeaterReply = true;
                const field = this._pendingPosFields.shift();
                const val = parseFloat(pm[1]);
                if (field === 'lat') this._repeaterLat = val; else this._repeaterLon = val;
                if (!this._pendingPosFields.length) {
                    clearTimeout(this._posQueryTimer);
                    this._setDeviceLocation(this._repeaterLat, this._repeaterLon);
                }
                return;
            }
        }

        // Neighbours-table row: "<8 hex>:<secs_ago>:<snr*4>".
        const nb = body.match(/^([0-9A-Fa-f]{8}):(\d+):(-?\d+)$/);
        if (nb) { this._sawRepeaterReply = true; this._handleNeighborLine(nb[1], parseInt(nb[2], 10), parseInt(nb[3], 10)); return; }

        // Other replies (logging on/off, -none-, errors, command echoes) ignored.
    }

    // Decode a RAW packet dump and queue it for pairing with the summary line
    // that carries SNR/RSSI, giving full last-hop attribution.
    //
    // NOTE: unverified against a real MESH_PACKET_LOGGING build. On the firmware
    // I've seen, RAW dumps stream to serial in real time (logRxRaw) while summary
    // lines live in the log file we poll — so the two arrive on different timing.
    // Hence a generous window and type+length matching rather than strict
    // adjacency. May need tuning once tested on a logging-enabled repeater.
    _handleRepeaterRaw(hex) {
        if (!this._sawRepeaterRaw) {
            this._sawRepeaterRaw = true;
            // Logging build detected: every received packet now streams live as a
            // RAW dump + summary line, with the full path for true last-hop
            // attribution. The polled 'log' file is the same packets a second time,
            // so stop reading it — its summary lines arrive with no RAW to pair
            // with and would otherwise land as phantom 'unknown' duplicates next to
            // the real identified entry.
            this._stopLogPolling();
        }
        let packet;
        try { packet = MeshCoreDecoder.decode(hex); } catch (e) { return; }
        if (!packet || !packet.isValid) return;
        // Adverts carry node name/pubkey/location — feed contacts right away so
        // repeater names resolve even if no summary line pairs with this dump.
        this._ingestContactFromPacket(packet);
        const payloadLen = packet.payload?.raw ? packet.payload.raw.length / 2 : null;
        const now = Date.now();
        this._pendingRaw.push({ packet, rawHex: hex, payloadType: packet.payloadType, payloadLen, t: now });
        const cutoff = now - 6000;
        this._pendingRaw = this._pendingRaw.filter(r => r.t >= cutoff).slice(-16);
    }

    // A neighbours-table entry: identified repeater + SNR + age. Dedup on the
    // real heard-time (so we only add a point when the node is heard afresh), but
    // stamp the point at reception time — the table can report a long-ago advert,
    // and an old timestamp would drop it straight out of the display window.
    _handleNeighborLine(id, secsAgo, snrX4) {
        const fullId = id.toUpperCase();
        const heardEpoch = Date.now() - secsAgo * 1000;
        const prev = this._neighborSeen.get(fullId) ?? 0;
        if (heardEpoch <= prev + 2000) return;   // same reading (allow 1 s rounding jitter)
        this._neighborSeen.set(fullId, heardEpoch);
        const snr = snrX4 / 4;
        const hash = 'nbr-' + fullId + '-' + heardEpoch;
        this._ingestPacket(hash, fullId, 'Repeater Neighbour', null, snr, null,
            { repeaterNeighbor: true, secsAgo }, null, this._myLocation());
    }

    _handleRepeaterLogLine(m) {
        if (m[7] !== 'RX') return;   // outgoing TX carries no SNR/RSSI — ignore entirely

        const len        = parseInt(m[8], 10);
        const payloadType = parseInt(m[9], 10);
        const route      = m[10];                 // 'D' | 'F'
        const payloadLen = parseInt(m[11], 10);
        const snr  = m[12] != null ? parseInt(m[12], 10) : null;
        const rssi = m[13] != null ? parseInt(m[13], 10) : null;
        const src  = m[15] ? m[15].toUpperCase() : null;
        const dest = m[16] ? m[16].toUpperCase() : null;

        // Reception time = now (when the line reached us). The repeater's own
        // clock string is unreliable — an unset RTC stamps packets years off,
        // which would push them outside the chart/map TTL window.

        // Rich path (logging build): a RAW dump for this same packet should be
        // queued — pairing gives the real last hop from the decoded path.
        if (this._pendingRaw.length) {
            let idx = -1;
            for (let i = this._pendingRaw.length - 1; i >= 0; i--) {
                const r = this._pendingRaw[i];
                if (r.payloadType === payloadType && (r.payloadLen == null || r.payloadLen === payloadLen)) { idx = i; break; }
            }
            if (idx >= 0) {
                const r = this._pendingRaw.splice(idx, 1)[0];
                this._processPacket(r.packet, r.rawHex, snr, rssi);
                return;
            }
        }

        // Stock fallback: no usable hop identity — a flood line names the origin
        // (not the node we actually heard), and direct traffic is almost always
        // our own nearby companion. So bucket by route only, and never merge.
        //
        // On a logging build, though, every real packet is captured by the live
        // RAW+summary pairing above. An unpaired summary here is then a redundant
        // copy from the polled 'log' file (one may still be in flight when the
        // first RAW flips us to logging mode) — not a new packet — so suppress it
        // rather than spawn a phantom 'unknown' alongside the identified entry.
        if (this._sawRepeaterRaw) return;

        const col  = route === 'D' ? 'direct' : 'unknown';
        const hash = this._makeUnknownHash();
        const type = (route === 'D' ? 'Direct ' : 'Flood ') + Utils.getPayloadTypeName(payloadType);
        const meta = { repeaterLog: true, route, payloadType, len, payloadLen, src, dest };
        this._ingestPacket(hash, col, type, null, snr, rssi, meta, null, this._myLocation());

        // Summary lines with no accompanying RAW dump ⇒ stock firmware ⇒ limited
        // data. Surface the caveat once.
        if (!this._sawRepeaterRaw && !this._repeaterStockNoticed) {
            this._repeaterStockNoticed = true;
            this._showRepeaterNotice();
        }
    }

    _showRepeaterNotice() {
        document.getElementById('repeaterNotice')?.classList.remove('hidden');
    }

    // Read the repeater's own configured position once over the CLI. There's no
    // single command for both, and the replies are unlabelled ("> <decimal>"),
    // so we ask lat then lon and pair the answers by order (see the parser in
    // _handleRepeaterLine). A repeater with no position set answers "> 0.0",
    // which _setDeviceLocation treats as unset. Firmware that doesn't know the
    // commands answers non-numerically, so the pending fields simply time out.
    async _queryRepeaterLocation() {
        this._repeaterLat = null;
        this._repeaterLon = null;
        this._pendingPosFields = ['lat', 'lon'];
        // Await between writes — the serial writer is single-locked, so firing
        // both at once would make the second getWriter() throw.
        await this._serialWriteText('get lat\r\n').catch(() => {});
        await this._serialWriteText('get lon\r\n').catch(() => {});
        clearTimeout(this._posQueryTimer);
        this._posQueryTimer = setTimeout(() => { this._pendingPosFields = []; }, 5000);
    }

    // Repeater data is pulled, not pushed. Both the neighbours table and the
    // packet log are polled over the CLI (reading them transmits nothing). The
    // log is a stored file with no streaming, so each cycle we dump it ('log')
    // and clear it ('log erase' on the EOF marker) to get only-new entries.
    _startRepeaterPolling() {
        this._stopRepeaterPolling();
        const alive = () => this.connectionMode === 'repeater' && this.serialPort;
        this._neighborPollTimer = setInterval(() => {
            if (alive()) this._serialWriteText('neighbors\r\n').catch(() => {});
        }, 5000);
        this._logPollTimer = setInterval(() => {
            if (alive()) this._serialWriteText('log\r\n').catch(() => {});
        }, 2500);
        // Seed immediately on connect.
        this._serialWriteText('neighbors\r\n').catch(() => {});
        this._serialWriteText('log\r\n').catch(() => {});
    }

    _stopRepeaterPolling() {
        if (this._neighborPollTimer) { clearInterval(this._neighborPollTimer); this._neighborPollTimer = null; }
        this._stopLogPolling();
    }

    // Stop dumping the packet-log file. Used both on disconnect and the moment a
    // logging build is detected (its live stream supersedes the polled file).
    _stopLogPolling() {
        if (this._logPollTimer) { clearInterval(this._logPollTimer); this._logPollTimer = null; }
    }

    // Wrap a MeshCore command in a serial frame and write it to the port.
    async _serialSendFrame(data) {
        if (!this.serialPort) return;
        const frame = new Uint8Array(3 + data.length);
        frame[0] = 0x3c; // "<" app → radio
        frame[1] = data.length & 0xff;
        frame[2] = (data.length >> 8) & 0xff;
        frame.set(data, 3);
        const writer = this.serialPort.writable.getWriter();
        try { await writer.write(frame); }
        finally { try { writer.releaseLock(); } catch (e) {} }
    }

    // Transport-agnostic frame send: raw notification write over BLE, or
    // length-prefixed frame over serial.
    async _sendFrame(bytes) {
        if (this.transportKind === 'serial') {
            await this._serialSendFrame(bytes);
        } else if (this.bleRxCharacteristic) {
            await this.bleRxCharacteristic.writeValueWithoutResponse(bytes);
        }
    }

    // True when a transport is up and able to accept commands.
    _canSend() {
        return this.transportKind === 'serial' ? !!this.serialPort : !!this.bleRxCharacteristic;
    }

    async sendAppStart() {
        // CMD_APP_START = [0x01, app_ver 0x03, 6 padding bytes, app_name (UTF-8)].
        // app_name only identifies this client to the device (informational, not
        // echoed back in SELF_INFO), so its length is irrelevant — the frame stays
        // tiny either way.
        const header = [0x01, 0x03, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20];
        const name = new TextEncoder().encode('signal-tester');
        const payload = new Uint8Array(header.length + name.length);
        payload.set(header, 0);
        payload.set(name, header.length);
        await this._sendFrame(payload);
    }

    async sendGetContacts() {
        if (!this._canSend()) return;
        this._contactsRetries = 0;
        this._contactsLastStallSize = -1;
        this._contactsFetchedKeys.clear();
        this._contactsFetchActive = true;
        this._setContactsLoading(true);
        await this._sendGetContactsCmd();
    }

    // Send the raw CMD_GET_CONTACTS frame and arm the stall watchdog. Separate
    // from sendGetContacts() so a retry can re-request without resetting the
    // retry counter.
    async _sendGetContactsCmd() {
        // CMD_GET_CONTACTS = 0x04; optional 4-byte LE lastmod for incremental sync
        const cmd = new Uint8Array(this._contactsLastmod > 0 ? 5 : 1);
        cmd[0] = 0x04;
        if (this._contactsLastmod > 0)
            new DataView(cmd.buffer).setUint32(1, this._contactsLastmod, true);
        this._armContactsWatchdog();
        try { await this._sendFrame(cmd); }
        catch (e) { this._setContactsError('Contact request failed: ' + (e?.message || e)); }
    }

    _armContactsWatchdog() {
        clearTimeout(this._contactsStallTimer);
        this._contactsStallTimer = setTimeout(() => this._onContactsStall(), CONTACTS_STALL_MS);
    }

    // The contact stream went quiet before END_OF_CONTACTS — almost always a
    // dropped frame on a busy BLE link. Re-request and merge; contacts upsert by
    // key, so each pass fills more gaps. Stop once a pass adds nothing new (the
    // list is as complete as it'll get — likely just the END frame was lost) or
    // after the retry cap.
    _onContactsStall() {
        if (!this._canSend() || this.connectionMode !== 'companion') {
            this._contactsFetchActive = false;
            this._setContactsLoading(false);
            return;
        }
        // Count only what THIS fetch has pulled, not the whole contact map
        // (which may already hold CSV-imported or previously-known contacts).
        const fetched = this._contactsFetchedKeys.size;
        const noProgress = this._contactsRetries > 0 && fetched === this._contactsLastStallSize;
        if (noProgress || this._contactsRetries >= CONTACTS_MAX_RETRIES) {
            this._contactsReceiving = false;
            this._contactsFetchActive = false;
            this._updateContactsCount();
            if (fetched === 0) {
                this._setContactsError('Contact fetch failed — try reconnecting.');
            } else {
                // Partial list and further retries aren't pulling the rest — say
                // so rather than stopping silently, so the user knows to reconnect.
                this._setContactsError(`Synced ${fetched} contacts — some may be missing. Reconnect to retry.`);
            }
            return;
        }
        this._contactsLastStallSize = fetched;
        this._contactsRetries++;
        if (this.contactsLoadingMsg) {
            this.contactsLoadingMsg.style.display = '';
            this.contactsLoadingMsg.textContent = `Syncing contacts… (${fetched} so far)`;
        }
        this._sendGetContactsCmd();
    }

    _setContactsLoading(on) {
        if (this.contactsLoadingMsg) {
            this.contactsLoadingMsg.style.display = on ? '' : 'none';
            if (on) this.contactsLoadingMsg.textContent = 'Fetching contacts…';
        }
        if (!on) clearTimeout(this._contactsStallTimer);
    }

    _setContactsError(msg) {
        clearTimeout(this._contactsStallTimer);
        if (this.contactsLoadingMsg) {
            this.contactsLoadingMsg.style.display = '';
            this.contactsLoadingMsg.textContent = msg;
        }
        console.error('[contacts]', msg);
    }

    _parseContact(payload) {
        // byte 0 = code (0x03 RESP_CODE_CONTACT or 0x8A PUSH_CODE_NEW_ADVERT)
        // bytes 1-32  = pub_key
        // byte 33     = type (1=Chat 2=Repeater 3=RoomSrv 4=Sensor)
        // byte 34     = flags, byte 35 = path_len
        // bytes 36-99 = out_path (64 B)
        // bytes 100-131 = adv_name (32 B, null-terminated UTF-8)
        // bytes 132-135 = last_advert (uint32 LE)
        // bytes 136-139 = lat (int32 LE / 1e6)
        // bytes 140-143 = lon (int32 LE / 1e6)
        // bytes 144-147 = lastmod (uint32 LE)
        if (payload.length < 132) return;
        const pubKey = payload.slice(1, 33);
        const pubKeyFull = Array.from(pubKey).map(b => b.toString(16).padStart(2, '0')).join('');
        const type = payload[33];
        const nameEnd = Math.min(132, payload.length);
        let nullIdx = payload.indexOf(0, 100);
        if (nullIdx < 0 || nullIdx > nameEnd) nullIdx = nameEnd;
        const name = new TextDecoder('utf-8').decode(payload.slice(100, nullIdx)).trim();
        let lastAdvert = 0, lat = 0, lon = 0, lastmod = 0;
        if (payload.length >= 136) lastAdvert = payload[132] | (payload[133] << 8) | (payload[134] << 16) | (payload[135] << 24);
        if (payload.length >= 140) lat = ((payload[136] | (payload[137] << 8) | (payload[138] << 16) | (payload[139] << 24)) | 0) / 1e6;
        if (payload.length >= 144) lon = ((payload[140] | (payload[141] << 8) | (payload[142] << 16) | (payload[143] << 24)) | 0) / 1e6;
        if (payload.length >= 148) lastmod = payload[144] | (payload[145] << 8) | (payload[146] << 16) | (payload[147] << 24);
        this._contacts.set(pubKeyFull, { name: name || null, type, lat, lon, lastAdvert, lastmod, pubKeyFullHex: pubKeyFull });
        this._scheduleContactsPersist();
        // NB: do NOT advance _contactsLastmod here. The incremental-sync marker
        // must only move forward once a FULL contact list has been received
        // (END_OF_CONTACTS). Advancing it per-contact meant an interrupted fetch
        // (e.g. another client grabbed the single-client companion) left the
        // marker partway, so every later reconnect did an incremental sync that
        // skipped the missing contacts — and only restarting the app (which
        // resets the marker to 0) recovered. Re-fetching a contact we already
        // have via push is a harmless upsert.
        this._updateContactsCount();
        return pubKeyFull;
    }

    _contactsByPrefix(hexPrefix) {
        if (!hexPrefix || hexPrefix === 'direct') return [];
        const p = hexPrefix.toLowerCase();
        const out = [];
        for (const [key, val] of this._contacts)
            if (key.startsWith(p)) out.push(val);
        return out;
    }

    _contactByPrefix(hexPrefix) {
        return this._contactsByPrefix(hexPrefix)[0] ?? null;
    }

    // Map a contact's full public key back to the live repeater column it
    // belongs to. Columns are keyed by a short hash *prefix* of the repeater id
    // (often just 2 hex chars, sometimes promoted longer, or an "a/b" collision
    // key) — NOT by a fixed 6-char pubkey slice. A pinned map marker must resolve
    // its real column this way; keying it off slice(0,6) instead selects a
    // phantom column that matches no data, so the dots, table and chart all come
    // up empty (looking as if everything were filtered out). Picks the longest
    // (most specific) matching prefix. Null when no current column matches.
    _colForPubKey(pubKeyHex) {
        if (!pubKeyHex) return null;
        const pk = pubKeyHex.toLowerCase();
        let bestKey = null, bestLen = -1;
        for (const key of this.repeaterColumns) {
            for (const seg of key.split('/')) {
                if (seg === 'direct' || seg === 'unknown') continue;
                // Column keys are stored upper-case, contact pub keys lower-case,
                // so compare case-insensitively. Return the ORIGINAL key so it
                // still matches the rx data / _selectedCol exactly.
                const s = seg.toLowerCase();
                if (s && pk.startsWith(s) && s.length > bestLen) {
                    bestKey = key; bestLen = s.length;
                }
            }
        }
        return bestKey;
    }

    _contactNameForCol(col) {
        const matches = this._contactsByPrefix(col);
        if (!matches.length) return null;
        if (matches.length === 1) return matches[0].name ?? null;
        return matches.map(c => c.name ?? '?').join(' / ');
    }

    _colStats(col) {
        const pts = this.chartPoints.filter(p => p.col === col);
        if (!pts.length) return null;
        const maxRssi = Math.max(...pts.map(p => p.rssi));
        const snrPts  = pts.filter(p => p.snr != null);
        const maxSnr  = snrPts.length ? Math.max(...snrPts.map(p => p.snr)) : null;
        const last    = pts[pts.length - 1];
        return { count: pts.length, lastRssi: last.rssi, lastSnr: last.snr ?? null, maxRssi, maxSnr };
    }

    _contactsForMapButtons(col) {
        const matches = this._contactsByPrefix(col);
        return matches.filter(c => c.name && (c.lat !== 0 || c.lon !== 0));
    }

    // Toggle whether all GPS contacts of a repeater column are kept on the 3D
    // map permanently. Driven by the pushpin button in the map infobox (A).
    _toggleMapPinForCol(col) {
        const contacts = this._contactsForMapButtons(col);
        if (!contacts.length) return;
        const anyPinned = contacts.some(c => this._mapPins.has(c.pubKeyFullHex));
        for (const c of contacts) {
            if (anyPinned) this._mapPins.delete(c.pubKeyFullHex);
            else           this._mapPins.add(c.pubKeyFullHex);
        }
        this._updateMapPins();
        this._updateCornerNotices();
    }

    _updateMapPins() {
        if (!this.signalMap) return;
        const markers = [];
        const seen = new Set();
        // Auto-show currently selected repeater if it has GPS coords
        if (this._selectedCol && (!this._repFilterTerms.length || this._colMatchesRepFilter(this._selectedCol))) {
            for (const c of this._contactsForMapButtons(this._selectedCol)) {
                if (seen.has(c.pubKeyFullHex)) continue;
                seen.add(c.pubKeyFullHex);
                const isPinned = this._mapPins.has(c.pubKeyFullHex);
                markers.push({ lat: c.lat, lon: c.lon, name: c.name,
                    id: this.displayId(this._selectedCol), color: this.getRepeaterColor(this._selectedCol),
                    col: this._selectedCol, pubKeyFullHex: c.pubKeyFullHex, isPinned });
            }
        }
        // Permanently pinned contacts not already shown via auto-select
        for (const pubKeyFullHex of this._mapPins) {
            if (seen.has(pubKeyFullHex)) continue;
            const contact = this._contacts.get(pubKeyFullHex);
            if (!contact?.name || (contact.lat === 0 && contact.lon === 0)) continue;
            // Resolve the live data column so clicking the marker selects the
            // same key the dots/table/chart use; fall back to a 6-char prefix
            // only when the repeater isn't currently in the data.
            const col = this._colForPubKey(pubKeyFullHex) ?? pubKeyFullHex.slice(0, 6);
            if (this._repFilterTerms.length && !this._colMatchesRepFilter(col)) continue;
            seen.add(pubKeyFullHex);
            markers.push({ lat: contact.lat, lon: contact.lon, name: contact.name,
                id: this.displayId(col), color: this.getRepeaterColor(col),
                col, pubKeyFullHex, isPinned: true });
        }
        this.signalMap.setStaticMarkers(markers);
        this._updateShowAllBtn();
    }

    _colHasMapMarker(col) {
        if (!col) return false;
        if (col === this._selectedCol && this._contactsForMapButtons(col).length) return true;
        for (const pubKeyFullHex of this._mapPins) {
            if (this._colForPubKey(pubKeyFullHex) === col) return true;
        }
        return false;
    }

    _updateContactsCount() {
        if (this.contactsCountEl) this.contactsCountEl.textContent = this._contacts.size;
        if (this.contactsHstat) this.contactsHstat.style.display = this._contacts.size > 0 ? '' : 'none';
    }

    // Persist contacts (debounced) to the session DB so they survive a reload /
    // renderer-crash rebuild — restored in _initStore. The incremental-sync
    // marker is saved too, so a reconnect resumes from it instead of re-pulling
    // the whole contact list.
    _scheduleContactsPersist() {
        if (!this._storeReady) return;
        clearTimeout(this._contactsPersistTimer);
        this._contactsPersistTimer = setTimeout(() => {
            this.store.setKV('contacts', { entries: [...this._contacts.values()], lastmod: this._contactsLastmod });
        }, 1000);
    }

    _updateSoundHighlight() {
        const label = this.soundSelect?.closest('.sound-toggle');
        if (!label) return;
        // Only highlight when sound is enabled AND a device is connected — without
        // a connection nothing produces sound anyway.
        const active = (this.soundSelect.value || 'off') !== 'off' && this._canSend();
        label.classList.toggle('sound-active', active);
    }

    // Send one DISCOVER_REQ, then wait 2 s to collect responses before re-enabling the button.
    async startDiscoverSequence(filterMask) {
        const btn = document.getElementById('discoverBtn');
        if (!this._canSend()) {
            if (btn) {
                btn.textContent = '⚠ Not connected';
                btn.classList.add('btn-error');
                setTimeout(() => { btn.textContent = 'Discover nodes'; btn.classList.remove('btn-error'); }, 2500);
            }
            return;
        }
        // Repeater CLI: trigger an active neighbour discovery. Responses refresh
        // the repeater's neighbours table (ingested by a later phase).
        if (this.connectionMode === 'repeater') {
            await this._serialWriteText('discover.neighbors\r\n');
            if (btn) { btn.textContent = 'Discovering…'; setTimeout(() => { btn.textContent = 'Discover nodes'; }, 2000); }
            // Read the table back once responses have had time to arrive (the
            // periodic poll would catch them too, just less promptly).
            setTimeout(() => this._serialWriteText('neighbors\r\n').catch(() => {}), 1500);
            return;
        }
        if (this._discoverActive) return; // prevent double-click overlap
        this._discoverActive = true;

        const tag = (Math.random() * 0xFFFFFFFF) >>> 0;
        if (!this._discoverTags) this._discoverTags = new Map();
        this._discoverTags.set(tag, Date.now());
        // Prune tags older than 30 s
        for (const [t, ts] of this._discoverTags)
            if (Date.now() - ts > 30000) this._discoverTags.delete(t);

        await this.sendDiscoverRequest(filterMask, tag);
        if (btn) btn.textContent = 'Discovering…';

        // Keep button showing "Discovering…" for 2 s to collect responses
        await new Promise(r => setTimeout(r, 2000));
        if (btn) btn.textContent = 'Discover nodes';
        this._discoverActive = false;
    }

    async sendDiscoverRequest(filterMask, tag) {
        if (!this._canSend()) return;
        // CMD_SEND_CONTROL_DATA (0x37) + CTL_TYPE_NODE_DISCOVER_REQ (0x80) + filter + tag (4 B LE)
        // filter bits: 0=Chat, 1=Repeater, 2=Room, 3=Sensor
        if (tag === undefined) tag = (Math.random() * 0xFFFFFFFF) >>> 0;
        const bytes = new Uint8Array([
            0x37, 0x80, filterMask & 0x0F,
            tag & 0xFF, (tag >>> 8) & 0xFF, (tag >>> 16) & 0xFF, (tag >>> 24) & 0xFF,
        ]);
        if (!this._discoverTags) this._discoverTags = new Map();
        this._discoverTags.set(tag, Date.now());
        try {
            await this._sendFrame(bytes);
        } catch (e) { console.error('sendDiscoverRequest:', e); }
    }

    // --- Saved devices (localStorage) ---

    getSavedDevices() {
        return Store.json('devices', []);
    }

    saveDevice(device, nameOverride) {
        let devices = this.getSavedDevices();
        // The live name: a fresh GAP-read name when we have one (see
        // _refreshBleName), else whatever the BLE layer reported — which on a
        // saved-id reconnect can be Android's stale cached name.
        const liveName = nameOverride || device.name;
        // Web Bluetooth's device.id is NOT reliably stable across
        // requestDevice() calls — getDevices() (the zero-friction reconnect
        // path) needs an experimental Chrome flag, so a quick-connect usually
        // falls back to re-pairing, which can mint a fresh id for the very same
        // physical device. Keyed on id alone, those re-pairs piled up duplicate
        // saved entries over time. So also match a prior BLE entry by name
        // (MeshCore names carry a unique suffix) and collapse onto one entry.
        const prior = devices.find(d => d.id === device.id
            || (liveName && d.transport === 'ble' && d.name === liveName));
        const name = liveName || prior?.name || 'Unknown';
        devices = devices.filter(d => d.id !== device.id
            && !(liveName && d.transport === 'ble' && d.name === liveName));
        devices.push({ id: device.id, name, transport: 'ble' });
        Store.set('devices', JSON.stringify(devices));
        this._lastConnectedId = device.id;   // for auto-reconnect
        this._renderSavedDevices();
        return name;
    }

    // The device may have been renamed since it was saved. device.name on a
    // saved-id reconnect is often Android's stale cached name, so read the live
    // GAP "Device Name" (service 0x1800, char 0x2A00) and, if it differs, adopt
    // it for the connection label and the saved entry. Fire-and-forget so it
    // never delays "Connected". No-op on the web: Chrome block-lists the GAP
    // service, so getPrimaryService rejects — caught here, leaving the cached
    // name in place (the requestDevice picker path already gets a fresh name).
    async _refreshBleName(device, server) {
        if (!server) return;
        let live = null;
        try {
            const gap = await server.getPrimaryService('00001800-0000-1000-8000-00805f9b34fb');
            const ch  = await gap.getCharacteristic('00002a00-0000-1000-8000-00805f9b34fb');
            const val = await ch.readValue();
            live = new TextDecoder('utf-8').decode(val).replace(/\0+$/, '').trim();
        } catch (_) { return; }
        // Still the same live connection, and a real new name?
        if (!live || this.device !== device || live === device.name) return;
        this._setConnectedDeviceName(this.saveDevice(device, live));
    }

    // Serial ports expose no stable id or name — only the USB vendor/product id
    // (and only for USB-backed ports). We key the saved entry on those so a
    // previously-authorised port can be re-opened without the picker. Two
    // identical adapters are indistinguishable and collapse to one entry.
    saveSerialPort(port) {
        let info = {};
        try { info = port.getInfo?.() || {}; } catch (e) {}
        // WiFi/TCP companion: persisted by host:port so it appears in the Saved
        // list and can be reconnected with one tap (Android only).
        if (info.wifi) {
            const id = `wifi:${info.host}:${info.port}`;
            const name = `WiFi ${info.host}:${info.port}`;
            const devices = this.getSavedDevices();
            const existing = devices.find(d => d.id === id);
            if (existing) {
                existing.name = name; existing.transport = 'wifi';
                existing.host = info.host; existing.port = info.port;
            } else {
                devices.push({ id, name, transport: 'wifi', host: info.host, port: info.port });
            }
            Store.set('devices', JSON.stringify(devices));
            this._lastConnectedId = id;   // for auto-reconnect
            this._renderSavedDevices();
            return name;
        }
        const vid = info.usbVendorId;
        const pid = info.usbProductId;
        const hex4 = n => (n == null ? '????' : n.toString(16).padStart(4, '0').toUpperCase());
        const id = `serial:${hex4(vid)}:${hex4(pid)}`;
        const name = (vid != null || pid != null) ? `USB ${hex4(vid)}:${hex4(pid)}` : 'USB device';
        const devices = this.getSavedDevices();
        const existing = devices.find(d => d.id === id);
        if (existing) {
            existing.name = name;
            existing.transport = 'serial';
            existing.usbVendorId = vid;
            existing.usbProductId = pid;
        } else {
            devices.push({ id, name, transport: 'serial', usbVendorId: vid, usbProductId: pid });
        }
        Store.set('devices', JSON.stringify(devices));
        this._lastConnectedId = id;   // for auto-reconnect
        this._renderSavedDevices();
        return name;
    }

    forgetDevice(deviceId) {
        const devices = this.getSavedDevices().filter(d => d.id !== deviceId);
        Store.set('devices', JSON.stringify(devices));
        this._renderSavedDevices();
    }

    _renderSavedDevices() {
        const el = document.getElementById('savedDevices');
        if (!el) return;
        const devices = this.getSavedDevices();
        if (devices.length === 0) {
            el.classList.add('hidden');
            return;
        }
        el.classList.remove('hidden');
        el.innerHTML = '<span class="saved-label">Saved:</span>' +
            devices.map(d => `
                <span class="saved-device">
                    <button class="saved-btn" data-id="${d.id}">${d.name}</button>
                    <button class="forget-btn" data-id="${d.id}" title="Forget">✕</button>
                </span>
            `).join('');
    }

    // --- Data handling ---

    handleData(event) {
        this.handlePayload(new Uint8Array(event.target.value.buffer));
    }

    handlePayload(payload) {
        const pushCode = payload[0];
        // PACKET_BATTERY (0x0C): bytes [1-2] = uint16 LE voltage in mV
        if (pushCode === 0x0c) {
            if (payload.length >= 3) {
                const milliVolts = payload[1] | (payload[2] << 8);
                this._updateBleBatteryVoltage(milliVolts);
            }
            return;
        }

        // PACKET_SELF_INFO (0x05): the device's own info, returned in reply to
        // APP_START. We only want the configured advertised position from it.
        if (pushCode === 0x05) { this._handleSelfInfo(payload); return; }

        // Contact list responses (from CMD_GET_CONTACTS = 0x04)
        if (pushCode === 0x02) {
            this._contactsReceiving = true;
            this._armContactsWatchdog();   // stream started — reset the stall timer
            return;
        }
        if (pushCode === 0x03) {
            if (this._contactsReceiving) {
                const key = this._parseContact(payload);
                if (key) this._contactsFetchedKeys.add(key);   // count what THIS fetch pulled
                this._armContactsWatchdog();   // got a contact — keep the stream alive
            }
            return;
        }
        if (pushCode === 0x04 && this._contactsReceiving) {
            this._contactsReceiving = false;
            this._contactsRetries = 0;
            this._contactsFetchActive = false;
            this._setContactsLoading(false);
            if (payload.length >= 5)
                this._contactsLastmod = payload[1] | (payload[2]<<8) | (payload[3]<<16) | (payload[4]<<24);
            this._scheduleContactsPersist();   // full list received → persist with the new sync marker
            this._updateContactsCount();
            this._lastColKey = null; // force column header redraw with names
            this._renderMsgTable();
            this._renderRepTable();
            this._scheduleChartRender();
            this._updateShowAllBtn();
            return;
        }
        // PUSH_CODE_NEW_ADVERT = 0x8A — device heard an advert from a node not yet in contacts
        if (pushCode === 0x8a) { this._parseContact(payload); return; }

        // PUSH_CODE_CONTROL_DATA (0x8E) may carry a DISCOVER_RESP (ctl_type 0x9X)
        // Format: [0x8E, snr*4, rssi, path_len, ctl_type, ...payload]
        if (pushCode === 0x8e && payload.length >= 5 && (payload[4] & 0xF0) === 0x90) {
            this._handleDiscoverResp(payload);
            return;
        }
        // Only the three known LoRa RX push codes carry the SNR/RSSI/path
        // layout we trust. Everything else is silently ignored.
        let loraPacket;
        if (pushCode === 0x88) {
            loraPacket = payload.slice(3);
        } else if (pushCode === 0x84 || pushCode === 0x8e) {
            loraPacket = payload.slice(4);
        } else if (pushCode === 0x80) {
            this._handleAdvertPush(payload);
            return;
        } else if (pushCode === 0x89) {
            this._handleTracePush(payload);
            return;
        } else {
            return;
        }
        if (loraPacket.length === 0) return;

        const snr  = (payload[1] > 127 ? payload[1] - 256 : payload[1]) / 4;
        const rssi = payload[2] > 127 ? payload[2] - 256 : payload[2];

        try {
            const rawHex = this._bufferToHex(loraPacket.buffer);
            const packet = MeshCoreDecoder.decode(rawHex);
            if (packet.isValid) this._processPacket(packet, rawHex, snr, rssi);
        } catch (e) { console.error('Decode error:', e); }
    }

    // PACKET_SELF_INFO (0x05) layout: [0]=code, [1]=adv_type, [2-3]=tx powers,
    // [4-35]=pub_key, [36-39]=adv_lat, [40-43]=adv_lon (int32 LE / 1e6),
    // [45]=adv_loc_policy. We read only the device's own advertised position.
    _handleSelfInfo(payload) {
        if (payload.length < 44) return;
        const lat = ((payload[36] | (payload[37] << 8) | (payload[38] << 16) | (payload[39] << 24)) | 0) / 1e6;
        const lon = ((payload[40] | (payload[41] << 8) | (payload[42] << 16) | (payload[43] << 24)) | 0) / 1e6;
        this._setDeviceLocation(lat, lon);
        this._updateDeviceLocationRefresh();
    }

    // Periodically re-read the device's own position while the user is watching
    // its 3D-map marker. SELF_INFO always reports the device's LIVE sensor
    // position (sensors.node_lat), so for a companion with onboard GPS this keeps
    // moving even when its advert_loc_policy is 'none' — that policy only governs
    // what goes into adverts, NOT whether GPS is running. Re-issuing APP_START
    // pulls the fresh position; its SELF_INFO reply updates the marker.
    //
    // We deliberately do NOT gate on advert_loc_policy === 'share': that wrongly
    // excluded GPS devices that simply don't advertise their location, so we'd
    // read the position once at connect and never again — which is why only
    // reconnecting refreshed it. The poll is cheap, so we run it for any
    // connected companion with the marker shown. A device with no GPS just keeps
    // reporting the same coordinates, which is harmless.
    //
    // This method is called both on marker/connection changes AND from
    // _handleSelfInfo (every poll reply), so it must be idempotent: if the timer
    // is already running we leave it alone. Otherwise the immediate poll() below
    // would re-fire on every SELF_INFO reply, turning the interval into a tight
    // reply-driven loop that hammers the device. We refresh once per second; the
    // device's GPS updates at ~1 Hz and the round-trip is tiny (~90 bytes), so
    // this is negligible BT load. Gated purely on the (default-off) device marker
    // — turning it on is the user opting in.
    _updateDeviceLocationRefresh() {
        const wants = this.connectionMode === 'companion' && this._showDeviceMarker;
        if (!wants) {
            clearInterval(this._deviceRefreshTimer);
            this._deviceRefreshTimer = null;
            return;
        }
        if (this._deviceRefreshTimer) return;   // already polling — don't restart or double-poll
        const poll = () => {
            // Never poll while contacts are being fetched: re-issuing APP_START
            // mid-stream disrupts the companion's contact dump and stalls it.
            if (this.connectionMode === 'companion' && this._canSend() && !this._contactsFetchActive) {
                this.sendAppStart().catch(() => {});   // its SELF_INFO reply refreshes the position
            }
        };
        poll();                                        // refresh now so toggling the marker updates immediately
        this._deviceRefreshTimer = setInterval(poll, 1000);
    }

    // Record the connected device's own configured position and place it on the
    // 3D map. lat/lon of 0,0 (or null) means unset / unsupported → clear it. The
    // zero-zero convention matches how contacts and adverts mark "no position".
    _setDeviceLocation(lat, lon) {
        const has = lat != null && lon != null && !(lat === 0 && lon === 0);
        this.signalMap?.setDeviceLocation(has ? lat : null, has ? lon : null);
    }

    _handleAdvertPush(_payload) {
        // 0x80: existing contact re-heard — redundant with the 0x88 Flood Advert that fires alongside it
    }

    _handleDiscoverResp(payload) {
        // Outer 0x8E header: [code, snr*4, rssi, path_len]
        // Inner control_data: [0x9X (X=adv_type), snr_remote, tag(4 LE), pub_key (32 or 8)]
        const ourSnrByte = payload[1];
        const ourSnr  = (ourSnrByte > 127 ? ourSnrByte - 256 : ourSnrByte) / 4;
        const ourRssiByte = payload[2];
        const ourRssi = ourRssiByte > 127 ? ourRssiByte - 256 : ourRssiByte;
        const pathLen = payload[3];
        const ctlType = payload[4];
        const advType = ctlType & 0x0F;
        const remoteSnrByte = payload[5];
        const remoteSnr = (remoteSnrByte > 127 ? remoteSnrByte - 256 : remoteSnrByte) / 4;
        const tag = (payload[6] | (payload[7] << 8) | (payload[8] << 16) | (payload[9] << 24)) >>> 0;
        const pubKeyLen = payload.length - 10;
        if (pubKeyLen !== 32 && pubKeyLen !== 8) return;
        const pubKey = payload.slice(10, 10 + pubKeyLen);

        const TYPE_NAMES = { 1: 'Chat', 2: 'Repeater', 3: 'RoomSrv', 4: 'Sensor' };
        const typeName = TYPE_NAMES[advType] ?? `Adv${advType}`;
        const pubKeyHex = Array.from(pubKey.slice(0, 3))
            .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const pubKeyFull = pubKeyLen === 32
            ? Array.from(pubKey).map(b => b.toString(16).padStart(2, '0')).join('')
            : null;
        const adHash = 'AD:' + pubKeyHex;
        const existing = this.hashData.get(adHash);
        const tagKnown = this._discoverTags?.has(tag);
        const nodeName = existing?.meta?.name ?? null;
        const meta = {
            name: nodeName,
            advType,
            pubKeyHex,
            pubKeyFull: pubKeyFull ?? existing?.meta?.pubKeyFull ?? null,
            remoteSnr,
            tag,
            tagKnown,
        };

        // Record uplink SNR in the Sent SNR History chart and 3D map. Persist the
        // capture position too, so the map can show outgoing SNR from disk
        // (clustered, surviving reload/export) the same way it shows incoming.
        const now = Date.now();
        const sentLoc = this.signalMap?.currentLocation() ?? null;
        this._sentSnrHistory.push({ time: now, snr: remoteSnr, col: pubKeyHex, label: nodeName ?? pubKeyHex, lat: sentLoc?.lat ?? null, lon: sentLoc?.lon ?? null });
        if (!this._storeDead) { this._sentWriteBuf.push({ time: now, snr: remoteSnr, rawId: pubKeyHex, label: nodeName ?? pubKeyHex, lat: sentLoc?.lat ?? null, lon: sentLoc?.lon ?? null }); this._scheduleWriteFlush(); }
        this._scheduleChartRender();
        if (sentLoc && remoteSnr != null) {
            this.signalMap.addSentSnrPacket({ lat: sentLoc.lat, lon: sentLoc.lon, snr: remoteSnr, col: pubKeyHex, time: now, rawId: pubKeyHex });
        }

        // Each DSC response → new row in Received Packets; always use current time so order is correct.
        // Column = the responding node's pub key prefix so all its DSC responses share one column.
        const dscHash = 'DSC:' + (++this._dscSeq);
        const rawHex = Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join('');
        this._ingestPacket(dscHash, pubKeyHex, typeName + ' DSC', rawHex, ourSnr, ourRssi, meta, null, { remoteSnr, ...this._myLocation() });
    }

    _handleTracePush(payload) {
        if (payload.length < 12) return;
        const pathLen = payload[2];
        const tag = ((payload[4]) | (payload[5]<<8) | (payload[6]<<16) | (payload[7]<<24)) >>> 0;
        const needed = 12 + pathLen + pathLen + 1;
        if (payload.length < needed) return;
        // SNRs: path_len+1 values (signed byte / 4)
        const snrs = [];
        for (let i = 0; i <= pathLen; i++) {
            const b = payload[12 + pathLen + i];
            snrs.push((b > 127 ? b - 256 : b) / 4);
        }
        // Last path hash = last repeater before destination
        const lastHash = pathLen > 0 ? payload[12 + pathLen - 1] : null;
        const repeaterCol = lastHash != null
            ? lastHash.toString(16).padStart(2, '0').toUpperCase()
            : 'direct';
        const lastSnr = snrs[snrs.length - 1];
        const hash = 'TR:' + tag.toString(16).toUpperCase().padStart(8, '0');
        const meta = { pathLen, tag, snrs };
        this._ingestPacket(hash, repeaterCol, 'Trace', null, lastSnr, null, meta, null, this._myLocation());
    }

    _bufferToHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    _processPacket(packet, rawHex, snr, rssi) {
        const payloadRaw = packet.payload?.raw;
        const hash = payloadRaw ? this._hashPayload(payloadRaw) : packet.messageHash;
        const repeater = this._extractRepeater(packet);
        const type = [
            Utils.getRouteTypeName(packet.routeType),
            Utils.getPayloadTypeName(packet.payloadType),
        ].filter(Boolean).join(' ');

        const path = packet.path || [];
        const pathLen = path.length;
        const firstItem = pathLen > 0 ? path[0] : null;
        const firstItemBytes = firstItem != null ? firstItem.length / 2 : 0;
        const pathItemBytes = packet.pathHashSize ?? firstItemBytes;

        const p = packet.payload?.decoded;
        const meta = { pathLen, pathItemBytes, totalBytes: packet.totalBytes };
        if (p) {
            // GroupTextPayload: decrypted only present when channel key is available
            const dec = p.decrypted;
            if (dec?.message != null) meta.text   = String(dec.message);
            if (dec?.sender  != null) meta.sender = String(dec.sender);
            // AdvertPayload: name lives inside appData
            if (p.appData?.name != null) meta.name = String(p.appData.name);
            // public key (advert)
            const lk = p.publicKey ?? p.pubKey ?? p.linkKey ?? p.key ?? null;
            if (lk != null) meta.linkKey = String(lk);
        }

        this._ingestContactFromPacket(packet);

        if (hash && repeater) {
            this._ingestPacket(hash, repeater, type, rawHex, snr, rssi, meta, packet, this._myLocation());
        }
    }

    _ingestContactFromPacket(packet) {
        const p = packet?.payload?.decoded;
        if (packet?.payloadType !== 4 || !p?.isValid || !p?.publicKey) return;
        const pubKeyFullHex = String(p.publicKey).toLowerCase();
        const advName = p.appData?.name ?? null;
        const advType = p.appData?.deviceRole ?? null;
        const lat = p.appData?.hasLocation ? (p.appData.location?.latitude ?? 0) : 0;
        const lon = p.appData?.hasLocation ? (p.appData.location?.longitude ?? 0) : 0;
        const lastAdvert = p.timestamp ? Math.floor(new Date(p.timestamp).getTime() / 1000) : 0;
        const existing = this._contacts.get(pubKeyFullHex);
        this._contacts.set(pubKeyFullHex, {
            name: advName || existing?.name || null,
            type: advType ?? existing?.type ?? null,
            lat: lat || existing?.lat || 0,
            lon: lon || existing?.lon || 0,
            lastAdvert: lastAdvert || existing?.lastAdvert || 0,
            lastmod: existing?.lastmod || 0,
            pubKeyFullHex,
        });
        if (!existing) this._updateContactsCount();
        this._scheduleContactsPersist();
    }

    _escHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    _hashPayload(str) {
        // Two independent FNV-1a passes → 16 hex chars
        let h1 = 0x811c9dc5, h2 = 0xdeadbeef;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 ^= c; h1 = Math.imul(h1, 0x01000193);
            h2 ^= c; h2 = Math.imul(h2, 0x01000193) ^ (h2 >>> 5);
        }
        return [h1, h2].map(h => (h >>> 0).toString(16).padStart(8, '0')).join('').toUpperCase();
    }

    _extractRepeater(packet) {
        // Trace packets (payloadType 9) are the one case where the header `path`
        // field does NOT hold node IDs: it holds one per-hop SNR byte
        // (signed / 4 = dB). The real traversed node hashes live in
        // payload.decoded.pathHashes, so for traces that is the only correct
        // source of the last repeater (empty = a 0-hop/direct trace).
        if (packet.payloadType === 9) {
            const hops = packet.payload?.decoded?.pathHashes;
            return Array.isArray(hops) && hops.length > 0
                ? (hops[hops.length - 1] || 'unknown')
                : 'direct';
        }
        // Every other type: the header path accumulates forwarder hashes as the
        // packet floods, so its last element is the last repeater. NOTE: Path
        // payloads (type 8) also expose payload.decoded.pathHashes, but it is
        // meaningless — the real PATH body is "dest/src hashes, MAC, encrypted
        // (path, extra)", and the decoder misreads that ciphertext as a
        // plaintext path (often erroring on a reserved hash-size bit pattern).
        // The header path is plaintext and stays valid regardless, so use it.
        if (packet.path && packet.path.length > 0) {
            return packet.path[packet.path.length - 1] || 'unknown';
        }
        // Empty path is only meaningful when the route accumulates hops.
        // Flood-routed packets append the forwarder ID at every hop, so an
        // empty path proves the packet was heard at first hop = direct RF.
        // Other routing modes (unicast Direct, etc.) leave path empty by
        // design and tell us nothing about coverage — drop them.
        const routeName = Utils.getRouteTypeName(packet.routeType) || '';
        return /Flood/i.test(routeName) ? 'direct' : null;
    }

    // --- Node ID prefix resolution ---
    // Path IDs can be 1/2/3-byte truncations of full 4-byte node IDs.
    // The first ID seen wins as the column key; all compatible refinements
    // (longer or shorter prefixes that share its bytes) merge into it.

    idPrecision(id) {
        if (id === 'direct' || id === 'unknown' || id.includes('/')) return 4;
        return Math.ceil(id.length / 2);
    }

    idSuffix(id, bytes) {
        // IDs are high-byte-first: '5E' is the high byte of '5E9F', so compare from left
        return id.slice(0, bytes * 2).toUpperCase();
    }

    findOrCreateColumn(rawId) {
        if (rawId === 'direct') {
            if (!this.repeaterColumns.includes('direct')) this.repeaterColumns.push('direct');
            return 'direct';
        }
        if (this.repeaterColumns.includes(rawId)) return rawId;

        const rawPrec = this.idPrecision(rawId);

        const colMinPrec = (col) => {
            if (col === 'direct') return 4;
            // For collision keys, use the stored minPrecision (reflects the
            // shortest rawId ever seen for this column, e.g. a 1-byte prefix
            // that triggered the initial split).  Fall back to the precision
            // of the first component only when no stats exist yet.
            const fallback = this.idPrecision(col.split('/')[0]);
            return this.allRepeaters.get(col)?.minPrecision ?? fallback;
        };
        const colSuffix = (col, p) => this.idSuffix(col.split('/')[0], p);

        // Match at min(rawPrec, colMinPrec) — promoted columns still catch
        // siblings that share their original shorter prefix.
        const matches = this.repeaterColumns.filter(col => {
            if (col === 'direct') return false;
            const cmp = colMinPrec(col);
            const minP = Math.min(rawPrec, cmp);
            return colSuffix(col, minP) === this.idSuffix(rawId, minP);
        });

        if (matches.length === 0) {
            this.repeaterColumns.push(rawId);
            return rawId;
        }

        // Partition specific cols from collision keys. Treated very differently:
        //  - specific: subject to promote / split
        //  - collision: their components may need to be refined when a
        //    more-precise sibling arrives
        const specificMatches  = matches.filter(m => !m.includes('/'));
        const collisionMatches = matches.filter(m =>  m.includes('/'));

        // Multiple distinct specific siblings → this rawId is ambiguous over
        // all of them. Use (or create) the canonical collision key. If a
        // subset collision is already there, fold it into the bigger one.
        if (specificMatches.length >= 2) {
            const collisionKey = specificMatches.sort().join('/');
            if (!this.repeaterColumns.includes(collisionKey)) {
                const subsets = collisionMatches.filter(ck =>
                    ck.split('/').every(comp => specificMatches.includes(comp))
                );
                for (const sub of subsets) this.renameColumnKey(sub, collisionKey);
                if (!this.repeaterColumns.includes(collisionKey)) this.repeaterColumns.push(collisionKey);
            }
            return collisionKey;
        }

        // Exactly one specific match — the usual promote / split path,
        // plus refining components inside any matched collision keys.
        if (specificMatches.length === 1) {
            const existing = specificMatches[0];
            const existingPrec = this.idPrecision(existing);
            const commonPrec   = Math.min(rawPrec, existingPrec);
            const compatibleAtCommon =
                this.idSuffix(rawId, commonPrec) === this.idSuffix(existing, commonPrec);

            if (compatibleAtCommon) {
                // Optimistically promote — the column adopts the more-precise
                // label. Per-packet rawId is preserved so a later collision
                // can un-merge.
                if (rawPrec > existingPrec) {
                    this.renameColumnKey(existing, rawId);
                    // Mirror the promote into every collision key that has
                    // `existing` as a component. We scan all columns rather
                    // than relying on collisionMatches, because colSuffix only
                    // checks the first component — collision keys where
                    // `existing` is the second (or later) component would be
                    // missed and left with a stale label.
                    for (const ck of [...this.repeaterColumns]) {
                        if (!ck.includes('/')) continue;
                        const comps = ck.split('/');
                        if (!comps.includes(existing)) continue;
                        const newKey = comps.map(c => c === existing ? rawId : c).sort().join('/');
                        if (newKey !== ck) this.renameColumnKey(ck, newKey);
                    }
                    return rawId;
                }
                return existing;
            }

            // Match at minPrec but conflict at the column's full precision —
            // the column was optimistically promoted and we now have a real
            // sibling. Split: ambiguous (shorter-rawId) packets move to the
            // collision key; specific packets stay in `existing`. The new
            // rawId becomes its own specific column.
            const collisionKey = [existing, rawId].sort().join('/');
            this._splitColumn(existing, collisionKey);
            if (!this.repeaterColumns.includes(rawId)) this.repeaterColumns.push(rawId);
            return rawId;
        }

        // No specific match, only collision key(s).  Three sub-cases:
        //
        //  (a) rawId refines a component (rawPrec > component precision,
        //      same prefix at that precision) → swap the component label.
        //
        //  (b) rawId is a new sibling at the same precision as the existing
        //      components (compatible at the collision's stored minPrecision
        //      but distinct at full precision) → add rawId as a new specific
        //      column and expand the collision key to include it.
        //
        //  (c) rawId is a short ambiguous ID (rawPrec < min component
        //      precision) → belongs in the existing collision key as-is.
        let dest = collisionMatches[0];
        let isNewSibling = false;
        for (const ck of collisionMatches) {
            const comps = ck.split('/');
            const minCompPrec = Math.min(...comps.map(c => this.idPrecision(c)));

            const refined = comps.find(comp => {
                const cPrec = this.idPrecision(comp);
                return rawPrec > cPrec && this.idSuffix(rawId, cPrec) === this.idSuffix(comp, cPrec);
            });

            if (refined) {
                // (a) Refinement: update that component in the collision key.
                const newKey = comps.map(c => c === refined ? rawId : c).sort().join('/');
                if (newKey !== ck) {
                    this.renameColumnKey(ck, newKey);
                    if (ck === dest) dest = newKey;
                }
            } else if (rawPrec >= minCompPrec) {
                // (b) New sibling: add it as a specific column and widen the
                // collision key so ambiguous short-ID packets are attributed
                // to all three (or more) possible repeaters.
                if (!this.repeaterColumns.includes(rawId)) this.repeaterColumns.push(rawId);
                const newKey = [...comps, rawId].sort().join('/');
                if (newKey !== ck) {
                    this.renameColumnKey(ck, newKey);
                    if (ck === dest) dest = newKey;
                }
                isNewSibling = true;
            }
            // (c) rawPrec < minCompPrec: short ambiguous ID — dest unchanged.
        }
        // For new siblings the specific rawId column is the canonical
        // destination for this packet; ambiguous packets stay in the
        // collision key.
        return isNewSibling ? rawId : dest;
    }

    // Un-merge: move entries that came in at a shorter precision (= ambiguous
    // at the column's current label) into the collision key, leaving the
    // specifically-matched entries in place.
    _splitColumn(existingCol, collisionKey) {
        const existingPrec = this.idPrecision(existingCol);

        if (!this.repeaterColumns.includes(collisionKey)) {
            this.repeaterColumns.push(collisionKey);
        }

        // hashData: per (hash, repeater) entry
        for (const [, data] of this.hashData) {
            const entry = data.repeaters.get(existingCol);
            if (!entry) continue;
            const ePrec = entry.rawId ? this.idPrecision(entry.rawId) : existingPrec;
            if (ePrec < existingPrec) {
                data.repeaters.delete(existingCol);
                // If the collision already has an entry for this hash, keep
                // the newer one (Map.set overwrites — fine for our purposes).
                data.repeaters.set(collisionKey, entry);
            }
        }

        // chartPoints: per packet
        for (const p of this.chartPoints) {
            if (p.col !== existingCol) continue;
            const ePrec = p.rawId ? this.idPrecision(p.rawId) : existingPrec;
            if (ePrec < existingPrec) p.col = collisionKey;
        }

        // 3D map
        this.signalMap?.splitPoints?.(existingCol, (rawId) => {
            const ePrec = rawId ? this.idPrecision(rawId) : existingPrec;
            return ePrec < existingPrec ? collisionKey : null;
        });

        // Open detail rows in the message table — flip those that should follow
        this.msgTableBody?.querySelectorAll('tr.detail-row').forEach(tr => {
            if (tr.dataset.col !== existingCol) return;
            // Detail row doesn't know its rawId — safest is to drop the detail
            tr.dataset.col = '';
        });

        // Recompute aggregate stats for both columns
        this._recomputeRepeaterStats(existingCol);
        this._recomputeRepeaterStats(collisionKey);
    }

    _recomputeRepeaterStats(col) {
        let count = 0, lastSeen = -1, maxSnr = null, maxRssi = null;
        let lastSnr = null, lastRssi = null, minPrec = Infinity;
        for (const p of this.chartPoints) {
            if (p.col !== col) continue;
            count++;
            if (p.time > lastSeen) {
                lastSeen = p.time;
                lastSnr  = p.snr;
                lastRssi = p.rssi;
            }
            if (p.snr  != null && (maxSnr  == null || p.snr  > maxSnr))  maxSnr  = p.snr;
            if (p.rssi != null && (maxRssi == null || p.rssi > maxRssi)) maxRssi = p.rssi;
            if (p.rawId) {
                const r = this.idPrecision(p.rawId);
                if (r < minPrec) minPrec = r;
            }
        }
        if (count === 0) {
            this.allRepeaters.delete(col);
            const idx = this.repeaterColumns.indexOf(col);
            if (idx >= 0) this.repeaterColumns.splice(idx, 1);
            return;
        }
        if (!Number.isFinite(minPrec)) minPrec = this.idPrecision(col.split('/')[0]);
        this.allRepeaters.set(col, {
            lastSeen, count, maxSnr, maxRssi, lastSnr, lastRssi,
            minPrecision: minPrec,
        });
    }

    renameColumnKey(oldKey, newKey) {
        if (oldKey === newKey) return;
        const oldIdx = this.repeaterColumns.indexOf(oldKey);
        if (oldIdx < 0) return;
        const newIdx = this.repeaterColumns.indexOf(newKey);
        if (newIdx >= 0) this.repeaterColumns.splice(oldIdx, 1);
        else             this.repeaterColumns[oldIdx] = newKey;

        const oldData = this.allRepeaters.get(oldKey);
        if (oldData) {
            const newData = this.allRepeaters.get(newKey);
            if (newData) {
                const newer = oldData.lastSeen >= newData.lastSeen ? oldData : newData;
                const mergeMax = (a, b) => a == null ? b : b == null ? a : Math.max(a, b);
                this.allRepeaters.set(newKey, {
                    lastSeen:     Math.max(oldData.lastSeen, newData.lastSeen),
                    count:        oldData.count + newData.count,
                    maxSnr:       mergeMax(oldData.maxSnr,  newData.maxSnr),
                    maxRssi:      mergeMax(oldData.maxRssi, newData.maxRssi),
                    lastSnr:      newer.lastSnr,
                    lastRssi:     newer.lastRssi,
                    minPrecision: Math.min(
                        oldData.minPrecision ?? this.idPrecision(oldKey.split('/')[0]),
                        newData.minPrecision ?? this.idPrecision(newKey.split('/')[0]),
                    ),
                });
            } else {
                this.allRepeaters.set(newKey, oldData);
            }
            this.allRepeaters.delete(oldKey);
        }

        for (const data of this.hashData.values()) {
            if (data.repeaters.has(oldKey)) {
                data.repeaters.set(newKey, data.repeaters.get(oldKey));
                data.repeaters.delete(oldKey);
            }
        }

        this.chartColors.delete(oldKey);
        for (const p of this.chartPoints) {
            if (p.col === oldKey) p.col = newKey;
        }
        if (this._selectedCol === oldKey) this._selectedCol = newKey;

        this.msgTableBody?.querySelectorAll('tr.detail-row').forEach(tr => {
            if (tr.dataset.col === oldKey) tr.dataset.col = newKey;
        });

        this.signalMap?.renameCol?.(oldKey, newKey);
    }

    displayId(id) {
        if (id === 'direct' || id === 'unknown') return id;
        if (id.includes('/')) return id.split('/').map(p => this.displayId(p)).join('/');
        const num = parseInt(id, 16);
        if (isNaN(num)) return id;
        if (num === 0) return '00';
        let h = num.toString(16).toUpperCase();
        if (h.length % 2 !== 0) h = '0' + h;
        return h;
    }

    // --- Data ingestion ---

    _isAtPageBottom() {
        const margin = 80;
        if (document.body.scrollHeight <= window.innerHeight + margin) return false;
        return window.scrollY + window.innerHeight >= document.body.scrollHeight - margin;
    }

    // The user's current GPS fix as { lat, lon } (null fields when unknown), to
    // stamp onto a freshly received live packet. The geolocation watch lives in
    // the 3D map; this is the single point that reads it, so callers (and
    // _ingestPacket) stay decoupled from where the fix comes from.
    _myLocation() {
        const l = this.signalMap?.currentLocation();
        return { lat: l?.lat ?? null, lon: l?.lon ?? null };
    }

    // Fold one observation into the per-repeater running stats (RX count, max/last
    // SNR & RSSI, last-seen, and the finest id precision seen for this column).
    _recordRepeaterStat(canonicalKey, repeater, now, snr, rssi) {
        const rawPrec  = this.idPrecision(repeater);
        const existing = this.allRepeaters.get(canonicalKey);
        this.allRepeaters.set(canonicalKey, {
            lastSeen:     now,
            count:        (existing?.count ?? 0) + 1,
            maxSnr:  snr  != null ? Math.max(existing?.maxSnr  ?? -Infinity, snr)  : (existing?.maxSnr  ?? null),
            maxRssi: rssi != null ? Math.max(existing?.maxRssi ?? -Infinity, rssi) : (existing?.maxRssi ?? null),
            lastSnr:  snr  != null ? snr  : (existing?.lastSnr  ?? null),
            lastRssi: rssi != null ? rssi : (existing?.lastRssi ?? null),
            minPrecision: Math.min(existing?.minPrecision ?? rawPrec, rawPrec),
        });
    }

    _ingestPacket(hash, repeater, type, rawHex, snr, rssi, meta = {}, packet = null, opts = {}) {
        if (!this._collecting && !opts.importing && !opts.forceIngest) return;
        const wasAtBottom = !opts.importing && this._isAtPageBottom();
        this.totalRxCount++;
        if (!opts.importing) this._unsavedRxCount++;
        const now = opts.timestamp ?? Date.now();
        if (!opts.importing) this._rxTimestamps.push(now);
        const isNewHash = !this.hashData.has(hash);
        const prevColCount = this.repeaterColumns.length;
        const canonicalKey = this.findOrCreateColumn(repeater);

        // Position is supplied by the caller, never fetched here: live handlers
        // stamp the current GPS fix (_myLocation), replay/import carry the stored
        // one. A packet with no position (e.g. captured before location was on)
        // arrives as null and STAYS null — it can never silently acquire the
        // current location, so it's correctly omitted from the 3D map.
        const loc = opts.lat != null ? { lat: opts.lat, lon: opts.lon } : null;
        const repEntry = { snr, rssi, packet, rawHex, rawId: repeater, time: now };
        if (loc) { repEntry.lat = loc.lat; repEntry.lon = loc.lon; }
        if (opts.remoteSnr != null) repEntry.remoteSnr = opts.remoteSnr;

        if (isNewHash) {
            this.hashData.set(hash, {
                repeaters: new Map([[canonicalKey, repEntry]]),
                firstSeen: now,
                lastSeen: now,
                insertOrder: ++this.hashCounter,
                type,
                rawHex,
                meta,
                packet,
            });
        } else {
            const data = this.hashData.get(hash);
            // When importing, skip (hash, repeater) pairs that already exist — existing data wins
            if (opts.importing && data.repeaters.has(canonicalKey)) return;
            data.lastSeen = now;
            // Keep the strongest-RSSI observation per (packet, repeater), matching
            // the disk grid/page representative so the table cell reads the same
            // value in every Display window.
            const prevRep = data.repeaters.get(canonicalKey);
            if (!prevRep || (rssi != null && (prevRep.rssi == null || rssi > prevRep.rssi))) {
                data.repeaters.set(canonicalKey, repEntry);
            }
        }

        this._recordRepeaterStat(canonicalKey, repeater, now, snr, rssi);
        if (snr != null || rssi != null) {
            this.chartPoints.push({ time: now, rssi, snr, col: canonicalKey, rawId: repeater });
            // Fold it into the chart bucket cache so the charts show it without a
            // disk re-query. Replay/import skip this — they end with a full disk
            // rebuild of the layers anyway.
            if (!opts.replaying && !opts.importing && this._storeReady) {
                this._upsertChartCell(now, snr, rssi, repeater);
            }
        }
        if (loc) {
            this.signalMap?.addPacket({ lat: loc.lat, lon: loc.lon, rssi, snr, col: canonicalKey, time: now, rawId: repeater });
            // Fold it into the RAM map-cell cache so the wide view shows it
            // immediately, no disk rescan. Replay/import skip this — they end
            // with a full disk rebuild of the layers anyway.
            if (!opts.replaying && !opts.importing && this._storeReady) {
                this._upsertMapCell({ lat: loc.lat, lon: loc.lon, snr, rssi, time: now, rawId: repeater });
            }
        }

        // Persist this observation (rawHex is per-path, so it lives per-obs).
        // Skipped only while replaying from disk to avoid writing it back.
        if (!opts.replaying) this._ingestToStore({ now, hash, repeater, rawHex, snr, rssi, meta, type, loc, remoteSnr: opts.remoteSnr }, isNewHash);

        if (opts.importing) return;

        // Heavy DOM work (both tables + stats) is coalesced so a busy mesh
        // doesn't rebuild them on every packet and starve the 3D-map frame loop.
        // The cells to flash and a pending "scroll to bottom" are remembered and
        // applied by the coalesced pass.
        (this._flashPending ??= new Set()).add(hash + '|' + canonicalKey);
        this._scheduleLiveRender(wasAtBottom);
        this._scheduleChartRender();
        const matchesRepFilter = !this._repFilterTerms.length || this._colMatchesRepFilter(canonicalKey);

        // Keep the table pager's page count current without a disk count() —
        // replay/import end with an authoritative _loadTablePage instead.
        if (!opts.replaying && this._storeReady) {
            if (isNewHash) this._tableHashCount++;
            // Fold the packet into the narrow index too — note an OLD hash can
            // newly join it when the narrowed repeater hears it for the first
            // time. Guard on the index being current for the active narrowing.
            const narrowFn = this._tableNarrowFn();
            if (this._tableNarrowHashes && narrowFn
                && this._tableNarrowIndexKey === this._tableNarrowKey()
                && narrowFn(canonicalKey) && !this._tableNarrowSet.has(hash)) {
                this._tableNarrowHashes.unshift(hash);
                this._tableNarrowSet.add(hash);
            }
            const total = this._tableNarrowHashes ? this._tableNarrowHashes.length : this._tableHashCount;
            this._tablePageCount = Math.max(1, Math.ceil(total / this._tablePageSize));
        }

        // Sound stays immediate (cheap, and its timing matters).
        const data = this.hashData.get(hash);
        const filterText = this._msgFilter.toLowerCase().trim();
        const matchesMsgFilter = !filterText || this._rowMatchesFilter(data, filterText);
        if (matchesMsgFilter && matchesRepFilter) this._playRxSound(snr);
        this.emptyState?.classList.add('hidden');
    }

    // Coalesce the per-packet table/stats render to ~7×/s. Rebuilding both
    // tables on every packet (a busy mesh is many per second) saturates the main
    // thread and makes the 3D map stutter while panning during capture.
    _scheduleLiveRender(wasAtBottom = false) {
        if (wasAtBottom) this._pendingScrollBottom = true;
        if (this._liveRenderTimer) return;
        const since = performance.now() - (this._lastLiveRender || 0);
        this._liveRenderTimer = setTimeout(() => {
            this._liveRenderTimer = null;
            this._lastLiveRender = performance.now();
            this._sortColumns();
            this._renderRepTable();
            this._renderMsgTable();
            this._refreshTablePager();   // page count is maintained in RAM at ingest
            this._updateStats();
            // Flash the cells that received new values since the last render.
            if (this._flashPending && this._flashPending.size) {
                for (const key of this._flashPending) {
                    const sep = key.lastIndexOf('|');
                    const h = key.slice(0, sep), c = key.slice(sep + 1);
                    this.msgTableBody?.querySelectorAll(`[data-hash="${h}"][data-col="${c}"]`).forEach(el => {
                        el.classList.remove('cell-flash');
                        void el.offsetWidth;   // restart the animation
                        el.classList.add('cell-flash');
                    });
                }
                this._flashPending.clear();
            }
            this._checkTableOverflow(false);
            if (this._pendingScrollBottom) {
                this._pendingScrollBottom = false;
                requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
            }
        }, Math.max(0, 150 - since));
    }

    // --- Column management ---

    _sortColumns() {
        const FIVE_MIN = 5 * 60 * 1000;
        const cutoff = Date.now() - FIVE_MIN;
        const recentCount = new Map();
        for (const p of this.chartPoints) {
            if (p.time >= cutoff) recentCount.set(p.col, (recentCount.get(p.col) ?? 0) + 1);
        }
        this.repeaterColumns.sort((a, b) => {
            const ra = recentCount.get(a) ?? 0;
            const rb = recentCount.get(b) ?? 0;
            if (rb !== ra) return rb - ra;
            const da = this.allRepeaters.get(a);
            const db = this.allRepeaters.get(b);
            const lrA = da?.lastRssi ?? -Infinity;
            const lrB = db?.lastRssi ?? -Infinity;
            if (lrB !== lrA) return lrB - lrA;
            const lsA = da?.lastSnr ?? -Infinity;
            const lsB = db?.lastSnr ?? -Infinity;
            if (lsB !== lsA) return lsB - lsA;
            const cA = da?.count ?? 0;
            const cB = db?.count ?? 0;
            if (cB !== cA) return cB - cA;
            return a.localeCompare(b);
        });
    }

    _abbreviateType(type) {
        if (!type) return '?';
        // Show only payload type (2 chars); route type is visible from repeater columns
        const payload = [
            [/GroupText|GROUP_TEXT/,     'GT'],
            [/TextMessage|TEXT_MESSAGE/, 'TX'],
            [/Traceroute|TRACEROUTE/,    'TR'],
            [/AnonRequest|ANON_REQUEST/, 'AQ'],
            [/Response|RESPONSE/,        'RS'],
            [/Request|REQUEST/,          'RQ'],
            [/Private|PRIVATE/,          'PV'],
            [/Control|CONTROL/,          'CT'],
            [/Advert|ADVERT/,            'AD'],
            [/Path|PATH/,                'PT'],
            [/Ping|PING/,                'PN'],
        ];
        for (const [re, abbr] of payload) {
            if (re.test(type)) return abbr;
        }
        // Fall back to route type
        if (/Transport|TRANSPORT/.test(type)) return 'TP';
        if (/Flood|FLOOD/.test(type))         return 'FL';
        if (/Direct|DIRECT/.test(type))       return 'DR';
        if (/Broadcast|BROADCAST/.test(type)) return 'BC';
        if (/DSC/.test(type))                  return 'RD';
        if (/Repeater|REPEATER/.test(type))   return 'RP';
        return type.slice(0, 2).toUpperCase();
    }

    _checkTableOverflow(allowUpgrade) {
        const scroll = this.msgTableHead?.closest('.msg-table-scroll');
        if (!scroll) return;
        const table = scroll.querySelector('.msg-table');
        if (!table) return;
        const overflows = table.scrollWidth > scroll.clientWidth + 2;
        if (overflows && !this._useAbbreviatedTypes) {
            this._useAbbreviatedTypes = true;
            this._renderMsgTable();
        } else if (!overflows && allowUpgrade && this._useAbbreviatedTypes) {
            this._useAbbreviatedTypes = false;
            this._renderMsgTable();
        }
    }

    // --- Table rendering ---

    _renderMsgTable(flashHash = null) {
        if (!this.msgTableHead || !this.msgTableBody) return;

        const openDetails = new Map(
            [...this.msgTableBody.querySelectorAll('tr[id^="detail-"]:not(.detail-closing)')]
                .map(tr => [tr.id.slice(7), tr.dataset.col ?? null])
        );

        // Show filter bar only when there are visible rows
        const msgFilterBar = document.getElementById('msgFilterBar');

        const filter = this._msgFilter.toLowerCase().trim();
        // Rows = the current disk page snapshot (see _loadTablePage) plus, on
        // page 0, a live tail of packets newer than the cache so new rows show
        // instantly. Pre-ready (store still opening) the page is empty and the
        // cutoff-filtered tail alone is the full live RAM window — one path.
        const cutoff = this._displayCutoffNow();
        const narrowFn = this._tableNarrowFn();
        const m = new Map(this._tablePageData);
        if (this._tablePage === 0) {
            for (const [h, d] of this.hashData) {
                if (d.lastSeen <= this._renderCacheAt) continue;
                // When narrowed the snapshot holds only matching hashes — keep the
                // tail consistent so hidden rows don't eat the page cap.
                if (narrowFn && ![...d.repeaters.keys()].some(narrowFn)) continue;
                m.set(h, d);
            }
        }
        // The Display-window cutoff applies to the snapshot too, not just the
        // tail — the snapshot is loaded once and ages while it is on screen.
        let allRows = [...m.entries()]
            .filter(([, data]) => !data._stub && (!cutoff || data.firstSeen >= cutoff))
            .sort(([, a], [, b]) => b.firstSeen - a.firstSeen);
        // Page 0 is maintained in RAM during capture (the disk snapshot is never
        // periodically reloaded), so the live tail can outgrow the page — cap the
        // rendered rows at the page size; older rows are reachable via the pager.
        // Pre-ready (store still opening) there is no pager yet, so don't cap.
        if (this._tablePage === 0 && this._storeReady && allRows.length > this._tablePageSize) {
            allRows = allRows.slice(0, this._tablePageSize);
        }

        // Show every repeater that has data within the display window (the same
        // predicate the Seen Repeaters table uses) as a column — not only those
        // with a packet on the *current page* — so columns don't appear and
        // disappear as you page through. The disk snapshot can also surface a
        // historical column not in the live model, so keep any column present in
        // this page's rows too. Empty columns sort to the end (column order
        // follows repeaterColumns, by RX count).
        const activeColsInRows = new Set(allRows.flatMap(([, data]) => [...data.repeaters.keys()]));
        const colList = [...new Set([...this.repeaterColumns, ...activeColsInRows])];
        const inWindow = c => !cutoff || (this.allRepeaters.get(c)?.lastSeen ?? -Infinity) >= cutoff;
        const visibleCols = colList
            .filter(c => this._colMatchesRepFilter(c) && (inWindow(c) || activeColsInRows.has(c)));
        this._visibleCols = visibleCols;   // columns actually rendered (used by the
                                           // detail colspan and the filter notice)

        const msgTableEmpty = document.getElementById('msgTableEmpty');
        const msgTableScroll = this.msgTableHead?.closest('.msg-table-scroll');

        if (allRows.length === 0) {
            if (msgFilterBar) msgFilterBar.classList.add('hidden');
            if (msgTableScroll) msgTableScroll.style.display = 'none';
            if (msgTableEmpty) {
                msgTableEmpty.textContent = cutoff
                    ? 'No packets in the current display window.'
                    : 'Waiting for data…';
                msgTableEmpty.classList.remove('hidden');
            }
            this.msgTableHead.innerHTML = '';
            this.msgTableBody.innerHTML = '';
            this._lastColKey = null;
            return;
        }

        if (msgFilterBar) msgFilterBar.classList.remove('hidden');

        if (msgTableScroll) msgTableScroll.style.display = '';
        if (msgTableEmpty) msgTableEmpty.classList.add('hidden');
        let rows = filter
            ? allRows.filter(([, data]) => this._rowMatchesFilter(data, filter))
            : allRows;
        // When narrowed (filter or selection), drop rows with no data from a
        // matching repeater — matches the paged hash index, so a full page of
        // rows survives instead of mostly-hidden ones.
        if (narrowFn) {
            rows = rows.filter(([, data]) => [...data.repeaters.keys()].some(narrowFn));
        }

        this._renderMsgTableHeader(visibleCols);

        // Filter count badge
        if (this.msgFilterCountEl) {
            const show = filter && allRows.length > 0;
            this.msgFilterCountEl.textContent = show ? `${rows.length} / ${allRows.length}` : '';
            this.msgFilterCountEl.classList.toggle('hidden', !show);
        }

        this.msgTableBody.innerHTML = rows.map(([hash, data]) =>
            this._buildMsgRow(hash, data, visibleCols)
        ).join('');

        this._reinsertOpenDetailRows(openDetails);

        this._applyMsgTableSelection();

        if (flashHash) {
            const row = document.getElementById(`row-${flashHash}`);
            if (row) row.classList.add('row-new');
        }
    }

    // Rebuild the packet-table header (repeater columns + SNR/RSSI sub-row) only
    // when the visible column set changes, keyed on _lastColKey.
    _renderMsgTableHeader(visibleCols) {
        const colKey = visibleCols.join(',');
        if (colKey === this._lastColKey) return;
        this._lastColKey = colKey;
        const repHeaders = visibleCols.map(r => {
            const cName = this._contactNameForCol(r);
            const nameTag = cName ? `<br><span class="col-contact-name">${this._escHtml(cName)}</span>` : '';
            return `<th colspan="2" class="msg-col-rep" data-col="${this._escHtml(r)}"><span class="rl-dot" style="${this._repDotStyle(r)}"></span>${this.displayId(r)}${nameTag}</th>`;
        }).join('');
        const subHeaders = visibleCols.map(() =>
            `<th class="msg-sub-snr">SNR</th><th class="msg-sub-rssi">RSSI</th>`
        ).join('');
        // Indentation inside this template literal is intentionally preserved
        // byte-for-byte from the original inline version (it becomes innerHTML).
        this.msgTableHead.innerHTML = `
                <tr>
                    <th class="msg-col-rx-head" rowspan="2">RX log<span class="help-icon" data-help="msg-type">?</span></th>
                    ${repHeaders}
                </tr>
                <tr>${subHeaders}</tr>
            `;
    }

    // Re-attach detail rows that were open before a table rebuild. `openDetails`
    // maps hash → column (or null), captured before msgTableBody was replaced.
    _reinsertOpenDetailRows(openDetails) {
        for (const [hash, col] of openDetails) {
            if (!this._tableSource().has(hash) && !this.hashData.has(hash)) continue;
            // Drop detail for a column that is now filtered out
            if (col && !this._colMatchesRepFilter(col)) continue;
            const row = document.getElementById(`row-${hash}`);
            if (!row) continue;
            const detail = document.createElement('tr');
            detail.id = `detail-${hash}`;
            detail.className = 'detail-row';
            if (col) detail.dataset.col = col;
            detail.innerHTML = this._buildDetailRow(hash, col);
            // Suppress the open animation — this is a re-insert, not a user-triggered open
            const detailCell = detail.querySelector('.detail-cell');
            if (detailCell) detailCell.style.animation = 'none';
            row.after(detail);
            if (col) {
                this.msgTableBody.querySelectorAll(`[data-hash="${hash}"][data-col="${col}"]`)
                    .forEach(el => el.classList.add('sig-active'));
            }
        }
    }

    _buildMsgRow(hash, data, cols = this.repeaterColumns) {
        const cells = cols.map(r => {
            const sig = data.repeaters.get(r);
            return sig ? this._buildSigCells(sig.rssi, sig.snr, hash, r) : '<td></td><td></td>';
        }).join('');
        const typeDisplay = this._useAbbreviatedTypes
            ? this._escHtml(this._abbreviateType(data.type))
            : this._escHtml(data.type || '?');
        return `<tr id="row-${hash}">
            <td class="msg-col-rx">
                <span class="rx-time">${this._formatTime(data.firstSeen)}</span><span class="rx-type" title="${this._escHtml(data.type || '?')}">${typeDisplay}</span>
            </td>
            ${cells}
        </tr>`;
    }

    _closeDetailRow(tr) {
        tr.classList.add('detail-closing');
        const cell = tr.querySelector('.detail-cell');
        if (cell) {
            const onEnd = () => tr.remove();
            cell.addEventListener('animationend', onEnd, { once: true });
            setTimeout(() => { cell.removeEventListener('animationend', onEnd); tr.remove(); }, 300);
        } else {
            tr.remove();
        }
    }

    toggleDetailRow(hash, col = null) {
        const existing = document.getElementById(`detail-${hash}`);
        this.msgTableBody?.querySelectorAll('.sig-active').forEach(el => el.classList.remove('sig-active'));
        // Same cell clicked again → close with animation
        if (existing && existing.dataset.col === (col ?? '')) { this._closeDetailRow(existing); return; }
        const row = document.getElementById(`row-${hash}`);
        if (!row) return;
        const detail = existing ?? document.createElement('tr');
        if (!existing) {
            detail.id = `detail-${hash}`;
            detail.className = 'detail-row';
            row.after(detail);
        }
        detail.dataset.col = col ?? '';
        detail.innerHTML = this._buildDetailRow(hash, col);
        if (col) {
            this.msgTableBody?.querySelectorAll(`[data-hash="${hash}"][data-col="${col}"]`)
                .forEach(el => el.classList.add('sig-active'));
        }
    }

    _syntaxHighlightJson(json) {
        let out = '';
        let i = 0;
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        while (i < json.length) {
            if (json[i] === '"') {
                let j = i + 1;
                while (j < json.length) {
                    if (json[j] === '\\') { j += 2; continue; }
                    if (json[j] === '"') { j++; break; }
                    j++;
                }
                const str = json.slice(i, j);
                let k = j;
                while (k < json.length && json[k] === ' ') k++;
                const cls = json[k] === ':' ? 'jh-key' : 'jh-str';
                out += `<span class="${cls}">${esc(str)}</span>`;
                i = j;
            } else if (json[i] === '-' || (json[i] >= '0' && json[i] <= '9')) {
                let j = i + 1;
                while (j < json.length && /[\d.eE+\-]/.test(json[j])) j++;
                out += `<span class="jh-num">${json.slice(i, j)}</span>`;
                i = j;
            } else if (json.slice(i, i + 4) === 'true') {
                out += '<span class="jh-bool">true</span>'; i += 4;
            } else if (json.slice(i, i + 5) === 'false') {
                out += '<span class="jh-bool">false</span>'; i += 5;
            } else if (json.slice(i, i + 4) === 'null') {
                out += '<span class="jh-null">null</span>'; i += 4;
            } else {
                out += esc(json[i]); i++;
            }
        }
        return out;
    }

    _formatPacketDetail(packet) {
        const clean = JSON.parse(JSON.stringify(packet));
        delete clean.isValid;
        if (clean.payload) delete clean.payload.raw;

        const walk = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const [k, v] of Object.entries(obj)) {
                if ((k === 'timestamp' || k === 'time') && typeof v === 'number' && v > 1_000_000_000 && v < 4_000_000_000) {
                    obj[k] = new Date(v * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
                } else if (typeof v === 'object' && v !== null) {
                    walk(v);
                }
            }
        };
        walk(clean);
        return JSON.stringify(clean, null, 2);
    }

    _buildDetailRow(hash, col = null) {
        const data = this._tableSource().get(hash) || this.hashData.get(hash);
        if (!data) return '';
        // Span every rendered column (the table shows the union of live + disk
        // columns, which can exceed repeaterColumns).
        const colCount = this._visibleCols?.length ?? this.repeaterColumns.length;
        const colspan = 1 + colCount * 2;

        // Use per-repeater packet/rawHex when available (each repeater receives a different path)
        const repEntry = col ? data.repeaters.get(col) : null;
        let pkt = repEntry?.packet ?? data.packet;
        const hex = repEntry?.rawHex ?? data.rawHex;
        // Disk-paged rows carry packet:null (the decoded form isn't stored — see
        // packet-store.js) — reconstruct it from the raw bytes on demand and
        // cache it on the entry so re-renders of an open detail don't re-decode.
        if (!pkt && hex) {
            try { pkt = MeshCoreDecoder.decode(hex); } catch (_) { pkt = null; }
            if (pkt) { if (repEntry) repEntry.packet = pkt; else data.packet = pkt; }
        }

        let header = '';
        if (repEntry) {
            const rc = this._signalColor(repEntry.rssi, -70, -130);
            const sc = this._signalColor(repEntry.snr,  13, -10, 0);
            const timeStr = repEntry.time ? this._formatTimeMs(repEntry.time) : '';
            const hexPart = hex
                ? ` &nbsp; <code class="raw-hex" data-hex="${hex}" title="Click to copy raw hex">${this._escHtml(hex.slice(0, 12))}…</code>`
                : '';
            const rs = repEntry.remoteSnr ?? data.meta?.remoteSnr;
            const uplinkPart = rs != null
                ? ` &nbsp; Uplink SNR <span style="color:${this._signalColor(rs, 13, -10, 0)};font-weight:700">${this._fmtSnr(rs)} dB</span>`
                : '';
            const colContact = this._contactByPrefix(col);
            const colName = colContact?.name ?? null;
            header = `<div class="detail-sig">` +
                `<span class="rl-dot" style="${this._repDotStyle(col)}"></span>` +
                `<b>${this._escHtml(this.displayId(col))}</b>` +
                (colName ? ` <span class="detail-col-name">${this._escHtml(colName)}</span>` : '') +
                (timeStr ? ` &nbsp; <span class="detail-time">${timeStr}</span>` : '') +
                ` &nbsp; RSSI <span style="color:${rc};font-weight:700">${repEntry.rssi ?? '—'}</span>` +
                ` &nbsp; SNR <span style="color:${sc};font-weight:700">${this._fmtSnr(repEntry.snr)}</span>` +
                uplinkPart +
                hexPart +
                `</div>`;
        }

        const typeHtml = data.type
            ? `<div class="detail-type">${this._escHtml(data.type)}</div>`
            : '';
        const jsonHtml = pkt
            ? `<pre class="detail-json">${this._syntaxHighlightJson(this._formatPacketDetail(pkt))}</pre>`
            : '';
        let metaHtml = '';
        if (data.meta?.pubKeyFull) {
            const pk = data.meta.pubKeyFull.toUpperCase().match(/.{1,8}/g).join(' ');
            const contact = this._contacts.get(data.meta.pubKeyFull);
            const name = contact?.name ?? data.meta.name ?? null;
            const TYPE_NAMES = { 1: 'Chat', 2: 'Repeater', 3: 'Room server', 4: 'Sensor' };
            const typeName = contact?.type != null ? (TYPE_NAMES[contact.type] ?? `Type ${contact.type}`) : null;
            const typeStr = typeName ? ` <span style="color:#888">(${this._escHtml(typeName)})</span>` : '';
            metaHtml = `<div class="detail-pubkey">${typeStr ? typeStr + ' &nbsp; ' : ''}Key: <code>${pk}</code></div>`;
        }

        return `<td colspan="${colspan}" class="detail-cell" title="Click to hide detail"><div class="detail-content">${typeHtml}${header}${metaHtml}${jsonHtml}</div></td>`;
    }

    _buildSigCells(rssi, snr, hash, col) {
        const rc = this._signalColor(rssi, -70, -130);
        const sc = this._signalColor(snr,  13, -10, 0);
        const rssiStr = rssi != null ? rssi : '—';
        const snrStr  = this._fmtSnr(snr);
        return `<td class="sig-snr"  data-hash="${hash}" data-col="${col}" style="color:${sc}">${snrStr}</td>` +
               `<td class="sig-rssi" data-hash="${hash}" data-col="${col}" style="color:${rc}">${rssiStr}</td>`;
    }

    _scheduleChartRender() {
        if (this._chartRenderPending) return;
        this._chartRenderPending = true;
        requestAnimationFrame(() => {
            this._chartRenderPending = false;
            this._renderCharts();
        });
    }

    // --- Chart ---

    // Stable 32-bit FNV-1a hash of the display id (cached).
    _repeaterHash(col) {
        if (!this.chartColors.has(col)) {
            const id = this.displayId(col);
            let h = 0x811c9dc5;
            for (let i = 0; i < id.length; i++) {
                h ^= id.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            this.chartColors.set(col, h >>> 0);
        }
        return this.chartColors.get(col);
    }

    // Hue, saturation and lightness — each from a different slice of the hash, so
    // repeaters vary in all three. Returns the light-theme lightness.
    _repeaterHSL(col) {
        const h = this._repeaterHash(col);
        const hue = h % 360;
        const sat = Math.round(REP_S_MIN + ((h >>> 10) & 0xFF) / 255 * (REP_S_MAX - REP_S_MIN));
        const lit = Math.round(REP_L_MIN + ((h >>> 18) & 0xFF) / 255 * (REP_L_MAX - REP_L_MIN));
        return { hue, sat, lit };
    }

    // Light colour — used by the 3D map, whose background is always light.
    getRepeaterColor(col) {
        const { hue, sat, lit } = this._repeaterHSL(col);
        return `hsl(${hue}, ${sat}%, ${lit}%)`;
    }

    // Theme-aware colour for the 2D UI: dark theme lifts the lightness.
    _dotColor(col) {
        const { hue, sat, lit } = this._repeaterHSL(col);
        const isDark = !document.documentElement.classList.contains('light-theme');
        const l = isDark ? Math.min(90, lit + REP_DARK_BUMP) : lit;
        return `hsl(${hue}, ${sat}%, ${l}%)`;
    }

    // Stock-firmware repeater RX lines carry no packet hash: a flood summary
    // names the origin (not the node we heard) and direct traffic has no hop
    // identity at all. Such packets must never be merged with one another — each
    // is its own distinct observation — so we mint a globally-unique sentinel
    // hash for every one at capture time. That UUID is written to the CSV, so it
    // also keeps observations distinct across capture sessions and imports, while
    // re-importing the same file stays idempotent (identical hashes are deduped).
    _makeUnknownHash() {
        const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
        return 'unknown-' + rand;
    }

    // The two pseudo columns aren't real nodes, so they get a reserved look the
    // hash can never produce: a black-ringed circle, filled yellow (direct) or
    // white (unknown).
    _isPseudoCol(col) { return col === 'direct' || col === 'unknown'; }
    _pseudoRing(col)  { return col === 'direct' ? '#111' : '#c00'; }
    _pseudoFill(col)  { return col === 'direct' ? '#ffd400' : '#fff'; }

    // Inline style for a .rl-dot swatch.
    _repDotStyle(col) {
        if (this._isPseudoCol(col))
            return `background:${this._pseudoFill(col)};border:2px solid ${this._pseudoRing(col)};box-sizing:border-box`;
        return `background:${this._dotColor(col)}`;
    }

    // Same, applied to an existing element (JS-updated dots).
    _applyDotStyle(el, col) {
        if (!el) return;
        if (this._isPseudoCol(col)) {
            el.style.background = this._pseudoFill(col);
            el.style.border = `2px solid ${this._pseudoRing(col)}`;
            el.style.boxSizing = 'border-box';
        } else {
            el.style.background = this._dotColor(col);
            el.style.border = '';
        }
    }

    // SVG marker paint for chart dots.
    _markerFill(col)         { return this._isPseudoCol(col) ? this._pseudoFill(col) : this._dotColor(col); }
    _markerStroke(col, base) { return this._isPseudoCol(col) ? this._pseudoRing(col) : base; }
    _markerStrokeW(col, base){ return this._isPseudoCol(col) ? Math.max(base, 2) : base; }

    // Format an SNR for display: whole numbers (e.g. the repeater log, which
    // truncates SNR to integer dB) show without a decimal; finer values keep one.
    _fmtSnr(v) {
        if (v == null || !isFinite(v)) return '—';
        return Number.isInteger(v) ? String(v) : v.toFixed(1);
    }

    _renderCharts() {
        if (this._selectedCol
            && !this._visibleChartPoints().some(p => p.col === this._selectedCol)
            && !this._colHasMapMarker(this._selectedCol)) {
            this._selectRepeater(null);
        }
        this._renderChart('snr');
        this._renderChart('rssi');
    }

    _chartYBounds(type) {
        const pts = this._visibleChartPoints();
        // Avoid spread on potentially large arrays (Math.min(...arr) has an arg-count limit)
        let vMin = Infinity, vMax = -Infinity;
        for (const p of pts) {
            const v = type === 'rssi' ? p.rssi : p.snr;
            if (v == null) continue;
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
        }
        if (type === 'snr') {
            for (const p of this._visibleSentSnrPts()) {
                if (p.snr < vMin) vMin = p.snr;
                if (p.snr > vMax) vMax = p.snr;
            }
        }
        if (vMin === Infinity) { vMin = 0; vMax = 1; }
        const rawRange = vMax - vMin || 1;
        const yStep = rawRange <= 5 ? 1 : rawRange <= 10 ? 2 : rawRange <= 25 ? 5 : rawRange <= 50 ? 10 : 20;
        const yPad = Math.max(1, yStep / 2);
        const yMin = Math.floor((vMin - yPad) / yStep) * yStep;
        const yMax = Math.ceil((vMax + yPad) / yStep) * yStep;
        return { yMin, yMax, yStep };
    }

    _earliestTime(pts) {
        let m = Infinity;
        for (const p of pts) if (p.time < m) m = p.time;
        return m;
    }

    _onChartClick(e, type) {
        // A drag-to-zoom gesture ends with a click event we must not treat as a tap.
        if (this._suppressChartClick) { this._suppressChartClick = false; return; }
        const incomingPts = (type === 'snr' && !this._snrShowIncoming) ? [] : this._visibleChartPoints();
        const sentPts = type === 'snr' ? (this._snrShowOutgoing ? this._visibleSentSnrPts() : []) : [];
        const pts = type === 'snr' ? [...incomingPts, ...sentPts] : incomingPts;
        if (!pts.length) return;
        const svg = type === 'rssi' ? this.rssiChartSvg : this.snrChartSvg;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const W = rect.width || 600;
        const H = rect.height || 180;
        const { l: pl, r: pr, t: pt, b: pb } = CHART_PAD;
        const cw = W - pl - pr;
        const ch = H - pt - pb;
        // Use the exact window the chart was last rendered with, so hit-testing
        // stays aligned with the dots even when the X axis is zoomed.
        const now = this._chartFrozenAt ?? Date.now();
        const win = this._lastChartWindow ?? { tMin: now - 5 * 60000, tMax: now };
        const tMin = win.tMin, tMax = win.tMax;
        const { yMin, yMax } = this._chartYBounds(type);
        const tRange = Math.max(1, tMax - tMin);
        const yRange = Math.max(1e-9, yMax - yMin);
        const xOf = t => pl + (t - tMin) / tRange * cw;
        const yOf = v => pt + (1 - (v - yMin) / yRange) * ch;
        let nearest = null, minDist = Infinity;
        for (const p of pts) {
            const v = type === 'rssi' ? p.rssi : p.snr;
            if (v == null) continue;
            const dx = xOf(p.time) - mx;
            const dy = yOf(v) - my;
            const d = dx * dx + dy * dy;
            if (d < minDist) { minDist = d; nearest = p; }
        }
        if (!nearest || minDist > 2500) {
            if (this._selectedCol) this._selectRepeater(null);
            this.hideChartTooltip(true);
            return;
        }
        const deselect = this._selectedCol === nearest.col;
        this._selectRepeater(deselect ? null : nearest.col);
        if (deselect) this.hideChartTooltip(true);
        else this.showChartTooltip(e, type, true);
    }

    // ----- 2D-chart X-axis zoom ------------------------------------------
    // Both charts share one zoom window (this._chartZoom) so the SNR and RSSI
    // time axes stay aligned. Gestures: mouse wheel (zoom about the cursor),
    // drag a region with the mouse, two-finger pinch on touch. Double-click or
    // the "Reset zoom" button returns to the full auto/live window.

    // A viewport clientX mapped into the SVG's own (local, pre-transform) pixel
    // space — the space style.left and the SVG's internal drawing both use.
    // The page may be CSS-scaled (the desktop / text-size zoom transforms
    // <body>), so getBoundingClientRect() is in scaled viewport pixels while
    // svg.clientWidth is the unscaled layout width; dividing by their ratio
    // undoes the scale. (Without this the drag-zoom selection band, positioned
    // via style.left, landed off to the side by the scale factor.)
    _chartLocalX(svg, clientX) {
        const rect = svg.getBoundingClientRect();
        const scale = (rect.width && svg.clientWidth) ? rect.width / svg.clientWidth : 1;
        return (clientX - rect.left) / scale;
    }

    // Map a clientX over `svg` to a time, using the window the chart was last
    // drawn with (so it matches what's on screen).
    _chartTimeAtClientX(svg, clientX) {
        const win = this._lastChartWindow ?? this._chartFullWindow;
        if (!win) return null;
        const { l: pl, r: pr } = CHART_PAD;
        const cw = Math.max(1, svg.clientWidth - pl - pr);
        const frac = Math.max(0, Math.min(1, (this._chartLocalX(svg, clientX) - pl) / cw));
        return win.tMin + frac * (win.tMax - win.tMin);
    }

    _setChartZoom(tMin, tMax) {
        const full = this._chartFullWindow;
        if (!full || !(tMax > tMin)) return;
        // Clamp to the available data extent.
        tMin = Math.max(full.tMin, tMin);
        tMax = Math.min(full.tMax, tMax);
        const MIN_SPAN = 1000;   // don't zoom tighter than 1 s
        if (tMax - tMin < MIN_SPAN) {
            const mid = (tMin + tMax) / 2;
            tMin = Math.max(full.tMin, mid - MIN_SPAN / 2);
            tMax = Math.min(full.tMax, mid + MIN_SPAN / 2);
        }
        // Covers (almost) the whole range ⇒ drop the zoom and resume auto/live —
        // a ≥99%-of-full window isn't a meaningful zoom, so don't keep zoom state
        // (and the Reset button) around for it.
        if (tMax - tMin >= (full.tMax - full.tMin) * 0.99) { this._clearChartZoom(); return; }
        this._chartZoom = { tMin, tMax };
        this._updateZoomResetBtns();
        this._scheduleChartRender();        // instant: rescale the current cache
        this._scheduleChartCacheRefresh();  // then refine resolution for the new window
    }

    _clearChartZoom() {
        const had = !!this._chartZoom;
        this._chartZoom = null;
        this._updateZoomResetBtns();
        if (had) { this._scheduleChartRender(); this._scheduleChartCacheRefresh(); }
    }

    // Swallow the click that may trail a drag/pan gesture, but auto-expire so a
    // later genuine tap is never lost (touch pan preventDefaults, so the click
    // sometimes never arrives to consume the flag).
    _suppressClickBriefly() {
        this._suppressChartClick = true;
        clearTimeout(this._suppressClickTimer);
        this._suppressClickTimer = setTimeout(() => { this._suppressChartClick = false; }, 400);
    }

    // Slide the zoom window along the X axis by dtMs (keeping its span), clamped
    // to the data extent. No-op unless currently zoomed.
    _panChartZoom(dtMs) {
        if (!this._chartZoom || !this._chartFullWindow || !dtMs) return;
        const full = this._chartFullWindow;
        const span = this._chartZoom.tMax - this._chartZoom.tMin;
        let nMin = this._chartZoom.tMin + dtMs;
        let nMax = this._chartZoom.tMax + dtMs;
        if (nMin < full.tMin) { nMin = full.tMin; nMax = nMin + span; }
        if (nMax > full.tMax) { nMax = full.tMax; nMin = nMax - span; }
        this._chartZoom = { tMin: nMin, tMax: nMax };
        this._updateZoomResetBtns();
        this._scheduleChartRender();
        this._scheduleChartCacheRefresh();
    }

    // React to a zoom change, debounced so a wheel/pinch gesture coalesces into
    // one action once it settles. Zooming IN (or moving the zoom window) builds
    // a finer disk layer for it; zooming OUT just drops the layer and re-derives
    // from the always-current base — no disk read.
    _scheduleChartCacheRefresh() {
        clearTimeout(this._chartCacheTimer);
        this._chartCacheTimer = setTimeout(() => {
            if (this._chartZoom) {
                this._rebuildChartZoomLayer();
            } else {
                this._chartZoomLayer = null;
                this._rebuildChartArrays();
            }
        }, 140);
    }

    _updateZoomResetBtns() {
        const zoomed = !!this._chartZoom;
        for (const b of (this._zoomResetBtns ?? [])) b.classList.toggle('hidden', !zoomed);
    }

    _showZoomSel(svg, xa, xb) {
        const wrap = svg.parentElement;
        if (!wrap) return;
        let band = this._zoomSelBand;
        if (!band || band.parentElement !== wrap) {
            band = document.createElement('div');
            band.className = 'chart-zoom-sel';
            wrap.appendChild(band);
            this._zoomSelBand = band;
        }
        const { l: pl, r: pr } = CHART_PAD;
        // Position in the SVG's local px (what style.left uses) — see _chartLocalX:
        // a CSS-scaled page would otherwise offset the band by the scale factor.
        const xaL = this._chartLocalX(svg, xa);
        const xbL = this._chartLocalX(svg, xb);
        const left  = Math.max(pl, Math.min(xaL, xbL));
        const right = Math.min(svg.clientWidth - pr, Math.max(xaL, xbL));
        band.style.left = left + 'px';
        band.style.width = Math.max(0, right - left) + 'px';
        band.style.display = 'block';
    }

    _hideZoomSel() {
        if (this._zoomSelBand) this._zoomSelBand.style.display = 'none';
    }

    _bindChartZoom(svg, type) {
        // Lazily add a per-chart "Reset zoom" button (shown only while zoomed).
        const wrap = svg.parentElement;
        if (wrap && !wrap.querySelector('.chart-zoom-reset')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chart-zoom-reset hidden';
            btn.textContent = '⤢ Reset zoom';
            btn.title = 'Reset X-axis zoom (or double-click the chart)';
            btn.addEventListener('click', ev => { ev.stopPropagation(); this._clearChartZoom(); });
            wrap.appendChild(btn);
            (this._zoomResetBtns ??= []).push(btn);
        }

        // Wheel: zoom about the cursor (wheel up = zoom in). While zoomed,
        // Shift+wheel or a horizontal wheel/trackpad gesture pans along X.
        svg.addEventListener('wheel', e => {
            const win = this._lastChartWindow ?? this._chartFullWindow;
            if (!win) return;
            const span = win.tMax - win.tMin;
            if (this._chartZoom && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
                e.preventDefault();
                const d = e.shiftKey ? e.deltaY : e.deltaX;
                this._panChartZoom(Math.sign(d) * span * 0.2);
                return;
            }
            const tAt = this._chartTimeAtClientX(svg, e.clientX);
            if (tAt == null) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1 / 1.2 : 1.2;
            this._setChartZoom(tAt - (tAt - win.tMin) * factor, tAt + (win.tMax - tAt) * factor);
        }, { passive: false });

        // Mouse drag → select an X region to zoom into. Distinguish from a click
        // by a small movement threshold; a real drag suppresses the click.
        let drag = null;
        svg.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            e.preventDefault();   // don't start a text/SVG selection while dragging
            drag = { startX: e.clientX, moved: false };
        });
        window.addEventListener('mousemove', e => {
            if (!drag) return;
            if (!drag.moved && Math.abs(e.clientX - drag.startX) > 4) drag.moved = true;
            if (drag.moved) { this._showZoomSel(svg, drag.startX, e.clientX); this.hideChartTooltip(); }
        });
        window.addEventListener('mouseup', e => {
            if (!drag) return;
            const d = drag; drag = null;
            this._hideZoomSel();
            if (!d.moved) return;                 // it was a click → leave to _onChartClick
            this._suppressClickBriefly();
            const t1 = this._chartTimeAtClientX(svg, d.startX);
            const t2 = this._chartTimeAtClientX(svg, e.clientX);
            if (t1 != null && t2 != null) this._setChartZoom(Math.min(t1, t2), Math.max(t1, t2));
        });

        // Two-finger pinch on touch. Each finger stays pinned to the time it
        // grabbed; we solve for the window that keeps both anchors under them.
        let pinch = null, pan = null;
        svg.addEventListener('touchstart', e => {
            if (e.touches.length !== 2) return;
            pan = null;   // a second finger landed → switch from pan to pinch
            const t0 = this._chartTimeAtClientX(svg, e.touches[0].clientX);
            const t1 = this._chartTimeAtClientX(svg, e.touches[1].clientX);
            if (t0 == null || t1 == null) return;
            pinch = { t0, t1 };
            this.hideChartTooltip();
            e.preventDefault();
        }, { passive: false });
        svg.addEventListener('touchmove', e => {
            if (!pinch || e.touches.length !== 2) return;
            e.preventDefault();
            const rect = svg.getBoundingClientRect();
            const { l: pl, r: pr } = CHART_PAD;
            const cw = Math.max(1, (rect.width || svg.clientWidth) - pl - pr);
            const x0 = e.touches[0].clientX - rect.left - pl;
            const x1 = e.touches[1].clientX - rect.left - pl;
            if (Math.abs(x0 - x1) < 1) return;
            const span = (pinch.t0 - pinch.t1) * cw / (x0 - x1);
            if (!isFinite(span) || span <= 0) return;
            const tMin = pinch.t0 - (x0 / cw) * span;
            this._setChartZoom(tMin, tMin + span);
        }, { passive: false });
        const endPinch = e => { if (e.touches.length < 2) pinch = null; };
        svg.addEventListener('touchend', endPinch);
        svg.addEventListener('touchcancel', endPinch);

        // One-finger drag pans along X while zoomed. A predominantly horizontal
        // move pans (we own it — touch-action:pan-y leaves horizontal to us); a
        // vertical move falls through to normal page scrolling. A tap still
        // selects a point (no movement ⇒ no pan, click proceeds).
        svg.addEventListener('touchstart', e => {
            pan = (e.touches.length === 1 && this._chartZoom)
                ? { x: e.touches[0].clientX, y: e.touches[0].clientY, mode: null, moved: false }
                : null;
        }, { passive: true });
        svg.addEventListener('touchmove', e => {
            if (!pan || e.touches.length !== 1) return;
            const t = e.touches[0];
            const dx = t.clientX - pan.x, dy = t.clientY - pan.y;
            if (pan.mode === null) {
                if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;   // wait for a clear direction
                pan.mode = Math.abs(dx) > Math.abs(dy) ? 'pan' : 'scroll';
            }
            if (pan.mode !== 'pan') return;        // vertical ⇒ let the page scroll
            e.preventDefault();
            const rect = svg.getBoundingClientRect();
            const { l: pl, r: pr } = CHART_PAD;
            const cw = Math.max(1, (rect.width || svg.clientWidth) - pl - pr);
            const span = this._chartZoom.tMax - this._chartZoom.tMin;
            this._panChartZoom(-dx / cw * span);   // drag right → reveal earlier times
            pan.x = t.clientX; pan.y = t.clientY;  // incremental delta
            pan.moved = true;
            this.hideChartTooltip();
        }, { passive: false });
        const endPan = () => { if (pan && pan.moved) this._suppressClickBriefly(); pan = null; };
        svg.addEventListener('touchend', endPan);
        svg.addEventListener('touchcancel', endPan);

        // Double-click anywhere on the chart resets the zoom.
        svg.addEventListener('dblclick', e => { e.preventDefault(); this._clearChartZoom(); });
    }

    _xLabelStepMs(rangeMs, chartWidthPx) {
        // ~50 px per label for readability
        const targetSteps = Math.max(2, Math.floor(chartWidthPx / 50));
        const targetStep = rangeMs / targetSteps;
        const steps = [
            15000, 30000, 60000, 2*60000, 5*60000, 10*60000, 15*60000, 30*60000,
            3600000, 2*3600000, 3*3600000, 6*3600000, 12*3600000, 24*3600000,
        ];
        for (const s of steps) if (s >= targetStep) return s;
        return steps[steps.length - 1];
    }

    _renderChart(type) {
        const wrap   = type === 'rssi' ? this.rssiChartWrap   : this.snrChartWrap;
        const svg    = type === 'rssi' ? this.rssiChartSvg    : this.snrChartSvg;
        if (!svg) return;
        wrap?.classList.remove('hidden');

        const allInPts  = this._visibleChartPoints();
        const allOutPts = type === 'snr' ? this._visibleSentSnrPts() : [];
        const pts       = (type === 'snr' && !this._snrShowIncoming) ? [] : allInPts;
        const sentPts   = type === 'snr' ? (this._snrShowOutgoing ? allOutPts : []) : [];
        const hasData    = pts.length > 0 || sentPts.length > 0;
        const hasAnyData = allInPts.length > 0 || allOutPts.length > 0;
        const noneSelected = type === 'snr' && !this._snrShowIncoming && !this._snrShowOutgoing;

        const W = svg.clientWidth || 600;
        const H = svg.clientHeight || 180;
        const { l: pl, r: pr, t: pt, b: pb } = CHART_PAD;
        const cw = W - pl - pr;
        const ch = H - pt - pb;

        const now = this._chartFrozenAt ?? Date.now();
        const defaultWindow = 5 * 60000;
        let autoTMin;
        // The Display window defines the X axis; Auto-remove only caps it when
        // Display is "All" (nothing older exists then).
        if (isFinite(this.DISPLAY_LIFETIME)) autoTMin = now - this.DISPLAY_LIFETIME;
        else if (!hasAnyData) autoTMin = now - defaultWindow;
        else if (isFinite(this.HASH_LIFETIME)) autoTMin = now - this.HASH_LIFETIME;
        else {
            autoTMin = allInPts.length ? this._earliestTime(allInPts) : Infinity;
            if (allOutPts.length) autoTMin = Math.min(autoTMin, this._earliestTime(allOutPts));
            if (!isFinite(autoTMin)) autoTMin = now - defaultWindow;
        }
        // X-axis zoom: both charts share one window so they stay aligned. The full
        // (un-zoomed) window is [autoTMin, now]; an active zoom narrows it, clamped
        // to the data extent. While zoomed the data fed in is only the zoom window,
        // so it can't reveal the true extent — keep the previously measured full
        // tMin and only let the right edge track live time, so zoom-out still works.
        if (this._chartZoom && this._chartFullWindow) {
            this._chartFullWindow = { tMin: this._chartFullWindow.tMin, tMax: now };
        } else {
            this._chartFullWindow = { tMin: autoTMin, tMax: now };
        }
        const full = this._chartFullWindow;
        let tMin = full.tMin, tMax = full.tMax;
        if (this._chartZoom) {
            tMin = Math.max(full.tMin, this._chartZoom.tMin);
            tMax = Math.min(full.tMax, this._chartZoom.tMax);
            if (tMax - tMin < 1) { tMin = full.tMin; tMax = full.tMax; }
        }
        this._lastChartWindow = { tMin, tMax };

        let yMin, yMax, yStep;
        if (!hasAnyData) {
            if (type === 'rssi') { yMin = -130; yMax = -30; yStep = 20; }
            else                 { yMin = -20;  yMax = 15;  yStep = 5;  }
        } else {
            ({ yMin, yMax, yStep } = this._chartYBounds(type));
        }
        // Adapt yStep so major gridlines are ~35 px apart (more when taller, fewer when short)
        const maxMajorLines = Math.max(2, Math.floor(ch / 35));
        const niceYSteps = [0.5, 1, 2, 5, 10, 20, 50, 100];
        const minYStep = (yMax - yMin) / maxMajorLines;
        const adaptedStep = niceYSteps.find(s => s >= minYStep);
        if (adaptedStep && adaptedStep > yStep) yStep = adaptedStep;
        const tRange = Math.max(1, tMax - tMin);
        const yRange = Math.max(1e-9, yMax - yMin);

        const xOf = t => (pl + (t - tMin) / tRange * cw).toFixed(1);
        const yOf = v => (pt + (1 - (v - yMin) / yRange) * ch).toFixed(1);
        const valOf = p => type === 'rssi' ? p.rssi : p.snr;

        const isDark = !document.documentElement.classList.contains('light-theme');
        const gridMinor = isDark ? 'rgba(255,255,255,0.05)' : '#ebebeb';
        const gridMajor = isDark ? 'rgba(255,255,255,0.10)' : '#ddd';
        const gridAxis  = isDark ? 'rgba(255,255,255,0.18)' : '#bbb';
        const labelFill = isDark ? '#8892b8' : '#888';
        const dotStroke = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.28)';

        const parts = [];

        // Bundle the geometry/scale/theme context so the grid and data-series
        // builders take one parameter instead of ~20. The transforms (xOf/yOf)
        // and valOf are captured as-is.
        const geom = {
            W, H, pl, pr, pt, pb, cw, ch, tMin, tMax, tRange, yMin, yMax, yStep, yRange,
            xOf, yOf, valOf, isDark, gridMinor, gridMajor, gridAxis, labelFill, dotStroke,
        };
        this._pushChartGrid(parts, geom, type);
        this._pushChartSeries(parts, geom, type, pts, sentPts, hasData);

        if (!hasData) {
            const msg = noneSelected ? 'Select Incoming or Outgoing above' : 'Waiting for data…';
            parts.push(`<text x="${(pl + cw / 2).toFixed(1)}" y="${(pt + ch / 2).toFixed(1)}" text-anchor="middle" font-size="11" fill="${labelFill}">${msg}</text>`);
        }

        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.innerHTML = parts.join('');

        // Find the most recent point per column, then sort best → worst
        const lastByCol = new Map();
        for (const p of pts) {
            if (!lastByCol.has(p.col) || p.time > lastByCol.get(p.col).time) lastByCol.set(p.col, p);
        }
        const visible = [...lastByCol.keys()].sort((a, b) => {
            const pa = lastByCol.get(a), pb = lastByCol.get(b);
            const va = type === 'rssi' ? pa.rssi : pa.snr;
            const vb = type === 'rssi' ? pb.rssi : pb.snr;
            if (vb == null && va == null) return 0;
            if (vb == null) return -1;
            if (va == null) return 1;
            return vb - va;
        });

    }

    // Append the static chart frame (Y/X gridlines + labels + axes) to `parts`.
    _pushChartGrid(parts, geom, type) {
        const { pl, cw, pt, ch, tMin, tMax, tRange, yMin, yMax, yStep, xOf, yOf,
                gridMinor, gridMajor, gridAxis, labelFill } = geom;
        // Y grid + labels (major every yStep, minor every yStep/2)
        const yMinorStep = yStep / 2;
        for (let y = yMin + yMinorStep; y < yMax; y += yStep) {
            const yp = yOf(y);
            parts.push(`<line x1="${pl}" y1="${yp}" x2="${pl + cw}" y2="${yp}" stroke="${gridMinor}" stroke-width="1"/>`);
        }
        for (let y = yMin; y <= yMax; y += yStep) {
            const yp = yOf(y);
            parts.push(`<line x1="${pl}" y1="${yp}" x2="${pl + cw}" y2="${yp}" stroke="${gridMajor}" stroke-width="1"/>`);
            parts.push(`<text x="${pl - 3}" y="${(+yp + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="${labelFill}">${y}</text>`);
        }

        // Y axis label
        const yLabel = type === 'rssi' ? 'dBm' : 'dB';
        const yLabelCy = (pt + ch / 2).toFixed(1);
        parts.push(`<text x="10" y="${yLabelCy}" text-anchor="middle" font-size="9" fill="${labelFill}" transform="rotate(-90,10,${yLabelCy})">${yLabel}</text>`);

        // X grid + labels — adaptive step based on chart width and visible range
        const labelStep = this._xLabelStepMs(tRange, cw);
        const minorStep = labelStep / 2;
        // Use date+time when the visible range spans more than ~12 h
        const useDate = tRange > 12 * 3600000;
        const fmtOpts = useDate
            ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
            : (labelStep < 60000
                ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
                : { hour: '2-digit', minute: '2-digit' });
        for (let t = Math.ceil(tMin / minorStep) * minorStep; t <= tMax; t += minorStep) {
            if (t % labelStep === 0) continue;
            const xp = xOf(t);
            parts.push(`<line x1="${xp}" y1="${pt}" x2="${xp}" y2="${pt + ch}" stroke="${gridMinor}" stroke-width="1"/>`);
        }
        for (let t = Math.ceil(tMin / labelStep) * labelStep; t <= tMax; t += labelStep) {
            const xp = xOf(t);
            parts.push(`<line x1="${xp}" y1="${pt}" x2="${xp}" y2="${pt + ch}" stroke="${gridMajor}" stroke-width="1"/>`);
            const lbl = new Date(t).toLocaleString('en-GB', fmtOpts).replace(',', '');
            parts.push(`<text x="${xp}" y="${pt + ch + 14}" text-anchor="middle" font-size="9" fill="${labelFill}">${lbl}</text>`);
        }

        // Axes
        parts.push(`<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ch}" stroke="${gridAxis}" stroke-width="1"/>`);
        parts.push(`<line x1="${pl}" y1="${pt + ch}" x2="${pl + cw}" y2="${pt + ch}" stroke="${gridAxis}" stroke-width="1"/>`);
    }

    // Append the clipped data layer (noise floor, per-repeater lines, dots and
    // outgoing-SNR stars) to `parts`.
    _pushChartSeries(parts, geom, type, pts, sentPts, hasData) {
        const { pl, pt, cw, ch, tMin, tMax, xOf, yOf, valOf, dotStroke } = geom;
        // Clip the data layer (noise floor, lines, dots, stars) to the plot rect so
        // that when zoomed in, points outside the X window don't spill over the
        // axes/labels. Grid, axes and labels stay outside the clip.
        const clipId = `chartClip-${type}`;
        parts.push(`<defs><clipPath id="${clipId}"><rect x="${pl}" y="${pt}" width="${cw}" height="${ch}"/></clipPath></defs>`);
        parts.push(`<g clip-path="url(#${clipId})">`);

        // Noise floor area (RSSI chart only) — drawn behind repeater lines/dots
        if (type === 'rssi' && hasData) {
            const sorted = [...pts].filter(p => p.rssi != null && p.snr != null).sort((a, b) => a.time - b.time);
            if (sorted.length > 0) {
                const bottom = (pt + ch).toFixed(1);
                const lastP = sorted[sorted.length - 1];
                const nfPts = sorted.map(p => `${xOf(p.time)},${yOf(p.rssi - p.snr)}`);
                nfPts.push(`${xOf(tMax)},${yOf(lastP.rssi - lastP.snr)}`);
                const topEdge = nfPts.join(' ');
                const firstX = xOf(sorted[0].time);
                const lastX  = xOf(tMax);
                parts.push(
                    `<polygon points="${topEdge} ${lastX},${bottom} ${firstX},${bottom}" ` +
                    `fill="rgba(140,140,140,0.15)"/>`,
                    `<polyline points="${topEdge}" fill="none" stroke="rgba(120,120,120,0.45)" stroke-width="1"/>`
                );
            }
        }

        const selected = this._selectedCol;

        const groups = new Map();
        for (const p of pts) {
            if (!groups.has(p.col)) groups.set(p.col, []);
            groups.get(p.col).push(p);
        }

        // Build per-column decimated point sets (at most 2 pts per pixel column)
        const decimGroups = new Map();
        for (const [col, colPts] of groups) {
            colPts.sort((a, b) => a.time - b.time);
            decimGroups.set(col, this._decimateChartPts(colPts, tMin, tMax, cw, type));
        }

        for (const [col, dPts] of decimGroups) {
            const validPts = dPts.filter(p => valOf(p) != null);
            if (validPts.length < 2) continue;
            const color = this._isPseudoCol(col) ? this._pseudoRing(col) : this._dotColor(col);
            const isHighlighted = !selected || selected === col;
            const strokeW = (selected && selected === col) ? 2.5 : 1;
            const strokeOp = isHighlighted ? 0.65 : 0.15;
            const pointsStr = validPts.map(p => `${xOf(p.time)},${yOf(valOf(p))}`).join(' ');
            parts.push(`<polyline points="${pointsStr}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-opacity="${strokeOp}"/>`);
        }

        // Render dimmed circles first, then highlighted on top (SVG painter order)
        const ds = this._dotSize * 3.5;
        for (const [col, dPts] of decimGroups) {
            if (selected && selected === col) continue;
            for (const p of dPts) {
                if (valOf(p) == null) continue;
                parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(valOf(p))}" r="${ds}" fill="${this._markerFill(p.col)}" fill-opacity="${selected ? 0.10 : 0.90}" stroke="${this._markerStroke(p.col, dotStroke)}" stroke-width="${this._markerStrokeW(p.col, 0.8)}"/>`);
            }
        }
        if (selected) {
            const selPts = decimGroups.get(selected);
            if (selPts) {
                for (const p of selPts) {
                    if (valOf(p) == null) continue;
                    parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(valOf(p))}" r="${ds * 1.43}" fill="${this._markerFill(p.col)}" fill-opacity="0.95" stroke="${this._markerStroke(p.col, dotStroke)}" stroke-width="${this._markerStrokeW(p.col, 1)}"/>`);
                }
            }
        }

        // Render sent SNR as stars (SNR chart only)
        if (sentPts.length) {
            const starPts = (cx, cy, r) => {
                const inner = r * 0.42;
                const pts = [];
                for (let i = 0; i < 10; i++) {
                    const a = (i * Math.PI / 5) - Math.PI / 2;
                    const rad = i % 2 === 0 ? r : inner;
                    pts.push(`${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`);
                }
                return pts.join(' ');
            };
            const rNorm = ds * 1.5;
            const rSel  = rNorm * 1.43;
            for (const p of sentPts) {
                if (selected && selected === p.col) continue;
                parts.push(`<polygon points="${starPts(+xOf(p.time), +yOf(p.snr), rNorm)}" fill="${this._dotColor(p.col)}" fill-opacity="${selected ? 0.10 : 0.90}" stroke="${dotStroke}" stroke-width="0.8"/>`);
            }
            if (selected) {
                for (const p of sentPts) {
                    if (p.col !== selected) continue;
                    parts.push(`<polygon points="${starPts(+xOf(p.time), +yOf(p.snr), rSel)}" fill="${this._dotColor(p.col)}" fill-opacity="0.95" stroke="${dotStroke}" stroke-width="1"/>`);
                }
            }
        }

        parts.push(`</g>`);   // close the clipped data layer
    }

    _decimateChartPts(colPts, tMin, tMax, pixelWidth, type) {
        // Cluster into one column per ~5 px of chart width. tMin..tMax is the
        // (possibly zoomed) visible window, so the time each column spans shrinks
        // automatically as you zoom in — revealing finer detail at the same
        // on-screen density. Each column keeps its min- and max-value point.
        //
        // colPts is sorted by time. When zoomed in, also keep the nearest point
        // just OUTSIDE each edge so the connecting line is drawn across the plot
        // border (the SVG clip trims the overshoot) instead of stopping at the
        // last visible point and leaving a gap at the sides.
        const CLUSTER_PX = 5;
        const buckets = Math.max(1, Math.round(pixelWidth / CLUSTER_PX));
        const valOf = p => type === 'rssi' ? p.rssi : p.snr;

        let leftN = null, rightN = null;
        const inWin = [];
        for (const p of colPts) {
            if (p.time < tMin) leftN = p;                 // sorted ⇒ last one < tMin
            else if (p.time > tMax) { rightN = p; break; } // first one > tMax
            else inWin.push(p);
        }

        let body = inWin;
        if (inWin.length > buckets * 2) {
            const span = Math.max(1, tMax - tMin);
            const bucketMs = span / buckets;
            const bkts = new Array(buckets);
            for (const p of inWin) {
                const i = Math.min(buckets - 1, Math.max(0, Math.floor((p.time - tMin) / bucketMs)));
                if (!bkts[i]) { bkts[i] = { min: p, max: p }; }
                else {
                    if (valOf(p) < valOf(bkts[i].min)) bkts[i].min = p;
                    if (valOf(p) > valOf(bkts[i].max)) bkts[i].max = p;
                }
            }
            body = [];
            for (const b of bkts) {
                if (!b) continue;
                body.push(b.min);
                if (b.max !== b.min) body.push(b.max);
            }
            body.sort((a, b) => a.time - b.time);
        }
        if (!leftN && !rightN) return body;
        const out = [];
        if (leftN) out.push(leftN);
        out.push(...body);
        if (rightN) out.push(rightN);
        return out;
    }

    showChartTooltip(e, type, pin = false) {
        if (!this.tooltip) return;
        // Note: hover still updates the infobox even while a point is pinned, so
        // the live preview keeps working after a repeater is selected.
        const incomingPts = (type === 'snr' && !this._snrShowIncoming) ? [] : this._visibleChartPoints();
        const sentPts = type === 'snr' ? (this._snrShowOutgoing ? this._visibleSentSnrPts() : []) : [];
        const pts = type === 'snr' ? [...incomingPts, ...sentPts] : incomingPts;
        if (!pts.length) return;
        const svg = type === 'rssi' ? this.rssiChartSvg : this.snrChartSvg;
        if (!svg) return;

        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const W = rect.width || 600;
        const H = rect.height || 180;
        const { l: pl, r: pr, t: pt, b: pb } = CHART_PAD;
        const cw = W - pl - pr;
        const ch = H - pt - pb;

        // Use the exact window the chart was last rendered with, so hit-testing
        // stays aligned with the dots even when the X axis is zoomed.
        const now = this._chartFrozenAt ?? Date.now();
        const win = this._lastChartWindow ?? { tMin: now - 5 * 60000, tMax: now };
        const tMin = win.tMin, tMax = win.tMax;
        const { yMin, yMax } = this._chartYBounds(type);
        const tRange = Math.max(1, tMax - tMin);
        const yRange = Math.max(1e-9, yMax - yMin);

        const xOf = t => pl + (t - tMin) / tRange * cw;
        const yOf = v => pt + (1 - (v - yMin) / yRange) * ch;

        let nearest = null, minDist = Infinity;
        for (const p of pts) {
            const v = type === 'rssi' ? p.rssi : p.snr;
            if (v == null) continue;
            const dx = xOf(p.time) - mx;
            const dy = yOf(v) - my;
            const d = dx * dx + dy * dy;
            if (d < minDist) { minDist = d; nearest = p; }
        }
        if (!nearest || minDist > 1600) { if (!this._tooltipPinned) this.hideChartTooltip(); return; }

        const isSent = sentPts.includes(nearest);
        const time = new Date(nearest.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const color = this._dotColor(nearest.col);
        const dotShape = isSent
            ? `<span style="color:${color};font-size:13px;line-height:1;margin-right:5px;vertical-align:middle;flex-shrink:0">★</span>`
            : `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;${this._repDotStyle(nearest.col)};margin-right:5px;vertical-align:middle;flex-shrink:0"></span>`;
        const cName = this._contactNameForCol(nearest.col);
        const nameHtml = cName ? `<span class="ct-colname">${this._escHtml(cName)}</span>` : '';
        // Signal values and time share one line, with the time pushed to the end
        // (matching the 3D map infobox layout).
        const valLine = isSent
            ? `Sent SNR ${this._fmtSnr(nearest.snr)} dB ↗`
            : `SNR ${this._fmtSnr(nearest.snr)} &nbsp; RSSI ${nearest.rssi ?? '—'}`;
        this.tooltip.innerHTML =
            `<div class="ct-name">${dotShape}<b>${this._escHtml(this.displayId(nearest.col))}</b>${nameHtml}</div>` +
            `<div class="ct-sig">${valLine}<span class="ct-time">${time}</span></div>`;

        // Anchor the infobox to the data point itself (not the cursor/tap, which
        // can land a bit off), centred above it. The tooltip is position:absolute
        // inside <body>; since <body> may carry a transform: scale() (text-size /
        // desktop zoom), convert the point's viewport position into body-local
        // (un-scaled, scroll-included) coordinates so it stays anchored and
        // scrolls with the page.
        this.tooltip.style.display = 'block';
        const nv = type === 'rssi' ? nearest.rssi : nearest.snr;
        let scale = 1;
        const tr = getComputedStyle(document.body).transform;
        const m = tr && tr !== 'none' ? tr.match(/matrix\(([^)]+)\)/) : null;
        if (m) scale = parseFloat(m[1].split(',')[0]) || 1;
        const px = (rect.left + xOf(nearest.time) + window.scrollX) / scale;
        const py = (rect.top  + yOf(nv)           + window.scrollY) / scale;
        const tw = this.tooltip.offsetWidth;
        const th = this.tooltip.offsetHeight;
        const margin = 8;
        const viewTop = window.scrollY / scale;
        let left = px - tw / 2;
        let top  = py - th - 12;                 // above the point
        if (top < viewTop + margin) top = py + 16; // not enough room above → below it
        left = Math.max(margin, Math.min(left, document.body.clientWidth - tw - margin));
        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top  = `${top}px`;
        if (pin) {
            this._tooltipPinned = true;
            this.tooltip.classList.add('pinned');
        }
    }

    hideChartTooltip(force = false) {
        // A pinned infobox only hides when explicitly dismissed (force = true).
        if (this._tooltipPinned && !force) return;
        this._tooltipPinned = false;
        if (this.tooltip) {
            this.tooltip.style.display = 'none';
            this.tooltip.classList.remove('pinned');
        }
    }

    // --- Cleanup ---

    startCleanupTimer() {
        this.cleanupInterval = setInterval(() => this.cleanup(), 10000);
    }

    // --- Durable storage: write-through, startup replay, downsampled views ---

    // How much recent history to keep materialised in RAM. Never more than the
    // retention bound; otherwise the larger of the display window and the render
    // budget, so Display changes within the budget need no disk round-trip.
    _ramWindowMs() {
        // Until the store finishes opening there is no disk to fall back to,
        // so keep everything that should be visible in RAM (bounded by
        // retention, else the display window, else unbounded). Once ready,
        // RAM is bounded by the render budget.
        if (!this._storeReady) {
            if (isFinite(this.HASH_LIFETIME)) return this.HASH_LIFETIME;
            if (isFinite(this.DISPLAY_LIFETIME)) return this.DISPLAY_LIFETIME;
            return Infinity;
        }
        const ret  = isFinite(this.HASH_LIFETIME) ? this.HASH_LIFETIME : Infinity;
        const disp = isFinite(this.DISPLAY_LIFETIME) ? this.DISPLAY_LIFETIME : 0;
        return Math.min(Math.max(disp, this.RENDER_BUDGET_MS), ret);
    }

    // Decide which database this tab uses. Data is isolated per browser tab so
    // two tabs capturing different devices never share a store (#5). Whenever
    // previous captured data would be brought back — a normal launch, a manual
    // reload, or an Android renderer-crash rebuild — the user is asked whether to
    // resume it or start fresh; nothing old is ever shown unannounced. Only an
    // empty session is continued silently (there's nothing to lose).
    async _chooseSession() {
        const mk = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const setTab = id => { try { sessionStorage.setItem('mc_tab', id); } catch (_) {} this._tabId = id; return 'meshcore-capture-' + id; };

        // The session this tab would continue: the just-crashed one on an Android
        // renderer rebuild (?recover=1, via mc_last_tab), otherwise the within-tab
        // reload's id (sessionStorage survives a reload).
        const isRecover = !!new URLSearchParams(location.search).get('recover');
        let cur = null;
        if (isRecover) {
            try {
                const last = JSON.parse(localStorage.getItem('mc_last_tab') || 'null');
                if (last && Date.now() - last.beat < 120000) cur = last.id;
            } catch (_) {}
        }
        if (!cur) { try { cur = sessionStorage.getItem('mc_tab'); } catch (_) {} }

        // Never bring back old data without asking — on a manual reload OR a
        // crash rebuild. If the continued session holds data, ask whether to
        // resume it or start fresh (declining discards it). An empty session is
        // resumed silently (nothing to lose).
        if (cur) {
            const e = this._readReg()[cur];
            if (e && e.count > 0) {
                const when = new Date(e.beat).toLocaleString();
                if (confirm(`Load previously captured data?\n\n${e.count} packets received, last seen ${when}.`)) {
                    return setTab(cur);
                }
                this._deleteSession(cur);     // declined → discard and start fresh
                return setTab(mk());
            }
            return setTab(cur);   // empty session → just keep it
        }

        // Normal launch: offer to resume the most recent closed session with data.
        // On Android there is only ever one WebView, so any other session is
        // closed; in a browser a recently-beating entry may be a live tab, so
        // require it to be quiet for a while before treating it as resumable.
        const isAndroid = !!(window.AndroidFiles || window.AndroidScreen || window.AndroidBle);
        const LIVE = isAndroid ? 3000 : 60000;
        const reg = this._readReg();
        const now = Date.now();
        const candidates = Object.entries(reg)
            .filter(([, e]) => e && e.count > 0 && now - e.beat > LIVE)
            .sort((a, b) => b[1].beat - a[1].beat);
        if (candidates.length) {
            const [id, e] = candidates[0];
            const when = new Date(e.beat).toLocaleString();
            if (confirm(`Load previously captured data?\n\n${e.count} packets received, last seen ${when}.`)) {
                for (const [oid] of candidates.slice(1)) this._deleteSession(oid);  // drop the rest
                return setTab(id);
            }
            for (const [oid] of candidates) this._deleteSession(oid);  // declined → discard all
        }
        this._gcStaleSessions();
        return setTab(mk());
    }

    _readReg() { try { return JSON.parse(localStorage.getItem('mc_db_reg') || '{}'); } catch (_) { return {}; } }
    _writeReg(reg) { try { localStorage.setItem('mc_db_reg', JSON.stringify(reg)); } catch (_) {} }

    _deleteSession(id) {
        try { indexedDB.deleteDatabase('meshcore-capture-' + id); } catch (_) {}
        const reg = this._readReg(); delete reg[id]; this._writeReg(reg);
    }

    // Mark this session alive and record its packet count, so a later launch can
    // offer to resume it. Also drops databases left by closed empty sessions.
    _startDbHeartbeat() {
        const beat = () => {
            try {
                localStorage.setItem('mc_last_tab', JSON.stringify({ id: this._tabId, beat: Date.now() }));
                const reg = this._readReg();
                reg[this._tabId] = { beat: Date.now(), count: this.totalRxCount || 0 };
                this._writeReg(reg);
            } catch (_) {}
        };
        beat();
        setInterval(beat, 15000);   // runs for the app's lifetime
    }

    // Garbage-collect databases of closed sessions that hold no data (stale and
    // empty). Sessions that hold data are handled by the resume prompt instead.
    _gcStaleSessions() {
        const reg = this._readReg();
        const now = Date.now(), STALE = 10 * 60 * 1000;
        let changed = false;
        for (const [id, e] of Object.entries(reg)) {
            if (id === this._tabId) continue;
            if (!e || (!e.count && now - (e.beat || 0) > STALE)) {
                try { indexedDB.deleteDatabase('meshcore-capture-' + id); } catch (_) {}
                delete reg[id]; changed = true;
            }
        }
        if (changed) this._writeReg(reg);
    }

    async _initStore() {
        const ok = await this.store.open(await this._chooseSession());
        if (!ok) {
            // IndexedDB is a hard requirement (available everywhere, including
            // private modes) — a failed open means a broken browser profile or
            // disabled site storage. Say so loudly rather than degrade silently;
            // _storeReady stays false (the app keeps its pre-storage startup
            // behaviour) and _storeDead stops the write buffers from growing
            // unbounded (nothing would ever drain them).
            this._storeDead = true;
            this._obsWriteBuf = [];
            this._sentWriteBuf = [];
            this._hashWriteBuf = [];
            alert('Storage error: the browser refused to open IndexedDB, so captured data cannot be saved or paged.\n\n'
                + (this.store.lastError?.message ?? 'Unknown cause')
                + '\n\nCheck that site data/storage is not blocked for this site.');
            return;
        }
        this._storeReady = true;
        this._startDbHeartbeat();
        this.store.onQuotaExceeded = () => this._onStorageQuota();
        try {
            const totals = await this.store.getKV('totals');
            if (totals && Number.isFinite(totals.totalRxCount)) this.totalRxCount = totals.totalRxCount;
        } catch (_) {}
        // Restore persisted contacts (names, GPS, types) so the repeater map
        // markers and column names survive a reload / renderer-crash rebuild.
        try {
            const saved = await this.store.getKV('contacts');
            if (saved && Array.isArray(saved.entries)) {
                for (const c of saved.entries) if (c?.pubKeyFullHex) this._contacts.set(c.pubKeyFullHex, c);
                if (Number.isFinite(saved.lastmod)) this._contactsLastmod = saved.lastmod;
                this._updateContactsCount();
            }
        } catch (_) {}
        await this._replayWindow();
        this._scheduleChartRender();
        this._renderMsgTable();
        this._renderRepTable();
        this._updateStats();
        this._updateMapPins();   // contacts restored above ⇒ show repeater markers
        this._refreshWideView();
        // No periodic wide-view tick: charts, map and table page 0 are all kept
        // current in RAM (bucket/cell upserts + the live row tail); writes flush
        // themselves via _scheduleWriteFlush. Disk is only read on view changes.
    }

    // Rebuild the in-RAM render window from disk by replaying the most recent
    // observations through the normal ingest path, so columns / collision state
    // reconstruct identically. Used on startup and after a renderer-crash reload.
    async _replayWindow() {
        const w = this._ramWindowMs();
        const from = isFinite(w) ? Date.now() - w : -Infinity;
        const obsList = [];
        await this.store.eachObs(from, Infinity, r => { obsList.push(r); });
        if (obsList.length) {
            const hashMeta = new Map();
            for (const h of new Set(obsList.map(o => o.hash))) {
                const rec = await this.store.getHash(h);
                if (rec) hashMeta.set(h, rec);
            }
            const savedTotal = this.totalRxCount, savedUnsaved = this._unsavedRxCount;
            for (const o of obsList) {
                const hm = hashMeta.get(o.hash) ?? {};
                this._ingestPacket(o.hash, o.rawId, hm.type ?? null, o.rawHex ?? hm.rawHex ?? null,
                    o.snr ?? null, o.rssi ?? null, hm.meta ?? {}, null,
                    { importing: true, replaying: true, timestamp: o.time,
                      lat: o.lat ?? undefined, lon: o.lon ?? undefined, remoteSnr: o.remoteSnr });
            }
            // Counters are authoritative from kv, not from the (windowed) replay.
            this.totalRxCount = savedTotal; this._unsavedRxCount = savedUnsaved;
        }
        await this.store.eachSent(from, Infinity, r => {
            this._sentSnrHistory.push({ time: r.time, snr: r.snr, col: r.rawId, label: r.label, lat: r.lat ?? null, lon: r.lon ?? null });
        });
    }

    // Write-through: buffer an observation (and, for a new hash, its
    // path-invariant payload) and schedule a debounced flush to disk.
    _ingestToStore(o, isNewHash) {
        if (this._storeDead) return;
        this._obsWriteBuf.push({
            time: o.now, hash: o.hash, rawId: o.repeater, rawHex: o.rawHex ?? null,
            snr: o.snr ?? null, rssi: o.rssi ?? null,
            lat: o.loc?.lat ?? null, lon: o.loc?.lon ?? null,
            ...(o.remoteSnr != null ? { remoteSnr: o.remoteSnr } : {}),
        });
        if (isNewHash) {
            // Buffered like obs (flushed in one batched transaction) — an
            // immediate per-hash write would cost one transaction per new hash.
            this._hashWriteBuf.push({ hash: o.hash, firstSeen: o.now, type: o.type ?? null, meta: o.meta ?? null });
        }
        this._scheduleWriteFlush();
    }

    _scheduleWriteFlush() {
        if (this._writeFlushTimer || this._storeDead) return;
        this._writeFlushTimer = setTimeout(() => {
            this._writeFlushTimer = null;
            if (!this._storeReady) {
                // DB not open yet (startup): keep buffering and retry. If the
                // open failed, _initStore sets _storeDead and clears buffers.
                if (!this._storeDead && (this._obsWriteBuf.length || this._sentWriteBuf.length || this._hashWriteBuf.length)) this._scheduleWriteFlush();
                return;
            }
            const obs  = this._obsWriteBuf;  this._obsWriteBuf  = [];
            const sent = this._sentWriteBuf; this._sentWriteBuf = [];
            const hs   = this._hashWriteBuf; this._hashWriteBuf = [];
            if (hs.length)   this.store.putHashes(hs);   // before obs: readers join obs → hashes
            if (obs.length)  this.store.putObs(obs);
            if (sent.length) this.store.putSent(sent);
            if (obs.length || sent.length || hs.length) this._dataVer++;
            this.store.setKV('totals', { totalRxCount: this.totalRxCount });
        }, this.WRITE_FLUSH_MS);
    }

    _onStorageQuota() {
        // Disk full: keep the newest history by trimming the oldest on disk down
        // to the render budget. The session keeps running on its RAM window.
        if (this._quotaPruning || !this._storeReady) return;
        this._quotaPruning = true;
        this.store.pruneOlderThan(Date.now() - this.RENDER_BUDGET_MS)
            .then(n => this._afterDiskPrune(n))
            .finally(() => { this._quotaPruning = false; });
    }

    // Resolve a rawId to an existing column WITHOUT mutating the column model
    // (used to colour downsampled overlay points; live ingest uses
    // findOrCreateColumn, which may promote/merge).
    _resolveColReadonly(rawId) {
        if (rawId === 'direct' || rawId === 'unknown') return rawId;
        if (this.repeaterColumns.includes(rawId)) return rawId;
        for (const col of this.repeaterColumns) {
            if (col === 'direct' || col === 'unknown') continue;
            const head = col.split('/')[0];
            const p = Math.min(this.idPrecision(rawId), this.idPrecision(head));
            if (this.idSuffix(head, p) === this.idSuffix(rawId, p)) return col;
        }
        return rawId;
    }

    // (Re)build the disk render caches (chart overlay, map grid, paginated table)
    // for the current Display window. Called on Display-window change. Pre-ready
    // the caches stay empty and the views render from the RAM tail alone (same
    // code path, no separate branch).
    async _refreshWideView() {
        if (!this._storeReady) return;
        this._lastMapView = null;       // new window → start from full extent
        this._wideMapBase = null;       // window changed → recompute the base layer
        this._wideMapDetail = null;
        this._wideMapKey = null;
        this._chartBase = null;         // window changed → rebuild the bucket cache
        this._chartZoomLayer = null;
        await this._flushWrites();
        const boundary = Date.now();    // set _renderCacheAt only after caches land
        try {
            await Promise.all([
                this._refreshWideMap(),       // spatial downsample for the 3D map
                this._loadTablePage(0, true), // paginate the packet table over disk
                this._rebuildChartBase(),     // time-bucket cache for the 2D charts
            ]);
            this._renderCacheAt = boundary;
        } catch (e) {
            console.warn('Wide-view rebuild failed:', e);
        }
    }

    // --- 2D-chart bucket cache -------------------------------------------
    // Same model as the 3D map's cell cache: an in-RAM Map of time buckets
    // (key `rawId|bIdx`), kept current by folding each live packet into its bucket
    // (_upsertChartCell). Time buckets expire exactly — a bucket covers a fixed
    // time range, so once its end leaves a finite Display window it is provably
    // empty and is dropped. Disk is read only to BUILD a layer:
    //   - base:  once per Display window (and a growth escape valve for "All"),
    //   - zoom:  on zoom-in / zoom-window change (finer buckets over the window).
    // Zooming OUT needs no disk at all — the base stays maintained by upserts.

    // Re-establish the wide/All chart bucket cache if it is missing during live
    // capture. That cache is the ONLY source the charts read in a wide window
    // (see _visibleChartPoints), and _upsertChartCell cannot fold into a null
    // base — so if a build ever fails (the catch below) or is dropped, nothing
    // else would rebuild it until the next Display change, freezing the charts
    // at their last state while disk and the 3D map keep filling. Self-heal,
    // debounced and non-overlapping, so capture recovers on its own.
    _ensureChartBase() {
        if (!this._storeReady || this._chartBaseBuilding) return;
        if (Date.now() - this._chartBaseHealAt < 1000) return;
        this._chartBaseHealAt = Date.now();
        this._chartBaseBuilding = true;
        this._rebuildChartBase().finally(() => { this._chartBaseBuilding = false; });
    }

    async _rebuildChartBase() {
        if (!this._storeReady) return;
        // Standalone callers (escape valve, self-heal) may have unflushed writes;
        // flush so the rebuilt base includes the packets that triggered it.
        await this._flushWrites();
        // Pin the window this build is for; if Display changes while we await disk
        // a newer build owns the base, so discard this (possibly different-window)
        // result rather than clobbering it.
        const lifetime = this.DISPLAY_LIFETIME;
        const from = isFinite(lifetime) ? Date.now() - lifetime : -Infinity;
        try {
            const { buckets, width, lo } = await this.store.bucketObs(from, Infinity, this.DOWNSAMPLE_BUCKETS);
            if (this.DISPLAY_LIFETIME !== lifetime) return;
            const cells = new Map();
            for (const b of buckets) cells.set(b.rawId + '|' + b.bIdx, b);
            this._chartBase = { cells, width, lo };
            const sent = [];
            await this.store.eachSent(from, Infinity, r =>
                sent.push({ time: r.time, snr: r.snr, col: this._resolveColReadonly(r.rawId), label: r.label }));
            this._wideSentPoints = sent;
            this._sentChartAt = Date.now();   // live sent points after this are the tail
            this._rebuildChartArrays();
            this._restoreRepStatsFromBase();
        } catch (e) {
            console.warn('Chart base build failed:', e);
        }
    }

    // Restore Seen Repeaters entries from the disk chart layer. The live model
    // (allRepeaters) exists only in RAM, bounded by the RAM window (~60 min):
    // when a repeater's points age out of it, cleanup's _rebuildAfterPrune
    // dissolves the entry. But the Display window can be wider ("All"), where
    // those repeaters are still in range and live on disk — so re-seed them from
    // the (incrementally maintained, Display-window) chart cache. Runs both on a
    // fresh base build (Display change / startup) and after every prune. Live
    // entries are exact and win; only count/maxes are widened from disk.
    // Restored last SNR/RSSI are the real newest readings (the bucket records the
    // last value per metric, like live ingestion); only lastSeen is approximate
    // (≈ the newest bucket's midpoint).
    _restoreRepStatsFromBase() {
        const base = this._chartBase;
        if (!base) return;
        const agg = new Map();
        for (const b of base.cells.values()) {
            const col = this._resolveColReadonly(b.rawId);
            let a = agg.get(col);
            if (!a) {
                a = { count: 0, lastSeen: -1, maxSnr: null, maxRssi: null,
                      lastSnr: null, lastRssi: null, minPrecision: Infinity,
                      _lastSnrT: -Infinity, _lastRssiT: -Infinity };
                agg.set(col, a);
            }
            a.count += b.count;
            if (b.snrMax  != null && (a.maxSnr  == null || b.snrMax  > a.maxSnr))  a.maxSnr  = b.snrMax;
            if (b.rssiMax != null && (a.maxRssi == null || b.rssiMax > a.maxRssi)) a.maxRssi = b.rssiMax;
            if (b.time > a.lastSeen) a.lastSeen = b.time;
            // True last SNR/RSSI: the newest actual reading across buckets, each
            // tracked by its own observation time, exactly as live ingestion keeps
            // the last non-null value per metric (independent — the latest packet
            // with an RSSI may differ from the latest with an SNR).
            if (b.lastSnr  != null && b.lastSnrT  > a._lastSnrT)  { a._lastSnrT  = b.lastSnrT;  a.lastSnr  = b.lastSnr; }
            if (b.lastRssi != null && b.lastRssiT > a._lastRssiT) { a._lastRssiT = b.lastRssiT; a.lastRssi = b.lastRssi; }
            const prec = this.idPrecision(b.rawId);
            if (prec < a.minPrecision) a.minPrecision = prec;
        }
        let changed = false;
        for (const [col, a] of agg) {
            const live = this.allRepeaters.get(col);
            if (live) {
                // Keep the exact live lastSeen/last values; widen the totals.
                if (a.count > live.count) { live.count = a.count; changed = true; }
                if (a.maxSnr  != null && (live.maxSnr  == null || a.maxSnr  > live.maxSnr))  { live.maxSnr  = a.maxSnr;  changed = true; }
                if (a.maxRssi != null && (live.maxRssi == null || a.maxRssi > live.maxRssi)) { live.maxRssi = a.maxRssi; changed = true; }
                continue;
            }
            if (!Number.isFinite(a.minPrecision)) a.minPrecision = this.idPrecision(col.split('/')[0]);
            this.allRepeaters.set(col, a);
            if (!this.repeaterColumns.includes(col)) this.repeaterColumns.push(col);
            changed = true;
        }
        if (changed) {
            this._sortColumns();
            this._renderRepTable();
            this._updateStats();
        }
    }

    // Finer buckets over the (padded) zoom window, so zooming in reveals real
    // detail instead of magnifying the base's coarse buckets. The ±1-span pad
    // gives _decimateChartPts a neighbour point outside each edge for the
    // edge-crossing connecting lines (the clip trims the overshoot).
    async _rebuildChartZoomLayer() {
        const z = this._chartZoom;
        if (!z || !this._storeReady) return;
        const zspan = z.tMax - z.tMin;
        try {
            const { buckets, width, lo } = await this.store.bucketObs(z.tMin - zspan, z.tMax + zspan, this.DOWNSAMPLE_BUCKETS);
            const cells = new Map();
            for (const b of buckets) cells.set(b.rawId + '|' + b.bIdx, b);
            this._chartZoomLayer = { cells, width, lo, from: z.tMin - zspan, to: z.tMax + zspan };
            this._rebuildChartArrays();
        } catch (e) {
            console.warn('Chart zoom-layer build failed:', e);
        }
    }

    // Fold one live observation into the chart bucket layers (base always, the
    // zoom layer when the time falls inside it).
    _upsertChartCell(time, snr, rssi, rawId) {
        const fold = layer => {
            const bIdx = Math.floor((time - layer.lo) / layer.width);
            const key = rawId + '|' + bIdx;
            let g = layer.cells.get(key);
            if (!g) {
                g = { rawId, bIdx, time: layer.lo + bIdx * layer.width + Math.floor(layer.width / 2),
                      count: 0, snrMin: null, snrMax: null, snrSum: 0, snrN: 0,
                      rssiMin: null, rssiMax: null, rssiSum: 0, rssiN: 0,
                      lastSnrT: -Infinity, lastSnr: null, lastRssiT: -Infinity, lastRssi: null };
                layer.cells.set(key, g);
            }
            g.count++;
            if (snr != null) {
                g.snrSum += snr; g.snrN++;
                if (g.snrMin == null || snr < g.snrMin) g.snrMin = snr;
                if (g.snrMax == null || snr > g.snrMax) g.snrMax = snr;
                if (time >= (g.lastSnrT ?? -Infinity)) { g.lastSnrT = time; g.lastSnr = snr; }
            }
            if (rssi != null) {
                g.rssiSum += rssi; g.rssiN++;
                if (g.rssiMin == null || rssi < g.rssiMin) g.rssiMin = rssi;
                if (g.rssiMax == null || rssi > g.rssiMax) g.rssiMax = rssi;
                if (time >= (g.lastRssiT ?? -Infinity)) { g.lastRssiT = time; g.lastRssi = rssi; }
            }
            return bIdx;
        };
        const base = this._chartBase;
        if (!base) { this._ensureChartBase(); return; }   // self-heal; the point is on disk
        const bIdx = fold(base);
        // "All" keeps a fixed bucket width from its build, so a long session can
        // outgrow the bucket budget — rebuild once with a wider bucket when the
        // index runs 3x past it. (Finite windows slide: the index grows but the
        // live bucket count stays ~constant via expiry, so no rebuild is needed.)
        if (!isFinite(this.DISPLAY_LIFETIME) && bIdx > this.DOWNSAMPLE_BUCKETS * 3) {
            this._chartBase = null;
            this._ensureChartBase();
            return;
        }
        const zl = this._chartZoomLayer;
        if (zl && time >= zl.from && time <= zl.to) fold(zl);
        this._scheduleChartArrays();
    }

    _scheduleChartArrays() {
        if (this._chartArrTimer) return;
        this._chartArrTimer = setTimeout(() => { this._chartArrTimer = null; this._rebuildChartArrays(); }, 200);
    }

    // Derive the render array (_wideChartPoints) from the active bucket layer:
    // avg point per bucket, plus min/max spread once a bucket holds >1 packet.
    // Also purges base buckets that expired from a finite Display window (exact —
    // the bucket's whole time range is past the cutoff).
    _rebuildChartArrays() {
        const base = this._chartBase;
        if (!base) return;
        const cutoff = this._displayCutoffNow();
        if (cutoff) {
            for (const [k, b] of base.cells) {
                if (base.lo + (b.bIdx + 1) * base.width < cutoff) base.cells.delete(k);
            }
        }
        // Use the zoom layer only while it actually covers the current zoom
        // window — after a pan/zoom change the stale layer would be missing the
        // newly exposed range, so fall back to the (complete, coarser) base
        // until the rebuilt layer lands.
        const zl = this._chartZoomLayer;
        const z = this._chartZoom;
        const layer = (z && zl && zl.from <= z.tMin && zl.to >= z.tMax) ? zl : base;
        const cps = [];
        for (const b of layer.cells.values()) {
            const col = this._resolveColReadonly(b.rawId);
            const snrAvg  = b.snrN  ? b.snrSum  / b.snrN  : null;
            const rssiAvg = b.rssiN ? b.rssiSum / b.rssiN : null;
            cps.push({ time: b.time, snr: snrAvg, rssi: rssiAvg, col, rawId: b.rawId, _bucket: true, count: b.count });
            if (b.count > 1) {
                if (b.snrMin != null) cps.push({ time: b.time, snr: b.snrMin, rssi: b.rssiMin, col, rawId: b.rawId, _bucket: true });
                if (b.snrMax != null) cps.push({ time: b.time, snr: b.snrMax, rssi: b.rssiMax, col, rawId: b.rawId, _bucket: true });
            }
        }
        cps.sort((a, b) => a.time - b.time);
        this._wideChartPoints = cps;
        this._scheduleChartRender();
    }

    // Flush buffered writes to disk immediately (so a following query sees the
    // newest packets). Used before export and before each live wide-view refresh.
    async _flushWrites() {
        if (!this._storeReady) return;
        if (this._writeFlushTimer) { clearTimeout(this._writeFlushTimer); this._writeFlushTimer = null; }
        const dirty = this._hashWriteBuf.length || this._obsWriteBuf.length || this._sentWriteBuf.length;
        if (this._hashWriteBuf.length) { const h = this._hashWriteBuf; this._hashWriteBuf = []; await this.store.putHashes(h); }
        if (this._obsWriteBuf.length)  { const o = this._obsWriteBuf;  this._obsWriteBuf  = []; await this.store.putObs(o); }
        if (this._sentWriteBuf.length) { const s = this._sentWriteBuf; this._sentWriteBuf = []; await this.store.putSent(s); }
        if (dirty) this._dataVer++;
    }

    // The 3D map renders from an in-RAM cell cache (per-repeater spatial grid).
    // Disk is read only to BUILD a layer — never periodically:
    //
    //  - BASE: a coarse grid over the FULL extent, built once per Display window
    //    (and when the dot budget overflows). New packets upsert their cell
    //    directly in RAM (_upsertMapCell), so the map is current without any
    //    rescan. Because a cell's representative is its MOST RECENT observation,
    //    expiry is exact too: when the representative leaves a finite Display
    //    window, the whole cell is provably empty and is dropped (render-side
    //    the rolling cutoff hides it; _pushMapPoints purges the Map).
    //  - DETAIL: when zoomed into a sub-region, a finer grid for the visible
    //    bbox only (cheap — Morton-indexed), rebuilt on view change. Live
    //    packets inside the bbox upsert this layer too.
    //
    // Cell size is estimated up-front from extent area and a target dot budget,
    // clamped to ~4 screen px at the current zoom; output stays bounded
    // (≤ ~2× target) regardless of how many packets the span holds.

    // Same cell key math as PacketStore.gridObs, so RAM upserts and disk-built
    // layers agree on cell identity.
    _mapCellKey(cellMeters, rawId, lat, lon) {
        const latCell = cellMeters / 111320;
        const lonCell = cellMeters / (111320 * Math.cos(lat * Math.PI / 180) || 1);
        return rawId + '|' + Math.round(lon / lonCell) + '|' + Math.round(lat / latCell);
    }

    _mapCellsFrom(arr, cellMeters) {
        const m = new Map();
        for (const r of arr) m.set(this._mapCellKey(cellMeters, r.rawId, r.lat, r.lon), r);
        return m;
    }

    // Fold one live observation into the RAM cell layers. The new point is by
    // definition the newest in its cell, so it always becomes the representative.
    _upsertMapCell(o) {
        const base = this._wideMapBase;
        if (!base) {   // layers not built yet (startup race) — apply after build
            (this._pendingMapUpserts ??= []).length < 1000 && this._pendingMapUpserts.push(o);
            return;
        }
        if (!base.cell) base.cell = 5;   // first-ever point: gridObs' minimum cell
        const bKey = this._mapCellKey(base.cell, o.rawId, o.lat, o.lon);
        base.cells.set(bKey, { ...o, count: (base.cells.get(bKey)?.count ?? 0) + 1 });
        const d = this._wideMapDetail;
        if (d && o.lat >= d.bbox.minLat && o.lat <= d.bbox.maxLat
              && o.lon >= d.bbox.minLon && o.lon <= d.bbox.maxLon) {
            const dKey = this._mapCellKey(d.cell, o.rawId, o.lat, o.lon);
            d.cells.set(dKey, { ...o, count: (d.cells.get(dKey)?.count ?? 0) + 1 });
        }
        // Walking into new territory at the 5 m floor can blow the dot budget —
        // rebuild the base once with a properly sized cell when it does.
        if (base.cells.size > this.MAP_TARGET_DOTS * 3 && !this._mapRebuildBusy) {
            this._mapRebuildBusy = true;
            this._wideMapBase = null;
            this._refreshWideMap(this._lastMapView?.bbox ?? null, this._lastMapView?.mpp ?? null)
                .finally(() => { this._mapRebuildBusy = false; });
            return;
        }
        this._scheduleMapPush();
    }

    // Hand the merged cell layers to the map, coalesced so a packet burst costs
    // one geometry rebuild. Also purges cells that left a finite Display window
    // (exact — see header comment).
    _scheduleMapPush() {
        if (this._mapPushTimer) return;
        this._mapPushTimer = setTimeout(() => { this._mapPushTimer = null; this._pushMapPoints(); }, 200);
    }

    _pushMapPoints() {
        const base = this._wideMapBase;
        if (!base) return;
        const cutoff = this._displayCutoffNow();
        if (cutoff) {
            for (const [k, p] of base.cells) if (p.time < cutoff) base.cells.delete(k);
            const d = this._wideMapDetail;
            if (d) for (const [k, p] of d.cells) if (p.time < cutoff) d.cells.delete(k);
        }
        const d = this._wideMapDetail;
        let merged;
        if (d) {
            const inB = p => p.lat >= d.bbox.minLat && p.lat <= d.bbox.maxLat
                          && p.lon >= d.bbox.minLon && p.lon <= d.bbox.maxLon;
            merged = [...base.cells.values()].filter(p => !inB(p)).concat([...d.cells.values()]);
        } else {
            merged = [...base.cells.values()];
        }
        this.signalMap?.setHistoricalPoints?.(merged.map(r => ({
            lat: r.lat, lon: r.lon, snr: r.snr, rssi: r.rssi, time: r.time,
            rawId: r.rawId, col: this._resolveColReadonly(r.rawId), count: r.count,
        })));
    }

    async _refreshWideMap(bbox = null, mpp = null) {
        if (!this._storeReady) return;
        const from = isFinite(this.DISPLAY_LIFETIME) ? Date.now() - this.DISPLAY_LIFETIME : -Infinity;
        const TARGET_DOTS = this.MAP_TARGET_DOTS;
        // sqrt(area / target) spreads ~TARGET_DOTS cells across the extent.
        const cellFor = (minLat, maxLat, minLon, maxLon) => {
            const midLat = (minLat + maxLat) / 2;
            const latM = Math.max(1, (maxLat - minLat) * 111320);
            const lonM = Math.max(1, (maxLon - minLon) * 111320 * Math.cos(midLat * Math.PI / 180));
            return Math.max(5, Math.sqrt((latM * lonM) / TARGET_DOTS));
        };
        try {
            // Outgoing (sent) SNR is low-volume and has no spatial index, so load
            // the whole window when (re)building; live ones arrive via the sent
            // tail in signal3d.
            if (this._wideMapSentVer !== this._dataVer) {
                const sentPts = [];
                await this.store.eachSent(from, Infinity, r => {
                    if (r.lat == null || r.lon == null) return;
                    sentPts.push({ lat: r.lat, lon: r.lon, snr: r.snr, time: r.time,
                                   rawId: r.rawId, col: this._resolveColReadonly(r.rawId) });
                });
                this.signalMap?.setHistoricalSentPoints?.(sentPts);
                this._wideMapSentVer = this._dataVer;
            }
            // Build the base layer only when absent (Display change nulls it).
            // Freshness and expiry are handled in RAM — no periodic rescan.
            if (!this._wideMapBase) {
                await this._flushWrites();   // the disk build must include everything buffered
                const s = await this.store.regionStats(from, Infinity, null);
                if (s.count) {
                    const cell = cellFor(s.minLat, s.maxLat, s.minLon, s.maxLon);
                    const pts = await this.store.gridObs(from, Infinity, cell, null);
                    this._wideMapBase = { cells: this._mapCellsFrom(pts, cell), cell, at: Date.now() };
                } else {
                    this._wideMapBase = { cells: new Map(), cell: 0, at: Date.now() };
                }
                this._wideMapKey = null;
                // Packets that arrived while there was no base yet (startup race)
                const pend = this._pendingMapUpserts;
                this._pendingMapUpserts = null;
                if (pend) for (const o of pend) this._upsertMapCell(o);
            }
            const base = this._wideMapBase;
            // Detail cell is derived from the view bbox itself (it IS the region
            // whose dot density matters) — no extra disk scan needed for sizing.
            let dCell = 0;
            if (bbox && base.cells.size) {
                dCell = Math.max(cellFor(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon), (mpp ?? 0) * 4);
                if (dCell >= base.cell) dCell = 0;   // would not refine — base alone suffices
            }
            // Skip the disk re-query when the same view is already loaded —
            // panning around an already-loaded region costs nothing.
            const key = dCell
                ? `${base.at}|${Math.round(dCell)}|`
                  + [bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon].map(v => Math.round(v * 1e4)).join(',')
                : `${base.at}|base`;
            if (key === this._wideMapKey) return;
            if (dCell) {
                await this._flushWrites();   // fine grid must include the freshest packets
                const fine = await this.store.gridObs(from, Infinity, dCell, bbox);
                this._wideMapDetail = { cells: this._mapCellsFrom(fine, dCell), cell: dCell, bbox };
            } else {
                this._wideMapDetail = null;
            }
            this._pushMapPoints();
            this._wideMapKey = key;
        } catch (e) {
            console.warn('Wide-map load failed:', e);
        }
    }

    // --- Packet table pagination over disk history (wide / "All" view) ---

    // The current disk page snapshot. Callers fall back to live hashData for
    // tail rows (packets newer than the snapshot) via `?? this.hashData.get(h)`.
    _tableSource() {
        return this._tablePageData;
    }

    // Build one page of the table from disk: the newest `_tablePageSize` hashes
    // (by firstSeen) and all their observations, assembled into hashData-shaped
    // entries so _renderMsgTable can render them unchanged.
    // The column predicate that narrows which packets the table shows, or null
    // when it shows everything. A repeater SELECTION (single column) takes
    // precedence over a filter, since selection always hides rows lacking that
    // exact repeater — even within an active filter. Drives both the paged hash
    // index and the page-0 live-tail skip so narrowed pages are never padded
    // with hidden rows.
    _tableNarrowFn() {
        if (this._selectedCol) { const s = this._selectedCol; return c => c === s; }
        if (this._repFilterTerms.length) return c => this._colMatchesRepFilter(c);
        return null;
    }
    _tableNarrowKey() {
        if (this._selectedCol) return 's:' + this._selectedCol;
        if (this._repFilterTerms.length) return 'f:' + this._repFilterTerms.join('\x1f');
        return '';
    }

    // Repaginate the table from page 0 when the narrowing (filter or selection)
    // changed. Called from both the filter and the selection paths.
    _repaginateIfNarrowChanged() {
        const key = this._tableNarrowKey();
        if (key === this._tableNarrowKeyApplied) return;
        this._tableNarrowKeyApplied = key;
        if (this._storeReady) this._loadTablePage(0, true);
        // Pre-ready there is no pager yet, but the live tail still skips
        // narrowed-out rows — re-render so widening brings them back into the DOM.
        else this._renderMsgTable();
    }

    async _loadTablePage(page, reset = false) {
        if (!this._storeReady) return;
        await this._flushWrites();   // the page must include still-buffered packets
        const boundary = Date.now(); // snapshot covers disk up to here (tail base)
        if (reset) {
            this._tablePage = 0;
            // The underlying data may have changed (replay/import/prune/narrow
            // change) — any narrow index is stale.
            this._tableNarrowHashes = this._tableNarrowSet = null;
        }
        const size = this._tablePageSize;
        // The table respects the Display window: pages cover only packets first
        // seen inside it (the firstSeen index makes that a range scan).
        const winFrom = this._displayCutoffNow() || undefined;
        // Authoritative count from disk; between loads it is maintained in RAM
        // (incremented per new hash at ingest) so the pager needs no disk reads.
        this._tableHashCount = await this.store.countHashes(winFrom);
        this._tableNarrowKeyApplied = this._tableNarrowKey();
        const narrowed = this._tableNarrowFn() != null;
        if (narrowed && !this._tableNarrowHashes) await this._buildTableNarrowIndex();
        if (!narrowed) this._tableNarrowHashes = this._tableNarrowSet = null;
        const total = narrowed ? this._tableNarrowHashes.length : this._tableHashCount;
        this._tablePageCount = Math.max(1, Math.ceil(total / size));
        this._tablePage = Math.min(Math.max(0, page), this._tablePageCount - 1);
        const hashes = narrowed
            ? await this.store.getHashes(this._tableNarrowHashes.slice(this._tablePage * size, (this._tablePage + 1) * size))
            : await this.store.pageHashes(this._tablePage * size, size, winFrom);
        const map = new Map();
        for (const h of hashes) {
            const obs = await this.store.obsForHash(h.hash);
            if (!obs.length) continue;
            const repeaters = new Map();
            let firstSeen = h.firstSeen ?? Infinity, lastSeen = 0;
            for (const o of obs) {
                const col = this._resolveColReadonly(o.rawId);
                const rep = { snr: o.snr, rssi: o.rssi, rawHex: o.rawHex, rawId: o.rawId,
                              time: o.time, lat: o.lat, lon: o.lon, remoteSnr: o.remoteSnr, packet: null };
                // Keep the strongest-RSSI observation per column (matches live merge intent).
                const prev = repeaters.get(col);
                if (!prev || (rep.rssi != null && (prev.rssi == null || rep.rssi > prev.rssi))) repeaters.set(col, rep);
                if (o.time < firstSeen) firstSeen = o.time;
                if (o.time > lastSeen)  lastSeen  = o.time;
            }
            map.set(h.hash, { repeaters, firstSeen, lastSeen, type: h.type, meta: h.meta,
                              rawHex: obs[0].rawHex, packet: null, _stub: false });
        }
        this._tablePageData = map;
        this._renderCacheAt = boundary;   // rows newer than this are the live tail
        this._renderMsgTable();
        this._refreshTablePager();
    }

    // Build the narrowed hash index: every hash with at least one observation
    // from a matching repeater, newest-first by the time that repeater first
    // heard it. One chunked scan over the obs store; the rawId → matches
    // projection is memoised since rawIds repeat heavily.
    async _buildTableNarrowIndex() {
        const narrowFn = this._tableNarrowFn();
        const matchByRawId = new Map();
        const firstHeard = new Map();   // hash -> earliest matching obs time
        // Scan only the Display window — the pager shows nothing older anyway.
        await this.store.eachObs(this._displayCutoffNow() || -Infinity, Infinity, o => {
            let ok = matchByRawId.get(o.rawId);
            if (ok === undefined) {
                ok = narrowFn(this._resolveColReadonly(o.rawId));
                matchByRawId.set(o.rawId, ok);
            }
            // eachObs iterates ascending time, so the first sighting is the earliest.
            if (ok && !firstHeard.has(o.hash)) firstHeard.set(o.hash, o.time);
        });
        this._tableNarrowHashes = [...firstHeard.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([h]) => h);
        this._tableNarrowSet = new Set(this._tableNarrowHashes);
        this._tableNarrowIndexKey = this._tableNarrowKey();
    }

    // Insert / update / remove the prev-next pager beneath the packet table.
    _refreshTablePager() {
        const scroll = this.msgTableHead?.closest('.msg-table-scroll');
        if (!scroll) return;
        let pager = document.getElementById('msgTablePager');
        // Only show the pager when there is more than one page — a single page
        // (the common live case) reads like the old scrollable table.
        const showPager = this._tablePageCount > 1;
        if (!showPager) { pager?.remove(); return; }
        if (!pager) {
            pager = document.createElement('div');
            pager.id = 'msgTablePager';
            pager.className = 'msg-table-pager';
            pager.innerHTML = '<button id="msgPagePrev" class="pager-btn">‹ Newer</button>'
                + '<span id="msgPageInfo" class="pager-info"></span>'
                + '<button id="msgPageNext" class="pager-btn">Older ›</button>';
            scroll.parentNode.insertBefore(pager, scroll.nextSibling);
            pager.querySelector('#msgPagePrev').addEventListener('click', () => this._loadTablePage(this._tablePage - 1));
            pager.querySelector('#msgPageNext').addEventListener('click', () => this._loadTablePage(this._tablePage + 1));
        }
        const narrowTag = this._tableNarrowHashes
            ? (this._selectedCol ? ' (selected)' : ' (filtered)') : '';
        pager.querySelector('#msgPageInfo').textContent =
            `Page ${this._tablePage + 1} / ${this._tablePageCount}${narrowTag}`;
        pager.querySelector('#msgPagePrev').disabled = this._tablePage <= 0;
        pager.querySelector('#msgPageNext').disabled = this._tablePage >= this._tablePageCount - 1;
    }

    cleanup() {
        const now = Date.now();
        // RAM is bounded by the render budget (and never exceeds retention).
        // Disk keeps full history when Auto-remove is "Never"; when it is finite,
        // history is truly deleted from disk too.
        if (isFinite(this.HASH_LIFETIME) && this._storeReady) {
            this.store.pruneOlderThan(now - this.HASH_LIFETIME)
                .then(n => this._afterDiskPrune(n));
        }
        // Safety net: if the wide/All chart cache went missing (a failed rebuild)
        // it would otherwise stay null until the next Display change, freezing the
        // charts. Re-establish it here too, in case no packet arrives to do so.
        if (this._storeReady && !this._chartBase) this._ensureChartBase();
        const lifetime = this._ramWindowMs();
        const toRemove = [];
        for (const [hash, data] of this.hashData.entries()) {
            if (now - data.lastSeen > lifetime) toRemove.push(hash);
        }

        if (!toRemove.length) {
            // No hashData expired, but chartPoints / map points may still need pruning
            if (isFinite(lifetime)) {
                const cutoff = now - lifetime;
                const before = this.chartPoints.length;
                this.chartPoints = this.chartPoints.filter(p => p.time >= cutoff);
                this._sentSnrHistory = this._sentSnrHistory.filter(p => p.time >= cutoff);
                this.signalMap?.purgeOlderThan(cutoff);
                if (this.chartPoints.length !== before) this._rebuildAfterPrune();
            }
            const prev = this.repeaterColumns.join('|');
            this._sortColumns();
            if (this.repeaterColumns.join('|') !== prev) this._renderMsgTable();
            return;
        }

        for (const hash of toRemove) {
            document.getElementById(`row-${hash}`)?.classList.add('row-removing');
            document.getElementById(`detail-${hash}`)?.remove();
        }

        setTimeout(() => {
            const cutoff = Date.now() - lifetime;
            for (const hash of toRemove) {
                const data = this.hashData.get(hash);
                if (data && data.lastSeen <= cutoff) this.hashData.delete(hash);
            }
            if (isFinite(lifetime)) {
                this.chartPoints = this.chartPoints.filter(p => p.time >= cutoff);
                this._sentSnrHistory = this._sentSnrHistory.filter(p => p.time >= cutoff);
            }
            this.signalMap?.purgeOlderThan(cutoff);
            this._rebuildAfterPrune();
            this._sortColumns();
            this._renderMsgTable();
            this._renderRepTable();
            this._updateStats();
            if (this.hashData.size === 0 && this.emptyState) this.emptyState.classList.remove('hidden');
        }, 400);
    }

    // After chartPoints have been pruned: dissolve stale collision columns,
    // recompute repeater stats, and clean up empty columns.
    _rebuildAfterPrune() {
        // Step 1: Demote specific columns whose precise label has no remaining evidence.
        // Example: column "1234" promoted from "12"; if the "1234" packet expired but
        // "12" packets remain, the column label must revert to "12".
        for (const col of [...this.repeaterColumns]) {
            if (col.includes('/') || col === 'direct' || col === 'unknown') continue;
            const colPrec = this.idPrecision(col);
            let maxPrec = 0, bestRawId = null;
            for (const p of this.chartPoints) {
                if (p.col !== col || !p.rawId) continue;
                const rp = this.idPrecision(p.rawId);
                if (rp > maxPrec) { maxPrec = rp; bestRawId = p.rawId; }
            }
            if (bestRawId && maxPrec < colPrec) {
                const oldCol = col;
                this.renameColumnKey(oldCol, bestRawId);
                // Mirror the demotion into every collision key that had oldCol as a component
                for (const ck of [...this.repeaterColumns]) {
                    if (!ck.includes('/')) continue;
                    const comps = ck.split('/');
                    if (!comps.includes(oldCol)) continue;
                    const newCk = comps.map(c => c === oldCol ? bestRawId : c).sort().join('/');
                    if (newCk !== ck) this.renameColumnKey(ck, newCk);
                }
            }
        }

        // Step 2: Dissolve collision columns whose component set shrank
        const activeSpecific = new Set();
        for (const p of this.chartPoints) {
            if (!p.col.includes('/')) activeSpecific.add(p.col);
        }

        for (const col of [...this.repeaterColumns]) {
            if (!col.includes('/')) continue;
            const comps = col.split('/');
            const survivors = comps.filter(c => activeSpecific.has(c));
            if (survivors.length === comps.length) continue; // nothing changed

            if (survivors.length > 1) {
                // Shrink: e.g. "A/B/C" → "A/C"
                this.renameColumnKey(col, survivors.sort().join('/'));
            } else if (survivors.length === 1) {
                // Dissolve: "A/B" → "B"
                this.renameColumnKey(col, survivors[0]);
            } else {
                // All specific siblings expired — release orphaned ambiguous points
                // back to their original raw prefix so they form their own column
                for (const p of this.chartPoints) {
                    if (p.col !== col) continue;
                    const rId = p.rawId ?? col;
                    if (!this.repeaterColumns.includes(rId)) this.repeaterColumns.push(rId);
                    p.col = rId;
                }
                for (const data of this.hashData.values()) {
                    const entry = data.repeaters.get(col);
                    if (!entry) continue;
                    const rId = entry.rawId ?? col;
                    if (!data.repeaters.has(rId)) data.repeaters.set(rId, entry);
                    data.repeaters.delete(col);
                }
                this.signalMap?.splitPoints?.(col, p => p ?? col);
                const idx = this.repeaterColumns.indexOf(col);
                if (idx >= 0) this.repeaterColumns.splice(idx, 1);
                this.allRepeaters.delete(col);
                this.chartColors.delete(col);
            }
        }

        // Step 3: Recompute stats for all remaining columns from the pruned chartPoints;
        // _recomputeRepeaterStats also removes columns that now have count=0
        for (const col of [...this.repeaterColumns]) {
            this._recomputeRepeaterStats(col);
        }

        // Column keys changed (demotions/dissolves) — re-derive the chart render
        // array so its cached col fields match the new column model.
        this._scheduleChartArrays();

        // Step 3 above deleted every repeater whose points aged out of the RAM
        // window — but with a Display window wider than that window (e.g. "All"),
        // those repeaters are still in range and live on disk. Re-seed them from
        // the disk chart cache so Seen Repeaters / the stats count keep showing
        // the whole Display window, not just the recent RAM tail. (This was the
        // cause of "only 3 repeaters until I toggled Display": the restore ran
        // only on a Display change, never after a routine prune.)
        this._restoreRepStatsFromBase();
    }

    _clearAllData() {
        this.hashData.clear();
        this.chartPoints = [];
        this._sentSnrHistory = [];
        this._wideChartPoints = [];
        this._wideSentPoints = [];
        this._chartBase = null;
        this._chartZoomLayer = null;
        this._sentChartAt = 0;
        clearTimeout(this._chartArrTimer); this._chartArrTimer = null;
        this._tablePageData = new Map();
        this._tablePage = 0;
        this._tablePageCount = 1;
        this._tableNarrowHashes = this._tableNarrowSet = null;
        this._tableNarrowKeyApplied = this._tableNarrowIndexKey = '';
        this._renderCacheAt = 0;
        this._wideMapBase = null;
        this._wideMapDetail = null;
        this._wideMapKey = null;
        this._wideMapSentVer = -1;
        this._pendingMapUpserts = null;
        clearTimeout(this._mapPushTimer); this._mapPushTimer = null;
        this._lastMapView = null;
        this._obsWriteBuf = [];
        this._sentWriteBuf = [];
        this._hashWriteBuf = [];
        this.totalRxCount = 0;
        this.store?.clearAll();
        this._dscSeq = 0;
        this.repeaterColumns = [];
        this.allRepeaters.clear();
        this._selectedCol = null;
        this._mapPins.clear();
        // Contacts are data too — wipe them from RAM now and cancel any pending
        // persist so it can't re-write them after store.clearAll() empties the DB.
        this._contacts.clear();
        this._contactsLastmod = 0;
        clearTimeout(this._contactsPersistTimer);
        this.signalMap?.selectColumn(null);
        this.signalMap?.clearPoints?.();
        if (this.msgTableBody) this.msgTableBody.innerHTML = '';
        if (this.msgTableHead) this.msgTableHead.innerHTML = '';
        document.getElementById('msgFilterBar')?.classList.add('hidden');
        this._scheduleChartRender();
        this._renderRepTable();
        this._updateStats();
        this._updateContactsCount();
        this._updateMapPins();
        if (this.emptyState) this.emptyState.classList.remove('hidden');
        // Re-create the (now empty) chart/map cache layers so live upserts have
        // somewhere to land — nothing else rebuilds them outside Display changes.
        this._refreshWideView();
    }

    // A disk prune deleted `deletedHashes` hash records — keep the RAM-maintained
    // pager count in sync immediately (it is otherwise only incremented at ingest
    // and recounted on page loads). If the current page fell off the end, load
    // the new last page so the snapshot matches the pager.
    _afterDiskPrune(deletedHashes) {
        if (!deletedHashes) return;
        if (this._tableNarrowHashes) {
            // No way to tell how many of the deleted hashes were in the narrow
            // index — rebuild it (bounded: finite retention keeps the store small).
            this._loadTablePage(0, true);
            return;
        }
        this._tableHashCount = Math.max(0, this._tableHashCount - deletedHashes);
        this._tablePageCount = Math.max(1, Math.ceil(Math.max(1, this._tableHashCount) / this._tablePageSize));
        if (this._tablePage > this._tablePageCount - 1) {
            this._loadTablePage(this._tablePageCount - 1);
        } else {
            this._refreshTablePager();
        }
    }

    _displayCutoffNow() {
        return isFinite(this.DISPLAY_LIFETIME) ? Date.now() - this.DISPLAY_LIFETIME : 0;
    }

    _applyHideSelect() {
        const hideSelect = document.getElementById('hideSelect');
        if (!hideSelect) return;
        const v = hideSelect.value;
        this.DISPLAY_LIFETIME = (v === 'all' || v === 'Infinity') ? Infinity : +v * 1000;
        // The displayed time range changed, so any X-zoom window no longer matches.
        this._chartZoom = null;
        this._updateZoomResetBtns();
        const cutoff = this._displayCutoffNow();
        this.signalMap?.setDisplayCutoff?.(cutoff);
        this._scheduleChartRender();
        this._renderRepTable();
        this._renderMsgTable();
        this._updateStats();
        // Load (or drop) the downsampled disk overlay for wide / "All" windows,
        // and reclaim RAM promptly if the window shrank below the budget.
        this._refreshWideView();
        this.cleanup();
    }

    _updateHideSelectOptions() {
        const hideSelect = document.getElementById('hideSelect');
        if (!hideSelect) return;
        const ttlMs = this.HASH_LIFETIME;
        let currentValid = false;
        for (const opt of hideSelect.options) {
            if (opt.value === 'same') { opt.disabled = false; currentValid ||= (hideSelect.value === 'same'); continue; }
            const ms = opt.value === 'Infinity' ? Infinity : +opt.value * 1000;
            opt.disabled = isFinite(ttlMs) && ms > ttlMs;
            if (!opt.disabled && hideSelect.value === opt.value) currentValid = true;
        }
        if (!currentValid) {
            hideSelect.value = 'all';
            Store.set('hide', 'all');
            this._applyHideSelect();
        }
    }

    // --- Repeater log table ---

    _renderRepTable() {
        if (!this.repTableBody) return;
        const key = this.repeaterSortKey;
        const dir = this.repeaterSortDir;
        const cutoff = this._displayCutoffNow();
        const entries = Array.from(this.allRepeaters.entries())
            .filter(([id, d]) => this._colMatchesRepFilter(id) && (!cutoff || d.lastSeen >= cutoff));

        const repTableScroll = this.repTableBody.closest('.rep-table-scroll');
        const repTableEmpty  = document.getElementById('repTableEmpty');
        const repExpandBar   = document.getElementById('repExpandBar');
        const isEmpty = entries.length === 0;
        if (repTableScroll) repTableScroll.style.display = isEmpty ? 'none' : '';
        if (repExpandBar)   repExpandBar.style.display   = isEmpty ? 'none' : '';
        if (repTableEmpty)  repTableEmpty.classList.toggle('hidden', !isEmpty);
        if (isEmpty) { this.repTableBody.innerHTML = ''; return; }

        entries.sort(([idA, dA], [idB, dB]) => {
            if (key === 'id') {
                // 'direct' sorts first ascending, last descending
                if (idA === 'direct' && idB !== 'direct') return -dir;
                if (idB === 'direct' && idA !== 'direct') return dir;
                return dir * idA.localeCompare(idB);
            }
            const va = dA[key] ?? -Infinity;
            const vb = dB[key] ?? -Infinity;
            return dir * (va - vb);
        });
        const sel = this._selectedCol;
        this.repTableBody.innerHTML = entries.map(([repeater, d]) => {
            const mrc = this._signalColor(d.maxRssi,  -70, -130);
            const lrc = this._signalColor(d.lastRssi, -70, -130);
            const msc = this._signalColor(d.maxSnr,   13, -10, 0);
            const lsc = this._signalColor(d.lastSnr,  13, -10, 0);
            const isSel = repeater === sel;
            const rowCls = sel ? (isSel ? 'rl-row-sel' : 'rl-row-dim') : '';
            const cName = this._contactNameForCol(repeater);
            const nameTag = cName ? `<span class="rl-name">${this._escHtml(cName)}</span>` : '';
            return `<tr data-col="${this._escHtml(repeater)}"${rowCls ? ` class="${rowCls}"` : ''}>
                <td class="rl-id rl-id-clickable"><span class="rl-dot" style="${this._repDotStyle(repeater)}"></span>${this.displayId(repeater)}${nameTag}</td>
                <td class="rl-num">${d.count}</td>
                <td class="rl-num" style="color:${msc}">${this._fmtSnr(d.maxSnr)}</td>
                <td class="rl-num" style="color:${lsc}">${this._fmtSnr(d.lastSnr)}</td>
                <td class="rl-num" style="color:${mrc}">${d.maxRssi ?? '—'}</td>
                <td class="rl-num" style="color:${lrc}">${d.lastRssi ?? '—'}</td>
                <td class="rl-time">${this._formatTime(d.lastSeen)}</td>
            </tr>`;
        }).join('');
        // Scroll selected row into view within the table — without moving the page viewport
        if (sel) {
            const selRow = this.repTableBody.querySelector('tr.rl-row-sel');
            const scroll = this.repTableBody.closest('.rep-table-scroll');
            if (selRow && scroll) {
                const thead = scroll.querySelector('thead');
                const headerH = thead ? thead.offsetHeight : 0;
                const rowTop = selRow.offsetTop;
                const rowBot = rowTop + selRow.offsetHeight;
                if (rowTop - headerH < scroll.scrollTop)
                    scroll.scrollTop = rowTop - headerH;
                else if (rowBot > scroll.scrollTop + scroll.clientHeight)
                    scroll.scrollTop = rowBot - scroll.clientHeight;
            }
        }
    }

    // --- Repeater selection ---

    _selectRepeater(col) {
        this._selectedCol = col ?? null;
        this.signalMap?.selectColumn(this._selectedCol);
        this._updateMapPins();
        this._scheduleChartRender();
        this._renderRepTable();
        // Selection narrows the packet table to that repeater — repaginate over
        // its hashes so we don't page through mostly-hidden rows. The sync
        // _applyMsgTableSelection below dims/hides the current page for instant
        // feedback; the async reload then re-renders a full narrowed page.
        this._repaginateIfNarrowChanged();
        this._applyMsgTableSelection();
        this._updateCornerNotices();
    }

    _updateCornerNotices() {
        const hasFilter = this._repFilterTerms.length > 0;
        const hasSel    = !!this._selectedCol;

        const fSnr = v => v != null && isFinite(v) ? `${v >= 0 ? '+' : ''}${Number.isInteger(v) ? v : Number(v).toFixed(1)}` : '—';

        const buildExtra = (col, showMore, noticePrefix) => {
            // No single resolved repeater (e.g. a filter term matching several) ⇒
            // there are no per-repeater stats to show, so render nothing rather
            // than a "Show more" checkbox that reveals nothing.
            if (!col) return '';
            const stats = col ? this._colStats(col) : null;
            const contacts = col && col !== 'direct' ? this._contactsByPrefix(col) : [];
            const contactsWithName = contacts.filter(c => c.name);
            const mapBtns = col ? this._contactsForMapButtons(col) : [];
            const checkId = `${noticePrefix}ShowMore`;
            let mapHtml = '';
            // Only when the repeater's GPS location is known: a "Show on map"
            // button that scrolls to the 3D map and turns the camera toward it
            // (same as the eye in the map infobox). Keeping it on the map is done
            // via the pushpin in the map infobox.
            if (mapBtns.length) {
                const allPubkeys = mapBtns.map(c => c.pubKeyFullHex).join('|');
                mapHtml += `<div class="cn-map-btns"><button class="cn-map-btn" data-pubkeys="${this._escHtml(allPubkeys)}">📍 Show on map</button></div>`;
            }
            let html = `<div class="cn-showmore-row"><label class="cn-showmore-label"><input type="checkbox" id="${checkId}"${showMore ? ' checked' : ''}> Show more</label>${mapHtml}</div>`;
            if (showMore && stats) {
                html += `<div class="cn-stats">` +
                    `<div>Packets: <b>${stats.count}</b></div>` +
                    `<div>RSSI: last <b>${stats.lastRssi}</b>, best <b>${stats.maxRssi}</b> dBm</div>` +
                    `<div>SNR: last <b>${fSnr(stats.lastSnr)}</b>, best <b>${fSnr(stats.maxSnr)}</b> dB</div>` +
                    `</div>`;
                if (col && col !== 'direct') {
                    if (contactsWithName.length === 0) {
                        html += `<div class="cn-contact-note">Name not available <span class="help-icon" data-help="contact-unknown">?</span></div>`;
                    } else if (mapBtns.length === 0) {
                        html += `<div class="cn-contact-note">Position not available <span class="help-icon" data-help="contact-no-gps">?</span></div>`;
                    }
                }
            }
            return html;
        };

        const wireExtra = (noticePrefix, showMoreFlag) => {
            const checkEl = document.getElementById(`${noticePrefix}ShowMore`);
            if (checkEl) {
                checkEl.addEventListener('change', () => {
                    if (noticePrefix === 'sel') this._selShowMore = checkEl.checked;
                    else this._filterShowMore = checkEl.checked;
                    this._updateCornerNotices();
                });
            }
            document.querySelectorAll(`#${noticePrefix}NoticeExtra .cn-map-btn`).forEach(btn => {
                btn.addEventListener('click', () => {
                    const pks = (btn.dataset.pubkeys || '').split('|').filter(Boolean);
                    // Turn the map camera toward the repeater (centroid of its GPS
                    // contacts), then scroll the 3D map into view.
                    const locs = pks.map(pk => this._contacts.get(pk))
                                    .filter(c => c && (c.lat || c.lon));
                    if (locs.length) {
                        const lat = locs.reduce((s, c) => s + c.lat, 0) / locs.length;
                        const lon = locs.reduce((s, c) => s + c.lon, 0) / locs.length;
                        this.signalMap?.faceLatLon(lat, lon);
                    }
                    document.getElementById('mapWrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });
            });
        };

        // --- Filter notice ---
        const filterNotice = document.getElementById('filterNotice');
        if (filterNotice) {
            filterNotice.classList.toggle('hidden', !hasFilter);
            if (hasFilter) {
                document.getElementById('filterNoticeRep').textContent = this._repFilterTerms.join(', ');
                const matchingCols = (this._visibleCols ?? this.repeaterColumns).filter(c => this._colMatchesRepFilter(c));
                // Any single matched column counts (including a merged one) — its
                // dot, name and "Show more" stats are meaningful; only a multi-
                // match filter has no single repeater to detail.
                const exactCol = matchingCols.length === 1 ? matchingCols[0] : null;
                const dot = document.getElementById('filterNoticeDot');
                if (dot) {
                    if (exactCol) this._applyDotStyle(dot, exactCol);
                    else { dot.style.background = ''; dot.style.border = ''; }
                    dot.style.display = exactCol ? '' : 'none';
                }
                const nameEl = document.getElementById('filterNoticeName');
                if (nameEl) {
                    const cName = exactCol ? this._contactNameForCol(exactCol) : null;
                    nameEl.textContent = cName ? ` ${cName}` : '';
                    nameEl.style.display = cName ? '' : 'none';
                }
                const extra = document.getElementById('filterNoticeExtra');
                if (extra) {
                    extra.innerHTML = buildExtra(exactCol, this._filterShowMore, 'filter');
                    wireExtra('filter', this._filterShowMore);
                }
            }
        }

        // --- Selection notice (hidden when filter is also active) ---
        const selNotice = document.getElementById('selNotice');
        if (selNotice) {
            selNotice.classList.toggle('hidden', !hasSel || hasFilter);
            if (hasSel && !hasFilter) {
                document.getElementById('selNoticeRep').textContent = this.displayId(this._selectedCol);
                const dot = document.getElementById('selNoticeDot');
                this._applyDotStyle(dot, this._selectedCol);
                const nameEl = document.getElementById('selNoticeName');
                if (nameEl) {
                    const cName = this._contactNameForCol(this._selectedCol);
                    nameEl.textContent = cName ? ` ${cName}` : '';
                    nameEl.style.display = cName ? '' : 'none';
                }
                const extra = document.getElementById('selNoticeExtra');
                if (extra) {
                    extra.innerHTML = buildExtra(this._selectedCol, this._selShowMore, 'sel');
                    wireExtra('sel', this._selShowMore);
                }
            }
        }
    }

    _applyMsgTableSelection() {
        const sel = this._selectedCol;

        // Repeater column headers: dim non-selected
        document.querySelectorAll('#msgTableHead th.msg-col-rep[data-col]').forEach(th => {
            th.classList.toggle('col-dim', !!sel && th.dataset.col !== sel);
            th.classList.toggle('col-sel', !!sel && th.dataset.col === sel);
        });

        // Data cells: dim non-selected repeater columns
        document.querySelectorAll('#msgTableBody td.sig-rssi[data-col], #msgTableBody td.sig-snr[data-col]').forEach(td => {
            td.classList.toggle('col-dim', !!sel && td.dataset.col !== sel);
        });

        // Rows: hide if selected repeater has no data for that packet
        document.querySelectorAll('#msgTableBody tr[id^="row-"]').forEach(tr => {
            if (!sel) { tr.style.display = ''; return; }
            const hash = tr.id.slice(4);
            const data = this._tableSource().get(hash) || this.hashData.get(hash);
            tr.style.display = data?.repeaters.has(sel) ? '' : 'none';
        });
        // Keep detail rows in sync with their parent row
        document.querySelectorAll('#msgTableBody tr.detail-row').forEach(tr => {
            const prev = tr.previousElementSibling;
            if (prev) tr.style.display = prev.style.display;
        });

        // Scroll to selected column
        if (sel) {
            const th = document.querySelector(`#msgTableHead th.msg-col-rep[data-col="${CSS.escape(sel)}"]`);
            const scroll = this.msgTableHead?.closest('.msg-table-scroll');
            if (th && scroll) {
                const colLeft  = th.offsetLeft;
                const colRight = colLeft + th.offsetWidth;
                const firstColW = scroll.querySelector('th')?.offsetWidth ?? 0;
                if (colLeft - firstColW < scroll.scrollLeft)
                    scroll.scrollLeft = colLeft - firstColW;
                else if (colRight > scroll.scrollLeft + scroll.clientWidth)
                    scroll.scrollLeft = colRight - scroll.clientWidth;
            }
        }
    }

    // --- Signal color ---

    _signalColor(value, greenVal, redVal, yellowVal) {
        if (value == null) return 'inherit';
        const pivot = yellowVal !== undefined ? yellowVal : (greenVal + redVal) / 2;
        let t;
        if (value >= pivot) {
            t = 0.5 * Math.max(0, Math.min(1, (greenVal - value) / (greenVal - pivot)));
        } else {
            t = 0.5 + 0.5 * Math.max(0, Math.min(1, (pivot - value) / (pivot - redVal)));
        }
        return `hsl(${120 * (1 - t)}, 85%, 38%)`;
    }

    // --- Sound ---

    _playRxSound(snr) {
        const mode = this.soundSelect?.value ?? 'off';
        // 'disconnect' = alarm on drop only, no per-packet beep (see _playDisconnectAlarm).
        if (mode === 'off' || mode === 'disconnect') return;
        if (!this.audioCtx) this.audioCtx = new AudioContext();
        const ctx = this.audioCtx;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const baseFreq = 700;

        // Ring-out length grows with the chosen mode (short / medium / long).
        const ring = mode === 'long' ? 0.8 : mode === 'medium' ? 0.5 : 0.3;

        // A lowpass tames only the very top so it stays a bell, not a harsh
        // tick — set high so the upper partials ring through and give the sound
        // its clear, crystalline "glockenspiel" shimmer. (Tuned in sound-lab.html.)
        const out = ctx.createBiquadFilter();
        out.type = 'lowpass';
        out.frequency.value = 10700;
        out.Q.value = 0.3;
        out.connect(ctx.destination);

        // One struck bell note: fundamental + octave + a touch of detuned high
        // shimmer (4.01×) over a sub-octave (0.5×) for body. Very fast attack
        // gives a clear "ping"; partials ring out together (low decayFactor) so
        // the shimmer lingers, which reads as crystalline rather than dull.
        const bell = (freq, start, dur, vol) => {
            const t = now + start;
            const partials = [[1, 1.0], [2, 0.5], [4.01, 0.13], [0.5, 0.38]];
            for (const [mult, amp] of partials) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq * mult;
                osc.connect(gain);
                gain.connect(out);
                const peak = vol * amp * 0.085;
                const pdur = dur / (1 + (mult - 1) * 0.05);   // upper partials ring almost as long
                gain.gain.setValueAtTime(0.0001, t);
                gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.001);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + pdur);
                osc.start(t);
                osc.stop(t + pdur + 0.05);
            }
        };

        // Two notes: a brief, quieter reference ding, then the SNR-pitched note
        // that rings out. SNR 0 dB = base pitch; ±10 dB = ±1 octave. A small
        // overlap makes it a gentle "di-iing" instead of two separate ticks.
        const onset = ring * 0.18;
        bell(baseFreq, 0, ring * 0.5, 0.5);
        bell(baseFreq * Math.pow(2, (snr ?? 0) / 10), onset, ring, 1.0);
    }

    // An interrupted two-tone alarm (880-440-880-440-880-440 Hz) for the
    // unexpected-disconnect alert. Only plays when sound alerts are enabled.
    _playDisconnectAlarm() {
        const mode = this.soundSelect?.value ?? 'off';
        if (mode === 'off') return;
        try {
            if (!this.audioCtx) this.audioCtx = new AudioContext();
            const ctx = this.audioCtx;
            if (ctx.state === 'suspended') ctx.resume();
            const now = ctx.currentTime;
            const freqs = [880, 440, 880, 440, 880, 440];
            const dur = 0.16, gap = 0.08;   // gap between tones → "interrupted"
            freqs.forEach((f, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'square';
                osc.frequency.value = f;
                osc.connect(gain);
                gain.connect(ctx.destination);
                const start = now + i * (dur + gap);
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(0.13, start + 0.01);
                gain.gain.setValueAtTime(0.13, start + dur - 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
                osc.start(start);
                osc.stop(start + dur + 0.01);
            });
        } catch (e) { console.warn('Alarm sound failed:', e); }
    }

    _showDisconnectAlarm() {
        document.getElementById('disconnectAlarm')?.classList.remove('hidden');
    }

    _hideDisconnectAlarm() {
        document.getElementById('disconnectAlarm')?.classList.add('hidden');
    }

    // Whether a silent (no user gesture) reconnect is even possible here, which
    // is what gates the Auto-reconnect toggle. The native Android app can always
    // reconnect quietly (saved BLE address, USB permission, or a WiFi socket).
    // In a plain browser it needs an API that hands back an already-authorised
    // device without a picker: Web Bluetooth getDevices() or Web Serial.
    //
    // The catch: mobile Chrome *exposes* getDevices() but it returns nothing
    // usable, so every BLE connection still forces the system picker — feature
    // detection alone can't tell that apart. So on a mobile browser we treat a
    // silent reconnect as impossible and hide the toggle (the native app is
    // unaffected — it returns early above).
    _canAutoReconnect() {
        if (window.__MESHCORE_NATIVE__) return true;
        const ua = navigator.userAgent || '';
        const mobileWeb = navigator.userAgentData?.mobile === true
            || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
        if (mobileWeb) return false;
        if (navigator.bluetooth?.getDevices) return true;
        if (navigator.serial) return true;
        return false;
    }

    // Auto-reconnect: after an unexpected drop, retry the last device a few times
    // with backoff (reusing quickConnect, which handles every transport). Falls
    // back to the disconnect alarm if it can't get back. Only the zero-friction
    // paths (BLE getDevices / saved serial / WiFi) work without a user gesture.
    _startAutoReconnect() {
        if (this._reconnecting) return;
        this._reconnecting = true;
        this._reconnectTries = 0;
        this.updateStatus('Reconnecting…', 'connecting');
        this._scheduleReconnect(500);
    }

    _scheduleReconnect(delay) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => this._tryReconnect(), delay);
    }

    async _tryReconnect() {
        if (!this._reconnecting) return;
        if (this.device) { this._cancelAutoReconnect(); return; }   // already back (manual connect)
        this._reconnectTries++;
        // auto:true → only the zero-friction transports, no gesture-required
        // picker and no error alerts (those would stack up modally).
        this.updateStatus('Reconnecting…', 'connecting');
        try { await this.quickConnect(this._lastConnectedId, { auto: true }); } catch (e) { console.warn('Auto-reconnect attempt failed:', e); }
        if (!this._reconnecting) return;        // cancelled meanwhile
        if (this.device) { this._reconnecting = false; this._reconnectTimer = null; return; }  // success
        if (this._reconnectTries >= 5) {
            this._cancelAutoReconnect();
            this.updateStatus('Disconnected', 'disconnected');
            this._playDisconnectAlarm();        // gave up — sound + visual alert
            this._showDisconnectAlarm();
            return;
        }
        // A failed attempt left the status at 'Disconnected'; restore the
        // distinct 'Reconnecting…' so it doesn't look like a manual disconnect.
        this.updateStatus('Reconnecting…', 'connecting');
        this._scheduleReconnect(Math.min(8000, 2000 * 2 ** (this._reconnectTries - 1)));
    }

    _cancelAutoReconnect() {
        this._reconnecting = false;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
    }

    // --- BLE Device Battery ---

    _updateBleBatteryVoltage(milliVolts) {
        if (!this.batteryEl || !this.device) return;
        // LiPo: 3000 mV = 0%, 4200 mV = 100%
        const pct = Math.round(Math.min(100, Math.max(0, (milliVolts - 3000) / 1200 * 100)));
        this.batteryEl.innerHTML = `<span class="hstat-label">Bat </span><span class="batt-icon">🔋</span>${pct}%`;
        this.batteryEl.classList.remove('hidden', 'battery-low');
        if (pct <= 20) this.batteryEl.classList.add('battery-low');
    }

    // --- Wake Lock ---

    async acquireWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
            } catch (e) { /* denied — battery saver etc. */ }
        }
        window.AndroidScreen?.keepOn?.(true);
    }

    releaseWakeLock() {
        if (this.wakeLock) { this.wakeLock.release(); this.wakeLock = null; }
        window.AndroidScreen?.keepOn?.(false);
    }

    // --- Stats & status ---

    _updateStats() {
        if (this.exportCsvBtn) this.exportCsvBtn.disabled = this.hashData.size === 0 && !this._storeReady;
        const displayCutoff = this._displayCutoffNow();
        // "Active" = unique packets in the Display window. A finite window is
        // never wider than the RAM window (max Display = 1 h = the RAM budget),
        // so the cutoff-filtered RAM set is exact. Display="All" can exceed RAM,
        // though — fall back to the disk hash count (exact for "All": set from
        // countHashes() on load, then incremented per new hash) so it doesn't
        // collapse to just the recent RAM tail after a long capture.
        const visibleHashes = displayCutoff
            ? Array.from(this.hashData.values()).filter(d => d.lastSeen >= displayCutoff).length
            : (this._storeReady ? this._tableHashCount : this.hashData.size);
        this.activeHashesEl.textContent = visibleHashes;
        this.totalRxEl.textContent = this.totalRxCount;
        const visibleRepeaters = displayCutoff
            ? Array.from(this.allRepeaters.entries())
                .filter(([id, d]) => d.lastSeen >= displayCutoff && this._colMatchesRepFilter(id)).length
            : (this._repFilterTerms.length
                ? this.repeaterColumns.filter(c => this._colMatchesRepFilter(c)).length
                : this.repeaterColumns.length);
        this.totalRepeatersEl.textContent = visibleRepeaters;
        if (this.packetRateEl) {
            const now = Date.now();
            this._rxTimestamps = this._rxTimestamps.filter(t => t > now - 120000);
            const count = this._rxTimestamps.filter(t => t > now - 60000).length;
            this.packetRateEl.textContent = (this.device || count > 0) ? String(count) : '—';
        }
    }

    _rowMatchesFilter(data, filter) {
        if ((data.type || '').toLowerCase().includes(filter)) return true;
        if (this._abbreviateType(data.type).toLowerCase().includes(filter)) return true;
        for (const col of data.repeaters.keys()) {
            // Match the short ID label AND the repeater's synced contact name.
            if (this.displayId(col).toLowerCase().includes(filter)) return true;
            const cName = this._contactNameForCol(col);
            if (cName && cName.toLowerCase().includes(filter)) return true;
        }
        const m = data.meta;
        if (m?.text?.toLowerCase().includes(filter)) return true;
        if (m?.sender?.toLowerCase().includes(filter)) return true;
        if (m?.name?.toLowerCase().includes(filter)) return true;
        // An advert's own node name, resolved from the contact list (this is what
        // the expanded packet detail shows).
        if (m?.pubKeyFull) {
            const cn = this._contacts.get(m.pubKeyFull)?.name;
            if (cn && cn.toLowerCase().includes(filter)) return true;
        }
        // Raw bytes too, so a hex substring from the packet can be searched.
        if (data.rawHex?.toLowerCase().includes(filter)) return true;
        return false;
    }

    _colMatchesRepFilter(col) {
        if (!this._repFilterTerms.length) return true;
        // For collision keys like "1234/5678" check each component separately
        const ids = col.includes('/') ? col.split('/') : [col];
        return ids.some(id => {
            const display = this.displayId(id).toUpperCase();
            return this._repFilterTerms.some(term =>
                display.startsWith(term) || term.startsWith(display)
            );
        });
    }

    // Visible points come from the incrementally maintained bucket cache
    // (_wideChartPoints, see _rebuildChartArrays) — live packets are already
    // folded in, so there is no separate tail. Pre-ready the cache is empty and
    // the cutoff-filtered live RAM points serve directly — same path, no branch.
    _visibleChartPoints() {
        const cutoff = this._displayCutoffNow();
        let pts = this._wideChartPoints.length ? this._wideChartPoints : this.chartPoints;
        // The bucket cache is pruned only opportunistically (at array rebuilds),
        // so enforce the Display cutoff at read time for both sources.
        if (cutoff) pts = pts.filter(p => p.time >= cutoff);
        return this._repFilterTerms.length ? pts.filter(p => this._colMatchesRepFilter(p.col)) : pts;
    }

    _visibleSentSnrPts() {
        // Sent points are few, so the disk layer plus a plain live tail (points
        // newer than the layer) suffices. While zoomed, clamp the tail to the
        // zoom window so out-of-window stars don't skew the Y bounds.
        const cutoff = this._displayCutoffNow();
        const z = this._chartZoom;
        const tail = this._sentSnrHistory.filter(p =>
            p.time > this._sentChartAt &&
            (!cutoff || p.time >= cutoff) &&
            (!z || (p.time >= z.tMin && p.time <= z.tMax)));
        let pts = tail.length ? this._wideSentPoints.concat(tail) : this._wideSentPoints;
        if (cutoff) pts = pts.filter(p => p.time >= cutoff);
        if (z) pts = pts.filter(p => p.time >= z.tMin && p.time <= z.tMax);
        return this._repFilterTerms.length ? pts.filter(p => this._colMatchesRepFilter(p.col)) : pts;
    }

    _applyRepFilter() {
        // Repaginate the packet table when the filter changed: pages are then
        // drawn from the narrowed hash index, so no pages of entirely hidden
        // rows. Async — the immediate render below narrows the current page's
        // rows in the meantime.
        this._repaginateIfNarrowChanged();
        this._renderRepTable();
        this._renderMsgTable();
        // Filtering changes how many repeater columns are shown, so the table
        // width changes too — re-check overflow (allowing a return to full type
        // names) once the new layout has been laid out.
        requestAnimationFrame(() => this._checkTableOverflow(true));
        this._scheduleChartRender();
        this._updateStats();
        this.signalMap?.setFilterFn(
            this._repFilterTerms.length ? col => this._colMatchesRepFilter(col) : null
        );
        this._updateMapPins();
        this._updateCornerNotices();
    }

    async _exportCsv() {
        const useDisk = this._storeReady;
        if (this.hashData.size === 0 && !useDisk) return;
        this._unsavedRxCount = 0;

        // Flush any buffered writes so the export reflects everything captured.
        if (useDisk) await this._flushWrites();

        const msgFilter = this._msgFilter.toLowerCase().trim();

        // One row per (hash, repeater) observation, sorted chronologically.
        // Source the full history from disk when available; otherwise the RAM
        // window. Each row carries its own rawHex (per-path) and the per-hash
        // type/meta loaded once.
        const allRows = [];
        let sentSource = this._sentSnrHistory;
        if (useDisk) {
            const obsAll = [];
            await this.store.eachObs(-Infinity, Infinity, r => obsAll.push(r));
            const hashCache = new Map();
            for (const h of new Set(obsAll.map(o => o.hash))) {
                const rec = await this.store.getHash(h);
                if (rec) hashCache.set(h, rec);
            }
            for (const o of obsAll) {
                const col = this._resolveColReadonly(o.rawId);
                const hm = hashCache.get(o.hash) ?? {};
                const rep = { rawId: o.rawId, snr: o.snr, rssi: o.rssi, remoteSnr: o.remoteSnr,
                              rawHex: o.rawHex, lat: o.lat, lon: o.lon, time: o.time };
                const data = { type: hm.type, meta: hm.meta, firstSeen: hm.firstSeen,
                               rawHex: o.rawHex, repeaters: new Map([[col, rep]]) };
                if (msgFilter && !this._rowMatchesFilter(data, msgFilter)) continue;
                if (this._repFilterTerms.length && !this._colMatchesRepFilter(col)) continue;
                allRows.push({ hash: o.hash, data, col, rep });
            }
            const sent = [];
            await this.store.eachSent(-Infinity, Infinity, r =>
                sent.push({ time: r.time, snr: r.snr, col: r.rawId, label: r.label, lat: r.lat, lon: r.lon }));
            sentSource = sent;
        } else {
            for (const [hash, data] of this.hashData) {
                if (msgFilter && !this._rowMatchesFilter(data, msgFilter)) continue;
                for (const [col, rep] of data.repeaters) {
                    if (this._repFilterTerms.length && !this._colMatchesRepFilter(col)) continue;
                    allRows.push({ hash, data, col, rep });
                }
            }
        }
        allRows.sort((a, b) => (a.rep.time ?? 0) - (b.rep.time ?? 0));

        // Embed contacts that appear in the exported data as comment lines before the header
        const exportedCols = new Set(allRows.map(r => r.col));
        const contactsToExport = new Map();
        for (const col of exportedCols) {
            for (const c of this._contactsByPrefix(col)) {
                if (!c.name && c.lat === 0 && c.lon === 0) continue;
                contactsToExport.set(c.pubKeyFullHex, c);
            }
        }
        // Map the gathered observations into the flat shape csv.js serialises;
        // numeric/date formatting lives in buildCsv.
        const observations = allRows.map(({ hash, data, rep }) => ({
            time:      rep.time ?? data.firstSeen,
            type:      data.type,
            hash,
            rawId:     rep.rawId,
            snr:       rep.snr,
            remoteSnr: rep.remoteSnr,
            rssi:      rep.rssi,
            rawHex:    rep.rawHex || data.rawHex,
            lat:       rep.lat,
            lon:       rep.lon,
            text:      data.meta?.text,
            sender:    data.meta?.sender,
        }));

        const csv = buildCsv({
            contacts: [...contactsToExport.values()],
            observations,
            sentRows: sentSource,
        });
        const suggestedName = `meshcore-signal-tester-${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.csv`;

        // Android native app: delegate to SAF picker (shows system "Save as" dialog)
        if (window.AndroidFiles?.saveCsvWithPicker) {
            window.AndroidFiles.saveCsvWithPicker(suggestedName, csv);
            return;
        }

        if (window.showSaveFilePicker) {
            try {
                const fh = await window.showSaveFilePicker({
                    suggestedName,
                    types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
                });
                const writable = await fh.createWritable();
                await writable.write(csv);
                await writable.close();
                return;
            } catch (e) {
                if (e.name === 'AbortError') return; // user cancelled
            }
        }
        // Fallback for browsers without showSaveFilePicker
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async _importCsv(file) {
        let text;
        try { text = await file.text(); } catch { alert('Could not read file.'); return; }

        const parsed = parseCsv(text);
        if (parsed.error === 'empty') return;

        // Merge any contacts embedded in the CSV (new keys only, keep existing).
        // Done before the header check so a malformed body still imports contacts.
        for (const c of parsed.contacts) {
            if (!this._contacts.has(c.pubKeyFullHex)) {
                this._contacts.set(c.pubKeyFullHex,
                    { name: c.name, type: null, lat: c.lat, lon: c.lon, lastAdvert: 0, lastmod: 0, pubKeyFullHex: c.pubKeyFullHex });
            }
        }
        this._updateContactsCount();
        this._scheduleContactsPersist();   // persist any contacts embedded in the CSV

        if (!parsed.ok) {
            if (parsed.error === 'format')
                alert('Unrecognised CSV format — expected columns: time, hash, repeater.');
            return;
        }

        const rows = parsed.rows;
        const sentSnrRows = parsed.sentRows;
        if (rows.length === 0 && sentSnrRows.length === 0) return;

        const importBtn = document.getElementById('importCsvBtn');
        const prevBtnText = importBtn?.textContent;
        if (importBtn) { importBtn.textContent = 'Importing…'; importBtn.disabled = true; }
        const prevStatus = this.statusTextEl?.textContent;
        if (this.statusTextEl) this.statusTextEl.textContent = 'Importing CSV…';
        // Overlay the yellow "importing" tint without dropping the current
        // connection-state class (which governs child visibility).
        this.statusEl?.classList.add('importing');

        await new Promise(r => setTimeout(r, 0)); // yield to let the browser repaint

        if (this.hashData.size > 0) {
            if (!confirm(`There are already ${this.hashData.size} packet(s) loaded. Packets from the CSV will be added; existing entries are kept unchanged. Continue?`)) {
                // Cancelled: restore the button/status that were set above.
                if (importBtn) { importBtn.textContent = prevBtnText; importBtn.disabled = false; }
                this.statusEl?.classList.remove('importing');
                if (this.statusTextEl && prevStatus != null) this.statusTextEl.textContent = prevStatus;
                return;
            }
        }

        // Ascending time order so firstSeen and prefix resolution are correct
        rows.sort((a, b) => a.time - b.time);

        // Ensure imported historical data isn't immediately cleaned up by TTL
        const ttlSelect = document.getElementById('ttlSelect');
        if (ttlSelect && isFinite(this.HASH_LIFETIME)) {
            ttlSelect.value = 'Infinity';
            this.HASH_LIFETIME = Infinity;
            Store.set('ttl', 'Infinity');
            this._updateHideSelectOptions();
        }
        // Show all imported data regardless of previous display window setting
        const hideSelect = document.getElementById('hideSelect');
        if (hideSelect && hideSelect.value !== 'all') {
            hideSelect.value = 'all';
            Store.set('hide', 'all');
            this._applyHideSelect();
        }

        // Dedupe against already-persisted observations so re-importing the same
        // file is a no-op. The in-RAM merge only knows about the recent window;
        // older data lives on disk, so we check there too (keyed by hash, the
        // raw repeater id and the timestamp — the same identity a row exports as).
        const existingKeys = new Set();
        const existingSent = new Set();
        if (this._storeReady) {
            await this._flushWrites();   // dedupe must also see still-buffered packets
            for (const h of new Set(rows.map(r => r.hash))) {
                for (const o of await this.store.obsForHash(h)) existingKeys.add(h + '|' + o.rawId + '|' + o.time);
            }
            if (sentSnrRows.length) await this.store.eachSent(-Infinity, Infinity, r => existingSent.add(r.time + '|' + r.rawId));
        }

        for (const row of rows) {
            const dedupeKey = row.hash + '|' + row.repeater + '|' + row.time;
            if (existingKeys.has(dedupeKey)) continue;   // already captured/imported
            existingKeys.add(dedupeKey);
            let packet = null;
            let meta = {};
            if (row.rawHex) {
                try {
                    const decoded = MeshCoreDecoder.decode(row.rawHex);
                    if (decoded.isValid) {
                        packet = decoded;
                        const p = decoded.payload?.decoded;
                        if (p) {
                            const dec = p.decrypted;
                            if (dec?.message != null) meta.text   = String(dec.message);
                            if (dec?.sender  != null) meta.sender = String(dec.sender);
                            if (p.appData?.name != null) meta.name = String(p.appData.name);
                            const lk = p.publicKey ?? p.pubKey ?? p.linkKey ?? p.key ?? null;
                            if (lk != null) meta.linkKey = String(lk);
                        }
                        const path = decoded.path || [];
                        const fi = path[0];
                        meta.pathLen       = path.length;
                        meta.pathItemBytes = decoded.pathHashSize ?? fi?.length / 2 ?? 0;
                        meta.totalBytes    = decoded.totalBytes;
                    }
                } catch (e) { console.warn('Hex decode failed for row:', row.rawHex?.slice(0, 20), e.message); }
            }
            if (!meta.text   && row.csvText)   meta.text   = row.csvText;
            if (!meta.sender && row.csvSender)  meta.sender = row.csvSender;
            if (packet) this._ingestContactFromPacket(packet);

            const type = packet
                ? ([Utils.getRouteTypeName(packet.routeType), Utils.getPayloadTypeName(packet.payloadType)].filter(Boolean).join(' ') || row.type)
                : row.type;

            this._ingestPacket(row.hash, row.repeater, type, row.rawHex, row.snr, row.rssi, meta, packet, {
                importing:  true,
                timestamp:  row.time,
                lat:        row.lat,
                lon:        row.lon,
                remoteSnr:  row.uplinkSnr,
            });
        }

        // Import SentSNR history rows (deduped against disk the same way).
        // The SNR value is exported in the uplink_snr column (the snr column is
        // left empty for these rows), so read it from there.
        for (const r of sentSnrRows) {
            if (existingSent.has(r.time + '|' + r.repeater)) continue;
            existingSent.add(r.time + '|' + r.repeater);
            const snr = r.uplinkSnr ?? r.snr;
            const lat = r.lat, lon = r.lon;
            this._sentSnrHistory.push({ time: r.time, snr, col: r.repeater, label: r.csvText || r.repeater });
            if (!this._storeDead) this._sentWriteBuf.push({ time: r.time, snr, rawId: r.repeater, label: r.csvText || r.repeater, lat, lon });
        }
        if (sentSnrRows.length) {
            this._sentSnrHistory.sort((a, b) => a.time - b.time);
            this._renderChart('snr');
        }

        // Persist the import to disk and rebuild the downsampled "All" overlay,
        // so imported (historical) data survives the RAM-window prune and shows.
        if (this._storeReady) {
            await this._flushWrites();
            await this._refreshWideView();
        }

        this._sortColumns();
        // Move the 3D map camera to show all imported points regardless of current GPS location
        this.signalMap?.fitCamera?.();
        // Freeze chart at last packet time + 1 min so all imported data is in view
        const lastTime = rows.length ? rows[rows.length - 1].time : 0;
        if (!this._collecting && lastTime) this._chartFrozenAt = lastTime + 1_000;
        this._renderMsgTable();
        this._renderRepTable();
        this._scheduleChartRender();
        this._updateStats();
        this._updateMapPins();
        this._updateShowAllBtn();
        this.emptyState?.classList.add('hidden');
        requestAnimationFrame(() => this._checkTableOverflow(true));

        if (importBtn) { importBtn.textContent = prevBtnText; importBtn.disabled = false; }
        this.statusEl?.classList.remove('importing');
        if (this.statusTextEl && prevStatus != null) this.statusTextEl.textContent = prevStatus;
    }

    updateStatus(text, className) {
        if (this.statusTextEl) this.statusTextEl.textContent = text;
        this.statusEl.className = `status ${className}`;
        this._lastStatusText = text;
        // Mirror the connection status into the native foreground-service
        // notification so it reflects reality (including self-disconnects).
        this._refreshNativeStatus();
    }

    // Build the text shown in the Android foreground-service notification from
    // the current state: the base connection status, plus a speaker icon when
    // sound alerts are armed and capture is live, plus a paused marker when the
    // capture is stopped. No-op outside the Android wrapper.
    _refreshNativeStatus() {
        let text = this._lastStatusText || '';
        if (this._canSend()) {
            const soundOn = (this.soundSelect?.value || 'off') !== 'off';
            if (!this._collecting) text += ' — paused';
            else if (soundOn) text = '🔊 ' + text;
        }
        try { window.AndroidScreen?.setStatus?.(text); } catch (e) {}
    }

    // Show the name/id of the currently connected device (same label as the
    // matching "Saved:" entry). Hidden by CSS while not connected.
    _setConnectedDeviceName(name) {
        if (this.connectedNameEl) this.connectedNameEl.textContent = name || '';
    }

    // --- Utilities ---

    _formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString('en-GB');
    }

    _formatTimeMs(timestamp) {
        const d = new Date(timestamp);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
    }

    async disconnect() {
        // The user explicitly asked to disconnect — suppress the surprise-
        // disconnect alarm that onDisconnected() would otherwise raise, and stop
        // any auto-reconnect cycle.
        this._cancelAutoReconnect();
        this._intentionalDisconnect = true;
        // Serial teardown is handled synchronously inside onDisconnected().
        if (this.transportKind === 'serial') {
            this._serialClosing = true;
            this.onDisconnected();
            return;
        }

        // Grab refs before onDisconnected nulls them
        const device = this.device;
        const txChar = this.txCharacteristic;

        // Remove ALL event listeners synchronously before any async BLE operation so that
        // notifications arriving during stopNotifications / gatt.disconnect can't update the UI.
        if (this._onGattDisconnected && device) {
            device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
            this._onGattDisconnected = null;
        }
        if (this._onDataReceived) {
            txChar?.removeEventListener('characteristicvaluechanged', this._onDataReceived);
            this._onDataReceived = null;
        }
        if (this._onBatteryChanged && this._batteryCharacteristic) {
            try { this._batteryCharacteristic.removeEventListener('characteristicvaluechanged', this._onBatteryChanged); } catch {}
            this._onBatteryChanged = null;
        }
        // Hide battery immediately — no BLE events can re-show it after this point
        if (this.batteryEl) this.batteryEl.classList.add('hidden');

        // stopNotifications BEFORE gatt.disconnect() so Chrome fully releases the notify pipe
        if (txChar) {
            try { await txChar.stopNotifications(); } catch (e) { console.warn('stopNotifications:', e); }
        }

        if (device?.gatt) {
            await new Promise(resolve => {
                const onDisc = () => { device.removeEventListener('gattserverdisconnected', onDisc); resolve(); };
                device.addEventListener('gattserverdisconnected', onDisc);
                const t = setTimeout(resolve, 3000);
                try {
                    if (device.gatt.connected) device.gatt.disconnect();
                    else { clearTimeout(t); device.removeEventListener('gattserverdisconnected', onDisc); resolve(); }
                } catch (_) { clearTimeout(t); resolve(); }
            });
        }

        this.onDisconnected();
    }

    onDisconnected() {
        this.releaseWakeLock();
        this._stopRepeaterPolling();
        clearTimeout(this._monitorDelay);
        clearInterval(this._connectionMonitor);
        this._monitorDelay = null;
        this._connectionMonitor = null;
        // Clean up listeners — needed when called from surprise disconnect (gattserverdisconnected event)
        if (this._onGattDisconnected) {
            this.device?.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
            this._onGattDisconnected = null;
        }
        if (this._onDataReceived) {
            this.txCharacteristic?.removeEventListener('characteristicvaluechanged', this._onDataReceived);
            this._onDataReceived = null;
        }
        if (this._onBatteryChanged && this._batteryCharacteristic) {
            try { this._batteryCharacteristic.removeEventListener('characteristicvaluechanged', this._onBatteryChanged); } catch (e) {}
            this._onBatteryChanged = null;
        }
        this._batteryCharacteristic = null;
        this.txCharacteristic = null;
        this.bleRxCharacteristic = null;
        // Serial teardown: release the reader lock (this unblocks the read loop)
        // and close the port. Releasing the lock with a read pending makes that
        // read() reject with a TypeError, which the read loop swallows.
        if (this._onSerialDisconnect && this.serialPort) {
            try { this.serialPort.removeEventListener('disconnect', this._onSerialDisconnect); } catch (e) {}
        }
        this._onSerialDisconnect = null;
        try { this.serialReader?.releaseLock(); } catch (e) {}
        this.serialReader = null;
        if (this.serialPort) {
            const sp = this.serialPort;
            this.serialPort = null;
            Promise.resolve().then(() => sp.close()).catch(() => {});
        }
        this._serialReadBuffer = new Uint8Array(0);
        this._serialTextBuffer = '';
        this.transportKind = null;
        this.connectionMode = null;
        this._sawCompanionFrame = false;
        this._sawRepeaterReply = false;
        this._sawRepeaterRaw = false;
        this._repeaterStockNoticed = false;
        this._neighborSeen = new Map();
        this._pendingRaw = [];
        this._pendingPosFields = [];
        clearTimeout(this._posQueryTimer);
        clearInterval(this._deviceRefreshTimer);
        this._deviceRefreshTimer = null;
        this._setDeviceLocation(null, null);
        // Clear any in-flight contact fetch so a fresh connection starts clean
        // (a stuck _contactsReceiving from an interrupted stream would otherwise
        // linger). The lastmod marker is intentionally kept — it only ever
        // reflects a fully-completed sync now, so incremental sync stays correct.
        this._contactsReceiving = false;
        this._contactsFetchActive = false;
        this._setContactsLoading(false);
        document.getElementById('repeaterNotice')?.classList.add('hidden');
        this.device = null; // null before hiding so queued battery events are ignored by guards below
        if (this.batteryEl) this.batteryEl.classList.add('hidden');
        this.updateStatus('Disconnected', 'disconnected');
        this._setConnectedDeviceName('');
        this._setConnectIdle();
        this._updateSoundHighlight();
        this._collecting = false;
        this._updatePauseBtn();
        if (this.emptyState) {
            const p = this.emptyState.querySelector('p');
            if (p) p.textContent = 'Connect to a MeshCore companion device via Bluetooth or USB to start monitoring RX logs.';
        }
        // A drop on an established connection that we didn't initiate ourselves
        // is a surprise disconnect — flash the screen red and sound the alarm.
        const surprise = this._wasConnected && !this._intentionalDisconnect;
        this._wasConnected = false;
        this._intentionalDisconnect = false;
        if (this._reconnecting) return;   // a reconnect cycle already owns the recovery
        if (surprise) {
            this._playDisconnectAlarm();   // audible cue on every unexpected drop (if sound on)
            if (this._autoReconnect && this._lastConnectedId) this._startAutoReconnect();
            else this._showDisconnectAlarm();
        }
    }
}

let monitor;
function init() { monitor = new MeshCoreApp(); }

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        monitor?._syncWakeLock();
    } else {
        monitor?.releaseWakeLock();
    }
});
