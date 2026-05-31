// MeshCore Signal Tester Application
import { MeshCoreDecoder, Utils } from './vendor/meshcore-decoder.js?v=1';
import { Signal3DMap } from './signal3d.js?v=90';



// Tiny localStorage wrapper: swallows quota/privacy errors and coerces types.
// Booleans are stored as 'true'/'false'; numbers as their string form.
const Store = {
    get(key, fallback = null) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
        catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
    },
    num(key, fallback) {
        const n = parseFloat(this.get(key));
        return Number.isFinite(n) ? n : fallback;
    },
    bool(key, fallback) {
        const v = this.get(key);
        return v === null ? fallback : (v === 'true' || v === '1');
    },
    json(key, fallback) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
        catch { return fallback; }
    },
};

// Inner padding (px) of the SVG signal charts: left (y-axis labels), right,
// top, bottom (x-axis labels). Shared by render, click hit-testing and tooltip.
const CHART_PAD = { l: 36, r: 8, t: 6, b: 24 };

class MeshCoreApp {
    constructor() {
        this.device = null;
        this.bleRxCharacteristic = null;
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
        this._selShowMore = false;
        this._filterShowMore = false;
        this._mapPins = new Set(); // pubKeyFullHex of contacts pinned to 3D map
        this._batteryCharacteristic = null;
        this._onBatteryChanged = null;
        this._useAbbreviatedTypes = false;
        this._selectedCol = null;
        this._snrShowIncoming = true;
        this._snrShowOutgoing = true;
        this._rxTimestamps = [];
        this._msgFilter = '';
        this._repFilterTerms = [];
        this._collecting = false;
        this._keepScreenOn = Store.bool('keepScreenOn', true);
        this._unsavedRxCount = 0; // packets received since last CSV export
        this._chartFrozenAt = Date.now();

        this.initUI();
        this.startCleanupTimer();
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
        this._syncWakeLock();
    }

    _syncWakeLock() {
        if (this._collecting && this._keepScreenOn) this.acquireWakeLock();
        else this.releaseWakeLock();
    }

    initUI() {
        this.connectBtn = document.getElementById('connectBtn');
        this.statusEl = document.getElementById('status');
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
        document.querySelectorAll('.chart-svg-wrap').forEach(wrap => {
            const handle = document.createElement('div');
            handle.className = 'chart-resize-handle';
            wrap.insertAdjacentElement('afterend', handle);
            let startY = 0, startH = 0;
            const onMove = e => {
                const cy = e.touches ? e.touches[0].clientY : e.clientY;
                wrap.style.height = Math.max(80, Math.min(window.innerHeight - 80, startH + cy - startY)) + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.removeEventListener('touchend', onUp);
            };
            handle.addEventListener('mousedown', e => {
                e.preventDefault();
                startY = e.clientY; startH = wrap.offsetHeight;
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            handle.addEventListener('touchstart', e => {
                e.preventDefault();
                startY = e.touches[0].clientY; startH = wrap.offsetHeight;
                document.addEventListener('touchmove', onMove, { passive: false });
                document.addEventListener('touchend', onUp);
            }, { passive: false });
        });
        setInterval(() => {
            if (!this._chartFrozenAt) this._scheduleChartRender();
            if (isFinite(this.DISPLAY_LIFETIME)) {
                this.signalMap?.setDisplayCutoff?.(this._displayCutoffNow());
                this._renderRepTable();
                this._renderMsgTable();
            }
            this._updateStats();
        }, 2000);

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
        this.tooltip = document.getElementById('chartTooltip');

        document.getElementById('pauseBtn')?.addEventListener('click', () => {
            if (!this.device) return;
            this._collecting = !this._collecting;
            this._updatePauseBtn();
        });

        this.connectBtn.onclick = () => this.connectBluetooth();

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
            let lastTouch = 0;
            svg.addEventListener('mousemove', e => this.showChartTooltip(e, type));
            svg.addEventListener('mouseleave', () => {
                if (Date.now() - lastTouch > 400) this.hideChartTooltip();
            });
            svg.addEventListener('click', e => this._onChartClick(e, type));
            svg.addEventListener('touchstart', e => {
                lastTouch = Date.now();
                if (e.touches.length === 1) this.showChartTooltip(e.touches[0], type);
            }, { passive: true });
            svg.addEventListener('touchend', () => {
                lastTouch = Date.now();
                setTimeout(() => this.hideChartTooltip(), 2500);
            });
        };
        bindChartTooltip(this.rssiChartSvg, 'rssi');
        bindChartTooltip(this.snrChartSvg,  'snr');

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
            // Time/type cell: toggle detail for first repeater that has data for this row
            const rxCell = e.target.closest('.msg-col-rx');
            if (rxCell) {
                const row = rxCell.closest('tr[id^="row-"]');
                if (!row) return;
                const hash = row.id.slice(4);
                const data = this.hashData.get(hash);
                if (!data) return;
                const firstCol = this.repeaterColumns.find(col => data.repeaters.has(col));
                if (firstCol) this.toggleDetailRow(hash, firstCol);
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

        document.getElementById('savedDevices')?.addEventListener('click', e => {
            const quickBtn = e.target.closest('.saved-btn');
            const forgetBtn = e.target.closest('.forget-btn');
            if (quickBtn) this.quickConnect(quickBtn.dataset.id).catch(e => console.error('Quick connect failed:', e));
            if (forgetBtn) this.forgetDevice(forgetBtn.dataset.id);
        });

        const ttlSelect  = document.getElementById('ttlSelect');
        const hideSelect = document.getElementById('hideSelect');
        if (ttlSelect) {
            ttlSelect.value = Store.get('ttl', ttlSelect.value);
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

        this.soundSelect?.addEventListener('change', () => {
            Store.set('sound', this.soundSelect.value);
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
                    mapContainer?.requestFullscreen().catch(() => {});
                } else {
                    document.exitFullscreen();
                }
            });
            document.addEventListener('fullscreenchange', () => {
                const isFs = !!document.fullscreenElement;
                fsBtn.textContent = isFs ? '✕' : '⛶';
                fsBtn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
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

        this._initHelpSystem();
        this._initSignalMap();
        this._initDebug();
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
            this._ingestPacket(hash, repeater, 'Flood Debug', fakeHex, snr, rssi, { debug: true }, null, { forceIngest: true });
            if (fbk) {
                const col = this.findOrCreateColumn(repeater);
                fbk.textContent = `→ column ${this.displayId(col)}`;
                setTimeout(() => fbk.textContent = '', 2500);
            }
        };

        btn.addEventListener('click', inject);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inject(); } });
    }

    _initSignalMap() {
        const canvas = document.getElementById('mapCanvas');
        if (!canvas) return;

        // Resize handle — same pattern as chart resize handles
        const mapContainer = document.querySelector('.map-container');
        if (mapContainer) {
            const handle = document.createElement('div');
            handle.className = 'map-resize-handle';
            mapContainer.insertAdjacentElement('afterend', handle);
            let startY = 0, startH = 0;
            const onMove = e => {
                const cy = e.touches ? e.touches[0].clientY : e.clientY;
                mapContainer.style.height = Math.max(200, Math.min(window.innerHeight - 80, startH + cy - startY)) + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.removeEventListener('touchend', onUp);
            };
            handle.addEventListener('mousedown', e => {
                e.preventDefault();
                startY = e.clientY; startH = mapContainer.offsetHeight;
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            handle.addEventListener('touchstart', e => {
                e.preventDefault();
                startY = e.touches[0].clientY; startH = mapContainer.offsetHeight;
                document.addEventListener('touchmove', onMove, { passive: false });
                document.addEventListener('touchend', onUp);
            }, { passive: false });
        }

        const sourceSel = document.getElementById('mapSourceSelect');
        const savedSource = Store.get('mapSource', '');
        if (sourceSel && savedSource) sourceSel.value = savedSource;

        try {
            this.signalMap = new Signal3DMap({
                canvas,
                statusEl:      document.getElementById('locationStatus'),
                btnEl:         document.getElementById('enableLocationBtn'),
                emptyEl:       document.getElementById('mapEmpty'),
                infoEl:        document.getElementById('mapInfo'),
                colorFor:      col => this.getRepeaterColor(col),
                displayId:     col => this.displayId(col),
                nameForCol:    col => this._contactNameForCol(col),
                initialSource:  sourceSel?.value,
                initialSphereSize: this._sphereSize,
                initialClusterRadius: Store.num('clusterRadius', 0),
                initialPerspSize: Store.bool('perspSize', true),
                onSelect:      col => {
                    this._selectRepeater(col);
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

        sourceSel?.addEventListener('change', () => {
            this.signalMap.setMapSource(sourceSel.value);
            Store.set('mapSource', sourceSel.value);
        });

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
        const clusterSel        = document.getElementById('clusterRadiusSelect');
        const perspSizeChk      = document.getElementById('perspSizeChk');
        showLinesChk?.addEventListener('change', () => {
            this.signalMap?.setShowLines(showLinesChk.checked);
            Store.set('showLines', showLinesChk.checked);
        });
        showMarkerChk?.addEventListener('change', () => {
            this.signalMap?.setShowMarker(showMarkerChk.checked);
            Store.set('showMarker', showMarkerChk.checked);
        });
        clusterSel?.addEventListener('change', () => {
            this.signalMap?.setClusterRadius(parseFloat(clusterSel.value));
            Store.set('clusterRadius', clusterSel.value);
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
        if (clusterSel)   clusterSel.value   = String(Store.num('clusterRadius', 0));
        if (perspSizeChk)    perspSizeChk.checked    = Store.bool('perspSize', true);

        document.getElementById('showAllRepeatersBtn')?.addEventListener('click', () => this._toggleAllRepeatersOnMap());
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
                'This repeater is not in the contact list and hasn\'t responded to discovery yet. If you know roughly where it is, try "Discover nodes" in the Active Ping section — it may respond and reveal its name and position. Connecting your device via Bluetooth and syncing contacts can also help significantly.',
            'contact-no-gps':
                'The owner of this node hasn\'t configured its position.',
            'sound':
                'off = silent. short / medium / long play a two-tone beep of increasing duration (long is 4× short) on each new packet. The first tone (1/3 of the beep) is a fixed 700 Hz click; the second tone (2/3) shifts pitch with SNR — higher SNR → higher pitch. Setting is remembered across sessions.',
            'ttl':
                'Data older than this window is permanently deleted — packets, signal history, seen repeaters, and 3D map points all expire together. Collision labels are recalculated when their evidence ages out. "Never" keeps everything for the whole session (set automatically on CSV import).',
            'display':
                'How far back to look when displaying data. Does not delete anything — data outside this window is still stored and continues to influence repeater ID merging and collision detection. "All" shows the full storage window. Can only be set equal to or shorter than Auto-remove.',
            'keepscreen':
                'This could be necessary in a mobile browser to keep collection running — when the screen turns off, the browser suspends JavaScript and stops capturing. In the Android app, collection runs in a background service so the screen can be off without losing data — unless the system\'s battery optimization is active and kills the service. Setting is remembered across sessions.',
            'repeater':
                '"direct" = flood-routed packet received at first hop. Otherwise the ID of the last forwarding repeater. Click a row to select that repeater — dims others in all views (charts, Received packets, 3D map); click again to deselect. Click a column header to sort by that field; click again to reverse. See "Show help" → Repeater ID prefix resolution for how partial IDs and collision labels work.',
            'rssi':
                'Received Signal Strength in dBm. Less negative = stronger. −70 dBm: excellent · −120 dBm: very weak.',
            'snr':
                'Signal-to-Noise Ratio in dB. Positive = signal is above the noise. LoRa can decode even at negative SNR (down to ~−20 dB).',
            'chart-snr':
                'Click a dot to select that repeater — dims others across both charts, Seen Repeaters, Received Packets, and the 3D map; click again or elsewhere to deselect. A notice appears top-right with options to filter or deselect. Circles = incoming SNR; stars (★) = outgoing SNR reported by the remote node via Discover.',
            'chart-interact':
                'Click a dot to select that repeater — dims others across both charts, Seen Repeaters, Received Packets, and the 3D map; click again or elsewhere to deselect. A notice appears top-right with options to filter or deselect. The shaded area shows the estimated noise floor (RSSI − SNR).',
            'rate':
                'Packets received in the last 60 seconds (rolling). Resets to 0 when the network goes quiet.',
            'rep-filter':
                'Comma-separated list of repeater IDs to keep visible. Matching is prefix-based and works either way — "3E" matches "3E2F1234" and vice versa. Affects Seen Repeaters, charts, Received Packets, and the 3D map. A notice appears top-right while a filter is active.',
            'messages':
                'Click any RSSI or SNR cell to expand full packet detail and raw hex, including reception time with millisecond precision. Click the hex string in an expanded row to copy it to the clipboard. Click a repeater column header to select that repeater — syncs with Seen Repeaters, charts, and 3D map. Repeater columns are ordered by: packets received in the last 5 min (desc), then last RSSI, last SNR, total RX count, then alphabetically.',
            'msg-type':
                'Type abbreviations — AD: Advert · GT: GroupText · TR: Traceroute · RS: Response · RQ: Request · PN: Ping · TX: TextMessage · PT: Path · CT: Control · PV: Private · RD: Repeater DSC (discover response, includes uplink SNR). Full type is shown in the expanded row.',
            'signal3d':
                'Interactive 3D map of received signal quality. Each dot is positioned at your GPS location at reception time; height reflects SNR (taller = higher SNR). Click a dot to select that repeater — shows an info panel and syncs the selection across Seen Repeaters, charts, and Received Packets. Use ⚙ (top right) to change map source, dot size, guide lines, and the location marker. Navigation: drag to pan · scroll/pinch to zoom · right-drag to tilt/rotate.',
            'discover':
                'Sends an active DISCOVER_REQ broadcast — this is not passive listening, it injects traffic into the mesh. Nearby nodes with firmware ≥ v1.10 reply with their public key, name, GPS position, and the SNR they measured for your signal (uplink). Please don\'t press it more than once a minute.',
        };

        const tipEl = document.getElementById('helpTip');
        let _tipTarget = null;

        const showTip = (icon) => {
            const text = HELP[icon.dataset.help];
            if (!text || !tipEl) return;
            tipEl.textContent = text;
            tipEl.style.display = 'block';
            const tipW = Math.min(260, window.innerWidth - 16);
            tipEl.style.maxWidth = `${tipW}px`;
            const r = icon.getBoundingClientRect();
            const tipH = tipEl.offsetHeight;
            let left = r.left + r.width / 2 - tipW / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
            tipEl.style.left = `${left}px`;
            // Default: float above the icon. If there's no room, flip below.
            if (r.top < tipH + 12) {
                tipEl.style.top = `${r.bottom + 8}px`;
                tipEl.style.transform = 'none';
            } else {
                tipEl.style.top = `${r.top - 8}px`;
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
            document.body.style.overflow = 'hidden';
        };
        const closeHelp = () => {
            helpModal?.classList.add('hidden');
            document.body.style.overflow = '';
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
        helpModal?.addEventListener('click', e => {
            if (e.target === helpModal) closeHelp();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && helpModal && !helpModal.classList.contains('hidden')) {
                closeHelp();
            }
        });
    }

    // --- Bluetooth connection ---

    async connectBluetooth() {
        if (!navigator.bluetooth) {
            alert('Web Bluetooth API is not available.\n\nRequirements:\n• Chrome or Edge browser\n• Page must be served over HTTPS or localhost');
            return;
        }
        try {
            this.connectBtn.disabled = true;
            this.updateStatus('Scanning...', 'disconnected');
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
            if (error.name !== 'NotFoundError') {
                alert('Connection error: ' + error.message);
            }
            if (this.device) this.onDisconnected();
            else this._resetConnectBtn();
        }
    }

    async quickConnect(deviceId) {
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
                    if (error.name !== 'NotFoundError') {
                        alert('Connection error: ' + error.message);
                    }
                    if (this.device) this.onDisconnected();
                    else this._resetConnectBtn();
                }
                return;
            }
        }

        // Fall back to requestDevice — use saved name as filter so picker pre-selects it
        const saved = this.getSavedDevices().find(d => d.id === deviceId);
        const name = saved?.name;
        try {
            this.connectBtn.disabled = true;
            this.updateStatus('Scanning...', 'disconnected');
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
            if (error.name !== 'NotFoundError') {
                alert('Connection error: ' + error.message);
            }
            if (this.device) this.onDisconnected();
            else this._resetConnectBtn();
        }
    }

    _resetConnectBtn() {
        this.updateStatus('Disconnected', 'disconnected');
        this.connectBtn.textContent = 'Connect Bluetooth';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.connectBluetooth();
    }

    async connectToDevice(device) {
        this.connectBtn.textContent = 'Cancel';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.disconnect();
        this.updateStatus('Connecting...', 'disconnected');
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
                if (attempt === 3) throw e;
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

        this.saveDevice(device);

        this.updateStatus('Connected', 'connected');
        this.connectBtn.textContent = 'Disconnect';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.disconnect();
        this._collecting = true;
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

    async sendAppStart() {
        // CMD_APP_START = 0x01, firmware target version = 0x03, 6 padding bytes, app name
        const payload = new Uint8Array([0x01, 0x03, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x72, 0x78, 0x6D, 0x6F, 0x6E]);
        await this.bleRxCharacteristic.writeValueWithoutResponse(payload);
    }

    async sendGetContacts() {
        if (!this.bleRxCharacteristic) return;
        // CMD_GET_CONTACTS = 0x04; optional 4-byte LE lastmod for incremental sync
        const cmd = new Uint8Array(this._contactsLastmod > 0 ? 5 : 1);
        cmd[0] = 0x04;
        if (this._contactsLastmod > 0)
            new DataView(cmd.buffer).setUint32(1, this._contactsLastmod, true);
        this._setContactsLoading(true);
        try { await this.bleRxCharacteristic.writeValueWithoutResponse(cmd); }
        catch (e) { this._setContactsError('Contact request failed: ' + (e?.message || e)); }
    }

    _setContactsLoading(on) {
        if (this.contactsLoadingMsg) {
            this.contactsLoadingMsg.style.display = on ? '' : 'none';
            if (on) this.contactsLoadingMsg.textContent = 'Fetching contacts…';
        }
        clearTimeout(this._contactsLoadingTimeout);
        if (on) this._contactsLoadingTimeout = setTimeout(() => {
            if (this.contactsLoadingMsg) this.contactsLoadingMsg.textContent = 'Contact fetch failed — try reconnecting.';
        }, 15000);
    }

    _setContactsError(msg) {
        clearTimeout(this._contactsLoadingTimeout);
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
        if (lastmod > this._contactsLastmod) this._contactsLastmod = lastmod;
        this._updateContactsCount();
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
            const col = pubKeyFullHex.slice(0, 6);
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
            if (pubKeyFullHex.slice(0, 6) === col) return true;
        }
        return false;
    }

    _updateContactsCount() {
        if (this.contactsCountEl) this.contactsCountEl.textContent = this._contacts.size;
        if (this.contactsHstat) this.contactsHstat.style.display = this._contacts.size > 0 ? '' : 'none';
    }

    // Send one DISCOVER_REQ, then wait 2 s to collect responses before re-enabling the button.
    async startDiscoverSequence(filterMask) {
        const btn = document.getElementById('discoverBtn');
        if (!this.bleRxCharacteristic) {
            if (btn) { btn.textContent = '⚠ Not connected'; setTimeout(() => { btn.textContent = 'Discover nodes'; }, 2500); }
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
        if (!this.bleRxCharacteristic) return;
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
            await this.bleRxCharacteristic.writeValueWithoutResponse(bytes);
        } catch (e) { console.error('sendDiscoverRequest:', e); }
    }

    // --- Saved devices (localStorage) ---

    getSavedDevices() {
        return Store.json('devices', []);
    }

    saveDevice(device) {
        const devices = this.getSavedDevices();
        const existing = devices.find(d => d.id === device.id);
        if (existing) {
            existing.name = device.name || existing.name;
        } else {
            devices.push({ id: device.id, name: device.name || 'Unknown' });
        }
        Store.set('devices', JSON.stringify(devices));
        this._renderSavedDevices();
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

        // Contact list responses (from CMD_GET_CONTACTS = 0x04)
        if (pushCode === 0x02) {
            this._contactsReceiving = true;
            return;
        }
        if (pushCode === 0x03) {
            if (this._contactsReceiving) this._parseContact(payload);
            return;
        }
        if (pushCode === 0x04 && this._contactsReceiving) {
            this._contactsReceiving = false;
            this._setContactsLoading(false);
            if (payload.length >= 5)
                this._contactsLastmod = payload[1] | (payload[2]<<8) | (payload[3]<<16) | (payload[4]<<24);
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

        // Record uplink SNR in the Sent SNR History chart and 3D map
        const now = Date.now();
        this._sentSnrHistory.push({ time: now, snr: remoteSnr, col: pubKeyHex, label: nodeName ?? pubKeyHex });
        this._scheduleChartRender();
        const sentLoc = this.signalMap?.currentLocation() ?? null;
        if (sentLoc && remoteSnr != null) {
            this.signalMap.addSentSnrPacket({ lat: sentLoc.lat, lon: sentLoc.lon, snr: remoteSnr, col: pubKeyHex, time: now, rawId: pubKeyHex });
        }

        // Each DSC response → new row in Received Packets; always use current time so order is correct.
        // Column = the responding node's pub key prefix so all its DSC responses share one column.
        const dscHash = 'DSC:' + (++this._dscSeq);
        const rawHex = Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join('');
        this._ingestPacket(dscHash, pubKeyHex, typeName + ' DSC', rawHex, ourSnr, ourRssi, meta, null, { remoteSnr });
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
        this._ingestPacket(hash, repeaterCol, 'Trace', null, lastSnr, null, meta, null);
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
            this._ingestPacket(hash, repeater, type, rawHex, snr, rssi, meta, packet);
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

        const loc = opts.lat != null ? { lat: opts.lat, lon: opts.lon }
            : (this.signalMap?.currentLocation() ?? null);
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
            data.repeaters.set(canonicalKey, repEntry);
        }

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
        if (snr != null || rssi != null) {
            this.chartPoints.push({ time: now, rssi, snr, col: canonicalKey, rawId: repeater });
        }
        if (loc) this.signalMap?.addPacket({ lat: loc.lat, lon: loc.lon, rssi, snr, col: canonicalKey, time: now, rawId: repeater });

        if (opts.importing) return;

        this._renderRepTable();
        this._sortColumns();
        this._renderMsgTable(isNewHash ? hash : null);
        // Flash the two signal cells that just received new values
        this.msgTableBody?.querySelectorAll(`[data-hash="${hash}"][data-col="${canonicalKey}"]`)
            .forEach(el => {
                el.classList.remove('cell-flash');
                // Force reflow so the animation restarts even on rapid back-to-back updates
                void el.offsetWidth;
                el.classList.add('cell-flash');
            });
        if (this.repeaterColumns.length !== prevColCount) {
            requestAnimationFrame(() => this._checkTableOverflow(false));
        }
        if (wasAtBottom) {
            requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
        }
        this._scheduleChartRender();

        // Sound only when the entry would actually appear under the current filters
        const data = this.hashData.get(hash);
        const filterText = this._msgFilter.toLowerCase().trim();
        const matchesMsgFilter = !filterText || this._rowMatchesFilter(data, filterText);
        const matchesRepFilter = !this._repFilterTerms.length || this._colMatchesRepFilter(canonicalKey);
        if (matchesMsgFilter && matchesRepFilter) this._playRxSound(snr);
        this._updateStats();
        this.emptyState?.classList.add('hidden');
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
        const displayCutoff = this._displayCutoffNow();
        const allRows = Array.from(this.hashData.entries())
            .filter(([, data]) => !data._stub && (!displayCutoff || data.lastSeen >= displayCutoff))
            .sort(([, a], [, b]) => b.firstSeen - a.firstSeen);

        // Only include columns that actually appear in the visible rows (respects display cutoff)
        const activeColsInRows = new Set(allRows.flatMap(([, data]) => [...data.repeaters.keys()]));
        const visibleCols = this.repeaterColumns
            .filter(c => this._colMatchesRepFilter(c) && activeColsInRows.has(c));

        const msgTableEmpty = document.getElementById('msgTableEmpty');
        const msgTableScroll = this.msgTableHead?.closest('.msg-table-scroll');

        if (allRows.length === 0) {
            if (msgFilterBar) msgFilterBar.classList.add('hidden');
            if (msgTableScroll) msgTableScroll.style.display = 'none';
            if (msgTableEmpty) {
                msgTableEmpty.textContent = displayCutoff
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
        // When repeater filter is active, hide rows that have no data from visible columns
        if (this._repFilterTerms.length) {
            rows = rows.filter(([, data]) => visibleCols.some(c => data.repeaters.has(c)));
        }

        // Rebuild header when column set changes
        const colKey = visibleCols.join(',');
        if (colKey !== this._lastColKey) {
            this._lastColKey = colKey;
            const repHeaders = visibleCols.map(r => {
                const cName = this._contactNameForCol(r);
                const nameTag = cName ? `<br><span class="col-contact-name">${this._escHtml(cName)}</span>` : '';
                return `<th colspan="2" class="msg-col-rep" data-col="${this._escHtml(r)}"><span class="rl-dot" style="background:${this._dotColor(r)}"></span>${this.displayId(r)}${nameTag}</th>`;
            }).join('');
            const subHeaders = visibleCols.map(() =>
                `<th class="msg-sub-snr">SNR</th><th class="msg-sub-rssi">RSSI</th>`
            ).join('');
            this.msgTableHead.innerHTML = `
                <tr>
                    <th class="msg-col-rx-head" rowspan="2">RX log<span class="help-icon" data-help="msg-type">?</span></th>
                    ${repHeaders}
                </tr>
                <tr>${subHeaders}</tr>
            `;
        }

        // Filter count badge
        if (this.msgFilterCountEl) {
            const show = filter && allRows.length > 0;
            this.msgFilterCountEl.textContent = show ? `${rows.length} / ${allRows.length}` : '';
            this.msgFilterCountEl.classList.toggle('hidden', !show);
        }

        this.msgTableBody.innerHTML = rows.map(([hash, data]) =>
            this._buildMsgRow(hash, data, visibleCols)
        ).join('');

        for (const [hash, col] of openDetails) {
            if (!this.hashData.has(hash)) continue;
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

        this._applyMsgTableSelection();

        if (flashHash) {
            const row = document.getElementById(`row-${flashHash}`);
            if (row) row.classList.add('row-new');
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
        const data = this.hashData.get(hash);
        if (!data) return '';
        const colspan = 1 + this.repeaterColumns.length * 2;

        // Use per-repeater packet/rawHex when available (each repeater receives a different path)
        const repEntry = col ? data.repeaters.get(col) : null;
        const pkt = repEntry?.packet ?? data.packet;
        const hex = repEntry?.rawHex ?? data.rawHex;

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
                ? ` &nbsp; Uplink SNR <span style="color:${this._signalColor(rs, 13, -10, 0)};font-weight:700">${rs.toFixed(1)} dB</span>`
                : '';
            const dotColor = this._dotColor(col);
            const colContact = this._contactByPrefix(col);
            const colName = colContact?.name ?? null;
            header = `<div class="detail-sig">` +
                `<span class="rl-dot" style="background:${dotColor}"></span>` +
                `<b>${this._escHtml(this.displayId(col))}</b>` +
                (colName ? ` <span class="detail-col-name">${this._escHtml(colName)}</span>` : '') +
                (timeStr ? ` &nbsp; <span class="detail-time">${timeStr}</span>` : '') +
                ` &nbsp; RSSI <span style="color:${rc};font-weight:700">${repEntry.rssi ?? '—'}</span>` +
                ` &nbsp; SNR <span style="color:${sc};font-weight:700">${repEntry.snr?.toFixed(1) ?? '—'}</span>` +
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
        const snrStr  = snr  != null ? snr.toFixed(1) : '—';
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

    getRepeaterColor(col) {
        if (!this.chartColors.has(col)) {
            const id = this.displayId(col);
            let h = 0x811c9dc5;
            for (let i = 0; i < id.length; i++) {
                h ^= id.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            const hue = (h >>> 0) % 360;
            this.chartColors.set(col, hue);
        }
        const hue = this.chartColors.get(col);
        return `hsl(${hue}, 72%, 44%)`;
    }

    _dotColor(col) {
        const hue = this.chartColors.has(col) ? this.chartColors.get(col) : (() => { this.getRepeaterColor(col); return this.chartColors.get(col); })();
        const isDark = !document.documentElement.classList.contains('light-theme');
        return isDark ? `hsl(${hue}, 85%, 68%)` : `hsl(${hue}, 72%, 44%)`;
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
        const now = this._chartFrozenAt ?? Date.now();
        let tMin;
        if (isFinite(this.HASH_LIFETIME)) tMin = now - this.HASH_LIFETIME;
        else {
            const allIn  = type === 'snr' ? this._visibleChartPoints()  : incomingPts;
            const allOut = type === 'snr' ? this._visibleSentSnrPts()   : [];
            tMin = allIn.length  ? this._earliestTime(allIn)  : Infinity;
            if (allOut.length) tMin = Math.min(tMin, this._earliestTime(allOut));
            if (!isFinite(tMin)) tMin = now - 5 * 60000;
        }
        const { yMin, yMax } = this._chartYBounds(type);
        const tRange = Math.max(1, now - tMin);
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
            return;
        }
        this._selectRepeater(this._selectedCol === nearest.col ? null : nearest.col);
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
        let tMin;
        if (!hasAnyData) tMin = now - defaultWindow;
        else if (isFinite(this.HASH_LIFETIME)) tMin = now - this.HASH_LIFETIME;
        else {
            tMin = allInPts.length ? this._earliestTime(allInPts) : Infinity;
            if (allOutPts.length) tMin = Math.min(tMin, this._earliestTime(allOutPts));
            if (!isFinite(tMin)) tMin = now - defaultWindow;
        }

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
        const tRange = Math.max(1, now - tMin);
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
        for (let t = Math.ceil(tMin / minorStep) * minorStep; t <= now; t += minorStep) {
            if (t % labelStep === 0) continue;
            const xp = xOf(t);
            parts.push(`<line x1="${xp}" y1="${pt}" x2="${xp}" y2="${pt + ch}" stroke="${gridMinor}" stroke-width="1"/>`);
        }
        for (let t = Math.ceil(tMin / labelStep) * labelStep; t <= now; t += labelStep) {
            const xp = xOf(t);
            parts.push(`<line x1="${xp}" y1="${pt}" x2="${xp}" y2="${pt + ch}" stroke="${gridMajor}" stroke-width="1"/>`);
            const lbl = new Date(t).toLocaleString('en-GB', fmtOpts).replace(',', '');
            parts.push(`<text x="${xp}" y="${pt + ch + 14}" text-anchor="middle" font-size="9" fill="${labelFill}">${lbl}</text>`);
        }

        // Axes
        parts.push(`<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ch}" stroke="${gridAxis}" stroke-width="1"/>`);
        parts.push(`<line x1="${pl}" y1="${pt + ch}" x2="${pl + cw}" y2="${pt + ch}" stroke="${gridAxis}" stroke-width="1"/>`);

        // Noise floor area (RSSI chart only) — drawn behind repeater lines/dots
        if (type === 'rssi' && hasData) {
            const sorted = [...pts].filter(p => p.rssi != null && p.snr != null).sort((a, b) => a.time - b.time);
            if (sorted.length > 0) {
                const bottom = (pt + ch).toFixed(1);
                const lastP = sorted[sorted.length - 1];
                const nfPts = sorted.map(p => `${xOf(p.time)},${yOf(p.rssi - p.snr)}`);
                nfPts.push(`${xOf(now)},${yOf(lastP.rssi - lastP.snr)}`);
                const topEdge = nfPts.join(' ');
                const firstX = xOf(sorted[0].time);
                const lastX  = xOf(now);
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
            decimGroups.set(col, this._decimateChartPts(colPts, tMin, now, cw, type));
        }

        for (const [col, dPts] of decimGroups) {
            const validPts = dPts.filter(p => valOf(p) != null);
            if (validPts.length < 2) continue;
            const color = this._dotColor(col);
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
                parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(valOf(p))}" r="${ds}" fill="${this._dotColor(p.col)}" fill-opacity="${selected ? 0.10 : 0.90}" stroke="${dotStroke}" stroke-width="0.8"/>`);
            }
        }
        if (selected) {
            const selPts = decimGroups.get(selected);
            if (selPts) {
                for (const p of selPts) {
                    if (valOf(p) == null) continue;
                    parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(valOf(p))}" r="${ds * 1.43}" fill="${this._dotColor(p.col)}" fill-opacity="0.95" stroke="${dotStroke}" stroke-width="1"/>`);
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

    _decimateChartPts(colPts, tMin, tMax, pixelWidth, type) {
        const buckets = Math.max(1, Math.floor(pixelWidth));
        if (colPts.length <= buckets * 2) return colPts;
        const span = Math.max(1, tMax - tMin);
        const bucketMs = span / buckets;
        const valOf = p => type === 'rssi' ? p.rssi : p.snr;
        const bkts = new Array(buckets);
        for (const p of colPts) {
            const i = Math.min(buckets - 1, Math.floor((p.time - tMin) / bucketMs));
            if (!bkts[i]) { bkts[i] = { min: p, max: p }; }
            else {
                if (valOf(p) < valOf(bkts[i].min)) bkts[i].min = p;
                if (valOf(p) > valOf(bkts[i].max)) bkts[i].max = p;
            }
        }
        const result = [];
        for (const b of bkts) {
            if (!b) continue;
            result.push(b.min);
            if (b.max !== b.min) result.push(b.max);
        }
        return result.sort((a, b) => a.time - b.time);
    }

    showChartTooltip(e, type) {
        if (!this.tooltip) return;
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

        const now = this._chartFrozenAt ?? Date.now();
        let tMin;
        if (isFinite(this.HASH_LIFETIME)) tMin = now - this.HASH_LIFETIME;
        else {
            const allIn  = type === 'snr' ? this._visibleChartPoints()  : incomingPts;
            const allOut = type === 'snr' ? this._visibleSentSnrPts()   : [];
            tMin = allIn.length  ? this._earliestTime(allIn)  : Infinity;
            if (allOut.length) tMin = Math.min(tMin, this._earliestTime(allOut));
            if (!isFinite(tMin)) tMin = now - 5 * 60000;
        }
        const { yMin, yMax } = this._chartYBounds(type);
        const tRange = Math.max(1, now - tMin);
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
        if (!nearest || minDist > 1600) { this.hideChartTooltip(); return; }

        const isSent = sentPts.includes(nearest);
        const time = new Date(nearest.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const color = this._dotColor(nearest.col);
        const dotShape = isSent
            ? `<span style="color:${color};font-size:13px;line-height:1;margin-right:5px;vertical-align:middle;flex-shrink:0">★</span>`
            : `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle;flex-shrink:0"></span>`;
        const cName = this._contactNameForCol(nearest.col);
        const nameHtml = cName ? `<span style="color:#7ab;font-size:11px;margin-left:3px">${this._escHtml(cName)}</span>` : '';
        const valLine = isSent
            ? `Sent SNR ${nearest.snr?.toFixed(1) ?? '—'} dB ↗`
            : `SNR ${nearest.snr?.toFixed(1) ?? '—'} &nbsp; RSSI ${nearest.rssi ?? '—'}`;
        this.tooltip.innerHTML =
            `${dotShape}<b>${this._escHtml(this.displayId(nearest.col))}</b>${nameHtml}<br>` +
            `${time}<br>${valLine}`;

        const tx = e.clientX + 14;
        const ty = e.clientY - 10;
        this.tooltip.style.left = `${Math.min(tx, window.innerWidth - 160)}px`;
        this.tooltip.style.top  = `${Math.max(ty, 4)}px`;
        this.tooltip.style.display = 'block';
    }

    hideChartTooltip() {
        if (this.tooltip) this.tooltip.style.display = 'none';
    }

    // --- Cleanup ---

    startCleanupTimer() {
        this.cleanupInterval = setInterval(() => this.cleanup(), 10000);
    }

    cleanup() {
        const now = Date.now();
        const toRemove = [];
        for (const [hash, data] of this.hashData.entries()) {
            if (now - data.lastSeen > this.HASH_LIFETIME) toRemove.push(hash);
        }

        if (!toRemove.length) {
            // No hashData expired, but chartPoints may still need pruning
            if (isFinite(this.HASH_LIFETIME)) {
                const cutoff = now - this.HASH_LIFETIME;
                const before = this.chartPoints.length;
                this.chartPoints = this.chartPoints.filter(p => p.time >= cutoff);
                this._sentSnrHistory = this._sentSnrHistory.filter(p => p.time >= cutoff);
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
            const cutoff = Date.now() - this.HASH_LIFETIME;
            for (const hash of toRemove) {
                const data = this.hashData.get(hash);
                if (data && data.lastSeen <= cutoff) this.hashData.delete(hash);
            }
            if (isFinite(this.HASH_LIFETIME)) {
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
    }

    _clearAllData() {
        this.hashData.clear();
        this.chartPoints = [];
        this._sentSnrHistory = [];
        this._dscSeq = 0;
        this.repeaterColumns = [];
        this.allRepeaters.clear();
        this._selectedCol = null;
        this._mapPins.clear();
        this.signalMap?.selectColumn(null);
        this.signalMap?.clearPoints?.();
        if (this.msgTableBody) this.msgTableBody.innerHTML = '';
        if (this.msgTableHead) this.msgTableHead.innerHTML = '';
        document.getElementById('msgFilterBar')?.classList.add('hidden');
        this._scheduleChartRender();
        this._renderRepTable();
        this._updateStats();
        if (this.emptyState) this.emptyState.classList.remove('hidden');
    }

    _displayCutoffNow() {
        return isFinite(this.DISPLAY_LIFETIME) ? Date.now() - this.DISPLAY_LIFETIME : 0;
    }

    _applyHideSelect() {
        const hideSelect = document.getElementById('hideSelect');
        if (!hideSelect) return;
        const v = hideSelect.value;
        this.DISPLAY_LIFETIME = (v === 'all' || v === 'Infinity') ? Infinity : +v * 1000;
        const cutoff = this._displayCutoffNow();
        this.signalMap?.setDisplayCutoff?.(cutoff);
        this._scheduleChartRender();
        this._renderRepTable();
        this._renderMsgTable();
        this._updateStats();
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
                <td class="rl-id rl-id-clickable"><span class="rl-dot" style="background:${this._dotColor(repeater)}"></span>${this.displayId(repeater)}${nameTag}</td>
                <td class="rl-num">${d.count}</td>
                <td class="rl-num" style="color:${msc}">${d.maxSnr?.toFixed(1) ?? '—'}</td>
                <td class="rl-num" style="color:${lsc}">${d.lastSnr?.toFixed(1) ?? '—'}</td>
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
        this._applyMsgTableSelection();
        this._updateCornerNotices();
    }

    _updateCornerNotices() {
        const hasFilter = this._repFilterTerms.length > 0;
        const hasSel    = !!this._selectedCol;

        const fSnr = v => v != null && isFinite(v) ? `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}` : '—';

        const buildExtra = (col, showMore, noticePrefix) => {
            const stats = col ? this._colStats(col) : null;
            const contacts = col && col !== 'direct' ? this._contactsByPrefix(col) : [];
            const contactsWithName = contacts.filter(c => c.name);
            const mapBtns = col ? this._contactsForMapButtons(col) : [];
            const isAutoShown = col && col === this._selectedCol;
            const checkId = `${noticePrefix}ShowMore`;
            let mapHtml = '';
            if (mapBtns.length) {
                mapHtml += `<div class="cn-map-btns">`;
                // Collapse all contacts into a single button regardless of count
                const anyPinned = mapBtns.some(c => this._mapPins.has(c.pubKeyFullHex));
                const allPubkeys = mapBtns.map(c => c.pubKeyFullHex).join('|');
                let label, cls;
                if (anyPinned) {
                    label = '✕ Remove pin'; cls = 'cn-map-btn cn-map-btn-active';
                } else if (isAutoShown) {
                    label = '📌 Keep on map'; cls = 'cn-map-btn';
                } else {
                    label = '📍 Show on map'; cls = 'cn-map-btn';
                }
                mapHtml += `<button class="${cls}" data-pubkeys="${this._escHtml(allPubkeys)}">${label}</button>`;
                mapHtml += `</div>`;
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
                    const anyPinned = pks.some(pk => this._mapPins.has(pk));
                    for (const pk of pks) {
                        if (anyPinned) this._mapPins.delete(pk);
                        else this._mapPins.add(pk);
                    }
                    this._updateMapPins();
                    this._updateCornerNotices();
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
                const matchingCols = this.repeaterColumns.filter(c => this._colMatchesRepFilter(c));
                const exactCol = matchingCols.length === 1 && !matchingCols[0].includes('/') ? matchingCols[0] : null;
                const dot = document.getElementById('filterNoticeDot');
                if (dot) {
                    dot.style.background = exactCol ? this._dotColor(exactCol) : '';
                    dot.style.display    = exactCol ? '' : 'none';
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
                if (dot) dot.style.background = this._dotColor(this._selectedCol);
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
            const data = this.hashData.get(hash);
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
        if (mode === 'off') return;
        if (!this.audioCtx) this.audioCtx = new AudioContext();
        const ctx = this.audioCtx;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const baseFreq = 700;
        const scale = mode === 'long' ? 4 : mode === 'medium' ? 2 : 1;

        const beep = (freq, start, dur) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.08, now + start);
            gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
            osc.start(now + start);
            osc.stop(now + start + dur);
        };

        const dur = 0.05 * scale;
        const gap = 0.08 * scale;
        // The two tones run back-to-back over one window: the first tone takes
        // 1/3 of the time, the second (pitched by SNR) the remaining 2/3.
        // SNR 0 dB = base pitch; ±10 dB = ±1 octave.
        const total = dur + gap;
        const d1 = total / 3;
        const d2 = total * 2 / 3;
        beep(baseFreq, 0, d1);
        beep(baseFreq * Math.pow(2, (snr ?? 0) / 10), d1, d2);
    }

    // --- BLE Device Battery ---

    _updateBleBattery(pct) {
        if (!this.batteryEl || !this.device) return;
        if (pct >= 100) return; // BLE Battery Service often reports 100% incorrectly
        this.batteryEl.innerHTML = `<span class="hstat-label">Device </span><span class="batt-icon">🔋</span>${pct}%`;
        this.batteryEl.classList.remove('hidden', 'battery-low');
        if (pct <= 20) this.batteryEl.classList.add('battery-low');
    }

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
        if (this.exportCsvBtn) this.exportCsvBtn.disabled = this.hashData.size === 0;
        const displayCutoff = this._displayCutoffNow();
        const visibleHashes = displayCutoff
            ? Array.from(this.hashData.values()).filter(d => d.lastSeen >= displayCutoff).length
            : this.hashData.size;
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
            if (this.displayId(col).toLowerCase().includes(filter)) return true;
        }
        const m = data.meta;
        if (m?.text?.toLowerCase().includes(filter)) return true;
        if (m?.sender?.toLowerCase().includes(filter)) return true;
        if (m?.name?.toLowerCase().includes(filter)) return true;
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

    _visibleChartPoints() {
        const cutoff = this._displayCutoffNow();
        let pts = cutoff ? this.chartPoints.filter(p => p.time >= cutoff) : this.chartPoints;
        return this._repFilterTerms.length
            ? pts.filter(p => this._colMatchesRepFilter(p.col))
            : pts;
    }

    _visibleSentSnrPts() {
        const cutoff = this._displayCutoffNow();
        let pts = cutoff ? this._sentSnrHistory.filter(p => p.time >= cutoff) : this._sentSnrHistory;
        return this._repFilterTerms.length ? pts.filter(p => this._colMatchesRepFilter(p.col)) : pts;
    }

    _applyRepFilter() {
        this._renderRepTable();
        this._renderMsgTable();
        this._scheduleChartRender();
        this._updateStats();
        this.signalMap?.setFilterFn(
            this._repFilterTerms.length ? col => this._colMatchesRepFilter(col) : null
        );
        this._updateMapPins();
        this._updateCornerNotices();
    }

    async _exportCsv() {
        if (this.hashData.size === 0) return;
        this._unsavedRxCount = 0;

        const msgFilter = this._msgFilter.toLowerCase().trim();

        const esc = v => {
            if (v == null || v === '') return '';
            const s = String(v);
            return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
                ? '"' + s.replace(/"/g, '""') + '"' : s;
        };

        const header = ['time', 'type', 'hash', 'repeater', 'snr', 'uplink_snr', 'rssi', 'raw_hex', 'lat', 'lon', 'text', 'sender'];
        const lines = [];

        // One row per (hash, repeater) pair, sorted chronologically
        const allRows = [];
        for (const [hash, data] of this.hashData) {
            if (msgFilter && !this._rowMatchesFilter(data, msgFilter)) continue;
            for (const [col, rep] of data.repeaters) {
                if (this._repFilterTerms.length && !this._colMatchesRepFilter(col)) continue;
                allRows.push({ hash, data, col, rep });
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
        for (const c of contactsToExport.values()) {
            lines.push('# CONTACT,' + [c.pubKeyFullHex, c.name || '', c.lat ?? 0, c.lon ?? 0].map(esc).join(','));
        }
        lines.push(header.join(','));

        for (const { hash, data, rep } of allRows) {
            lines.push([
                new Date(rep.time ?? data.firstSeen).toISOString(),
                data.type  || '',
                hash,
                rep.rawId  || '',
                rep.snr?.toFixed(2) ?? '',
                rep.remoteSnr?.toFixed(2) ?? '',
                rep.rssi ?? '',
                rep.rawHex || data.rawHex || '',
                rep.lat    ?? '',
                rep.lon    ?? '',
                data.meta?.text   || '',
                data.meta?.sender || '',
            ].map(esc).join(','));
        }

        // Append sent SNR history rows
        for (const p of this._sentSnrHistory) {
            lines.push([
                new Date(p.time).toISOString(),
                'SentSNR',
                'SENTSNR',
                p.col || '',
                '',
                p.snr.toFixed(2),
                '',
                '',
                '',
                p.label || '',
                '',
            ].map(esc).join(','));
        }

        const csv = lines.join('\r\n');
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

    _parseCsvLine(line) {
        const cols = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQ) {
                if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (ch === '"') inQ = false;
                else cur += ch;
            } else {
                if (ch === '"') inQ = true;
                else if (ch === ',') { cols.push(cur); cur = ''; }
                else cur += ch;
            }
        }
        cols.push(cur);
        return cols;
    }

    async _importCsv(file) {
        let text;
        try { text = await file.text(); } catch { alert('Could not read file.'); return; }
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

        const lines = text.split(/\r?\n/);
        if (lines.length < 2) return;

        // Parse embedded contact metadata and find real header line
        let headerLineIdx = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            if (line.startsWith('# CONTACT,')) {
                const parts = this._parseCsvLine(line.slice('# CONTACT,'.length));
                const [pubKeyFullHex, name, latStr, lonStr] = parts;
                if (pubKeyFullHex && !this._contacts.has(pubKeyFullHex)) {
                    const lat = parseFloat(latStr) || 0;
                    const lon = parseFloat(lonStr) || 0;
                    this._contacts.set(pubKeyFullHex, { name: name || null, type: null, lat, lon, lastAdvert: 0, lastmod: 0, pubKeyFullHex });
                }
                continue;
            }
            headerLineIdx = i;
            break;
        }

        const header = this._parseCsvLine(lines[headerLineIdx]);
        const idx = name => header.indexOf(name);
        const iTime = idx('time'), iType = idx('type'), iHash = idx('hash');
        const iRep  = idx('repeater'), iRssi = idx('rssi'), iSnr = idx('snr');
        const iUplinkSnr = idx('uplink_snr');
        const iHex  = idx('raw_hex'), iLat = idx('lat'), iLon = idx('lon');
        const iTxt  = idx('text'), iSnd = idx('sender');

        if (iTime < 0 || iHash < 0 || iRep < 0) {
            alert('Unrecognised CSV format — expected columns: time, hash, repeater.');
            return;
        }

        let rows = [];
        for (let i = headerLineIdx + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const c = this._parseCsvLine(line);
            const time = new Date(c[iTime]).getTime();
            if (isNaN(time)) continue;
            const lat = iLat >= 0 && c[iLat] !== '' ? parseFloat(c[iLat]) : null;
            const lon = iLon >= 0 && c[iLon] !== '' ? parseFloat(c[iLon]) : null;
            rows.push({
                time,
                type:      iType >= 0 ? c[iType] : '',
                hash:      c[iHash],
                repeater:  c[iRep],
                rssi:      parseInt(c[iRssi]) || -100,
                snr:       parseFloat(c[iSnr]) || 0,
                rawHex:    iHex  >= 0 ? c[iHex]  : '',
                lat:       lat != null && !isNaN(lat) ? lat : null,
                lon:       lon != null && !isNaN(lon) ? lon : null,
                uplinkSnr: iUplinkSnr >= 0 && c[iUplinkSnr] !== '' ? parseFloat(c[iUplinkSnr]) : null,
                csvText:   iTxt >= 0 ? c[iTxt]  : '',
                csvSender: iSnd >= 0 ? c[iSnd]  : '',
            });
        }
        // Split SentSNR rows from regular rows
        const sentSnrRows = rows.filter(r => r.type === 'SentSNR');
        rows = rows.filter(r => r.type !== 'SentSNR');

        if (rows.length === 0 && sentSnrRows.length === 0) return;

        const importBtn = document.getElementById('importCsvBtn');
        const prevBtnText = importBtn?.textContent;
        if (importBtn) { importBtn.textContent = 'Importing…'; importBtn.disabled = true; }
        const prevStatus = this.statusEl?.textContent;
        const prevClass  = this.statusEl?.className;
        this.updateStatus('Importing CSV…', 'importing');

        await new Promise(r => setTimeout(r, 0)); // yield to let the browser repaint

        if (this.hashData.size > 0) {
            if (!confirm(`There are already ${this.hashData.size} packet(s) loaded. Packets from the CSV will be added; existing entries are kept unchanged. Continue?`)) return;
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

        for (const row of rows) {
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

        // Import SentSNR history rows
        for (const r of sentSnrRows) {
            this._sentSnrHistory.push({ time: r.time, snr: r.snr, col: r.repeater, label: r.csvText || r.repeater });
        }
        if (sentSnrRows.length) {
            this._sentSnrHistory.sort((a, b) => a.time - b.time);
            this._renderChart('snr');
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
        if (this.statusEl && prevStatus != null) { this.statusEl.textContent = prevStatus; this.statusEl.className = prevClass; }
    }

    updateStatus(text, className) {
        this.statusEl.textContent = text;
        this.statusEl.className = `status ${className}`;
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
        this.device = null; // null before hiding so queued battery events are ignored by guards below
        if (this.batteryEl) this.batteryEl.classList.add('hidden');
        this.updateStatus('Disconnected', 'disconnected');
        this.connectBtn.textContent = 'Connect Bluetooth';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.connectBluetooth();
        this._collecting = false;
        this._updatePauseBtn();
        if (this.emptyState) {
            const p = this.emptyState.querySelector('p');
            if (p) p.textContent = 'Connect to a MeshCore companion device via Bluetooth to start monitoring RX logs.';
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
