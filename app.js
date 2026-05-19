// MeshCore RX Monitor Application
import { MeshCoreDecoder } from 'https://esm.sh/@michaelhart/meshcore-decoder';

class MeshCoreMonitor {
    constructor() {
        this.device = null;
        this.serialPort = null;
        this.serialReader = null;
        this.serialBuffer = new Uint8Array(0);
        this.hashData = new Map();
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

        this.connectBtn.onclick = () => this.connectBluetooth();
        this.serialBtn.onclick = () => this.connectSerial();
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

            const txCharacteristic = await service.getCharacteristic(NUS_TX);
            await txCharacteristic.startNotifications();
            txCharacteristic.addEventListener('characteristicvaluechanged', (event) => this.handleData(event));

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
        if (this.serialBuffer.length === 0) return;

        const text = new TextDecoder().decode(this.serialBuffer);

        // Log complete lines so we can see the format
        const newlineIdx = text.lastIndexOf('\n');
        if (newlineIdx !== -1) {
            console.log('[serial]', text.substring(0, newlineIdx));
        }

        try {
            const hexData = this.bufferToHex(this.serialBuffer.buffer);
            const packet = MeshCoreDecoder.decode(hexData);
            if (packet.isValid) {
                this.processPacket(packet);
                this.serialBuffer = new Uint8Array(0);
            }
        } catch (e) {
            if (this.serialBuffer.length > 4096) {
                this.serialBuffer = new Uint8Array(0);
            }
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
        const value = event.target.value;

        try {
            const hexData = this.bufferToHex(value.buffer);
            const packet = MeshCoreDecoder.decode(hexData);
            if (packet.isValid) {
                this.processPacket(packet);
            }
        } catch (error) {
            console.error('Error processing data:', error);
        }
    }

    bufferToHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    processPacket(packet) {
        const hash = packet.messageHash;
        const repeater = this.extractRepeater(packet);

        if (hash && repeater) {
            this.addRxEntry(hash, repeater);
        }
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

    addRxEntry(hash, repeater) {
        this.totalRxCount++;
        const now = Date.now();

        if (!this.hashData.has(hash)) {
            // Nový hash
            this.hashData.set(hash, {
                repeaters: new Map([[repeater, 1]]),
                firstSeen: now,
                lastSeen: now
            });
            this.createHashBox(hash);
        } else {
            // Existující hash
            const data = this.hashData.get(hash);
            data.lastSeen = now;

            if (data.repeaters.has(repeater)) {
                data.repeaters.set(repeater, data.repeaters.get(repeater) + 1);
            } else {
                data.repeaters.set(repeater, 1);
            }

            this.updateHashBox(hash);
        }

        this.updateStats();
        this.emptyState.classList.add('hidden');
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
                <div class="timestamp">${this.formatTime(data.firstSeen)}</div>
            </div>
            <div class="repeaters-label">Repeaters:</div>
            <div class="repeater-list" id="repeaters-${hash}">
                ${this.renderRepeaters(data.repeaters)}
            </div>
        `;

        box.appendChild(lifetimeBar);
        this.hashContainer.prepend(box);

        // Start animating lifetime bar
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
            .sort((a, b) => b[1] - a[1]) // Seřadit podle počtu
            .map(([repeater, count]) => `
                <div class="repeater-tag">
                    ${repeater}
                    ${count > 1 ? `<span class="repeater-count">${count}x</span>` : ''}
                </div>
            `).join('');
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
        }, 10000); // Kontrola každých 10 sekund
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
