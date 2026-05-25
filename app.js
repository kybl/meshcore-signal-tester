// MeshCore RX Monitor Application
import { MeshCoreDecoder, Utils } from 'https://esm.sh/@michaelhart/meshcore-decoder';
import { Signal3DMap } from './signal3d.js?v=33';

class MeshCoreMonitor {
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
        this._batteryCharacteristic = null;
        this._onBatteryChanged = null;
        this._useAbbreviatedTypes = false;
        this._chartSelected = null;
        this._rxTimestamps = [];
        this._msgFilter = '';
        this._repFilterTerms = [];
        this._collecting = false;
        this._unsavedRxCount = 0; // packets received since last CSV export
        this._chartFrozenAt = Date.now();

        this.initUI();
        this.startCleanupTimer();
        this.renderSavedDevices();
        // Render empty chart axes immediately so the section is visible from page load
        requestAnimationFrame(() => this.scheduleChartRender());
    }

    _updatePauseBtn() {
        const btn = document.getElementById('pauseBtn');
        if (!btn) return;
        const connected = !!this.device;
        btn.disabled = !connected;
        if (this._collecting) {
            btn.textContent = '⏸ Pause';
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
        if (this._collecting) this.acquireWakeLock();
        else this.releaseWakeLock();
    }

    initUI() {
        this.connectBtn = document.getElementById('connectBtn');
        this.statusEl = document.getElementById('status');
        this.batteryEl = document.getElementById('batteryStatus');
        this.rssiChartWrap = document.getElementById('rssiChartWrap');
        this.rssiChartSvg  = document.getElementById('rssiChart');
        this.rssiChartLegend = document.getElementById('rssiChartLegend');
        this.snrChartWrap  = document.getElementById('snrChartWrap');
        this.snrChartSvg   = document.getElementById('snrChart');
        this.snrChartLegend = document.getElementById('snrChartLegend');
        this.sentSnrChartWrap  = document.getElementById('sentSnrChartWrap');
        this.sentSnrChartSvg   = document.getElementById('sentSnrChart');
        this.sentSnrChartLegend = document.getElementById('sentSnrChartLegend');
        if (typeof ResizeObserver !== 'undefined') {
            const obs = new ResizeObserver(() => this.scheduleChartRender());
            document.querySelectorAll('.chart-svg-wrap').forEach(el => obs.observe(el));
        }
        setInterval(() => {
            if (!this._chartFrozenAt) this.scheduleChartRender();
            if (isFinite(this.DISPLAY_LIFETIME)) {
                this.signalMap?.setDisplayCutoff?.(this._displayCutoffNow());
                this.updateRepeaterTable();
                this.renderMsgTable();
            }
            this.updateStats();
        }, 2000);

        // Collapsible sections — clicking anywhere in the header row toggles
        document.querySelectorAll('.section-header').forEach(header => {
            const btn = header.querySelector('.collapse-btn');
            if (!btn) return;
            header.addEventListener('click', e => {
                if (e.target.closest('.help-icon')) return; // help icon has its own handler
                const body = document.getElementById(btn.dataset.target);
                if (!body) return;
                const collapsed = body.classList.toggle('collapsed');
                btn.classList.toggle('collapsed', collapsed);
            });
        });
        this.msgTableHead = document.getElementById('msgTableHead');
        this.msgTableBody = document.getElementById('msgTableBody');
        this.emptyState = document.getElementById('emptyState');
        this.activeHashesEl = document.getElementById('activeHashes');
        this.totalRxEl = document.getElementById('totalRx');
        this.totalRepeatersEl = document.getElementById('totalRepeaters');
        this.repeaterLogBody = document.getElementById('repeaterLogBody');
        this.soundSelect = document.getElementById('soundSelect');
        try { const s = localStorage.getItem('sound'); if (s) this.soundSelect.value = s; } catch {}
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
                if (this.chartPoints.length) this.scheduleChartRender();
                this._checkTableOverflow(true);
            }, 150);
        });

        const bindChartTooltip = (svg, type) => {
            if (!svg) return;
            svg.addEventListener('mousemove', e => this.showChartTooltip(e, type));
            svg.addEventListener('mouseleave', () => this.hideChartTooltip());
            svg.addEventListener('click', e => this._onChartClick(e, type));
            svg.addEventListener('touchstart', e => {
                if (e.touches.length === 1) this.showChartTooltip(e.touches[0], type);
            }, { passive: true });
            svg.addEventListener('touchend', () => {
                setTimeout(() => this.hideChartTooltip(), 2000);
            });
        };
        bindChartTooltip(this.rssiChartSvg, 'rssi');
        bindChartTooltip(this.snrChartSvg,  'snr');

        // Legend click for repeater selection
        const bindLegendClick = legend => {
            if (!legend) return;
            legend.addEventListener('click', e => {
                const item = e.target.closest('.legend-item[data-col]');
                if (!item) return;
                const col = item.dataset.col;
                this._selectRepeater(this._chartSelected === col ? null : col);
            });
        };
        bindLegendClick(this.rssiChartLegend);
        bindLegendClick(this.snrChartLegend);

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
        document.getElementById('repeaterLogBody')?.addEventListener('click', e => {
            const row = e.target.closest('tr[data-col]');
            if (!row) return;
            const col = row.dataset.col;
            this._selectRepeater(col === this._chartSelected ? null : col);
        });

        // Click column header in Received Packets to select repeater
        document.getElementById('msgTableHead')?.addEventListener('click', e => {
            const th = e.target.closest('th.msg-col-rep[data-col]');
            if (!th) return;
            const col = th.dataset.col;
            this._selectRepeater(col === this._chartSelected ? null : col);
        });

        document.getElementById('savedDevices')?.addEventListener('click', e => {
            const quickBtn = e.target.closest('.saved-btn');
            const forgetBtn = e.target.closest('.forget-btn');
            if (quickBtn) this.quickConnect(quickBtn.dataset.id);
            if (forgetBtn) this.forgetDevice(forgetBtn.dataset.id);
        });

        const ttlSelect  = document.getElementById('ttlSelect');
        const hideSelect = document.getElementById('hideSelect');
        if (ttlSelect) {
            try { const s = localStorage.getItem('ttl'); if (s) ttlSelect.value = s; } catch {}
            const v = ttlSelect.value;
            this.HASH_LIFETIME = v === 'Infinity' ? Infinity : +v * 1000;
            ttlSelect.addEventListener('change', () => {
                const v = ttlSelect.value;
                this.HASH_LIFETIME = v === 'Infinity' ? Infinity : +v * 1000;
                try { localStorage.setItem('ttl', v); } catch {}
                this._updateHideSelectOptions();
            });
        }
        if (hideSelect) {
            try { let s = localStorage.getItem('hide'); if (s === 'same') s = 'all'; if (s) hideSelect.value = s; } catch {}
            this._applyHideSelect();
            hideSelect.addEventListener('change', () => {
                try { localStorage.setItem('hide', hideSelect.value); } catch {}
                this._applyHideSelect();
            });
        }
        this._updateHideSelectOptions();

        document.getElementById('clearDataBtn')?.addEventListener('click', () => {
            if (!confirm('Delete all captured data? This cannot be undone.')) return;
            this._clearAllData();
        });

        document.getElementById('discoverBtn')?.addEventListener('click', () => this.startDiscoverSequence(0x0F));

        this.soundSelect?.addEventListener('change', () => {
            try { localStorage.setItem('sound', this.soundSelect.value); } catch {}
        });

        // Point size controls
        try { this._dotSize = parseFloat(localStorage.getItem('dotSize') || '3.5'); } catch { this._dotSize = 3.5; }
        try { this._sphereSize = parseFloat(localStorage.getItem('sphereSize') || '1'); } catch { this._sphereSize = 1; }

        const dotSizeInput = document.getElementById('dotSizeInput');
        const dotSizeVal   = document.getElementById('dotSizeVal');
        if (dotSizeInput) {
            dotSizeInput.value = this._dotSize;
            if (dotSizeVal) dotSizeVal.textContent = this._dotSize;
            dotSizeInput.addEventListener('input', () => {
                this._dotSize = parseFloat(dotSizeInput.value);
                if (dotSizeVal) dotSizeVal.textContent = this._dotSize;
                try { localStorage.setItem('dotSize', this._dotSize); } catch {}
                this.scheduleChartRender();
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
                try { localStorage.setItem('sphereSize', this._sphereSize); } catch {}
                this.signalMap?.setSphereSize(this._sphereSize);
            });
        }

        // Collapsible chart legends
        document.querySelectorAll('.legend-toggle-btn').forEach(btn => {
            const wrap = document.getElementById(btn.dataset.wrap);
            const key  = btn.dataset.key;
            const applyState = collapsed => {
                wrap?.classList.toggle('legend-collapsed', collapsed);
                btn.textContent = (collapsed ? '▸' : '▾') + ' Legend';
                try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
            };
            try { applyState(localStorage.getItem(key) === '1'); } catch { applyState(false); }
            btn.addEventListener('click', () => applyState(!wrap?.classList.contains('legend-collapsed')));
        });

        const repeaterHead = document.querySelector('.repeater-log-table thead');
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
                this.updateRepeaterTable();
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
                this.renderMsgTable();
            });
        }
        if (msgFilterClear) {
            msgFilterClear.addEventListener('click', () => {
                this._msgFilter = '';
                if (msgFilterInput) { msgFilterInput.value = ''; msgFilterInput.classList.remove('has-value'); }
                msgFilterClear.classList.add('hidden');
                msgFilterApplied?.classList.add('hidden');
                this.renderMsgTable();
                msgFilterInput?.focus();
            });
        }
        this.exportCsvBtn = document.getElementById('exportCsvBtn');
        this.exportCsvBtn?.addEventListener('click', () => this._exportCsv());

        const importCsvInput = document.getElementById('importCsvInput');
        document.getElementById('importCsvBtn')?.addEventListener('click', () => importCsvInput?.click());
        importCsvInput?.addEventListener('change', () => {
            const file = importCsvInput.files?.[0];
            if (file) { this._importCsv(file); importCsvInput.value = ''; }
        });

        const fsBtn = document.getElementById('signalMapFullscreenBtn');
        if (fsBtn) {
            const mapContainer = document.querySelector('.signal-map-container');
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

        // Corner notice buttons
        document.getElementById('filterNoticeHelpBtn')?.addEventListener('click', () => {
            const hint = document.getElementById('filterNoticeHint');
            hint?.classList.toggle('hidden');
        });
        document.getElementById('filterNoticeClear')?.addEventListener('click', () => {
            this._repFilterTerms = [];
            const inp = document.getElementById('repFilter');
            if (inp) { inp.value = ''; inp.classList.remove('has-value'); }
            document.getElementById('repFilterClear')?.classList.add('hidden');
            document.getElementById('repFilterApplied')?.classList.add('hidden');
            this._applyRepFilter();
        });
        document.getElementById('selNoticeFilter')?.addEventListener('click', () => {
            const col = this._chartSelected;
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
            if (this.device || this._unsavedRxCount > 0) {
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
                let hex = raw.replace(/^!/, '').toUpperCase();
                if (!/^[0-9A-F]+$/.test(hex)) {
                    if (fbk) { fbk.textContent = 'hex digits only'; setTimeout(() => fbk.textContent = '', 1500); }
                    return;
                }
                if (hex.length % 2) hex = '0' + hex;
                repeater = '!' + hex;
            }
            // Unique payload so each inject creates a fresh row, not a merge
            const fakeHex = 'debug-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
            const hash    = this.hashPayload(fakeHex);
            const rssi    = -60 - Math.floor(Math.random() * 50);
            const snr     = Math.round((Math.random() * 25 - 10) * 10) / 10;
            this.addRxEntry(hash, repeater, 'Flood Debug', fakeHex, snr, rssi, { debug: true }, null, { forceIngest: true });
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
        const canvas = document.getElementById('signalMapCanvas');
        if (!canvas) return;

        const sourceSel = document.getElementById('mapSourceSelect');
        const savedSource = (() => {
            try {
                const v = localStorage.getItem('mapSource') || '';
                // Migrate the original single-key 'mapycom' value
                return v === 'mapycom' ? 'mapycom-basic' : v;
            } catch { return ''; }
        })();
        if (sourceSel && savedSource) sourceSel.value = savedSource;

        try {
            this.signalMap = new Signal3DMap({
                canvas,
                statusEl:      document.getElementById('locationStatus'),
                btnEl:         document.getElementById('enableLocationBtn'),
                emptyEl:       document.getElementById('signalMapEmpty'),
                infoEl:        document.getElementById('signalMapInfo'),
                colorFor:      col => this.getRepeaterColor(col),
                displayId:     col => this.displayId(col),
                initialSource:  sourceSel?.value,
                initialSphereSize: this._sphereSize,
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
            });
        } catch (err) {
            console.error('Signal3DMap init failed:', err);
            this.signalMap = null;
            document.getElementById('signalMapWrap')?.classList.add('signal-map-offline');
            const emptyEl = document.getElementById('signalMapEmpty');
            if (emptyEl) {
                emptyEl.classList.remove('hidden');
                emptyEl.textContent = '3D map unavailable — WebGL is not supported or disabled in this browser.';
            }
            return;
        }

        sourceSel?.addEventListener('change', () => {
            this.signalMap.setMapSource(sourceSel.value);
            try { localStorage.setItem('mapSource', sourceSel.value); } catch {}
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

        const showLinesChk  = document.getElementById('showLinesChk');
        const showMarkerChk = document.getElementById('showMarkerChk');
        showLinesChk?.addEventListener('change', () => {
            this.signalMap?.setShowLines(showLinesChk.checked);
            try { localStorage.setItem('showLines', showLinesChk.checked); } catch {}
        });
        showMarkerChk?.addEventListener('change', () => {
            this.signalMap?.setShowMarker(showMarkerChk.checked);
            try { localStorage.setItem('showMarker', showMarkerChk.checked); } catch {}
        });
        // Restore saved values
        try {
            if (localStorage.getItem('showLines') === 'false' && showLinesChk) {
                showLinesChk.checked = false;
                this.signalMap?.setShowLines(false);
            }
            if (localStorage.getItem('showMarker') === 'false' && showMarkerChk) {
                showMarkerChk.checked = false;
                this.signalMap?.setShowMarker(false);
            }
        } catch {}
    }

    _initHelpSystem() {
        const HELP = {
            'active':
                'Unique packets in the current display window. Data outside the window is still stored (see Auto-remove) but not shown (see Display).',
            'totalrx':
                'All packet arrivals this session. The same packet heard via two different repeaters counts as two.',
            'repeaters-count':
                'Distinct repeaters visible in the current display window. More may be stored but hidden.',
            'sound':
                'off = silent. short / medium / long play a beep of increasing duration (long is 4× short) on each new packet. Pitch varies with RSSI — stronger signal → higher pitch. Setting is remembered across sessions.',
            'ttl':
                'Data older than this window is permanently deleted — packets, signal history, seen repeaters, and 3D map points all expire together. Collision labels are recalculated when their evidence ages out. "Never" keeps everything for the whole session (set automatically on CSV import).',
            'display':
                'How far back to look when displaying data. Does not delete anything — data outside this window is still stored and continues to influence repeater ID merging and collision detection. "All" shows the full storage window. Can only be set equal to or shorter than Auto-remove.',
            'repeater':
                '"direct" = flood-routed packet received at first hop. Otherwise the ID of the last forwarding repeater. Click a row to select that repeater — dims others in all views (charts, Received packets, 3D map); click again to deselect. Click a column header to sort by that field; click again to reverse. See "Show help" → Repeater ID prefix resolution for how partial IDs and collision labels work.',
            'rssi':
                'Received Signal Strength in dBm. Less negative = stronger. −70 dBm: excellent · −120 dBm: very weak.',
            'snr':
                'Signal-to-Noise Ratio in dB. Positive = signal is above the noise. LoRa can decode even at negative SNR (down to ~−20 dB).',
            'chart-interact':
                'Click a dot or legend label to select that repeater — dims others across both charts, Seen Repeaters, Received Packets, and the 3D map; click again or elsewhere to deselect. A notice appears top-right with options to filter or deselect. The shaded area on the RSSI chart shows the estimated noise floor (RSSI − SNR).',
            'rate':
                'Packets received in the last 60 seconds (rolling). Resets to 0 when the network goes quiet.',
            'rep-filter':
                'Comma-separated list of repeater IDs to keep visible. Matching is prefix-based and works either way — "5E" matches "5E9F1234" and vice versa. Affects Seen Repeaters, charts, Received Packets, and the 3D map. A notice appears top-right while a filter is active.',
            'messages':
                'Click any RSSI or SNR cell to expand full packet detail and raw hex, including reception time with millisecond precision. Click the hex string in an expanded row to copy it to the clipboard. Click a repeater column header to select that repeater — syncs with Seen Repeaters, charts, and 3D map. Repeater columns are ordered by: packets received in the last 5 min (desc), then last RSSI, last SNR, total RX count, then alphabetically.',
            'msg-type':
                'Type abbreviations — AD: Advert · GT: GroupText · TR: Traceroute · RS: Response · RQ: Request · PN: Ping · TX: TextMessage · PT: Path · CT: Control · PV: Private. Full type is shown in the expanded row.',
            'signal3d':
                'Interactive 3D map of received signal strength. Each dot is positioned at your GPS location at reception time; height reflects RSSI (taller = stronger) and scales with camera zoom. Click a dot to select that repeater — shows an info panel and syncs the selection across Seen Repeaters, charts, and Received Packets. Use ⚙ (top right) to change map source, dot size, guide lines, and the location marker. Navigation: drag to pan · scroll/pinch to zoom · right-drag to tilt/rotate.',
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
                console.error('Bluetooth error:', error);
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
                        console.error('Quick connect error:', error);
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
                console.error('Quick connect error:', error);
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

        // Try to read BLE device battery (standard Battery Service 0x180F)
        if (this.device && server) {
            try {
                const battSvc  = await server.getPrimaryService('0000180f-0000-1000-8000-00805f9b34fb');
                const battChar = await battSvc.getCharacteristic('00002a19-0000-1000-8000-00805f9b34fb');
                const val = await battChar.readValue();
                this._updateBleBattery(val.getUint8(0));
                try {
                    this._onBatteryChanged = e => this._updateBleBattery(e.target.value.getUint8(0));
                    await battChar.startNotifications();
                    battChar.addEventListener('characteristicvaluechanged', this._onBatteryChanged);
                    this._batteryCharacteristic = battChar;
                } catch (e) { /* notifications not supported — one-shot read is enough */ }
            } catch (e) { /* device does not expose Battery Service */ }
        }

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

    // Send DISCOVER_REQ 4 times with 500 ms gaps — LoRa is lossy, repeating improves coverage.
    // All retries share the same tag so every response is correlated correctly.
    async startDiscoverSequence(filterMask) {
        if (!this.bleRxCharacteristic) return;
        if (this._discoverActive) return; // prevent double-click overlap

        const btn = document.getElementById('discoverBtn');
        const REPEATS = 4;
        const INTERVAL_MS = 500;
        this._discoverActive = true;

        const tag = (Math.random() * 0xFFFFFFFF) >>> 0;
        if (!this._discoverTags) this._discoverTags = new Map();
        this._discoverTags.set(tag, Date.now());
        // Prune tags older than 30 s
        for (const [t, ts] of this._discoverTags)
            if (Date.now() - ts > 30000) this._discoverTags.delete(t);

        for (let i = 0; i < REPEATS; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, INTERVAL_MS));
            await this.sendDiscoverRequest(filterMask, tag);
            if (btn) btn.textContent = `Discovering… (${i + 1}/${REPEATS})`;
        }

        // Keep button showing "Discovering…" for a further 2 s to collect late responses
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
        } catch (e) {
            console.error('sendDiscoverRequest:', e);
        }
    }

    // --- Saved devices (localStorage) ---

    getSavedDevices() {
        try { return JSON.parse(localStorage.getItem('meshcore-devices') || '[]'); }
        catch { return []; }
    }

    saveDevice(device) {
        const devices = this.getSavedDevices();
        const existing = devices.find(d => d.id === device.id);
        if (existing) {
            existing.name = device.name || existing.name;
        } else {
            devices.push({ id: device.id, name: device.name || 'Unknown' });
        }
        localStorage.setItem('meshcore-devices', JSON.stringify(devices));
        this.renderSavedDevices();
    }

    forgetDevice(deviceId) {
        const devices = this.getSavedDevices().filter(d => d.id !== deviceId);
        localStorage.setItem('meshcore-devices', JSON.stringify(devices));
        this.renderSavedDevices();
    }

    renderSavedDevices() {
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
            const rawHex = this.bufferToHex(loraPacket.buffer);
            const packet = MeshCoreDecoder.decode(rawHex);
            if (packet.isValid) this.processPacket(packet, rawHex, snr, rssi);
        } catch (e) {
            console.error('Decode error:', e);
        }
    }

    _handleAdvertPush(payload) {
        // Format: byte 0 = push code, bytes 1-32 = pub_key (32 B),
        // optional byte 33 = adv_type, optional bytes 34+ = name (null-term)
        if (payload.length < 33) return;
        const pubKey = payload.slice(1, 33);
        const advType = payload.length > 33 ? payload[33] : null;
        const TYPE_NAMES = { 1: 'Chat', 2: 'Repeater', 3: 'RoomSrv', 4: 'Sensor' };
        const typeName = advType != null ? (TYPE_NAMES[advType] ?? `Adv${advType}`) : 'Node';
        let name = '';
        for (let i = 34; i < payload.length && payload[i] !== 0; i++)
            name += String.fromCharCode(payload[i]);
        const pubKeyHex = Array.from(pubKey.slice(0, 3))
            .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const pubKeyFull = Array.from(pubKey)
            .map(b => b.toString(16).padStart(2, '0')).join('');
        // Store advert metadata for later DSC correlation (name lookup etc.) without
        // adding a row to Received Packets.
        const hash = 'AD:' + pubKeyHex;
        const existing = this.hashData.get(hash);
        if (existing) {
            existing.meta = { ...existing.meta, name: name || existing.meta?.name || null, advType, pubKeyFull };
        } else {
            // Lightweight stub — not shown in the table (no addRxEntry)
            this.hashData.set(hash, { _stub: true, repeaters: new Map(), firstSeen: Date.now(), lastSeen: Date.now(), insertOrder: 0, type: typeName + ' AD', rawHex: null, meta: { name: name || null, advType, pubKeyHex, pubKeyFull }, packet: null });
        }
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

        // Record uplink SNR in the Sent SNR History chart
        this._sentSnrHistory.push({ time: Date.now(), snr: remoteSnr, col: pubKeyHex, label: nodeName ?? pubKeyHex });
        this.scheduleChartRender();

        // Each DSC response → new row in Received Packets (same node can respond to
        // multiple retries; always use current time so order is correct).
        // Column = the responding node's pub key prefix so all its DSC responses share one column.
        const dscHash = 'DSC:' + (++this._dscSeq);
        const rawHex = Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join('');
        this.addRxEntry(dscHash, pubKeyHex, typeName + ' DSC', rawHex, ourSnr, ourRssi, meta, null);
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
        this.addRxEntry(hash, repeaterCol, 'Trace', null, lastSnr, null, meta, null);
    }

    bufferToHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    processPacket(packet, rawHex, snr, rssi) {
        const payloadRaw = packet.payload?.raw;
        const hash = payloadRaw ? this.hashPayload(payloadRaw) : packet.messageHash;
        const repeater = this.extractRepeater(packet);
        const type = [
            Utils.getRouteTypeName(packet.routeType),
            Utils.getPayloadTypeName(packet.payloadType),
        ].filter(Boolean).join(' ');

        const path = packet.path || [];
        const pathLen = path.length;
        const firstItem = pathLen > 0 ? path[0] : null;
        const firstItemBytes = typeof firstItem === 'string' ? firstItem.length / 2
            : typeof firstItem === 'number' ? 4 : 0;
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

        if (hash && repeater) {
            this.addRxEntry(hash, repeater, type, rawHex, snr, rssi, meta, packet);
        }
    }

    escHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    hashPayload(str) {
        // Two independent FNV-1a passes → 16 hex chars
        let h1 = 0x811c9dc5, h2 = 0xdeadbeef;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 ^= c; h1 = Math.imul(h1, 0x01000193);
            h2 ^= c; h2 = Math.imul(h2, 0x01000193) ^ (h2 >>> 5);
        }
        return [h1, h2].map(h => (h >>> 0).toString(16).padStart(8, '0')).join('').toUpperCase();
    }

    extractRepeater(packet) {
        if (packet.path && packet.path.length > 0) {
            return this.formatNodeId(packet.path[packet.path.length - 1]);
        }
        // Empty path is only meaningful when the route accumulates hops.
        // Flood-routed packets append the forwarder ID at every hop, so an
        // empty path proves the packet was heard at first hop = direct RF.
        // Other routing modes (unicast Direct, etc.) leave path empty by
        // design and tell us nothing about coverage — drop them.
        const routeName = Utils.getRouteTypeName(packet.routeType) || '';
        return /Flood/i.test(routeName) ? 'direct' : null;
    }

    formatNodeId(nodeId) {
        if (typeof nodeId === 'number') {
            // Round up to byte boundary; don't force 4-byte padding (would clobber
            // precision info — see idPrecision/idsCompatible).
            let hex = nodeId.toString(16);
            if (hex.length % 2 !== 0) hex = '0' + hex;
            return '!' + hex;
        }
        return nodeId?.toString() || 'unknown';
    }

    // --- Node ID prefix resolution ---
    // Path IDs can be 1/2/3-byte truncations of full 4-byte node IDs.
    // The first ID seen wins as the column key; all compatible refinements
    // (longer or shorter prefixes that share its bytes) merge into it.

    idPrecision(id) {
        if (id === 'direct' || id === 'unknown' || id.includes('/')) return 4;
        const hex = id.startsWith('!') ? id.slice(1) : id;
        return Math.ceil(hex.length / 2);
    }

    idSuffix(id, bytes) {
        // IDs are high-byte-first: '5E' is the high byte of '5E9F', so compare from left
        const hex = id.startsWith('!') ? id.slice(1) : id;
        return hex.slice(0, bytes * 2).toUpperCase();
    }

    idsCompatible(id1, id2) {
        if (id1.includes('/') || id2.includes('/')) return false;
        if (id1 === 'direct' || id2 === 'direct') return id1 === id2;
        if (id1 === 'unknown' || id2 === 'unknown') return id1 === id2;
        const minPrec = Math.min(this.idPrecision(id1), this.idPrecision(id2));
        return this.idSuffix(id1, minPrec) === this.idSuffix(id2, minPrec);
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
        if (this._chartSelected === oldKey) this._chartSelected = newKey;

        this.msgTableBody?.querySelectorAll('tr.detail-row').forEach(tr => {
            if (tr.dataset.col === oldKey) tr.dataset.col = newKey;
        });

        this.signalMap?.renameCol?.(oldKey, newKey);
    }

    displayId(id) {
        if (id === 'direct' || id === 'unknown') return id;
        if (id.includes('/')) return id.split('/').map(p => this.displayId(p)).join('/');
        const hex = id.startsWith('!') ? id.slice(1) : id;
        const num = parseInt(hex, 16);
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

    addRxEntry(hash, repeater, type, rawHex, snr, rssi, meta = {}, packet = null, opts = {}) {
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

        this.updateRepeaterTable();
        this.sortColumns();
        this.renderMsgTable(isNewHash ? hash : null);
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
        this.scheduleChartRender();

        // Sound only when the entry would actually appear under the current filters
        const data = this.hashData.get(hash);
        const filterText = this._msgFilter.toLowerCase().trim();
        const matchesMsgFilter = !filterText || this._rowMatchesFilter(data, filterText);
        const matchesRepFilter = !this._repFilterTerms.length || this._colMatchesRepFilter(canonicalKey);
        if (matchesMsgFilter && matchesRepFilter) this.playRxSound(rssi);
        this.updateStats();
        this.emptyState?.classList.add('hidden');
    }

    // --- Column management ---

    sortColumns() {
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

    abbreviateType(type) {
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
            this.renderMsgTable();
        } else if (!overflows && allowUpgrade && this._useAbbreviatedTypes) {
            this._useAbbreviatedTypes = false;
            this.renderMsgTable();
        }
    }

    // --- Table rendering ---

    renderMsgTable(flashHash = null) {
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
                    : 'No packets yet.';
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
            const repHeaders = visibleCols.map(r =>
                `<th colspan="2" class="msg-col-rep" data-col="${this.escHtml(r)}"><span class="rl-dot" style="background:${this.getRepeaterColor(r)}"></span>${this.displayId(r)}</th>`
            ).join('');
            const subHeaders = visibleCols.map(() =>
                `<th class="msg-sub-rssi">RSSI</th><th class="msg-sub-snr">SNR</th>`
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
            this.buildMsgRowHtml(hash, data, visibleCols)
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
            detail.innerHTML = this.buildDetailRowHtml(hash, col);
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

    buildMsgRowHtml(hash, data, cols = this.repeaterColumns) {
        const cells = cols.map(r => {
            const sig = data.repeaters.get(r);
            return sig ? this.buildSigCellsHtml(sig.rssi, sig.snr, hash, r) : '<td></td><td></td>';
        }).join('');
        const typeDisplay = this._useAbbreviatedTypes
            ? this.escHtml(this.abbreviateType(data.type))
            : this.escHtml(data.type || '?');
        return `<tr id="row-${hash}">
            <td class="msg-col-rx">
                <span class="rx-time">${this.formatTime(data.firstSeen)}</span><span class="rx-type" title="${this.escHtml(data.type || '?')}">${typeDisplay}</span>
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
        detail.innerHTML = this.buildDetailRowHtml(hash, col);
        if (col) {
            this.msgTableBody?.querySelectorAll(`[data-hash="${hash}"][data-col="${col}"]`)
                .forEach(el => el.classList.add('sig-active'));
        }
    }

    syntaxHighlightJson(json) {
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

    formatPacketDetail(packet) {
        const clean = JSON.parse(JSON.stringify(packet));
        delete clean.isValid;
        if (clean.payload) delete clean.payload.raw;

        const walk = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const [k, v] of Object.entries(obj)) {
                if (typeof v === 'string' && /^[0-9A-Fa-f]{33,}$/.test(v)) {
                    obj[k] = v.slice(0, 32) + '…';
                } else if ((k === 'timestamp' || k === 'time') && typeof v === 'number' && v > 1_000_000_000 && v < 4_000_000_000) {
                    obj[k] = new Date(v * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
                } else if (typeof v === 'object' && v !== null) {
                    walk(v);
                }
            }
        };
        walk(clean);
        return JSON.stringify(clean, null, 2);
    }

    buildDetailRowHtml(hash, col = null) {
        const data = this.hashData.get(hash);
        if (!data) return '';
        const colspan = 1 + this.repeaterColumns.length * 2;

        // Use per-repeater packet/rawHex when available (each repeater receives a different path)
        const repEntry = col ? data.repeaters.get(col) : null;
        const pkt = repEntry?.packet ?? data.packet;
        const hex = repEntry?.rawHex ?? data.rawHex;

        let header = '';
        if (repEntry) {
            const rc = this.signalColor(repEntry.rssi, -70, -130);
            const sc = this.signalColor(repEntry.snr,  13, -10, 0);
            const timeStr = repEntry.time ? this.formatTimeMs(repEntry.time) : '';
            const hexPart = hex
                ? ` &nbsp; <code class="raw-hex" data-hex="${hex}" title="Click to copy raw hex">${this.escHtml(hex.slice(0, 12))}…</code>`
                : '';
            header = `<div class="detail-sig">` +
                `<b>${this.escHtml(this.displayId(col))}</b>` +
                (timeStr ? ` &nbsp; <span class="detail-time">${timeStr}</span>` : '') +
                ` &nbsp; RSSI <span style="color:${rc};font-weight:700">${repEntry.rssi ?? '—'}</span>` +
                ` &nbsp; SNR <span style="color:${sc};font-weight:700">${repEntry.snr?.toFixed(1) ?? '—'}</span>` +
                hexPart +
                `</div>`;
        }

        const typeHtml = data.type
            ? `<div class="detail-type">${this.escHtml(data.type)}</div>`
            : '';
        const jsonHtml = pkt
            ? `<pre class="detail-json">${this.syntaxHighlightJson(this.formatPacketDetail(pkt))}</pre>`
            : '';
        let metaHtml = '';
        if (data.meta?.pubKeyFull) {
            const pk = data.meta.pubKeyFull.toUpperCase().match(/.{1,8}/g).join(' ');
            const rs = data.meta.remoteSnr;
            const remoteStr = rs != null
                ? ` &nbsp; <b>Uplink SNR: <span style="color:${this.signalColor(rs, 13, -10, 0)}">${rs.toFixed(1)} dB</span></b>` : '';
            metaHtml = `<div class="detail-pubkey">Public key: <code>${pk}</code>${remoteStr}</div>`;
        }

        return `<td colspan="${colspan}" class="detail-cell"><div class="detail-content">${typeHtml}${header}${metaHtml}${jsonHtml}</div></td>`;
    }

    buildSigCellsHtml(rssi, snr, hash, col) {
        const rc = this.signalColor(rssi, -70, -130);
        const sc = this.signalColor(snr,  13, -10, 0);
        const rssiStr = rssi != null ? rssi : '—';
        const snrStr  = snr  != null ? snr.toFixed(1) : '—';
        return `<td class="sig-rssi" data-hash="${hash}" data-col="${col}" style="color:${rc}">${rssiStr}</td>` +
               `<td class="sig-snr"  data-hash="${hash}" data-col="${col}" style="color:${sc}">${snrStr}</td>`;
    }

    scheduleChartRender() {
        if (this._chartRenderPending) return;
        this._chartRenderPending = true;
        requestAnimationFrame(() => {
            this._chartRenderPending = false;
            this.renderCharts();
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
            this.chartColors.set(col, `hsl(${hue}, 72%, 44%)`);
        }
        return this.chartColors.get(col);
    }

    renderCharts() {
        if (this._chartSelected && !this._visibleChartPoints().some(p => p.col === this._chartSelected)) {
            this._selectRepeater(null);
        }
        this.renderChart('rssi');
        this.renderChart('snr');
        this.renderSentSnrChart();
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
        if (vMin === Infinity) { vMin = 0; vMax = 1; }
        const rawRange = vMax - vMin || 1;
        const yStep = rawRange <= 5 ? 1 : rawRange <= 10 ? 2 : rawRange <= 25 ? 5 : rawRange <= 50 ? 10 : 20;
        const yPad = Math.max(1, yStep / 2);
        const yMin = vMin - yPad;
        const yMax = Math.ceil((vMax + yPad) / yStep) * yStep;
        return { yMin, yMax, yStep };
    }

    _earliestTime(pts) {
        let m = Infinity;
        for (const p of pts) if (p.time < m) m = p.time;
        return m;
    }

    _onChartClick(e, type) {
        const pts = this._visibleChartPoints();
        if (!pts.length) return;
        const svg = type === 'rssi' ? this.rssiChartSvg : this.snrChartSvg;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const W = rect.width || 600;
        const H = rect.height || 180;
        const pl = 36, pr = 8, pt = 6, pb = 24;
        const cw = W - pl - pr;
        const ch = H - pt - pb;
        const now = this._chartFrozenAt ?? Date.now();
        const tMin = isFinite(this.HASH_LIFETIME)
            ? now - this.HASH_LIFETIME
            : this._earliestTime(pts);
        const tRange = Math.max(1, now - tMin);
        const { yMin, yMax } = this._chartYBounds(type);
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
            if (this._chartSelected) this._selectRepeater(null);
            return;
        }
        this._selectRepeater(this._chartSelected === nearest.col ? null : nearest.col);
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

    renderChart(type) {
        const wrap   = type === 'rssi' ? this.rssiChartWrap   : this.snrChartWrap;
        const svg    = type === 'rssi' ? this.rssiChartSvg    : this.snrChartSvg;
        const legend = type === 'rssi' ? this.rssiChartLegend : this.snrChartLegend;
        if (!svg) return;
        wrap?.classList.remove('hidden');

        const pts = this._visibleChartPoints();
        const hasData = pts.length > 0;

        const W = svg.clientWidth || 600;
        const H = svg.clientHeight || 180;
        const pl = 36, pr = 8, pt = 6, pb = 24;
        const cw = W - pl - pr;
        const ch = H - pt - pb;

        const now = this._chartFrozenAt ?? Date.now();
        const defaultWindow = 5 * 60000;
        let tMin;
        if (!hasData) tMin = now - defaultWindow;
        else if (isFinite(this.HASH_LIFETIME)) tMin = now - this.HASH_LIFETIME;
        else tMin = this._earliestTime(pts);

        let yMin, yMax, yStep;
        if (!hasData) {
            if (type === 'rssi') { yMin = -130; yMax = -30; yStep = 20; }
            else                 { yMin = -20;  yMax = 15;  yStep = 5;  }
        } else {
            ({ yMin, yMax, yStep } = this._chartYBounds(type));
        }
        const tRange = Math.max(1, now - tMin);
        const yRange = Math.max(1e-9, yMax - yMin);

        const xOf = t => (pl + (t - tMin) / tRange * cw).toFixed(1);
        const yOf = v => (pt + (1 - (v - yMin) / yRange) * ch).toFixed(1);
        const valOf = p => type === 'rssi' ? p.rssi : p.snr;

        const parts = [];

        // Y grid + labels (major every yStep, minor every yStep/2)
        const yMinorStep = yStep / 2;
        for (let y = yMin + yMinorStep; y < yMax; y += yStep) {
            const yp = yOf(y);
            parts.push(`<line x1="${pl}" y1="${yp}" x2="${pl + cw}" y2="${yp}" stroke="#f5f5f5" stroke-width="1"/>`);
        }
        for (let y = yMin; y <= yMax; y += yStep) {
            const yp = yOf(y);
            parts.push(`<line x1="${pl}" y1="${yp}" x2="${pl + cw}" y2="${yp}" stroke="#e8e8e8" stroke-width="1"/>`);
            parts.push(`<text x="${pl - 3}" y="${(+yp + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#bbb">${y}</text>`);
        }

        // Y axis label
        const yLabel = type === 'rssi' ? 'dBm' : 'dB';
        const yLabelCy = (pt + ch / 2).toFixed(1);
        parts.push(`<text x="10" y="${yLabelCy}" text-anchor="middle" font-size="9" fill="#aaa" transform="rotate(-90,10,${yLabelCy})">${yLabel}</text>`);

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
            parts.push(`<line x1="${xp}" y1="${pt}" x2="${xp}" y2="${pt + ch}" stroke="#f5f5f5" stroke-width="1"/>`);
        }
        for (let t = Math.ceil(tMin / labelStep) * labelStep; t <= now; t += labelStep) {
            const xp = xOf(t);
            parts.push(`<line x1="${xp}" y1="${pt}" x2="${xp}" y2="${pt + ch}" stroke="#e8e8e8" stroke-width="1"/>`);
            const lbl = new Date(t).toLocaleString('en-GB', fmtOpts).replace(',', '');
            parts.push(`<text x="${xp}" y="${pt + ch + 14}" text-anchor="middle" font-size="9" fill="#bbb">${lbl}</text>`);
        }

        // Axes
        parts.push(`<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ch}" stroke="#ddd" stroke-width="1"/>`);
        parts.push(`<line x1="${pl}" y1="${pt + ch}" x2="${pl + cw}" y2="${pt + ch}" stroke="#ddd" stroke-width="1"/>`);

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

        const selected = this._chartSelected;

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
            const color = this.getRepeaterColor(col);
            const isHighlighted = !selected || selected === col;
            const strokeW = (selected && selected === col) ? 2.5 : 1;
            const strokeOp = isHighlighted ? 0.55 : 0.12;
            const pointsStr = validPts.map(p => `${xOf(p.time)},${yOf(valOf(p))}`).join(' ');
            parts.push(`<polyline points="${pointsStr}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-opacity="${strokeOp}"/>`);
        }

        // Render dimmed circles first, then highlighted on top (SVG painter order)
        for (const [col, dPts] of decimGroups) {
            if (selected && selected === col) continue;
            for (const p of dPts) {
                if (valOf(p) == null) continue;
                parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(valOf(p))}" r="${this._dotSize}" fill="${this.getRepeaterColor(p.col)}" fill-opacity="${selected ? 0.07 : 0.85}"/>`);
            }
        }
        if (selected) {
            const selPts = decimGroups.get(selected);
            if (selPts) {
                for (const p of selPts) {
                    if (valOf(p) == null) continue;
                    parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(valOf(p))}" r="${this._dotSize * 1.43}" fill="${this.getRepeaterColor(p.col)}" fill-opacity="0.92"/>`);
                }
            }
        }

        if (!hasData) {
            parts.push(`<text x="${(pl + cw / 2).toFixed(1)}" y="${(pt + ch / 2).toFixed(1)}" text-anchor="middle" font-size="11" fill="#bbb">Waiting for data…</text>`);
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

        if (legend) {
            const entries = visible.map(col => {
                const c = this.getRepeaterColor(col);
                const last = lastByCol.get(col);
                const val = type === 'rssi' ? last.rssi : last.snr;
                const valStr = val == null ? '—'
                    : type === 'rssi'
                        ? `${val} dBm`
                        : `${val >= 0 ? '+' : ''}${val.toFixed(1)} dB`;
                const selClass   = !selected ? '' : (selected === col ? ' legend-item-selected' : ' legend-item-dimmed');
                return {
                    val: val ?? -Infinity,
                    html: `<span class="legend-item${selClass}" data-col="${this.escHtml(col)}"><span class="legend-dot" style="background:${c}"></span>${this.escHtml(this.displayId(col))} <span class="legend-val">(${valStr})</span></span>`,
                };
            });
            if (type === 'rssi' && hasData) {
                const nfPts = [...lastByCol.values()].filter(p => p.rssi != null && p.snr != null);
                if (nfPts.length > 0) {
                    const lastPt = nfPts.reduce((a, b) => a.time > b.time ? a : b);
                    const nf = lastPt.rssi - lastPt.snr;
                    entries.push({
                        val: nf,
                        html: `<span class="legend-item"><span class="legend-nf"></span>Noise floor <span class="legend-val">(${nf} dBm)</span></span>`,
                    });
                }
                entries.sort((a, b) => b.val - a.val);
            }
            legend.innerHTML = entries.map(e => e.html).join('');
        }
    }

    renderSentSnrChart() {
        const svg = this.sentSnrChartSvg;
        const legend = this.sentSnrChartLegend;
        if (!svg) return;
        this.sentSnrChartWrap?.classList.remove('hidden');

        const pts = this._sentSnrHistory;
        const hasData = pts.length > 0;

        const W = svg.clientWidth || 600;
        const H = svg.clientHeight || 180;
        const pl = 36, pr = 8, pt = 6, pb = 24;
        const cw = W - pl - pr;
        const ch = H - pt - pb;

        const now = this._chartFrozenAt ?? Date.now();
        const defaultWindow = 5 * 60000;
        const tMin = hasData
            ? (isFinite(this.HASH_LIFETIME) ? now - this.HASH_LIFETIME : pts.reduce((m, p) => Math.min(m, p.time), Infinity))
            : now - defaultWindow;
        const tRange = Math.max(1, now - tMin);

        let vMin = Infinity, vMax = -Infinity;
        if (hasData) {
            for (const p of pts) { if (p.snr < vMin) vMin = p.snr; if (p.snr > vMax) vMax = p.snr; }
        } else { vMin = -20; vMax = 15; }
        const rawRange = vMax - vMin || 1;
        const pad = rawRange * 0.15;
        vMin = Math.floor((vMin - pad) / 5) * 5;
        vMax = Math.ceil((vMax + pad) / 5) * 5;
        const yStep = Math.ceil((vMax - vMin) / 6 / 5) * 5 || 5;
        const yRange = Math.max(1e-9, vMax - vMin);

        const xOf = t => (pl + (t - tMin) / tRange * cw).toFixed(1);
        const yOf = v => (pt + (1 - (v - vMin) / yRange) * ch).toFixed(1);

        const parts = [];

        for (let y = vMin + yStep / 2; y < vMax; y += yStep)
            parts.push(`<line x1="${pl}" y1="${yOf(y)}" x2="${pl + cw}" y2="${yOf(y)}" stroke="#f5f5f5" stroke-width="1"/>`);
        for (let y = vMin; y <= vMax; y += yStep) {
            const yp = yOf(y);
            parts.push(`<line x1="${pl}" y1="${yp}" x2="${pl + cw}" y2="${yp}" stroke="#e8e8e8" stroke-width="1"/>`);
            parts.push(`<text x="${pl - 3}" y="${(+yp + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#bbb">${y}</text>`);
        }
        const yLabelCy = (pt + ch / 2).toFixed(1);
        parts.push(`<text x="10" y="${yLabelCy}" text-anchor="middle" font-size="9" fill="#aaa" transform="rotate(-90,10,${yLabelCy})">dB</text>`);

        const labelStep = this._xLabelStepMs(tRange, cw);
        const minorStep = labelStep / 2;
        const useDate = tRange > 12 * 3600000;
        const fmtOpts = useDate
            ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
            : (labelStep < 60000 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
        for (let t = Math.ceil(tMin / minorStep) * minorStep; t <= now; t += minorStep) {
            if (t % labelStep === 0) continue;
            parts.push(`<line x1="${xOf(t)}" y1="${pt}" x2="${xOf(t)}" y2="${pt + ch}" stroke="#f5f5f5" stroke-width="1"/>`);
        }
        for (let t = Math.ceil(tMin / labelStep) * labelStep; t <= now; t += labelStep) {
            const xp = xOf(t);
            parts.push(`<line x1="${xp}" y1="${pt}" x2="${xp}" y2="${pt + ch}" stroke="#e8e8e8" stroke-width="1"/>`);
            const lbl = new Date(t).toLocaleString('en-GB', fmtOpts).replace(',', '');
            parts.push(`<text x="${xp}" y="${pt + ch + 14}" text-anchor="middle" font-size="9" fill="#bbb">${lbl}</text>`);
        }

        parts.push(`<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ch}" stroke="#ddd" stroke-width="1"/>`);
        parts.push(`<line x1="${pl}" y1="${pt + ch}" x2="${pl + cw}" y2="${pt + ch}" stroke="#ddd" stroke-width="1"/>`);

        if (hasData) {
            const groups = new Map();
            for (const p of pts) {
                if (!groups.has(p.col)) groups.set(p.col, []);
                groups.get(p.col).push(p);
            }
            for (const [col, colPts] of groups) {
                colPts.sort((a, b) => a.time - b.time);
                const color = this.getRepeaterColor(col);
                if (colPts.length >= 2) {
                    const pointsStr = colPts.map(p => `${xOf(p.time)},${yOf(p.snr)}`).join(' ');
                    parts.push(`<polyline points="${pointsStr}" fill="none" stroke="${color}" stroke-width="1" stroke-opacity="0.55"/>`);
                }
                for (const p of colPts)
                    parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(p.snr)}" r="${this._dotSize}" fill="${color}" fill-opacity="0.85"/>`);
            }

            if (legend) {
                const lastByCol = new Map();
                for (const p of pts)
                    if (!lastByCol.has(p.col) || p.time > lastByCol.get(p.col).time) lastByCol.set(p.col, p);
                const sorted = [...lastByCol.keys()].sort((a, b) => lastByCol.get(b).snr - lastByCol.get(a).snr);
                legend.innerHTML = sorted.map(col => {
                    const last = lastByCol.get(col);
                    const c = this.getRepeaterColor(col);
                    const valStr = `${last.snr >= 0 ? '+' : ''}${last.snr.toFixed(1)} dB`;
                    const displayName = last.label && last.label !== col ? this.escHtml(last.label) : this.escHtml(col);
                    return `<span class="legend-item"><span class="legend-dot" style="background:${c}"></span>${displayName} <span class="legend-val">(${valStr})</span></span>`;
                }).join('');
            }
        } else {
            parts.push(`<text x="${(pl + cw / 2).toFixed(1)}" y="${(pt + ch / 2).toFixed(1)}" text-anchor="middle" font-size="11" fill="#bbb">Waiting for data…</text>`);
            if (legend) legend.innerHTML = '';
        }

        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.innerHTML = parts.join('');
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
        const pts = this._visibleChartPoints();
        if (!pts.length) return;
        const svg = type === 'rssi' ? this.rssiChartSvg : this.snrChartSvg;
        if (!svg) return;

        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const W = rect.width || 600;
        const H = rect.height || 180;
        const pl = 36, pr = 8, pt = 6, pb = 24;
        const cw = W - pl - pr;
        const ch = H - pt - pb;

        const now = this._chartFrozenAt ?? Date.now();
        const tMin = isFinite(this.HASH_LIFETIME)
            ? now - this.HASH_LIFETIME
            : this._earliestTime(pts);

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

        const time = new Date(nearest.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const color = this.getRepeaterColor(nearest.col);
        const dot = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle;flex-shrink:0"></span>`;
        this.tooltip.innerHTML =
            `${dot}<b>${this.escHtml(this.displayId(nearest.col))}</b><br>` +
            `${time}<br>` +
            `RSSI ${nearest.rssi ?? '—'} &nbsp; SNR ${nearest.snr?.toFixed(1) ?? '—'}`;

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
            this.sortColumns();
            if (this.repeaterColumns.join('|') !== prev) this.renderMsgTable();
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
            this.sortColumns();
            this.renderMsgTable();
            this.updateRepeaterTable();
            this.updateStats();
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
        this._chartSelected = null;
        this.signalMap?.selectColumn(null);
        this.signalMap?.clearPoints?.();
        if (this.msgTableBody) this.msgTableBody.innerHTML = '';
        if (this.msgTableHead) this.msgTableHead.innerHTML = '';
        document.getElementById('msgFilterBar')?.classList.add('hidden');
        this.scheduleChartRender();
        this.updateRepeaterTable();
        this.updateStats();
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
        this.scheduleChartRender();
        this.updateRepeaterTable();
        this.renderMsgTable();
        this.updateStats();
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
            try { localStorage.setItem('hide', 'all'); } catch {}
            this._applyHideSelect();
        }
    }

    // --- Repeater log table ---

    updateRepeaterTable() {
        if (!this.repeaterLogBody) return;
        const key = this.repeaterSortKey;
        const dir = this.repeaterSortDir;
        const cutoff = this._displayCutoffNow();
        const entries = Array.from(this.allRepeaters.entries())
            .filter(([id, d]) => this._colMatchesRepFilter(id) && (!cutoff || d.lastSeen >= cutoff));
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
        const sel = this._chartSelected;
        this.repeaterLogBody.innerHTML = entries.map(([repeater, d]) => {
            const mrc = this.signalColor(d.maxRssi,  -70, -130);
            const lrc = this.signalColor(d.lastRssi, -70, -130);
            const msc = this.signalColor(d.maxSnr,   13, -10, 0);
            const lsc = this.signalColor(d.lastSnr,  13, -10, 0);
            const isSel = repeater === sel;
            const rowCls = sel ? (isSel ? 'rl-row-sel' : 'rl-row-dim') : '';
            return `<tr data-col="${this.escHtml(repeater)}"${rowCls ? ` class="${rowCls}"` : ''}>
                <td class="rl-id rl-id-clickable"><span class="rl-dot" style="background:${this.getRepeaterColor(repeater)}"></span>${this.displayId(repeater)}</td>
                <td class="rl-num">${d.count}</td>
                <td class="rl-num" style="color:${mrc}">${d.maxRssi ?? '—'}</td>
                <td class="rl-num" style="color:${lrc}">${d.lastRssi ?? '—'}</td>
                <td class="rl-num" style="color:${msc}">${d.maxSnr?.toFixed(1) ?? '—'}</td>
                <td class="rl-num" style="color:${lsc}">${d.lastSnr?.toFixed(1) ?? '—'}</td>
                <td class="rl-time">${this.formatTime(d.lastSeen)}</td>
            </tr>`;
        }).join('');
        // Scroll selected row into view within the table — without moving the page viewport
        if (sel) {
            const selRow = this.repeaterLogBody.querySelector('tr.rl-row-sel');
            const scroll = this.repeaterLogBody.closest('.repeater-log-scroll');
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
        this._chartSelected = col ?? null;
        this.signalMap?.selectColumn(this._chartSelected);
        this.scheduleChartRender();
        this.updateRepeaterTable();
        this._applyMsgTableSelection();
        this._updateCornerNotices();
    }

    _updateCornerNotices() {
        const hasFilter = this._repFilterTerms.length > 0;
        const hasSel    = !!this._chartSelected;

        // --- Filter notice ---
        const filterNotice = document.getElementById('filterNotice');
        if (filterNotice) {
            filterNotice.classList.toggle('hidden', !hasFilter);
            if (hasFilter) {
                const term = this._repFilterTerms.join(', ');
                document.getElementById('filterNoticeRep').textContent = term;
                // Try to find a matching column for the dot color
                const matchCol = this.repeaterColumns.find(c => this._colMatchesRepFilter(c));
                const dot = document.getElementById('filterNoticeDot');
                if (dot) {
                    dot.style.background = matchCol ? this.getRepeaterColor(matchCol) : 'transparent';
                    dot.style.display    = matchCol ? '' : 'none';
                }
            }
        }

        // --- Selection notice (hidden when filter is also active) ---
        const selNotice = document.getElementById('selNotice');
        if (selNotice) {
            selNotice.classList.toggle('hidden', !hasSel || hasFilter);
            if (hasSel && !hasFilter) {
                document.getElementById('selNoticeRep').textContent = this.displayId(this._chartSelected);
                const dot = document.getElementById('selNoticeDot');
                if (dot) dot.style.background = this.getRepeaterColor(this._chartSelected);
            }
        }
    }

    _applyMsgTableSelection() {
        const sel = this._chartSelected;

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

    signalColor(value, greenVal, redVal, yellowVal) {
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

    playRxSound(rssi) {
        const mode = this.soundSelect?.value ?? 'off';
        if (mode === 'off') return;
        if (!this.audioCtx) this.audioCtx = new AudioContext();
        const ctx = this.audioCtx;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const baseFreq = 880;
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
        beep(baseFreq, 0, dur);
        beep(baseFreq * Math.pow(2, (rssi + 100) / 30), gap, dur);
    }

    // --- BLE Device Battery ---

    _updateBleBattery(pct) {
        if (!this.batteryEl || !this.device) return;
        this.batteryEl.innerHTML = `<span class="hstat-label">Device </span>🔋${pct}%`;
        this.batteryEl.classList.remove('hidden', 'battery-low');
        if (pct <= 20) this.batteryEl.classList.add('battery-low');
    }

    _updateBleBatteryVoltage(milliVolts) {
        if (!this.batteryEl || !this.device) return;
        // LiPo: 3000 mV = 0%, 4200 mV = 100%
        const pct = Math.round(Math.min(100, Math.max(0, (milliVolts - 3000) / 1200 * 100)));
        this.batteryEl.innerHTML = `<span class="hstat-label">Bat </span>🔋${pct}%`;
        this.batteryEl.classList.remove('hidden', 'battery-low');
        if (pct <= 20) this.batteryEl.classList.add('battery-low');
    }

    // --- Wake Lock ---

    async acquireWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
            this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
        } catch (e) { /* denied — battery saver etc. */ }
    }

    releaseWakeLock() {
        if (this.wakeLock) { this.wakeLock.release(); this.wakeLock = null; }
    }

    // --- Stats & status ---

    updateStats() {
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
        if (this.abbreviateType(data.type).toLowerCase().includes(filter)) return true;
        for (const col of data.repeaters.keys()) {
            if (this.displayId(col).toLowerCase().includes(filter)) return true;
        }
        const m = data.meta;
        if (m?.text?.toLowerCase().includes(filter)) return true;
        if (m?.sender?.toLowerCase().includes(filter)) return true;
        if (m?.name?.toLowerCase().includes(filter)) return true;
        return false;
    }

    _formatPath(packet) {
        if (!packet?.path?.length) return '';
        return packet.path.map(id =>
            typeof id === 'number'
                ? '!' + id.toString(16).padStart(8, '0')
                : String(id ?? 'unknown')
        ).join(' > ');
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

    _applyRepFilter() {
        this.updateRepeaterTable();
        this.renderMsgTable();
        this.scheduleChartRender();
        this.updateStats();
        this.signalMap?.setFilterFn(
            this._repFilterTerms.length ? col => this._colMatchesRepFilter(col) : null
        );
        this._updateCornerNotices();
    }

    _exportCsv() {
        if (this.hashData.size === 0) return;
        this._unsavedRxCount = 0;

        const msgFilter = this._msgFilter.toLowerCase().trim();

        const esc = v => {
            if (v == null || v === '') return '';
            const s = String(v);
            return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
                ? '"' + s.replace(/"/g, '""') + '"' : s;
        };

        const header = ['time', 'type', 'hash', 'repeater', 'rssi', 'snr', 'raw_hex', 'lat', 'lon', 'text', 'sender'];
        const lines = [header.join(',')];

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

        for (const { hash, data, rep } of allRows) {
            lines.push([
                new Date(rep.time ?? data.firstSeen).toISOString(),
                data.type  || '',
                hash,
                rep.rawId  || '',
                rep.rssi,
                rep.snr.toFixed(2),
                rep.rawHex || data.rawHex || '',
                rep.lat    ?? '',
                rep.lon    ?? '',
                data.meta?.text   || '',
                data.meta?.sender || '',
            ].map(esc).join(','));
        }

        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `meshcore-rx-${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.csv`;
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

        const header = this._parseCsvLine(lines[0]);
        const idx = name => header.indexOf(name);
        const iTime = idx('time'), iType = idx('type'), iHash = idx('hash');
        const iRep  = idx('repeater'), iRssi = idx('rssi'), iSnr = idx('snr');
        const iHex  = idx('raw_hex'), iLat = idx('lat'), iLon = idx('lon');
        const iTxt  = idx('text'), iSnd = idx('sender');

        if (iTime < 0 || iHash < 0 || iRep < 0) {
            alert('Unrecognised CSV format — expected columns: time, hash, repeater.');
            return;
        }

        const rows = [];
        for (let i = 1; i < lines.length; i++) {
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
                csvText:   iTxt >= 0 ? c[iTxt]  : '',
                csvSender: iSnd >= 0 ? c[iSnd]  : '',
            });
        }
        if (rows.length === 0) return;

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
            try { localStorage.setItem('ttl', 'Infinity'); } catch {}
            this._updateHideSelectOptions();
        }
        // Show all imported data regardless of previous display window setting
        const hideSelect = document.getElementById('hideSelect');
        if (hideSelect && hideSelect.value !== 'all') {
            hideSelect.value = 'all';
            try { localStorage.setItem('hide', 'all'); } catch {}
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
                        meta.pathItemBytes = decoded.pathHashSize ?? (typeof fi === 'string' ? fi.length / 2 : typeof fi === 'number' ? 4 : 0);
                        meta.totalBytes    = decoded.totalBytes;
                    }
                } catch { /* ignore */ }
            }
            if (!meta.text   && row.csvText)   meta.text   = row.csvText;
            if (!meta.sender && row.csvSender)  meta.sender = row.csvSender;

            const type = packet
                ? ([Utils.getRouteTypeName(packet.routeType), Utils.getPayloadTypeName(packet.payloadType)].filter(Boolean).join(' ') || row.type)
                : row.type;

            this.addRxEntry(row.hash, row.repeater, type, row.rawHex, row.snr, row.rssi, meta, packet, {
                importing: true,
                timestamp: row.time,
                lat:       row.lat,
                lon:       row.lon,
            });
        }

        this.sortColumns();
        // Freeze chart at last packet time + 1 min so all imported data is in view
        if (!this._collecting) this._chartFrozenAt = rows[rows.length - 1].time + 1_000;
        this.renderMsgTable();
        this.updateRepeaterTable();
        this.scheduleChartRender();
        this.updateStats();
        this.emptyState?.classList.add('hidden');

        if (importBtn) { importBtn.textContent = prevBtnText; importBtn.disabled = false; }
        if (this.statusEl && prevStatus != null) { this.statusEl.textContent = prevStatus; this.statusEl.className = prevClass; }
    }

    updateStatus(text, className) {
        this.statusEl.textContent = text;
        this.statusEl.className = `status ${className}`;
    }

    // --- Utilities ---

    formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString('en-GB');
    }

    formatTimeMs(timestamp) {
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
                } catch (e) { console.warn('gatt.disconnect:', e); clearTimeout(t); resolve(); }
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
function init() { monitor = new MeshCoreMonitor(); }

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && monitor?.device?.gatt?.connected) {
        monitor.acquireWakeLock();
    }
});
