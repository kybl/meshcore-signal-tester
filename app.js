// MeshCore RX Monitor Application
import { MeshCoreDecoder, Utils } from 'https://esm.sh/@michaelhart/meshcore-decoder';
import { Signal3DMap } from './signal3d.js?v=5';

class MeshCoreMonitor {
    constructor() {
        this.device = null;
        this.bleRxCharacteristic = null;
        this.hashData = new Map();
        this.allRepeaters = new Map();
        this.repeaterColumns = []; // sorted by max RSSI descending (strongest first)
        this.totalRxCount = 0;
        this.HASH_LIFETIME = Infinity;
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
        this.chartColorIdx = 0;
        this.chartColorPalette = [
            '#667eea','#e74c3c','#2ecc71','#f39c12',
            '#9b59b6','#1abc9c','#e67e22','#3498db',
            '#e91e63','#00bcd4',
        ];
        this._batteryCharacteristic = null;
        this._onBatteryChanged = null;
        this._useAbbreviatedTypes = false;
        this._chartSelected = null;
        this._rxTimestamps = [];
        this._msgFilter = '';
        this._repFilterTerms = [];

        this.initUI();
        this.startCleanupTimer();
        this.renderSavedDevices();
        // Render empty chart axes immediately so the section is visible from page load
        requestAnimationFrame(() => this.scheduleChartRender());
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
        setInterval(() => this.scheduleChartRender(), 2000);

        // Collapsible sections — clicking anywhere in the header row toggles
        document.querySelectorAll('.section-header').forEach(header => {
            const btn = header.querySelector('.collapse-btn');
            if (!btn) return;
            header.addEventListener('click', () => {
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
        this.soundCheckbox = document.getElementById('soundEnabled');
        this.tooltip = document.getElementById('chartTooltip');

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
                this._chartSelected = this._chartSelected === col ? null : col;
                this.scheduleChartRender();
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

        document.getElementById('savedDevices')?.addEventListener('click', e => {
            const quickBtn = e.target.closest('.saved-btn');
            const forgetBtn = e.target.closest('.forget-btn');
            if (quickBtn) this.quickConnect(quickBtn.dataset.id);
            if (forgetBtn) this.forgetDevice(forgetBtn.dataset.id);
        });

        const ttlSelect = document.getElementById('ttlSelect');
        if (ttlSelect) {
            ttlSelect.addEventListener('change', () => {
                const v = ttlSelect.value;
                this.HASH_LIFETIME = v === 'Infinity' ? Infinity : +v * 1000;
            });
        }

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
        document.getElementById('exportCsvBtn')?.addEventListener('click', () => this._exportCsv());

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

        window.addEventListener('beforeunload', e => {
            if (this.device) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        this._initHelpSystem();
        this._initSignalMap();
    }

    _initSignalMap() {
        const canvas = document.getElementById('signalMapCanvas');
        if (!canvas) return;

        const sourceSel = document.getElementById('mapSourceSelect');
        const savedSource = (() => {
            try { return localStorage.getItem('mapSource') || ''; } catch { return ''; }
        })();
        if (sourceSel && savedSource) sourceSel.value = savedSource;

        this.signalMap = new Signal3DMap({
            canvas,
            statusEl:      document.getElementById('locationStatus'),
            btnEl:         document.getElementById('enableLocationBtn'),
            emptyEl:       document.getElementById('signalMapEmpty'),
            colorFor:      col => this.getRepeaterColor(col),
            displayId:     col => this.displayId(col),
            initialSource: sourceSel?.value,
        });

        sourceSel?.addEventListener('change', () => {
            this.signalMap.setMapSource(sourceSel.value);
            try { localStorage.setItem('mapSource', sourceSel.value); } catch {}
        });
    }

    _initHelpSystem() {
        const HELP = {
            'active':
                'Unique packets currently shown — within the auto-remove time window. Older packets are removed automatically.',
            'totalrx':
                'All packet arrivals this session. The same packet heard via two different repeaters counts as two.',
            'repeaters-count':
                'Number of distinct mesh nodes that have forwarded at least one packet to your device this session.',
            'sound':
                'Plays a short beep on each new incoming packet. Pitch varies with RSSI — stronger signal → higher pitch.',
            'ttl':
                'Packets not heard within this window are removed from the table and charts. "Never" keeps all data for the whole session.',
            'repeater':
                '"direct" = packet arrived with no intermediate node. Otherwise shows the ID of the last repeater that forwarded the packet.',
            'rssi':
                'Received Signal Strength in dBm. Less negative = stronger. −70 dBm: excellent · −120 dBm: very weak.',
            'snr':
                'Signal-to-Noise Ratio in dB. Positive = signal is above the noise. LoRa can decode even at negative SNR (down to ~−20 dB).',
            'rate':
                'Packets received in the last 60 seconds (rolling). Resets to 0 when the network goes quiet.',
        };

        const tipEl = document.getElementById('helpTip');
        let _tipTarget = null;

        const showTip = (icon) => {
            const text = HELP[icon.dataset.help];
            if (!text || !tipEl) return;
            tipEl.textContent = text;
            tipEl.style.display = 'block';
            const r = icon.getBoundingClientRect();
            const tipW = Math.min(260, window.innerWidth - 16);
            let left = r.left + r.width / 2 - tipW / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
            tipEl.style.left = `${left}px`;
            tipEl.style.top = `${r.top - 8}px`;
            tipEl.style.transform = 'translateY(-100%)';
            tipEl.style.maxWidth = `${tipW}px`;
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

        this.acquireWakeLock();
        this.saveDevice(device);

        this.updateStatus('Connected', 'connected');
        this.connectBtn.textContent = 'Disconnect';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.disconnect();
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
        // Debug: full BLE notification hex with push code + length (drop after diagnosis)
        const dbgHex = this.bufferToHex(payload.buffer);
        console.log(`[BLE-RX] push=0x${pushCode.toString(16).padStart(2, '0').toUpperCase()} len=${payload.length} ${dbgHex}`);
        // PACKET_BATTERY (0x0C): bytes [1-2] = uint16 LE voltage in mV
        if (pushCode === 0x0c) {
            if (payload.length >= 3) {
                const milliVolts = payload[1] | (payload[2] << 8);
                this._updateBleBatteryVoltage(milliVolts);
            }
            return;
        }
        // Known non-LoRa push codes — silently ignore
        if (pushCode === 0x05 || pushCode === 0x80 || pushCode === 0x82 || pushCode === 0x83) return;

        let loraPacket;
        let knownFormat = true;
        if (pushCode === 0x88) {
            loraPacket = payload.slice(3);
        } else if (pushCode === 0x84 || pushCode === 0x8e) {
            loraPacket = payload.slice(4);
        } else {
            // Unknown code — try 3-byte header (same as 0x88); fall back to raw row if decode fails
            loraPacket = payload.slice(3);
            knownFormat = false;
        }
        if (loraPacket.length === 0) return;

        const snr  = (payload[1] > 127 ? payload[1] - 256 : payload[1]) / 4;
        const rssi = payload[2] > 127 ? payload[2] - 256 : payload[2];

        try {
            const rawHex = this.bufferToHex(loraPacket.buffer);
            const packet = MeshCoreDecoder.decode(rawHex);
            if (packet.isValid) {
                // For unknown push codes we don't know the byte layout — bytes 1-2 may
                // not be SNR/RSSI at all, so pass null to avoid bogus values in the UI.
                this.processPacket(packet, rawHex, knownFormat ? snr : null, knownFormat ? rssi : null);
            } else if (!knownFormat) {
                this._addRawEntry(payload, pushCode);
            }
        } catch (e) {
            if (!knownFormat) {
                this._addRawEntry(payload, pushCode);
            } else {
                console.error('Decode error:', e);
            }
        }
    }

    _addRawEntry(payload, pushCode) {
        const fullHex = this.bufferToHex(payload.buffer);
        const hash = this.hashPayload(fullHex);
        const label = '0x' + pushCode.toString(16).toUpperCase().padStart(2, '0');
        this.addRxEntry(hash, 'direct', label, fullHex, null, null, {}, null);
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
        return 'direct';
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
    // We always use the longest (most precise) known version as the column key.

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

        const matches = this.repeaterColumns.filter(col =>
            col !== 'direct' && this.idsCompatible(rawId, col)
        );

        if (matches.length === 0) {
            this.repeaterColumns.push(rawId);
            return rawId;
        }

        if (matches.length === 1) {
            const existing = matches[0];
            if (this.idPrecision(rawId) > this.idPrecision(existing)) {
                this.renameColumnKey(existing, rawId);
                return rawId;
            }
            return existing;
        }

        // Multiple compatible columns → ambiguous short ID
        const collisionKey = matches.sort().join('/');
        if (!this.repeaterColumns.includes(collisionKey)) {
            this.repeaterColumns.push(collisionKey);
        }
        return collisionKey;
    }

    renameColumnKey(oldKey, newKey) {
        const idx = this.repeaterColumns.indexOf(oldKey);
        if (idx >= 0) this.repeaterColumns[idx] = newKey;

        const oldData = this.allRepeaters.get(oldKey);
        if (oldData) {
            const newData = this.allRepeaters.get(newKey);
            if (newData) {
                const newer = oldData.lastSeen >= newData.lastSeen ? oldData : newData;
                this.allRepeaters.set(newKey, {
                    lastSeen: Math.max(oldData.lastSeen, newData.lastSeen),
                    count:    oldData.count + newData.count,
                    maxSnr:   Math.max(oldData.maxSnr  ?? -999, newData.maxSnr  ?? -999),
                    maxRssi:  Math.max(oldData.maxRssi ?? -999, newData.maxRssi ?? -999),
                    lastSnr:  newer.lastSnr,
                    lastRssi: newer.lastRssi,
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

        // Keep chart color and history consistent after rename
        if (this.chartColors.has(oldKey) && !this.chartColors.has(newKey)) {
            this.chartColors.set(newKey, this.chartColors.get(oldKey));
        }
        this.chartColors.delete(oldKey);
        for (const p of this.chartPoints) {
            if (p.col === oldKey) p.col = newKey;
        }
        if (this._chartSelected === oldKey) this._chartSelected = newKey;

        // Update any open detail rows whose col attribute still references the old key,
        // so that renderMsgTable's sig-active restoration uses the correct (new) col.
        this.msgTableBody?.querySelectorAll('tr.detail-row').forEach(tr => {
            if (tr.dataset.col === oldKey) tr.dataset.col = newKey;
        });
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

    addRxEntry(hash, repeater, type, rawHex, snr, rssi, meta = {}, packet = null) {
        const wasAtBottom = this._isAtPageBottom();
        this.totalRxCount++;
        const now = Date.now();
        this._rxTimestamps.push(now);
        const isNewHash = !this.hashData.has(hash);
        const prevColCount = this.repeaterColumns.length;
        const canonicalKey = this.findOrCreateColumn(repeater);

        if (isNewHash) {
            this.hashData.set(hash, {
                repeaters: new Map([[canonicalKey, { snr, rssi, packet, rawHex }]]),
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
            data.lastSeen = now;
            data.repeaters.set(canonicalKey, { snr, rssi, packet, rawHex });
        }

        const hasSignal = snr !== null && rssi !== null;
        const existing = this.allRepeaters.get(canonicalKey);
        this.allRepeaters.set(canonicalKey, {
            lastSeen: now,
            count:    (existing?.count ?? 0) + 1,
            maxSnr:   hasSignal ? Math.max(existing?.maxSnr  ?? -999, snr)  : (existing?.maxSnr  ?? null),
            maxRssi:  hasSignal ? Math.max(existing?.maxRssi ?? -999, rssi) : (existing?.maxRssi ?? null),
            lastSnr:  hasSignal ? snr  : (existing?.lastSnr  ?? null),
            lastRssi: hasSignal ? rssi : (existing?.lastRssi ?? null),
        });
        if (hasSignal) {
            this.chartPoints.push({ time: now, rssi, snr, col: canonicalKey });
            const loc = this.signalMap?.currentLocation();
            if (loc) this.signalMap.addPacket({ lat: loc.lat, lon: loc.lon, rssi, snr, col: canonicalKey, time: now });
        }
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
        if (hasSignal && matchesMsgFilter && matchesRepFilter) this.playRxSound(rssi);
        this.updateStats();
        this.emptyState?.classList.add('hidden');
    }

    // --- Column management ---

    sortColumns() {
        this.repeaterColumns.sort((a, b) =>
            (this.allRepeaters.get(b)?.maxRssi ?? -200) - (this.allRepeaters.get(a)?.maxRssi ?? -200)
        );
    }

    abbreviateType(type) {
        if (!type) return '?';
        // Hex push codes like "0x8F" → show just the hex digits "8F"
        if (/^0x[0-9A-Fa-f]+$/i.test(type)) return type.slice(2).toUpperCase();
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

        const visibleCols = this.repeaterColumns.filter(c => this._colMatchesRepFilter(c));
        const colKey = visibleCols.join(',');
        if (colKey !== this._lastColKey) {
            this._lastColKey = colKey;
            const repHeaders = visibleCols.map(r =>
                `<th colspan="2" class="msg-col-rep">${this.displayId(r)}</th>`
            ).join('');
            const subHeaders = visibleCols.map(() =>
                `<th class="msg-sub-rssi">RSSI</th><th class="msg-sub-snr">SNR</th>`
            ).join('');
            this.msgTableHead.innerHTML = `
                <tr>
                    <th class="msg-col-rx-head" rowspan="2">RX log</th>
                    ${repHeaders}
                </tr>
                <tr>${subHeaders}</tr>
            `;
        }

        // Show filter bar whenever there is data
        document.getElementById('msgFilterBar')?.classList.toggle('hidden', this.hashData.size === 0);

        const filter = this._msgFilter.toLowerCase().trim();
        const allRows = Array.from(this.hashData.entries())
            .sort(([, a], [, b]) => b.insertOrder - a.insertOrder);
        let rows = filter
            ? allRows.filter(([, data]) => this._rowMatchesFilter(data, filter))
            : allRows;
        // When repeater filter is active, hide rows that have no data from visible columns
        if (this._repFilterTerms.length) {
            rows = rows.filter(([, data]) => visibleCols.some(c => data.repeaters.has(c)));
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
            row.after(detail);
            if (col) {
                this.msgTableBody.querySelectorAll(`[data-hash="${hash}"][data-col="${col}"]`)
                    .forEach(el => el.classList.add('sig-active'));
            }
        }

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
        const isRawType = /^0x[0-9A-Fa-f]+$/i.test(data.type);
        const typeDisplay = this._useAbbreviatedTypes
            ? this.escHtml(this.abbreviateType(data.type))
            : this.escHtml(data.type || '?');
        const typeClass = isRawType ? 'rx-type rx-type-raw' : 'rx-type';
        return `<tr id="row-${hash}">
            <td class="msg-col-rx">
                <span class="rx-time">${this.formatTime(data.firstSeen)}</span><span class="${typeClass}" title="${this.escHtml(data.type || '?')}">${typeDisplay}</span>
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
        if (col) {
            const sig = repEntry;
            if (sig) {
                const hasSignal = sig.rssi !== null && sig.snr !== null;
                let sigLine = '';
                if (hasSignal) {
                    const rc = this.signalColor(sig.rssi, -70, -130);
                    const sc = this.signalColor(sig.snr, 13, -10, 0);
                    sigLine = ` &nbsp; RSSI <span style="color:${rc};font-weight:700">${sig.rssi}</span>` +
                        ` &nbsp; SNR <span style="color:${sc};font-weight:700">${sig.snr.toFixed(1)}</span>`;
                }
                const hexShort = hex.slice(0, 12);
                header = `<div class="detail-sig">` +
                    `<b>${this.escHtml(this.displayId(col))}</b>` +
                    sigLine +
                    ` &nbsp; <code class="raw-hex" data-hex="${hex}" title="Click to copy raw hex">${this.escHtml(hexShort)}…</code>` +
                    `</div>`;
            }
        }

        const isRawCode = /^0x[0-9A-Fa-f]+$/i.test(data.type);
        const typeHtml = data.type
            ? `<div class="detail-type">${this.escHtml(data.type)}</div>`
            : '';
        const unknownNote = isRawCode
            ? `<div class="detail-raw" style="color:#c33;margin-bottom:6px">Unknown packet type — raw data</div>`
            : '';

        let jsonHtml = '';
        if (pkt) {
            jsonHtml = `<pre class="detail-json">${this.syntaxHighlightJson(this.formatPacketDetail(pkt))}</pre>`;
        } else if (isRawCode) {
            jsonHtml = `<code class="raw-hex" data-hex="${hex}" title="Click to copy raw hex" style="display:block;margin-top:2px">${this.escHtml(hex)}</code>`;
        }

        return `<td colspan="${colspan}" class="detail-cell"><div class="detail-content">${typeHtml}${unknownNote}${header}${jsonHtml}</div></td>`;
    }

    buildSigCellsHtml(rssi, snr, hash, col) {
        if (rssi === null || snr === null) {
            return `<td class="sig-rssi" data-hash="${hash}" data-col="${col}" style="color:#bbb;text-align:right">—</td>` +
                   `<td class="sig-snr"  data-hash="${hash}" data-col="${col}" style="color:#bbb;text-align:right">—</td>`;
        }
        const rc = this.signalColor(rssi, -70, -130);
        const sc = this.signalColor(snr,  13, -10, 0);
        return `<td class="sig-rssi" data-hash="${hash}" data-col="${col}" style="color:${rc}">${rssi}</td>` +
               `<td class="sig-snr"  data-hash="${hash}" data-col="${col}" style="color:${sc}">${snr.toFixed(1)}</td>`;
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
            this.chartColors.set(col, this.chartColorPalette[this.chartColorIdx++ % this.chartColorPalette.length]);
        }
        return this.chartColors.get(col);
    }

    renderCharts() {
        if (isFinite(this.HASH_LIFETIME)) {
            const cutoff = Date.now() - this.HASH_LIFETIME;
            this.chartPoints = this.chartPoints.filter(p => p.time >= cutoff);
        }
        if (this._chartSelected && !this._visibleChartPoints().some(p => p.col === this._chartSelected)) {
            this._chartSelected = null;
        }
        this.renderChart('rssi');
        this.renderChart('snr');
    }

    _chartYBounds(type) {
        const pts = this._visibleChartPoints();
        // Avoid spread on potentially large arrays (Math.min(...arr) has an arg-count limit)
        let vMin = Infinity, vMax = -Infinity;
        for (const p of pts) {
            const v = type === 'rssi' ? p.rssi : p.snr;
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
            if (type === 'rssi') {
                const nf = p.rssi - p.snr;
                if (nf < vMin) vMin = nf;
                if (nf > vMax) vMax = nf;
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
        const now = Date.now();
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
            const dx = xOf(p.time) - mx;
            const dy = yOf(type === 'rssi' ? p.rssi : p.snr) - my;
            const d = dx * dx + dy * dy;
            if (d < minDist) { minDist = d; nearest = p; }
        }
        if (!nearest || minDist > 2500) {
            if (this._chartSelected) { this._chartSelected = null; this.scheduleChartRender(); }
            return;
        }
        this._chartSelected = this._chartSelected === nearest.col ? null : nearest.col;
        this.scheduleChartRender();
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

        const now = Date.now();
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
            const sorted = [...pts].sort((a, b) => a.time - b.time);
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

        const selected = this._chartSelected;

        const groups = new Map();
        for (const p of pts) {
            if (!groups.has(p.col)) groups.set(p.col, []);
            groups.get(p.col).push(p);
        }
        for (const [col, colPts] of groups) {
            if (colPts.length < 2) continue;
            colPts.sort((a, b) => a.time - b.time);
            const color = this.getRepeaterColor(col);
            const isHighlighted = !selected || selected === col;
            const strokeW = (selected && selected === col) ? 2.5 : 1;
            const strokeOp = isHighlighted ? 0.55 : 0.12;
            const pointsStr = colPts.map(p => `${xOf(p.time)},${yOf(valOf(p))}`).join(' ');
            parts.push(`<polyline points="${pointsStr}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-opacity="${strokeOp}"/>`);
        }

        for (const p of pts) {
            const isHighlighted = !selected || selected === p.col;
            const r = (selected && selected === p.col) ? 5 : 3.5;
            const fillOp = isHighlighted ? 0.85 : 0.18;
            parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(valOf(p))}" r="${r}" fill="${this.getRepeaterColor(p.col)}" fill-opacity="${fillOp}"/>`);
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
            return type === 'rssi' ? pb.rssi - pa.rssi : pb.snr - pa.snr;
        });

        if (legend) {
            const entries = visible.map(col => {
                const c = this.getRepeaterColor(col);
                const last = lastByCol.get(col);
                const val = type === 'rssi' ? last.rssi : last.snr;
                const valStr = type === 'rssi'
                    ? `${val} dBm`
                    : `${val >= 0 ? '+' : ''}${val.toFixed(1)} dB`;
                const isSelected = selected === col;
                const selClass = isSelected ? ' legend-item-selected' : '';
                return {
                    val,
                    html: `<span class="legend-item${selClass}" data-col="${this.escHtml(col)}"><span class="legend-dot" style="background:${c}"></span>${this.escHtml(this.displayId(col))} <span class="legend-val">(${valStr})</span></span>`,
                };
            });
            if (type === 'rssi' && hasData) {
                const lastPt = [...lastByCol.values()].reduce((a, b) => a.time > b.time ? a : b);
                const nf = lastPt.rssi - lastPt.snr;
                entries.push({
                    val: nf,
                    html: `<span class="legend-item"><span class="legend-nf"></span>Noise floor <span class="legend-val">(${nf} dBm)</span></span>`,
                });
                entries.sort((a, b) => b.val - a.val);
            }
            legend.innerHTML = entries.map(e => e.html).join('');
        }
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

        const now = Date.now();
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
            const dx = xOf(p.time) - mx;
            const dy = yOf(type === 'rssi' ? p.rssi : p.snr) - my;
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
            `RSSI ${nearest.rssi} &nbsp; SNR ${nearest.snr.toFixed(1)}`;

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
        if (!toRemove.length) return;

        for (const hash of toRemove) {
            document.getElementById(`row-${hash}`)?.classList.add('row-removing');
            document.getElementById(`detail-${hash}`)?.remove();
        }

        setTimeout(() => {
            const cutoff = Date.now() - this.HASH_LIFETIME;
            for (const hash of toRemove) {
                const data = this.hashData.get(hash);
                // Re-check TTL: a fresh packet may have arrived during the animation delay
                if (data && data.lastSeen <= cutoff) this.hashData.delete(hash);
            }
            this.repeaterColumns = this.repeaterColumns.filter(r =>
                Array.from(this.hashData.values()).some(d => d.repeaters.has(r))
            );
            for (const key of this.allRepeaters.keys()) {
                if (!this.repeaterColumns.includes(key)) this.allRepeaters.delete(key);
            }
            this.sortColumns();
            this.renderMsgTable();
            this.updateStats();
            if (this.hashData.size === 0 && this.emptyState) this.emptyState.classList.remove('hidden');
        }, 400);
    }

    // --- Repeater log table ---

    updateRepeaterTable() {
        if (!this.repeaterLogBody) return;
        const key = this.repeaterSortKey;
        const dir = this.repeaterSortDir;
        const entries = Array.from(this.allRepeaters.entries())
            .filter(([id]) => this._colMatchesRepFilter(id));
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
        this.repeaterLogBody.innerHTML = entries.map(([repeater, d]) => {
            const mrc = d.maxRssi  !== null ? this.signalColor(d.maxRssi,  -70, -130) : '#bbb';
            const lrc = d.lastRssi !== null ? this.signalColor(d.lastRssi, -70, -130) : '#bbb';
            const msc = d.maxSnr   !== null ? this.signalColor(d.maxSnr,   13, -10, 0) : '#bbb';
            const lsc = d.lastSnr  !== null ? this.signalColor(d.lastSnr,  13, -10, 0) : '#bbb';
            return `<tr>
                <td class="rl-id">${this.displayId(repeater)}</td>
                <td class="rl-num">${d.count}</td>
                <td class="rl-num" style="color:${mrc}">${d.maxRssi  !== null ? d.maxRssi          : '—'}</td>
                <td class="rl-num" style="color:${lrc}">${d.lastRssi !== null ? d.lastRssi         : '—'}</td>
                <td class="rl-num" style="color:${msc}">${d.maxSnr   !== null ? d.maxSnr.toFixed(1)  : '—'}</td>
                <td class="rl-num" style="color:${lsc}">${d.lastSnr  !== null ? d.lastSnr.toFixed(1) : '—'}</td>
                <td class="rl-time">${this.formatTime(d.lastSeen)}</td>
            </tr>`;
        }).join('');
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
        if (!this.soundCheckbox?.checked) return;
        if (!this.audioCtx) this.audioCtx = new AudioContext();
        const ctx = this.audioCtx;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const baseFreq = 880;

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

        beep(baseFreq, 0, 0.05);
        beep(baseFreq * Math.pow(2, (rssi + 100) / 30), 0.08, 0.05);
    }

    // --- BLE Device Battery ---

    _updateBleBattery(pct) {
        if (!this.batteryEl) return;
        this.batteryEl.innerHTML = `<span class="hstat-label">Device </span>🔋${pct}%`;
        this.batteryEl.classList.remove('hidden', 'battery-low');
        if (pct <= 20) this.batteryEl.classList.add('battery-low');
    }

    _updateBleBatteryVoltage(milliVolts) {
        if (!this.batteryEl) return;
        const volts = (milliVolts / 1000).toFixed(2);
        this.batteryEl.innerHTML = `<span class="hstat-label">Bat </span>🔋${volts}V`;
        this.batteryEl.classList.remove('hidden', 'battery-low');
        if (milliVolts < 3300) this.batteryEl.classList.add('battery-low');
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
        this.activeHashesEl.textContent = this.hashData.size;
        this.totalRxEl.textContent = this.totalRxCount;
        this.totalRepeatersEl.textContent = this._repFilterTerms.length
            ? this.repeaterColumns.filter(c => this._colMatchesRepFilter(c)).length
            : this.repeaterColumns.length;
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
        return this._repFilterTerms.length
            ? this.chartPoints.filter(p => this._colMatchesRepFilter(p.col))
            : this.chartPoints;
    }

    _applyRepFilter() {
        this.updateRepeaterTable();
        this.renderMsgTable();
        this.scheduleChartRender();
        this.updateStats();
        this.signalMap?.setFilterFn(
            this._repFilterTerms.length ? col => this._colMatchesRepFilter(col) : null
        );
    }

    _exportCsv() {
        if (this.hashData.size === 0) return;

        const filter = this._msgFilter.toLowerCase().trim();
        const rows = Array.from(this.hashData.entries())
            .sort(([, a], [, b]) => a.insertOrder - b.insertOrder)
            .filter(([, data]) => !filter || this._rowMatchesFilter(data, filter));

        const cols = this.repeaterColumns;
        const header = [
            'time', 'type', 'path', 'hash',
            ...cols.flatMap(c => [`rssi_${this.displayId(c)}`, `snr_${this.displayId(c)}`]),
            'text', 'sender', 'raw_hex',
        ];

        const esc = v => {
            if (v == null || v === '') return '';
            const s = String(v);
            return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
                ? '"' + s.replace(/"/g, '""') + '"' : s;
        };

        const lines = [header.join(',')];
        for (const [hash, data] of rows) {
            // Pick the packet with the longest path for the path column
            let bestPkt = data.packet;
            for (const [, rep] of data.repeaters) {
                if ((rep.packet?.path?.length ?? 0) > (bestPkt?.path?.length ?? 0)) bestPkt = rep.packet;
            }
            const sigCols = cols.flatMap(c => {
                const sig = data.repeaters.get(c);
                return sig ? [sig.rssi != null ? String(sig.rssi) : '', sig.snr != null ? sig.snr.toFixed(1) : ''] : ['', ''];
            });
            lines.push([
                new Date(data.firstSeen).toISOString(),
                data.type || '',
                this._formatPath(bestPkt),
                hash,
                ...sigCols,
                data.meta?.text   || '',
                data.meta?.sender || '',
                data.rawHex       || '',
            ].map(esc).join(','));
        }

        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `meshcore-rx-${new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '-')}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    updateStatus(text, className) {
        this.statusEl.textContent = text;
        this.statusEl.className = `status ${className}`;
    }

    // --- Utilities ---

    formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString('en-GB');
    }

    async disconnect() {
        // Grab refs before onDisconnected nulls them
        const device = this.device;
        const txChar = this.txCharacteristic;

        // Remove the surprise-disconnect handler so onDisconnected isn't called twice
        if (this._onGattDisconnected && device) {
            device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
            this._onGattDisconnected = null;
        }

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
        if (this.batteryEl) this.batteryEl.classList.add('hidden');
        this.txCharacteristic = null;
        this.bleRxCharacteristic = null;
        this.device = null;
        this.updateStatus('Disconnected', 'disconnected');
        this.connectBtn.textContent = 'Connect Bluetooth';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.connectBluetooth();
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
