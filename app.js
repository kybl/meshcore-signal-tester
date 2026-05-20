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
        this.chartWrap = document.getElementById('chartWrap');
        this.chartSvg = document.getElementById('rssiChart');
        this.chartLegend = document.getElementById('chartLegend');
        setInterval(() => { if (this.chartPoints.length) this.renderChart(); }, 10000);
        this.msgTableHead = document.getElementById('msgTableHead');
        this.msgTableBody = document.getElementById('msgTableBody');
        this.emptyState = document.getElementById('emptyState');
        this.activeHashesEl = document.getElementById('activeHashes');
        this.totalRxEl = document.getElementById('totalRx');
        this.totalRepeatersEl = document.getElementById('totalRepeaters');
        this.repeaterLogBody = document.getElementById('repeaterLogBody');
        this.soundCheckbox = document.getElementById('soundEnabled');

        this.connectBtn.onclick = () => this.connectBluetooth();

        document.getElementById('msgTableWrap')?.addEventListener('click', e => {
            const rxCell = e.target.closest('.msg-col-rx');
            if (rxCell) { this.toggleDetailRow(rxCell.dataset.hash); return; }
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

        const ttlSlider = document.getElementById('ttlSlider');
        const ttlValue  = document.getElementById('ttlValue');
        if (ttlSlider) {
            ttlSlider.addEventListener('input', () => {
                const secs = +ttlSlider.value;
                this.HASH_LIFETIME = secs * 1000;
                ttlValue.textContent = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
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
            this.updateStatus('Disconnected', 'disconnected');
            this.connectBtn.disabled = false;
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
            this.updateStatus('Disconnected', 'disconnected');
            this.connectBtn.disabled = false;
        }
    }

    async connectToDevice(device) {
        this.device = device;
        device.addEventListener('gattserverdisconnected', () => this.onDisconnected());

        const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_RX     = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        const NUS_TX     = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

        let service;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const server = await device.gatt.connect();
                service = await server.getPrimaryService(NUS_SERVICE);
                break;
            } catch (e) {
                if (attempt === 3) throw e;
                await new Promise(r => setTimeout(r, attempt * 500));
            }
        }

        this.bleRxCharacteristic = await service.getCharacteristic(NUS_RX);
        const txCharacteristic = await service.getCharacteristic(NUS_TX);
        await txCharacteristic.startNotifications();
        txCharacteristic.addEventListener('characteristicvaluechanged', e => this.handleData(e));

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
        if (!devices.find(d => d.id === device.id)) {
            devices.push({ id: device.id, name: device.name || 'Unknown' });
            localStorage.setItem('meshcore-devices', JSON.stringify(devices));
        }
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

        const p = packet.payload;
        const meta = { pathLen, pathItemBytes, totalBytes: packet.totalBytes };
        if (p) {
            if (p.text      != null) meta.text      = String(p.text);
            if (p.name      != null) meta.name      = String(p.name);
            if (p.sender    != null) meta.sender    = String(p.sender);
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
        const collisionKey = [...matches].sort().join('/');
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
                this.allRepeaters.set(newKey, {
                    lastSeen: Math.max(oldData.lastSeen, newData.lastSeen),
                    count: oldData.count + newData.count,
                    maxSnr:  Math.max(oldData.maxSnr  ?? -999, newData.maxSnr  ?? -999),
                    maxRssi: Math.max(oldData.maxRssi ?? -999, newData.maxRssi ?? -999),
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
            count: (existing?.count ?? 0) + 1,
            maxSnr:  Math.max(existing?.maxSnr  ?? -999, snr),
            maxRssi: Math.max(existing?.maxRssi ?? -999, rssi),
        });
        this.chartPoints.push({ time: now, rssi, col: canonicalKey });
        this.updateRepeaterTable();
        this.sortColumns();
        this.renderMsgTable(isNewHash ? hash : null);
        this.renderChart();

        this.playRxSound(rssi);
        this.updateStats();
        if (this.emptyState) {
            this.emptyState.remove();
            this.emptyState = null;
        }
    }

    // --- Column management ---

    sortColumns() {
        // Strongest (highest max RSSI) first
        this.repeaterColumns.sort((a, b) => this.getColMaxRssi(b) - this.getColMaxRssi(a));
    }

    getColMaxRssi(repeaterId) {
        let max = null;
        for (const data of this.hashData.values()) {
            const r = data.repeaters.get(repeaterId);
            if (r && (max === null || r.rssi > max)) max = r.rssi;
        }
        return max ?? -200;
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

    hashMaxRssi(data) {
        let max = -999;
        for (const sig of data.repeaters.values()) if (sig.rssi > max) max = sig.rssi;
        return max;
    }

    hashMaxSnr(data) {
        let max = -999;
        for (const sig of data.repeaters.values()) if (sig.snr > max) max = sig.snr;
        return max;
    }

    renderMsgTable(flashHash = null) {
        if (!this.msgTableHead || !this.msgTableBody) return;

        // Remember open detail rows before rebuilding
        const openDetails = new Set(
            [...this.msgTableBody.querySelectorAll('tr[id^="detail-"]')]
                .map(tr => tr.id.slice(7))
        );

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

        const rows = Array.from(this.hashData.entries())
            .sort(([, a], [, b]) => b.insertOrder - a.insertOrder);

        this.msgTableBody.innerHTML = rows.map(([hash, data]) =>
            this.buildMsgRowHtml(hash, data)
        ).join('');

        // Restore detail rows that were open
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

        if (meta.pathLen > 0)
            lines.push(`<b>Path:</b> ${meta.pathLen} hop${meta.pathLen !== 1 ? 's' : ''} · ${meta.pathItemBytes}B/item`);
        else
            lines.push(`<b>Path:</b> direct`);
        if (meta.totalBytes != null)
            lines.push(`<b>Size:</b> ${meta.totalBytes}B`);

        if (meta.text != null)
            lines.push(`<b>Message:</b> ${this.escHtml(meta.text)}`);
        if (meta.name != null)
            lines.push(`<b>Node:</b> ${this.escHtml(meta.name)}`);
        if (meta.linkKey != null)
            lines.push(`<b>Link key:</b> <code>${this.escHtml(meta.linkKey)}</code>`);
        if (meta.sender != null && meta.name == null)
            lines.push(`<b>Sender:</b> ${this.escHtml(meta.sender)}`);

        lines.push(`<b>Raw:</b> <code class="raw-hex" data-hex="${data.rawHex}" title="Click to copy">${data.rawHex}</code>`);
        return `<td colspan="${colspan}" class="detail-cell"><div class="detail-content">${lines.join('<br>')}</div></td>`;
    }

    buildSigCellsHtml(rssi, snr) {
        const rc = this.signalColor(rssi, -70, -117);
        const sc = this.signalColor(snr, 13, -10);
        return `<td class="sig-rssi" style="color:${rc}">${rssi}</td><td class="sig-snr" style="color:${sc}">${snr.toFixed(1)}</td>`;
    }

    // --- Chart ---

    getRepeaterColor(col) {
        if (!this.chartColors.has(col)) {
            this.chartColors.set(col, this.chartColorPalette[this.chartColorIdx++ % this.chartColorPalette.length]);
        }
        return this.chartColors.get(col);
    }

    renderChart() {
        if (!this.chartSvg) return;

        const cutoff = Date.now() - this.HASH_LIFETIME;
        this.chartPoints = this.chartPoints.filter(p => p.time >= cutoff);

        if (!this.chartPoints.length) {
            this.chartWrap?.classList.add('hidden');
            return;
        }
        this.chartWrap?.classList.remove('hidden');

        const W = this.chartSvg.clientWidth || 600;
        const H = this.chartSvg.clientHeight || 120;
        const pl = 36, pr = 8, pt = 6, pb = 24;
        const cw = W - pl - pr;
        const ch = H - pt - pb;

        const now = Date.now();
        const tMin = now - this.HASH_LIFETIME;

        const rssis = this.chartPoints.map(p => p.rssi);
        const rMin = Math.min(...rssis), rMax = Math.max(...rssis);
        const yPad = 5;
        const yMin = Math.floor((rMin - yPad) / 10) * 10;
        const yMax = Math.ceil((rMax + yPad) / 10) * 10;

        const xOf = t  => (pl + (t - tMin) / (now - tMin) * cw).toFixed(1);
        const yOf = r  => (pt + (1 - (r - yMin) / (yMax - yMin)) * ch).toFixed(1);

        const parts = [];

        // Y grid + labels
        const yRange = yMax - yMin;
        const yStep = yRange <= 20 ? 5 : yRange <= 60 ? 10 : 20;
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

        // Lines connecting dots per repeater (drawn before dots)
        const groups = new Map();
        for (const p of this.chartPoints) {
            if (!groups.has(p.col)) groups.set(p.col, []);
            groups.get(p.col).push(p);
        }
        for (const [col, pts] of groups) {
            if (pts.length < 2) continue;
            pts.sort((a, b) => a.time - b.time);
            const color = this.getRepeaterColor(col);
            const pointsStr = pts.map(p => `${xOf(p.time)},${yOf(p.rssi)}`).join(' ');
            parts.push(`<polyline points="${pointsStr}" fill="none" stroke="${color}" stroke-width="1" stroke-opacity="0.35"/>`);
        }

        // Dots
        for (const p of this.chartPoints) {
            parts.push(`<circle cx="${xOf(p.time)}" cy="${yOf(p.rssi)}" r="3.5" fill="${this.getRepeaterColor(p.col)}" fill-opacity="0.75"/>`);
        }

        this.chartSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        this.chartSvg.innerHTML = parts.join('');

        // Legend — only repeaters visible in current window
        const visible = [...new Set(this.chartPoints.map(p => p.col))];
        if (this.chartLegend) {
            this.chartLegend.innerHTML = visible.map(col => {
                const c = this.getRepeaterColor(col);
                return `<span class="legend-item"><span class="legend-dot" style="background:${c}"></span>${this.escHtml(this.displayId(col))}</span>`;
            }).join('');
        }
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

        // Animate rows out, then re-render without them
        for (const hash of toRemove) {
            document.getElementById(`row-${hash}`)?.classList.add('row-removing');
            document.getElementById(`detail-${hash}`)?.remove();
            this.hashData.delete(hash);
        }

        setTimeout(() => {
            this.repeaterColumns = this.repeaterColumns.filter(r =>
                Array.from(this.hashData.values()).some(d => d.repeaters.has(r))
            );
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
            const a = key === 'id' ? idA : dA[key];
            const b = key === 'id' ? idB : dB[key];
            if (typeof a === 'string') return dir * a.localeCompare(b);
            return dir * (a - b);
        });
        this.repeaterLogBody.innerHTML = entries.map(([repeater, d]) => {
            const rc = this.signalColor(d.maxRssi, -70, -117);
            const sc = this.signalColor(d.maxSnr,  13,  -10);
            return `<tr>
                <td class="rl-id">${this.displayId(repeater)}</td>
                <td>${d.count}</td>
                <td style="color:${rc}">${d.maxRssi}</td>
                <td style="color:${sc}">${d.maxSnr.toFixed(1)}</td>
                <td>${this.formatTime(d.lastSeen)}</td>
            </tr>`;
        }).join('');
    }

    // --- Signal color ---

    signalColor(value, greenVal, redVal) {
        const t = Math.max(0, Math.min(1, (value - greenVal) / (redVal - greenVal)));
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

    disconnect() {
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
        this.onDisconnected();
    }

    onDisconnected() {
        this.releaseWakeLock();
        this.updateStatus('Disconnected', 'disconnected');
        this.connectBtn.textContent = 'Connect Bluetooth';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.connectBluetooth();
        this.device = null;
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
