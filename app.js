// MeshCore RX Monitor Application

class MeshCoreMonitor {
    constructor() {
        this.device = null;
        this.characteristic = null;
        this.hashData = new Map(); // hash -> { repeaters: Map(repeater -> count), firstSeen: timestamp, lastSeen: timestamp }
        this.totalRxCount = 0;
        this.HASH_LIFETIME = 300000; // 5 minut (300 000 ms)
        this.cleanupInterval = null;

        this.initUI();
        this.startCleanupTimer();
    }

    initUI() {
        this.connectBtn = document.getElementById('connectBtn');
        this.statusEl = document.getElementById('status');
        this.hashContainer = document.getElementById('hashContainer');
        this.emptyState = document.getElementById('emptyState');
        this.activeHashesEl = document.getElementById('activeHashes');
        this.totalRxEl = document.getElementById('totalRx');
        this.totalRepeatersEl = document.getElementById('totalRepeaters');

        this.connectBtn.addEventListener('click', () => this.connectBluetooth());
    }

    async connectBluetooth() {
        try {
            this.connectBtn.disabled = true;
            this.updateStatus('Připojování...', 'disconnected');

            // Request Bluetooth device
            // MeshCore uses Nordic UART Service (NUS)
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

            const server = await device.gatt.connect();
            const service = await server.getPrimaryService('6e400001-b5a3-f393-e0a9-e50e24dcca9e');

            // TX characteristic (device sends data to us)
            const txCharacteristic = await service.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e');

            // Start notifications
            await txCharacteristic.startNotifications();
            txCharacteristic.addEventListener('characteristicvaluechanged', (event) => this.handleData(event));

            this.updateStatus('Připojeno', 'connected');
            this.connectBtn.textContent = 'Odpojit';
            this.connectBtn.disabled = false;
            this.connectBtn.onclick = () => this.disconnect();

        } catch (error) {
            console.error('Bluetooth error:', error);
            alert('Chyba při připojování: ' + error.message);
            this.updateStatus('Odpojeno', 'disconnected');
            this.connectBtn.disabled = false;
        }
    }

    handleData(event) {
        const value = event.target.value;

        try {
            const decoder = new TextDecoder();
            const text = decoder.decode(value);
            this.parseRxLog(text);
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
        // Extrahujeme hash a repeater z dekódovaného paketu
        // Packet obsahuje strukturované informace o zprávě
        console.log('Decoded packet:', packet);

        // Hash paketu - používáme packet ID nebo hash pokud je dostupný
        const hash = packet.id?.toString(16) || packet.hash || this.generatePacketHash(packet);

        // Repeater - poslední node v routing path nebo from address
        const repeater = this.extractRepeater(packet);

        if (hash && repeater) {
            this.addRxEntry(hash, repeater);
        }
    }

    generatePacketHash(packet) {
        // Generujeme hash z důležitých částí paketu
        const hashSource = JSON.stringify({
            id: packet.id,
            from: packet.from,
            to: packet.to,
            payload: packet.payload?.slice(0, 16) // První 16 bytů payload
        });

        // Jednoduchý hash funkce
        let hash = 0;
        for (let i = 0; i < hashSource.length; i++) {
            const char = hashSource.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16).padStart(8, '0');
    }

    extractRepeater(packet) {
        // Snažíme se získat ID posledního repeateru
        if (packet.route && packet.route.length > 0) {
            // Poslední node v routě
            const lastNode = packet.route[packet.route.length - 1];
            return this.formatNodeId(lastNode);
        }

        if (packet.from) {
            return this.formatNodeId(packet.from);
        }

        if (packet.via) {
            return this.formatNodeId(packet.via);
        }

        return 'direct';
    }

    formatNodeId(nodeId) {
        // Formátujeme node ID do čitelné podoby
        if (typeof nodeId === 'number') {
            return '!' + nodeId.toString(16).padStart(8, '0');
        }
        return nodeId?.toString() || 'unknown';
    }

    parseRxLog(logText) {
        // Fallback text parsing pro případ, že data nejsou binární packet
        const lines = logText.split('\n');

        for (const line of lines) {
            if (!line.toLowerCase().includes('rx')) continue;

            let hash = null;
            let repeater = null;

            // Varianta 1: hash=XXX via=YYY
            let match = line.match(/hash[=:]?\s*([a-fA-F0-9]+).*?via[=:]?\s*([a-zA-Z0-9_!-]+)/i);
            if (match) {
                hash = match[1];
                repeater = match[2];
            }

            // Varianta 2: id=XXX from=YYY
            if (!match) {
                match = line.match(/(?:id|packet)[=:]?\s*([a-fA-F0-9]+).*?(?:from|via)[=:]?\s*([a-zA-Z0-9_!-]+)/i);
                if (match) {
                    hash = match[1];
                    repeater = match[2];
                }
            }

            // Varianta 3: hex hash a node ID ve formátu !XXXXXXXX
            if (!match) {
                const hashMatch = line.match(/([a-fA-F0-9]{6,})/);
                const nodeMatch = line.match(/!([a-fA-F0-9]{8})/);
                if (hashMatch && nodeMatch) {
                    hash = hashMatch[1];
                    repeater = '!' + nodeMatch[1];
                }
            }

            if (hash && repeater) {
                this.addRxEntry(hash, repeater);
            }
        }
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
