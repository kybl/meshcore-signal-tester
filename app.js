// MeshCore RX Monitor Application
import { MeshCoreDecoder, Utils } from 'https://esm.sh/@michaelhart/meshcore-decoder';

class MeshCoreMonitor {
    constructor() {
        this.device = null;
        this.bleRxCharacteristic = null;
        this.hashData = new Map();
        this.allRepeaters = new Map();
        this.repeaterColumns = []; // sorted by min RSSI ascending
        this.totalRxCount = 0;
        this.HASH_LIFETIME = 300000;
        this.cleanupInterval = null;
        this.audioCtx = null;

        this.initUI();
        this.startCleanupTimer();
    }

    initUI() {
        this.connectBtn = document.getElementById('connectBtn');
        this.serialBtn = document.getElementById('serialBtn');
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
            const cell = e.target.closest('.msg-type-cell');
            if (!cell?.dataset.hex) return;
            navigator.clipboard.writeText(cell.dataset.hex).then(() => {
                const orig = cell.textContent;
                cell.textContent = '✓';
                setTimeout(() => { cell.textContent = orig; }, 1000);
            });
        });
    }

    async connectBluetooth() {
        if (!navigator.bluetooth) {
            alert('Web Bluetooth API is not available.\n\nRequirements:\n• Chrome or Edge browser\n• Page must be served over HTTPS or localhost');
            return;
        }

        try {
            this.connectBtn.disabled = true;
            this.updateStatus('Connecting...', 'disconnected');

            const device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'Meshtastic' },
                    { namePrefix: 'MeshCore' }
                ],
                optionalServices: [
                    '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
                ]
            });

            this.device = device;
            this.device.addEventListener('gattserverdisconnected', () => this.onDisconnected());

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
            txCharacteristic.addEventListener('characteristicvaluechanged', (event) => this.handleData(event));

            await this.sendAppStart();

            this.updateStatus('Connected', 'connected');
            this.connectBtn.textContent = 'Disconnect';
            this.connectBtn.disabled = false;
            this.connectBtn.onclick = () => this.disconnect();

        } catch (error) {
            if (error.name !== 'NotFoundError') {
                console.error('Bluetooth error:', error);
                alert('Connection error: ' + error.message);
            }
            this.updateStatus('Disconnected', 'disconnected');
            this.connectBtn.disabled = false;
        }
    }

    async sendAppStart() {
        // CMD_APP_START = 0x01, firmware target version = 0x03, 6 padding bytes, app name
        const payload = new Uint8Array([0x01, 0x03, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x72, 0x78, 0x6D, 0x6F, 0x6E]);
        await this.bleRxCharacteristic.writeValueWithoutResponse(payload);
    }

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

    tryDecodeSerialBuffer() {
        // Parse framed messages: 0x3E [len_lo] [len_hi] [payload...]
        while (this.serialBuffer.length >= 3) {
            const startIdx = this.serialBuffer.indexOf(0x3E);
            if (startIdx === -1) {
                this.serialBuffer = new Uint8Array(0);
                return;
            }
            if (startIdx > 0) {
                this.serialBuffer = this.serialBuffer.slice(startIdx);
            }
            if (this.serialBuffer.length < 3) return;

            const len = this.serialBuffer[1] | (this.serialBuffer[2] << 8);
            if (len > 300) {
                this.serialBuffer = this.serialBuffer.slice(1);
                continue;
            }
            if (this.serialBuffer.length < 3 + len) return;

            const payload = this.serialBuffer.slice(3, 3 + len);
            this.serialBuffer = this.serialBuffer.slice(3 + len);
            this.handlePayload(payload);
        }
    }

    async sendAppStart(transport) {
        // CMD_APP_START = 0x01, firmware target version = 0x03, 6 padding bytes, app name
        const payload = new Uint8Array([0x01, 0x03, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x72, 0x78, 0x6D, 0x6F, 0x6E]);
        if (transport === 'ble') {
            await this.bleRxCharacteristic.writeValueWithoutResponse(payload);
        } else {
            const frame = new Uint8Array(3 + payload.length);
            frame[0] = 0x3C;
            frame[1] = payload.length & 0xFF;
            frame[2] = (payload.length >> 8) & 0xFF;
            frame.set(payload, 3);
            const writer = this.serialPort.writable.getWriter();
            await writer.write(frame);
            writer.releaseLock();
        }
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

        // Signed int8 conversion for SNR (stored as value*4) and RSSI
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

    async disconnectSerial() {
        if (this.serialReader) {
            await this.serialReader.cancel();
        }
    }

    onSerialDisconnected() {
        if (this.serialPort) {
            this.serialPort.close().catch(() => {});
            this.serialPort = null;
        }
        this.serialReader = null;
        this.serialBuffer = new Uint8Array(0);
        this.updateStatus('Odpojeno', 'disconnected');
        this.serialBtn.textContent = 'Připojit USB';
        this.serialBtn.disabled = false;
        this.serialBtn.onclick = () => this.connectSerial();
    }

    handleData(event) {
        // BLE: raw payload, no frame header
        this.handlePayload(new Uint8Array(event.target.value.buffer));
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

        if (hash && repeater) {
            this.addRxEntry(hash, repeater, type, rawHex, snr, rssi);
        }
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

    addRxEntry(hash, repeater, type, rawHex, snr, rssi) {
        this.totalRxCount++;
        const now = Date.now();
        const isNewHash = !this.hashData.has(hash);

        if (isNewHash) {
            this.hashData.set(hash, {
                repeaters: new Map([[repeater, { snr, rssi }]]),
                firstSeen: now,
                lastSeen: now,
                type,
                rawHex,
            });
        } else {
            const data = this.hashData.get(hash);
            data.lastSeen = now;
            data.repeaters.set(repeater, { snr, rssi });
        }

        const existing = this.allRepeaters.get(repeater);
        this.allRepeaters.set(repeater, {
            lastSeen: now,
            count: (existing?.count ?? 0) + 1,
            lastSnr: snr,
            lastRssi: rssi,
        });
        this.updateRepeaterTable();

        // Manage columns and decide how to update the table
        const oldOrder = [...this.repeaterColumns];
        const isNewRepeater = !this.repeaterColumns.includes(repeater);
        if (isNewRepeater) this.repeaterColumns.push(repeater);
        this.sortColumns();
        const orderChanged = isNewRepeater ||
            this.repeaterColumns.some((id, i) => id !== oldOrder[i]);

        if (orderChanged) {
            this.renderMsgTable();
        } else if (isNewHash) {
            this.insertMsgRow(hash);
        } else {
            this.updateMsgCell(hash, repeater, rssi, snr);
        }

        this.playRxSound(rssi);
        this.updateStats();
        this.emptyState.classList.add('hidden');
    }

    // --- Column management ---

    sortColumns() {
        this.repeaterColumns.sort((a, b) => this.getColMinRssi(a) - this.getColMinRssi(b));
    }

    getColMinRssi(repeaterId) {
        let min = null;
        for (const data of this.hashData.values()) {
            const r = data.repeaters.get(repeaterId);
            if (r && (min === null || r.rssi < min)) min = r.rssi;
        }
        return min ?? 0;
    }

    abbreviateType(type) {
        if (!type) return '?';
        return type
            .replace('GROUP_TEXT', 'GRP')
            .replace('TRACEROUTE', 'TRC')
            .replace('BROADCAST', 'BCT')
            .replace('RESPONSE', 'RSP')
            .replace('PRIVATE', 'PVT')
            .replace('REPEATER', 'RPT')
            .replace('FLOOD', 'FLD')
            .replace('DIRECT', 'DIR');
    }

    // --- Table rendering ---

    renderMsgTable() {
        if (!this.msgTableHead || !this.msgTableBody) return;

        this.msgTableHead.innerHTML = `<tr>
            <th class="msg-col-time">Time</th>
            <th class="msg-col-type">Type</th>
            ${this.repeaterColumns.map(r => `<th class="msg-col-rep">${r}</th>`).join('')}
        </tr>`;

        const rows = Array.from(this.hashData.entries())
            .sort((a, b) => b[1].firstSeen - a[1].firstSeen);

        this.msgTableBody.innerHTML = rows.map(([hash, data]) =>
            this.buildMsgRowHtml(hash, data)
        ).join('');
    }

    buildMsgRowHtml(hash, data) {
        const cells = this.repeaterColumns.map(r => {
            const sig = data.repeaters.get(r);
            return sig ? this.buildSigCellHtml(sig.rssi, sig.snr) : '<td></td>';
        }).join('');
        return `<tr id="row-${hash}">
            <td class="msg-col-time">${this.formatTime(data.firstSeen)}</td>
            <td class="msg-col-type msg-type-cell" title="${data.type}" data-hex="${data.rawHex}">${this.abbreviateType(data.type)}</td>
            ${cells}
        </tr>`;
    }

    buildSigCellHtml(rssi, snr) {
        const rc = this.signalColor(rssi, -70, -117);
        const sc = this.signalColor(snr, 13, -10);
        return `<td class="msg-sig-cell">
            <span class="sig-rssi" style="color:${rc}">${rssi}</span>
            <span class="sig-snr" style="color:${sc}">${snr.toFixed(1)}</span>
        </td>`;
    }

    insertMsgRow(hash) {
        if (!this.msgTableBody) return;
        const data = this.hashData.get(hash);
        const tr = document.createElement('tr');
        tr.id = `row-${hash}`;
        tr.innerHTML = `
            <td class="msg-col-time">${this.formatTime(data.firstSeen)}</td>
            <td class="msg-col-type msg-type-cell" title="${data.type}" data-hex="${data.rawHex}">${this.abbreviateType(data.type)}</td>
            ${this.repeaterColumns.map(r => {
                const sig = data.repeaters.get(r);
                return sig ? this.buildSigCellHtml(sig.rssi, sig.snr) : '<td></td>';
            }).join('')}
        `;
        this.msgTableBody.prepend(tr);
    }

    updateMsgCell(hash, repeater, rssi, snr) {
        const colIdx = this.repeaterColumns.indexOf(repeater);
        if (colIdx === -1) return;
        const row = document.getElementById(`row-${hash}`);
        if (!row) return;
        const cell = row.cells[colIdx + 2]; // +2 for time and type columns
        if (!cell) return;
        const rc = this.signalColor(rssi, -70, -117);
        const sc = this.signalColor(snr, 13, -10);
        cell.className = 'msg-sig-cell';
        cell.innerHTML = `<span class="sig-rssi" style="color:${rc}">${rssi}</span><span class="sig-snr" style="color:${sc}">${snr.toFixed(1)}</span>`;
    }

    // --- Cleanup ---

    startCleanupTimer() {
        this.cleanupInterval = setInterval(() => this.cleanup(), 10000);
    }

    cleanup() {
        const now = Date.now();
        const toRemove = [];

        for (const [hash, data] of this.hashData.entries()) {
            if (now - data.lastSeen > this.HASH_LIFETIME) {
                toRemove.push(hash);
            }
        }

        for (const hash of toRemove) {
            this.removeHashRow(hash);
            this.hashData.delete(hash);
        }

        if (toRemove.length > 0) {
            // Remove columns with no remaining rows
            const oldOrder = [...this.repeaterColumns];
            this.repeaterColumns = this.repeaterColumns.filter(r =>
                Array.from(this.hashData.values()).some(d => d.repeaters.has(r))
            );
            this.sortColumns();

            const changed = this.repeaterColumns.length !== oldOrder.length ||
                this.repeaterColumns.some((id, i) => id !== oldOrder[i]);
            if (changed) this.renderMsgTable();

            this.updateStats();
        }

        if (this.hashData.size === 0) {
            this.emptyState.classList.remove('hidden');
        }
    }

    removeHashRow(hash) {
        const row = document.getElementById(`row-${hash}`);
        if (row) {
            row.style.transition = 'opacity 0.5s';
            row.style.opacity = '0';
            setTimeout(() => row.remove(), 500);
        }
    }

    // --- Repeater log table ---

    updateRepeaterTable() {
        if (!this.repeaterLogBody) return;
        const sorted = Array.from(this.allRepeaters.entries())
            .sort((a, b) => b[1].lastSeen - a[1].lastSeen);
        this.repeaterLogBody.innerHTML = sorted.map(([repeater, d]) => {
            const rc = this.signalColor(d.lastRssi, -70, -117);
            const sc = this.signalColor(d.lastSnr,  13,  -10);
            return `<tr>
                <td class="rl-id">${repeater}</td>
                <td>${d.count}</td>
                <td style="color:${rc}">${d.lastRssi}</td>
                <td style="color:${sc}">${d.lastSnr.toFixed(1)}</td>
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
        this.updateStatus('Disconnected', 'disconnected');
        this.connectBtn.textContent = 'Connect Bluetooth';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.connectBluetooth();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new MeshCoreMonitor());
} else {
    new MeshCoreMonitor();
}
