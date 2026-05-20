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

        this.initUI();
        this.startCleanupTimer();
        this.renderSavedDevices();
    }

    initUI() {
        this.connectBtn = document.getElementById('connectBtn');
        this.statusEl = document.getElementById('status');
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
        const payloadRaw = packet.payload?.raw;
        const hash = payloadRaw ? this.hashPayload(payloadRaw) : packet.messageHash;
        const repeater = this.extractRepeater(packet);
        const type = [
            Utils.getRouteTypeName(packet.routeType),
            Utils.getPayloadTypeName(packet.payloadType),
        ].filter(Boolean).join(' ');

        const pathBytes = packet.path?.reduce((s, el) => s + el.length / 2, 0) ?? 0;
        const p = packet.payload;
        let payloadInfo = '';
        if (p?.text)   payloadInfo = `<b>Text:</b> ${this.escHtml(String(p.text))}`;
        else if (p?.name)   payloadInfo = `<b>Name:</b> ${this.escHtml(String(p.name))}`;
        else if (p?.sender) payloadInfo = `<b>Sender:</b> ${this.escHtml(String(p.sender))}`;

        if (hash && repeater) {
            this.addRxEntry(hash, repeater, type, rawHex, snr, rssi, { pathBytes, payloadInfo });
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
        this.updateRepeaterTable();
        this.sortColumns();
        this.renderMsgTable(isNewHash ? hash : null);

        this.playRxSound(rssi);
        this.updateStats();
        this.emptyState.classList.add('hidden');
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
            .sort(([, a], [, b]) => {
                const rd = this.hashMaxRssi(b) - this.hashMaxRssi(a);
                if (rd !== 0) return rd;
                const sd = this.hashMaxSnr(b) - this.hashMaxSnr(a);
                if (sd !== 0) return sd;
                return b.repeaters.size - a.repeaters.size;
            });

        this.msgTableBody.innerHTML = rows.map(([hash, data]) =>
            this.buildMsgRowHtml(hash, data)
        ).join('');

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
        if (meta.pathBytes !== undefined)
            lines.push(`<b>Path:</b> ${meta.pathBytes} byte${meta.pathBytes !== 1 ? 's' : ''}`);
        if (meta.payloadInfo) lines.push(meta.payloadInfo);
        lines.push(`<b>Raw hex:</b> <code class="raw-hex" data-hex="${data.rawHex}" title="Click to copy">${data.rawHex}</code>`);
        return `<td colspan="${colspan}" class="detail-cell"><div class="detail-content">${lines.join('<br>')}</div></td>`;
    }

    buildSigCellsHtml(rssi, snr) {
        const rc = this.signalColor(rssi, -70, -117);
        const sc = this.signalColor(snr, 13, -10);
        return `<td class="sig-rssi" style="color:${rc}">${rssi}</td><td class="sig-snr" style="color:${sc}">${snr.toFixed(1)}</td>`;
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
            if (this.hashData.size === 0) this.emptyState.classList.remove('hidden');
        }, 400);
    }

    // --- Repeater log table ---

    updateRepeaterTable() {
        if (!this.repeaterLogBody) return;
        const sorted = Array.from(this.allRepeaters.entries())
            .sort((a, b) => b[1].lastSeen - a[1].lastSeen);
        this.repeaterLogBody.innerHTML = sorted.map(([repeater, d]) => {
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
