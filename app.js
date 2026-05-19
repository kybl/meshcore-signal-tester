// MeshCore RX Monitor Application
import { MeshCoreDecoder, Utils } from 'https://esm.sh/@michaelhart/meshcore-decoder';

class MeshCoreMonitor {
    constructor() {
        this.device = null;
        this.bleRxCharacteristic = null;
        this.serialPort = null;
        this.serialReader = null;
        this.serialBuffer = new Uint8Array(0);
        this.hashData = new Map();
        this.allRepeaters = new Map();
        this.totalRxCount = 0;
        this.HASH_LIFETIME = 300000;
        this.cleanupInterval = null;

        this.initUI();
        this.startCleanupTimer();
    }

    initUI() {
        this.connectBtn = document.getElementById('connectBtn');
        this.serialBtn = document.getElementById('serialBtn');
        this.statusEl = document.getElementById('status');
        this.hashContainer = document.getElementById('hashContainer');
        this.emptyState = document.getElementById('emptyState');
        this.activeHashesEl = document.getElementById('activeHashes');
        this.totalRxEl = document.getElementById('totalRx');
        this.totalRepeatersEl = document.getElementById('totalRepeaters');
        this.repeaterLogBody = document.getElementById('repeaterLogBody');

        this.connectBtn.onclick = () => this.connectBluetooth();
        this.serialBtn.onclick = () => this.connectSerial();

        this.hashContainer.addEventListener('click', e => {
            const btn = e.target.closest('.copy-hex-btn');
            if (!btn) return;
            navigator.clipboard.writeText(btn.dataset.hex).then(() => {
                btn.textContent = '✓';
                setTimeout(() => { btn.textContent = '⎘ hex'; }, 1000);
            });
        });
    }

    async connectBluetooth() {
        if (!navigator.bluetooth) {
            alert('Web Bluetooth API není dostupné.\n\nPožadavky:\n• Prohlížeč Chrome nebo Edge\n• Stránka musí běžet přes HTTPS nebo na localhost');
            return;
        }

        try {
            this.connectBtn.disabled = true;
            this.updateStatus('Připojování...', 'disconnected');

            const device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'Meshtastic' },
                    { namePrefix: 'MeshCore' }
                ],
                optionalServices: [
                    '6e400001-b5a3-f393-e0a9-e50e24dcca9e' // Nordic UART Service
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

            await this.sendAppStart('ble');

            this.updateStatus('Připojeno', 'connected');
            this.connectBtn.textContent = 'Odpojit';
            this.connectBtn.disabled = false;
            this.connectBtn.onclick = () => this.disconnect();

        } catch (error) {
            if (error.name !== 'NotFoundError') {
                console.error('Bluetooth error:', error);
                alert('Chyba při připojování: ' + error.message);
            }
            this.updateStatus('Odpojeno', 'disconnected');
            this.connectBtn.disabled = false;
        }
    }

    async connectSerial() {
        if (!navigator.serial) {
            alert('Web Serial API není dostupné.\n\nPožadavky:\n• Prohlížeč Chrome nebo Edge\n• Stránka musí běžet přes HTTPS nebo na localhost');
            return;
        }

        try {
            this.serialBtn.disabled = true;
            this.updateStatus('Připojování...', 'disconnected');

            this.serialPort = await navigator.serial.requestPort();
            await this.serialPort.open({ baudRate: 115200 });

            this.updateStatus('Připojeno (USB)', 'connected');
            this.serialBtn.textContent = 'Odpojit USB';
            this.serialBtn.disabled = false;
            this.serialBtn.onclick = () => this.disconnectSerial();

            await this.sendAppStart('serial');
            this.readSerialLoop();
        } catch (error) {
            if (error.name !== 'NotFoundError') {
                console.error('Serial error:', error);
                alert('Chyba při připojování USB: ' + error.message);
            }
            this.updateStatus('Odpojeno', 'disconnected');
            this.serialBtn.disabled = false;
        }
    }

    async readSerialLoop() {
        this.serialBuffer = new Uint8Array(0);
        this.serialReader = this.serialPort.readable.getReader();

        try {
            while (true) {
                const { value, done } = await this.serialReader.read();
                if (done) break;

                const merged = new Uint8Array(this.serialBuffer.length + value.length);
                merged.set(this.serialBuffer);
                merged.set(value, this.serialBuffer.length);
                this.serialBuffer = merged;

                this.tryDecodeSerialBuffer();
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Serial read error:', error);
            }
        } finally {
            this.serialReader.releaseLock();
            this.onSerialDisconnected();
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
        // Hash only from payload (path-independent) so same message via different routes groups together
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
        // Two independent FNV-1a passes → 16 hex chars, matches official app display format
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

        if (!this.hashData.has(hash)) {
            this.hashData.set(hash, {
                repeaters: new Map([[repeater, { count: 1, snr, rssi }]]),
                firstSeen: now,
                lastSeen: now,
                type,
                rawHex,
            });
            this.createHashBox(hash);
        } else {
            const data = this.hashData.get(hash);
            data.lastSeen = now;

            if (data.repeaters.has(repeater)) {
                const r = data.repeaters.get(repeater);
                data.repeaters.set(repeater, { count: r.count + 1, snr, rssi });
            } else {
                data.repeaters.set(repeater, { count: 1, snr, rssi });
            }

            this.updateHashBox(hash);
        }

        const existing = this.allRepeaters.get(repeater);
        this.allRepeaters.set(repeater, {
            lastSeen: now,
            count: (existing?.count ?? 0) + 1,
            lastSnr: snr,
            lastRssi: rssi,
        });
        this.updateRepeaterTable();

        this.updateStats();
        this.emptyState.classList.add('hidden');
    }

    updateRepeaterTable() {
        if (!this.repeaterLogBody) return;
        const sorted = Array.from(this.allRepeaters.entries())
            .sort((a, b) => b[1].lastSeen - a[1].lastSeen);
        this.repeaterLogBody.innerHTML = sorted.map(([repeater, d]) => {
            const sc = d.lastSnr  <    0 ? '#ffaaaa' : '#afa';
            const rc = d.lastRssi < -100 ? '#ffaaaa' : '#afa';
            return `<tr>
                <td class="rl-id">${repeater}</td>
                <td>${d.count}</td>
                <td style="color:${sc}">${d.lastSnr.toFixed(1)}</td>
                <td style="color:${rc}">${d.lastRssi}</td>
                <td>${this.formatTime(d.lastSeen)}</td>
            </tr>`;
        }).join('');
    }

    createHashBox(hash) {
        const data = this.hashData.get(hash);
        const box = document.createElement('div');
        box.className = 'hash-box';
        box.id = `hash-${hash}`;

        const lifetimeBar = document.createElement('div');
        lifetimeBar.className = 'lifetime-bar';
        lifetimeBar.style.width = '100%';

        box.innerHTML = `
            <div class="hash-header">
                <div class="hash-value">${this.truncateHash(hash)}</div>
                <div class="hash-meta">${data.type ? `<span class="msg-type">${data.type}</span>` : ''}<span class="timestamp">${this.formatTime(data.firstSeen)}</span></div>
            </div>
            <div class="repeater-list" id="repeaters-${hash}">
                ${this.renderRepeaters(data.repeaters)}
            </div>
            <button class="copy-hex-btn" data-hex="${data.rawHex}">⎘ hex</button>
        `;

        box.appendChild(lifetimeBar);
        this.hashContainer.prepend(box);
        this.animateLifetimeBar(hash, lifetimeBar);
    }

    updateHashBox(hash) {
        const data = this.hashData.get(hash);
        const repeaterList = document.getElementById(`repeaters-${hash}`);
        if (repeaterList) {
            repeaterList.innerHTML = this.renderRepeaters(data.repeaters);
        }
    }

    renderRepeaters(repeatersMap) {
        return Array.from(repeatersMap.entries())
            .sort((a, b) => b[1].rssi - a[1].rssi)
            .map(([repeater, { count, snr, rssi }]) => {
                const snrColor  = snr  <    0 ? '#ffaaaa' : '#afa';
                const rssiColor = rssi < -100 ? '#ffaaaa' : '#afa';
                return `
                <div class="repeater-tag">
                    ${repeater}
                    ${count > 1 ? `<span class="repeater-count">${count}x</span>` : ''}
                    <span class="signal-values">
                        <span style="color:${snrColor}">${snr.toFixed(1)}&thinsp;dB</span>
                        <span style="color:${rssiColor}">${rssi}&thinsp;dBm</span>
                    </span>
                </div>`;
            }).join('');
    }

    animateLifetimeBar(hash, barElement) {
        const startTime = Date.now();
        const updateBar = () => {
            const data = this.hashData.get(hash);
            if (!data) return;

            const elapsed = Date.now() - data.lastSeen;
            const remaining = Math.max(0, this.HASH_LIFETIME - elapsed);
            const percentage = (remaining / this.HASH_LIFETIME) * 100;

            barElement.style.width = percentage + '%';

            if (percentage > 0) {
                requestAnimationFrame(updateBar);
            }
        };
        updateBar();
    }

    startCleanupTimer() {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 10000);
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
            this.removeHashBox(hash);
            this.hashData.delete(hash);
        }

        if (toRemove.length > 0) {
            this.updateStats();
        }

        if (this.hashData.size === 0) {
            this.emptyState.classList.remove('hidden');
        }
    }

    removeHashBox(hash) {
        const box = document.getElementById(`hash-${hash}`);
        if (box) {
            box.classList.add('fading');
            setTimeout(() => box.remove(), 500);
        }
    }

    updateStats() {
        this.activeHashesEl.textContent = this.hashData.size;
        this.totalRxEl.textContent = this.totalRxCount;

        let totalUniqueRepeaters = new Set();
        for (const data of this.hashData.values()) {
            for (const repeater of data.repeaters.keys()) {
                totalUniqueRepeaters.add(repeater);
            }
        }
        this.totalRepeatersEl.textContent = totalUniqueRepeaters.size;
    }

    updateStatus(text, className) {
        this.statusEl.textContent = text;
        this.statusEl.className = `status ${className}`;
    }

    truncateHash(hash) {
        if (hash.length > 16) {
            return hash.substring(0, 8) + '...' + hash.substring(hash.length - 8);
        }
        return hash;
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('cs-CZ');
    }

    disconnect() {
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
        this.onDisconnected();
    }

    onDisconnected() {
        this.updateStatus('Odpojeno', 'disconnected');
        this.connectBtn.textContent = 'Připojit Bluetooth';
        this.connectBtn.disabled = false;
        this.connectBtn.onclick = () => this.connectBluetooth();
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new MeshCoreMonitor();
    });
} else {
    new MeshCoreMonitor();
}
