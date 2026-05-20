// MeshCore RX Monitor Application
import { MeshCoreDecoder, Utils } from 'https://esm.sh/@michaelhart/meshcore-decoder';

class MeshCoreMonitor {
    constructor() {
        this.device = null;
        this.bleRxCharacteristic = null;
        this.hashData = new Map();
        this.allRepeaters = new Map();
        this.repeaterColumns = []; // sorted by max RSSI descending (strongest first)
        this.totalRxCount = 0;
        this.HASH_LIFETIME = 300000;
        this.cleanupInterval = null;
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

        this.initUI();
        this.startCleanupTimer();
        this.renderSavedDevices();
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
        setInterval(() => { if (this.chartPoints.length) this.scheduleChartRender(); }, 2000);

        // Collapsible sections
        document.querySelectorAll('.collapse-btn').forEach(btn => {
            btn.addEventListener('click', () => {
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

        let _resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(() => { if (this.chartPoints.length) this.scheduleChartRender(); }, 150);
        });

        const bindChartTooltip = (svg, type) => {
            if (!svg) return;
            svg.addEventListener('mousemove', e => this.showChartTooltip(e, type));
            svg.addEventListener('mouseleave', () => this.hideChartTooltip());
            svg.addEventListener('touchstart', e => {
                if (e.touches.length === 1) this.showChartTooltip(e.touches[0], type);
            }, { passive: true });
            svg.addEventListener('touchend', () => {
                setTimeout(() => this.hideChartTooltip(), 2000);
            });
        };
        bindChartTooltip(this.rssiChartSvg, 'rssi');
        bindChartTooltip(this.snrChartSvg,  'snr');

        document.getElementById('msgTableWrap')?.addEventListener('click', e => {
            const rxCell = e.target.closest('.msg-col-rx');
            if (rxCell) { this.toggleDetailRow(rxCell.dataset.hash); return; }
            const detailRow = e.target.closest('tr.detail-row');
            if (detailRow && !e.target.closest('.raw-hex')) { detailRow.remove(); return; }
            const hexEl = e.target.closest('.raw-hex');
            if (hexEl) {
                navigator.clipboard.writeText(hexEl.dataset.hex).then(() => {
                    const orig = hexEl.textContent;
                    hexEl.textContent = '✓ copied';
                    setTimeout(() => { hexEl.textContent = orig; }, 1000);
                });
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

        if (navigator.getBattery) {
            navigator.getBattery().then(bat => {
                this.battery = bat;
                this.updateBattery();
                bat.addEventListener('chargingchange', () => this.updateBattery());
                bat.addEventListener('levelchange',    () => this.updateBattery());
            }).catch(() => {});
        }

        const repeaterHead = document.querySelector('.repeater-log-table thead');
        if (repeaterHead) {
            repeaterHead.addEventListener('click', e => {
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

        window.addEventListener('beforeunload', e => {
            if (this.device) {
                e.preventDefault();
                e.returnValue = '';
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
                optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e']
            });
            await this.connectToDevice(device);
        } catch (error) {
            if (error.name !== 'NotFoundError') {
                console.error('Bluetooth error:', error);
                alert('Connection error: ' + error.message);
            }
            this._resetConnectBtn();
        }
    }

    async quickConnect(deviceId) {
        // Try getDevices() for zero-friction reconnect (Chrome 85+, may need flag)
        if (navigator.bluetooth?.getDevices) {
            try {
                const devices = await navigator.bluetooth.getDevices();
                const device = devices.find(d => d.id === deviceId);
                if (device) {
                    this.connectBtn.disabled = true;
                    this.updateStatus('Connecting...', 'disconnected');
                    await this.connectToDevice(device);
                    return;
                }
            } catch (e) {
                console.warn('getDevices failed:', e);
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
                optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'],
            });
            await this.connectToDevice(device);
        } catch (error) {
            if (error.name !== 'NotFoundError') {
                console.error('Quick connect error:', error);
                alert('Connection error: ' + error.message);
            }
            this._resetConnectBtn();
        }
    }

    _resetConnectBtn() {
        this.updateStatus('Disconnected', 'disconnected');
        this.connectBtn.textContent = 'Connect Bluetooth';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.connectBluetooth();
    }

    _cancelConnect(device, token) {
        if (this._connectToken !== token) return;
        this._connectToken = null;
        if (this._onGattDisconnected && device) {
            device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
            this._onGattDisconnected = null;
        }
        this.device = null;
        this.txCharacteristic = null;
        this.bleRxCharacteristic = null;
        try { if (device?.gatt?.connected) device.gatt.disconnect(); } catch (e) {}
        this._resetConnectBtn();
    }

    async connectToDevice(device) {
        const token = Symbol();
        this._connectToken = token;
        const alive = () => this._connectToken === token;

        // Show Cancel button as soon as device is selected
        this.connectBtn.textContent = 'Cancel';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this._cancelConnect(device, token);
        this.updateStatus('Connecting...', 'disconnected');

        this.device = device;
        this._onGattDisconnected = () => this.onDisconnected();
        device.addEventListener('gattserverdisconnected', this._onGattDisconnected);

        const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_RX     = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_TX     = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

        let service;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (!alive()) return;
            try {
                const server = await Promise.race([
                    device.gatt.connect(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
                ]);
                if (!alive()) { try { device.gatt.disconnect(); } catch (e) {} return; }
                service = await server.getPrimaryService(NUS_SERVICE);
                break;
            } catch (e) {
                if (!alive()) return;
                if (attempt === 3) throw e;
                await new Promise(r => setTimeout(r, attempt * 500));
            }
        }

        if (!alive()) return;
        this.bleRxCharacteristic = await service.getCharacteristic(NUS_RX);
        if (!alive()) return;
        const txCharacteristic = await service.getCharacteristic(NUS_TX);
        if (!alive()) return;
        this.txCharacteristic = txCharacteristic;
        this._onDataReceived = e => this.handleData(e);
        await txCharacteristic.startNotifications();
        if (!alive()) return;
        txCharacteristic.addEventListener('characteristicvaluechanged', this._onDataReceived);

        await this.sendAppStart();
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
        let loraPacket;
        if (pushCode === 0x88) {
            loraPacket = payload.slice(3);
        } else if (pushCode === 0x84) {
            loraPacket = payload.slice(4);
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

    bufferToHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    processPacket(packet, rawHex, snr, rssi) {
        console.log('[RX packet]', packet);
        const payloadRaw = packet.payload?.raw;
        const hash = payloadRaw ? this.hashPayload(payloadRaw) : packet.messageHash;
        const repeater = this.extractRepeater(packet);
        const type = [
            Utils.getRouteTypeName(packet.routeType),
            Utils.getPayloadTypeName(packet.payloadType),
        ].filter(Boolean).join(' ');

        const path = packet.path || [];
        const pathLen = path.length;
        const pathItemBytes = packet.pathHashSize ?? (pathLen > 0 ? path[0].length / 2 : 0);

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
            this.addRxEntry(hash, repeater, type, rawHex, snr, rssi, meta);
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
            return '!' + nodeId.toString(16).padStart(8, '0');
        }
        return nodeId?.toString() || 'unknown';
    }

    // --- Node ID prefix resolution ---
    // Path IDs can be 1/2/3-byte truncations of full 4-byte node IDs.
    // We always use the longest (most precise) known version as the column key.

    idPrecision(id) {
        if (id === 'direct' || id.includes('/')) return 4;
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
    }

    displayId(id) {
        if (id === 'direct') return 'direct';
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

    addRxEntry(hash, repeater, type, rawHex, snr, rssi, meta = {}) {
        this.totalRxCount++;
        const now = Date.now();
        const isNewHash = !this.hashData.has(hash);
        const canonicalKey = this.findOrCreateColumn(repeater);

        if (isNewHash) {
            this.hashData.set(hash, {
                repeaters: new Map([[canonicalKey, { snr, rssi }]]),
                firstSeen: now,
                lastSeen: now,
                insertOrder: ++this.hashCounter,
                type,
                rawHex,
                meta,
            });
        } else {
            const data = this.hashData.get(hash);
            data.lastSeen = now;
            data.repeaters.set(canonicalKey, { snr, rssi });
        }

        const existing = this.allRepeaters.get(canonicalKey);
        this.allRepeaters.set(canonicalKey, {
            lastSeen: now,
            count:    (existing?.count ?? 0) + 1,
            maxSnr:   Math.max(existing?.maxSnr  ?? -999, snr),
            maxRssi:  Math.max(existing?.maxRssi ?? -999, rssi),
            lastSnr:  snr,
            lastRssi: rssi,
        });
        this.chartPoints.push({ time: now, rssi, snr, col: canonicalKey });
        this.updateRepeaterTable();
        this.sortColumns();
        this.renderMsgTable(isNewHash ? hash : null);
        this.scheduleChartRender();

        this.playRxSound(rssi);
        this.updateStats();
        if (this.emptyState) {
            this.emptyState.remove();
            this.emptyState = null;
        }
    }

    // --- Column management ---

    sortColumns() {
        this.repeaterColumns.sort((a, b) =>
            (this.allRepeaters.get(b)?.maxRssi ?? -200) - (this.allRepeaters.get(a)?.maxRssi ?? -200)
        );
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

    // --- Table rendering ---

    renderMsgTable(flashHash = null) {
        if (!this.msgTableHead || !this.msgTableBody) return;

        const openDetails = new Set(
            [...this.msgTableBody.querySelectorAll('tr[id^="detail-"]')]
                .map(tr => tr.id.slice(7))
        );

        const colKey = this.repeaterColumns.join(',');
        if (colKey !== this._lastColKey) {
            this._lastColKey = colKey;
            const repHeaders = this.repeaterColumns.map(r =>
                `<th colspan="2" class="msg-col-rep">${this.displayId(r)}</th>`
            ).join('');
            const subHeaders = this.repeaterColumns.map(() =>
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

        const rows = Array.from(this.hashData.entries())
            .sort(([, a], [, b]) => b.insertOrder - a.insertOrder);

        this.msgTableBody.innerHTML = rows.map(([hash, data]) =>
            this.buildMsgRowHtml(hash, data)
        ).join('');

        for (const hash of openDetails) {
            if (!this.hashData.has(hash)) continue;
            const row = document.getElementById(`row-${hash}`);
            if (!row) continue;
            const detail = document.createElement('tr');
            detail.id = `detail-${hash}`;
            detail.className = 'detail-row';
            detail.innerHTML = this.buildDetailRowHtml(hash);
            row.after(detail);
        }

        if (flashHash) {
            const row = document.getElementById(`row-${flashHash}`);
            if (row) row.classList.add('row-new');
        }
    }

    buildMsgRowHtml(hash, data) {
        const cells = this.repeaterColumns.map(r => {
            const sig = data.repeaters.get(r);
            return sig ? this.buildSigCellsHtml(sig.rssi, sig.snr) : '<td></td><td></td>';
        }).join('');
        return `<tr id="row-${hash}">
            <td class="msg-col-rx" data-hash="${hash}">
                <span class="rx-time">${this.formatTime(data.firstSeen)}</span><span class="rx-abbr">${this.abbreviateType(data.type)}</span>
            </td>
            ${cells}
        </tr>`;
    }

    toggleDetailRow(hash) {
        const existing = document.getElementById(`detail-${hash}`);
        if (existing) { existing.remove(); return; }
        const row = document.getElementById(`row-${hash}`);
        if (!row) return;
        const detail = document.createElement('tr');
        detail.id = `detail-${hash}`;
        detail.className = 'detail-row';
        detail.innerHTML = this.buildDetailRowHtml(hash);
        row.after(detail);
    }

    buildDetailRowHtml(hash) {
        const data = this.hashData.get(hash);
        if (!data) return '';
        const colspan = 1 + this.repeaterColumns.length * 2;
        const meta = data.meta || {};
        const lines = [`<b>Type:</b> ${this.escHtml(data.type || '?')}`];

        if (meta.pathItemBytes > 0)
            lines.push(`<b>Path hash size:</b> ${meta.pathItemBytes}B/item`);
        else
            lines.push(`<b>Path:</b> direct`);
        if (meta.totalBytes != null)
            lines.push(`<b>Size:</b> ${meta.totalBytes}B`);

        // Public channel message: show sender + text
        if (meta.text != null) {
            if (meta.sender != null)
                lines.push(`<b>From:</b> ${this.escHtml(meta.sender)}`);
            lines.push(`<b>Message:</b> ${this.escHtml(meta.text)}`);
        }
        // Advert: show node name + link key
        if (meta.name != null)
            lines.push(`<b>Node:</b> ${this.escHtml(meta.name)}`);
        if (meta.linkKey != null)
            lines.push(`<b>Link key:</b> <code>${this.escHtml(meta.linkKey)}</code>`);

        lines.push(`<b>Raw:</b> <code class="raw-hex" data-hex="${data.rawHex}" title="Click to copy">${data.rawHex}</code>`);
        return `<td colspan="${colspan}" class="detail-cell"><div class="detail-content">${lines.join('<br>')}</div></td>`;
    }

    buildSigCellsHtml(rssi, snr) {
        const rc = this.signalColor(rssi, -70, -130);
        const sc = this.signalColor(snr,  13, -10, 0);
        return `<td class="sig-rssi" style="color:${rc}">${rssi}</td><td class="sig-snr" style="color:${sc}">${snr.toFixed(1)}</td>`;
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
        this.renderChart('rssi');
        this.renderChart('snr');
    }

    renderChart(type) {
        const wrap   = type === 'rssi' ? this.rssiChartWrap   : this.snrChartWrap;
        const svg    = type === 'rssi' ? this.rssiChartSvg    : this.snrChartSvg;
        const legend = type === 'rssi' ? this.rssiChartLegend : this.snrChartLegend;
        if (!svg) return;

        if (!this.chartPoints.length) {
            wrap?.classList.add('hidden');
            return;
        }
        wrap?.classList.remove('hidden');

        const W = svg.clientWidth || 600;
        const H = svg.clientHeight || 180;
        const pl = 36, pr = 8, pt = 6, pb = 24;
        const cw = W - pl - pr;
        const ch = H - pt - pb;

        const now = Date.now();
        const tMin = isFinite(this.HASH_LIFETIME)
            ? now - this.HASH_LIFETIME
            : Math.min(...this.chartPoints.map(p => p.time));

        const vals = this.chartPoints.map(p => type === 'rssi' ? p.rssi : p.snr);
        const nfVals = type === 'rssi' ? this.chartPoints.map(p => p.rssi - p.snr) : [];
        const allVals = [...vals, ...nfVals];
        const vMin = Math.min(...allVals), vMax = Math.max(...allVals);
        const yPad = type === 'rssi' ? 5 : 2;
        const yMin = Math.floor((vMin - yPad) / 5) * 5;
        const yMax = Math.ceil((vMax + yPad) / 5) * 5;

        const xOf = t => (pl + (t - tMin) / (now - tMin) * cw).toFixed(1);
        const yOf = v => (pt + (1 - (v - yMin) / (yMax - yMin)) * ch).toFixed(1);
        const valOf = p => type === 'rssi' ? p.rssi : p.snr;

        const parts = [];

        // Y grid + labels
        const yRange = yMax - yMin;
        const yStep = yRange <= 10 ? 2 : yRange <= 20 ? 5 : yRange <= 60 ? 10 : 20;
        for (let y = yMin; y <= yMax; y += yStep) {
            const yp = yOf(y);
            parts.push(`<line x1="${pl}" y1="${yp}" x2="${pl + cw}" y2="${yp}" stroke="#f0f0f0" stroke-width="1"/>`);
            parts.push(`<text x="${pl - 3}" y="${(+yp + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#bbb">${y}</text>`);
        }

        // X grid + labels (every minute)
        const minMs = 60000;
        for (let t = Math.ceil(tMin / minMs) * minMs; t <= now; t += minMs) {
            const xp = xOf(t);
            parts.push(`<line x1="${xp}" y1="${pt}" x2="${xp}" y2="${pt + ch}" stroke="#f0f0f0" stroke-width="1"/>`);
            const lbl = new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            parts.push(`<text x="${xp}" y="${pt + ch + 14}" text-anchor="middle" font-size="9" fill="#bbb">${lbl}</text>`);
        }

        // Axes
        parts.push(`<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ch}" stroke="#ddd" stroke-width="1"/>`);
        parts.push(`<line x1="${pl}" y1="${pt + ch}" x2="${pl + cw}" y2="${pt + ch}" stroke="#ddd" stroke-width="1"/>`);

        // Noise floor area (RSSI chart only) — drawn behind repeater lines/dots
        if (type === 'rssi') {
            const sorted = [...this.chartPoints].sort((a, b) => a.time - b.time);
            const bottom = (pt + ch).toFixed(1);
            const lastP = sorted[sorted.length - 1];
            const nfPts = sorted.map(p => `${xOf(p.time)},${yOf(p.rssi - p.snr)}`);
            // Extend flat to the current time using the last known noise floor value
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

        const groups = new Map();
        for (const p of this.chartPoints) {
            if (!groups.has(p.col)) groups.set(p.col, []);
            groups.get(p.col).push(p);
        }
        for (const [col, pts] of groups) {
            if (pts.length < 2) continue;
            pts.sort((a, b) => a.time - b.time);
            const color = this.getRepeaterColor(col);
            const pointsStr = pts.map(p => `${xOf(p.time)},${yOf(valOf(p))}`).join(' ');
            parts.push(`<polyline points="${pointsStr}" fill="none" stroke="${color}" stroke-width="1" stroke-opacity="0.35"/>`);
        }

        for (const p of this.chartPoints) {
            parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(valOf(p))}" r="3.5" fill="${this.getRepeaterColor(p.col)}" fill-opacity="0.75"/>`);
        }

        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.innerHTML = parts.join('');

        // Find the most recent point per column, then sort best → worst
        const lastByCol = new Map();
        for (const p of this.chartPoints) {
            if (!lastByCol.has(p.col) || p.time > lastByCol.get(p.col).time) lastByCol.set(p.col, p);
        }
        const visible = [...lastByCol.keys()].sort((a, b) => {
            const pa = lastByCol.get(a), pb = lastByCol.get(b);
            return type === 'rssi' ? pb.rssi - pa.rssi : pb.snr - pa.snr;
        });

        if (legend) {
            const items = visible.map(col => {
                const c = this.getRepeaterColor(col);
                const last = lastByCol.get(col);
                const val = type === 'rssi' ? last.rssi : last.snr;
                const valStr = type === 'rssi'
                    ? `${val} dBm`
                    : `${val >= 0 ? '+' : ''}${val.toFixed(1)} dB`;
                return `<span class="legend-item"><span class="legend-dot" style="background:${c}"></span>${this.escHtml(this.displayId(col))} <span class="legend-val">(${valStr})</span></span>`;
            }).join('');
            let nfLegend = '';
            if (type === 'rssi') {
                const lastPt = [...lastByCol.values()].reduce((a, b) => a.time > b.time ? a : b);
                const nf = lastPt.rssi - lastPt.snr;
                nfLegend = `<span class="legend-item"><span class="legend-nf"></span>Noise floor <span class="legend-val">(${nf} dBm)</span></span>`;
            }
            legend.innerHTML = items + nfLegend;
        }
    }

    showChartTooltip(e, type) {
        if (!this.tooltip || !this.chartPoints.length) return;
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
            : Math.min(...this.chartPoints.map(p => p.time));

        const pts = this.chartPoints;
        const vals = pts.map(p => type === 'rssi' ? p.rssi : p.snr);
        const nfVals = type === 'rssi' ? pts.map(p => p.rssi - p.snr) : [];
        const allVals = [...vals, ...nfVals];
        const vMin = Math.min(...allVals), vMax = Math.max(...allVals);
        const yPad = type === 'rssi' ? 5 : 2;
        const yMin = Math.floor((vMin - yPad) / 5) * 5;
        const yMax = Math.ceil((vMax + yPad) / 5) * 5;

        const xOf = t => pl + (t - tMin) / (now - tMin) * cw;
        const yOf = v => pt + (1 - (v - yMin) / (yMax - yMin)) * ch;

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
        const entries = Array.from(this.allRepeaters.entries());
        entries.sort(([idA, dA], [idB, dB]) => {
            if (key === 'id') {
                if (idA === 'direct' && idB !== 'direct') return -1;
                if (idB === 'direct' && idA !== 'direct') return 1;
                return dir * idA.localeCompare(idB);
            }
            return dir * (dA[key] - dB[key]);
        });
        this.repeaterLogBody.innerHTML = entries.map(([repeater, d]) => {
            const mrc = this.signalColor(d.maxRssi,  -70, -130);
            const lrc = this.signalColor(d.lastRssi, -70, -130);
            const msc = this.signalColor(d.maxSnr,   13, -10, 0);
            const lsc = this.signalColor(d.lastSnr,  13, -10, 0);
            return `<tr>
                <td class="rl-id">${this.displayId(repeater)}</td>
                <td>${d.count}</td>
                <td style="color:${mrc}">${d.maxRssi}</td>
                <td style="color:${lrc}">${d.lastRssi}</td>
                <td style="color:${msc}">${d.maxSnr.toFixed(1)}</td>
                <td style="color:${lsc}">${d.lastSnr.toFixed(1)}</td>
                <td>${this.formatTime(d.lastSeen)}</td>
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

    // --- Battery ---

    updateBattery() {
        if (!this.batteryEl || !this.battery) return;
        const pct = Math.round(this.battery.level * 100);
        const charging = this.battery.charging;
        this.batteryEl.innerHTML =
            `<span class="hstat-label">${charging ? '⚡' : '🔋'}</span>${pct}%`;
        this.batteryEl.classList.remove('hidden', 'battery-low');
        if (!charging && pct <= 20) this.batteryEl.classList.add('battery-low');
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
        this.totalRepeatersEl.textContent = this.repeaterColumns.length;
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
        // Clean up listeners — needed when called from surprise disconnect (gattserverdisconnected event)
        if (this._onGattDisconnected) {
            this.device?.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
            this._onGattDisconnected = null;
        }
        if (this._onDataReceived) {
            this.txCharacteristic?.removeEventListener('characteristicvaluechanged', this._onDataReceived);
            this._onDataReceived = null;
        }
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
