// 3D signal map: stitched map tiles laid as a floor in Three.js;
// each captured packet is a colored bead floating above its GPS location at a
// height proportional to RSSI.
//
// Two tile sources: Mapy.com (default, requires API key) and OpenStreetMap.

import * as THREE from 'https://esm.sh/three@0.160.0';
import { OrbitControls } from 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js';

const PLANE_SIZE     = 100;   // world units, longest plane edge
const MAX_HEIGHT     = 60;    // world units for strongest signal
const MIN_HEIGHT     = 2;     // world units for weakest signal
const RSSI_GOOD      = -50;
const RSSI_BAD       = -125;
const MAX_TILES_AXIS = 4;
const TILE_PX        = 256;

// Mapy.com tile API: path includes tile size (256) before z/x/y.
// Reference: https://developer.mapy.com/rest-api/maptiles/
const MAPYCOM_KEY = '8k8RZ_2rNYvfSzsufejwlKuBnnF0kYmPtfVDhSeBoiE';
const mapycomUrl = type => (z, x, y) =>
    `https://api.mapy.cz/v1/maptiles/${type}/256/${z}/${x}/${y}?apikey=${MAPYCOM_KEY}`;
const TILE_SOURCES = {
    'mapycom-basic':   { label: 'Mapy.com — Basic',             url: mapycomUrl('basic'),   attrib: '© Mapy.com' },
    'mapycom-outdoor': { label: 'Mapy.com — Outdoor (hiking)',   url: mapycomUrl('outdoor'), attrib: '© Mapy.com' },
    'mapycom-aerial':  { label: 'Mapy.com — Aerial (ortofoto)', url: mapycomUrl('aerial'),  attrib: '© Mapy.com' },
    'mapycom-winter':  { label: 'Mapy.com — Winter',             url: mapycomUrl('winter'),  attrib: '© Mapy.com' },
    'osm':             {
        label:  'OpenStreetMap',
        url:    (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
        attrib: '© OpenStreetMap contributors',
    },
    'opentopo':        {
        label:  'OpenTopoMap',
        url:    (z, x, y) => `https://tile.opentopomap.org/${z}/${x}/${y}.png`,
        attrib: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
    },
};
const DEFAULT_SOURCE = 'mapycom-basic';


function lonLatToTile(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const x = (lon + 180) / 360 * n;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
}

export class Signal3DMap {
    constructor(opts) {
        this.canvas    = opts.canvas;
        this.statusEl  = opts.statusEl;
        this.btnEl     = opts.btnEl;
        this.emptyEl   = opts.emptyEl;
        this.colorFor  = opts.colorFor  || (() => '#667eea');
        this.displayId = opts.displayId || (col => col);

        this.points       = [];     // { lat, lon, rssi, snr, col, time }
        this.userLoc      = null;
        this.watchId      = null;
        this.tileBounds   = null;   // { x0, y0, nx, ny, zoom }
        this.planeDim     = null;   // { w, h } in world units
        this.mapMesh      = null;
        this.userMarker   = null;
        this.lastBboxKey  = null;
        this._cameraFit   = false;
        this._mapBusy     = false;
        this.filterFn     = null;   // col => boolean, or null (show all)
        this.mapSource    = (opts.initialSource && TILE_SOURCES[opts.initialSource])
            ? opts.initialSource : DEFAULT_SOURCE;
        this.sphereSize   = (opts.initialSphereSize > 0) ? opts.initialSphereSize : 1.0;
        this._selectedCol = null;
        // Points / mesh handles — replaced per _repositionAll call
        this._ptsMeshLit  = null;   // THREE.Points for lit spheres (sprite texture)
        this._ptsMeshDim  = null;   // THREE.Points for dim spheres
        this._iMeshHit    = null;   // invisible InstancedMesh for raycasting only
        this._lineSegs    = null;   // all vertical lines as one LineSegments object
        this._iHitClusters = [];
        // Shared hit-test geometry & sphere sprite texture (created once)
        this._hitGeo      = new THREE.SphereGeometry(1, 6, 4);
        this._sphereTex   = this._makeSphereTex();
        this.infoEl       = opts.infoEl   || null;
        this.onSelect     = opts.onSelect || null;
        this.onFilter     = opts.onFilter || null;

        this._initScene();
        this._bindButton();
        this._checkInitialPermission();
    }

    _makeSphereTex() {
        const s = 64, cx = s / 2, cy = s / 2, r = s / 2 - 1;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = s;
        const ctx = canvas.getContext('2d');
        // Clip to circle
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
        // Base shading: lit from top-left, shadow bottom-right
        const shade = ctx.createRadialGradient(cx * 0.7, cy * 0.65, 0, cx, cy, r);
        shade.addColorStop(0,    'rgba(255,255,255,1)');   // highlight: full brightness
        shade.addColorStop(0.45, 'rgba(210,210,210,1)');   // lit side
        shade.addColorStop(0.8,  'rgba(130,130,130,1)');   // shadow side
        shade.addColorStop(1,    'rgba(70,70,70,1)');      // dark rim
        ctx.fillStyle = shade; ctx.fillRect(0, 0, s, s);
        // Soft specular spot
        const spec = ctx.createRadialGradient(cx * 0.58, cy * 0.52, 0, cx * 0.58, cy * 0.52, r * 0.32);
        spec.addColorStop(0,   'rgba(255,255,255,0.7)');
        spec.addColorStop(0.5, 'rgba(255,255,255,0.2)');
        spec.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.fillStyle = spec; ctx.fillRect(0, 0, s, s);
        return new THREE.CanvasTexture(canvas);
    }

    // ---- Scene setup ----

    _initScene() {
        const canvas = this.canvas;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this.renderer.setClearColor(0xeef2f7);

        const w = Math.max(1, canvas.clientWidth);
        const h = Math.max(1, canvas.clientHeight);
        this.renderer.setSize(w, h, false);

        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
        this.camera.position.set(70, 90, 110);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.target.set(0, MAX_HEIGHT * 0.25, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
        this.controls.minDistance   = 20;
        this.controls.maxDistance   = 600;
        this.controls.update();

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const dl = new THREE.DirectionalLight(0xffffff, 0.45);
        dl.position.set(60, 180, 80);
        this.scene.add(dl);

        // Placeholder floor until tiles arrive
        const phGeo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
        const phMat = new THREE.MeshBasicMaterial({ color: 0xdcdcdc });
        this.mapMesh = new THREE.Mesh(phGeo, phMat);
        this.mapMesh.rotation.x = -Math.PI / 2;
        this.scene.add(this.mapMesh);
        this.planeDim = { w: PLANE_SIZE, h: PLANE_SIZE };

        this.pointsGroup = new THREE.Group();
        this.scene.add(this.pointsGroup);

        this._raycaster = new THREE.Raycaster();

        // Distinguish click from drag: track pointer displacement
        let _ptrStart = null;
        canvas.addEventListener('pointerdown', e => { _ptrStart = { x: e.clientX, y: e.clientY }; });
        canvas.addEventListener('click', e => {
            if (!_ptrStart) return;
            const dx = e.clientX - _ptrStart.x;
            const dy = e.clientY - _ptrStart.y;
            _ptrStart = null;
            if (Math.sqrt(dx * dx + dy * dy) > 5) return; // drag, not click
            this._onCanvasClick(e);
        });

        this._onResize = () => this._resize();
        window.addEventListener('resize', this._onResize);
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(canvas);

        if (this.infoEl) {
            this.infoEl.addEventListener('click', e => {
                if (e.target.closest('.smi-close')) {
                    this._selectedCol = null;
                    this._repositionAll();
                    this._updateInfoPanel();
                    this.onSelect?.(null);
                } else if (e.target.closest('.smi-filter')) {
                    this.onFilter?.(this._selectedCol);
                }
            });
        }

        const tick = () => {
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
            this._rafId = requestAnimationFrame(tick);
        };
        tick();
    }

    _resize() {
        const w = Math.max(1, this.canvas.clientWidth);
        const h = Math.max(1, this.canvas.clientHeight);
        if (w === this._lastW && h === this._lastH) return;
        this._lastW = w; this._lastH = h;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    // ---- Geolocation ----

    async _checkInitialPermission() {
        if (!('geolocation' in navigator)) {
            this._setStatus('Geolocation not supported in this browser.');
            if (this.btnEl) { this.btnEl.disabled = true; this.btnEl.textContent = 'Not supported'; }
            return;
        }
        if (!navigator.permissions) return;
        try {
            const p = await navigator.permissions.query({ name: 'geolocation' });
            const apply = () => {
                if (p.state === 'granted') {
                    if (!this.watchId) this.startWatching();
                } else if (p.state === 'denied') {
                    this._setStatus('Location denied — allow it in browser settings to use the 3D map.');
                    if (this.btnEl) { this.btnEl.disabled = true; this.btnEl.textContent = 'Location denied'; }
                } else {
                    this._setStatus('Location not enabled.');
                }
            };
            apply();
            p.addEventListener?.('change', apply);
        } catch { /* permissions API may not support 'geolocation' on some platforms */ }
    }

    _bindButton() {
        if (!this.btnEl) return;
        this.btnEl.addEventListener('click', () => this.startWatching());
    }

    _setStatus(text) {
        if (this.statusEl) this.statusEl.textContent = text;
    }

    startWatching() {
        if (!('geolocation' in navigator) || this.watchId != null) return;
        this._setStatus('Requesting location… (allow in browser if prompted)');
        if (this.btnEl) this.btnEl.disabled = true;
        let resolved = false;
        const failTimer = setTimeout(() => {
            if (!resolved) {
                this._setStatus('No response from browser — check location permissions or browser shields (e.g. Brave).');
                if (this.btnEl) { this.btnEl.disabled = false; this.btnEl.classList.remove('hidden'); }
                navigator.geolocation.clearWatch(this.watchId);
                this.watchId = null;
            }
        }, 10000);
        this.watchId = navigator.geolocation.watchPosition(
            pos => {
                resolved = true;
                clearTimeout(failTimer);
                if (this.btnEl) this.btnEl.classList.add('hidden');
                const { latitude, longitude, accuracy } = pos.coords;
                this.userLoc = { lat: latitude, lon: longitude, accuracy };
                this._setStatus(`📍 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}  (±${Math.round(accuracy)} m)`);
                if (this.emptyEl && !this.points.length) {
                    this.emptyEl.textContent = 'Waiting for packets to populate the 3D map.';
                }
                this._scheduleMapUpdate();
                this._updateUserMarker();
            },
            err => {
                resolved = true;
                clearTimeout(failTimer);
                this._setStatus(`Location error: ${err.message}`);
                if (this.btnEl) { this.btnEl.disabled = false; this.btnEl.classList.remove('hidden'); }
                this.watchId = null;
            },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
        );
    }

    currentLocation() {
        return this.userLoc;
    }

    // ---- Filter ----

    // Pass col => boolean to show only matching repeaters; null to show all.
    // Migrate stored points/state when the main app renames a repeater column
    // (e.g. promotion or demote-to-collision). Without this, beads would
    // keep the stale col and lose their selection / color sync.
    renameCol(oldCol, newCol) {
        if (oldCol === newCol) return;
        for (const p of this.points) {
            if (p.col === oldCol) p.col = newCol;
        }
        if (this._selectedCol === oldCol) {
            this._selectedCol = newCol;
            this._updateInfoPanel();
        }
        this._repositionAll();
    }

    // For un-merging a previously-promoted column. classifier(rawId) returns
    // a new col to migrate the point to, or null/undefined to leave it.
    splitPoints(oldCol, classifier) {
        let touched = false;
        for (const p of this.points) {
            if (p.col !== oldCol) continue;
            const target = classifier(p.rawId);
            if (target && target !== oldCol) {
                p.col = target;
                touched = true;
            }
        }
        if (touched) {
            if (this._selectedCol === oldCol) {
                this._selectedCol = null;
                this._updateInfoPanel();
            }
            this._repositionAll();
        }
    }

    setFilterFn(fn) {
        this.filterFn = fn;
        // If the currently selected repeater is now filtered out, deselect it
        if (this._selectedCol && fn && !fn(this._selectedCol)) {
            this._selectedCol = null;
            this._updateInfoPanel();
            this.onSelect?.(null);
        }
        this._repositionAll();
    }

    // ---- Click / selection ----

    _onCanvasClick(e) {
        const rect  = this.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width)  * 2 - 1,
            -((e.clientY - rect.top)  / rect.height) * 2 + 1
        );
        this._raycaster.setFromCamera(mouse, this.camera);
        let newCol = null;
        if (this._iMeshHit) {
            const hits = this._raycaster.intersectObject(this._iMeshHit);
            if (hits.length > 0) {
                const c = this._iHitClusters[hits[0].instanceId];
                if (c) newCol = (this._selectedCol === c.col) ? null : c.col;
            }
        }
        this._selectedCol = newCol;
        this._repositionAll();
        this._updateInfoPanel();
        this.onSelect?.(newCol);
    }

    _updateInfoPanel() {
        if (!this.infoEl) return;
        const col = this._selectedCol;
        if (!col) { this.infoEl.classList.add('hidden'); return; }
        const pts = this.points.filter(p => p.col === col);
        if (!pts.length) { this.infoEl.classList.add('hidden'); return; }
        const maxRssi = Math.max(...pts.map(p => p.rssi));
        const maxSnr  = Math.max(...pts.map(p => p.snr ?? -Infinity));
        const last    = pts[pts.length - 1];
        const color   = this.colorFor(col);
        const dot     = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;flex-shrink:0"></span>`;
        const fSnr    = v => v != null && isFinite(v) ? `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}` : '—';
        this.infoEl.innerHTML =
            `<button class="smi-close" title="Deselect">✕</button>` +
            `<div class="smi-name">${dot}<b>${this._escHtml(this.displayId(col))}</b><span class="smi-count">${pts.length} pkt${pts.length !== 1 ? 's' : ''}</span></div>` +
            `<div class="smi-stat">RSSI: best <b>${maxRssi}</b>, last <b>${last.rssi}</b> dBm</div>` +
            `<div class="smi-stat">SNR: best <b>${fSnr(maxSnr)}</b>, last <b>${fSnr(last.snr)}</b> dB</div>` +
            (this.onFilter ? `<button class="smi-filter">Filter</button>` : '');
        this.infoEl.classList.remove('hidden');
    }

    _escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- Map source ----

    clearPoints() {
        this.points = [];
        this._selectedCol = null;
        this._disposeInstanced();
        this._updateInfoPanel();
        this.onSelect?.(null);
        if (this.emptyEl) {
            this.emptyEl.classList.remove('hidden');
            this.emptyEl.textContent = 'Waiting for packets to populate the 3D map.';
        }
    }

    setSphereSize(n) {
        if (n === this.sphereSize) return;
        this.sphereSize = n;
        this._repositionAll();
    }

    setMapSource(source) {
        if (!TILE_SOURCES[source] || source === this.mapSource) return;
        this.mapSource = source;
        // Force a tile reload on next update
        this.lastBboxKey = null;
        this._scheduleMapUpdate();
    }

    availableSources() {
        return Object.entries(TILE_SOURCES).map(([id, s]) => ({ id, label: s.label }));
    }

    // ---- Packet ingestion ----

    addPacket(opts) {
        if (opts.lat == null || opts.lon == null || opts.rssi == null) return;
        this.points.push({ ...opts });
        if (this.emptyEl) this.emptyEl.classList.add('hidden');
        if (opts.col === this._selectedCol) this._updateInfoPanel();
        this._repositionAll();
        this._scheduleMapUpdate();   // reload tiles if point moved out of bounds (slow, debounced)
    }

    // Called by the host app when chart/legend selection changes.
    selectColumn(col) {
        if (this._selectedCol === col) return;
        this._selectedCol = col ?? null;
        this._repositionAll();
        this._updateInfoPanel();
    }

    // Drop packets older than the given timestamp. Disposes their meshes and
    // refreshes selection / info panel if the active repeater goes away.
    purgeOlderThan(cutoff) {
        if (!Number.isFinite(cutoff)) return;
        const before = this.points.length;
        this.points = this.points.filter(p => p.time >= cutoff);
        if (this.points.length === before) return;
        if (this._selectedCol && !this.points.some(p => p.col === this._selectedCol)) {
            this._selectedCol = null;
            this._updateInfoPanel();
            this.onSelect?.(null);
        }
        this._repositionAll();
    }

    _scheduleMapUpdate() {
        clearTimeout(this._mapTimer);
        this._mapTimer = setTimeout(() => this._updateMap(), 500);
    }

    _bbox() {
        const locs = this.points.map(p => ({ lat: p.lat, lon: p.lon }));
        if (this.userLoc) locs.push({ lat: this.userLoc.lat, lon: this.userLoc.lon });
        if (!locs.length) return null;
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (const l of locs) {
            if (l.lat < minLat) minLat = l.lat;
            if (l.lat > maxLat) maxLat = l.lat;
            if (l.lon < minLon) minLon = l.lon;
            if (l.lon > maxLon) maxLon = l.lon;
        }
        return { minLat, maxLat, minLon, maxLon };
    }

    async _updateMap() {
        if (this._mapBusy) { this._scheduleMapUpdate(); return; }
        const bb = this._bbox();
        if (!bb) return;

        // Only pad when bbox has zero extent (single point) — otherwise the
        // +1 tile margin below already gives plenty of context, and bbox
        // padding here would only shrink the data area on screen.
        let { minLat, maxLat, minLon, maxLon } = bb;
        const padLat = (maxLat - minLat) || 0.0008;
        const padLon = (maxLon - minLon) || 0.0008;
        if (maxLat === minLat) { minLat -= padLat / 2; maxLat += padLat / 2; }
        if (maxLon === minLon) { minLon -= padLon / 2; maxLon += padLon / 2; }

        let zoom = 19;
        let tl, br;
        while (zoom > 1) {
            tl = lonLatToTile(minLon, maxLat, zoom);
            br = lonLatToTile(maxLon, minLat, zoom);
            const tx = Math.floor(br.x) - Math.floor(tl.x) + 1;
            const ty = Math.floor(br.y) - Math.floor(tl.y) + 1;
            if (tx <= MAX_TILES_AXIS && ty <= MAX_TILES_AXIS) break;
            zoom--;
        }

        const maxTile = Math.pow(2, zoom) - 1;
        const x0 = Math.max(0, Math.floor(tl.x) - 2);
        const y0 = Math.max(0, Math.floor(tl.y) - 2);
        const x1 = Math.min(maxTile, Math.floor(br.x) + 2);
        const y1 = Math.min(maxTile, Math.floor(br.y) + 2);
        const nx = x1 - x0 + 1;
        const ny = y1 - y0 + 1;

        const sourceId = this.mapSource;
        const key = `${sourceId}/${zoom}/${x0}/${y0}/${x1}/${y1}`;
        if (key === this.lastBboxKey) {
            this._updateUserMarker();  // tiles unchanged — just move the user pin
            return;
        }

        this._mapBusy = true;
        try {
            const tileCanvas = document.createElement('canvas');
            tileCanvas.width  = nx * TILE_PX;
            tileCanvas.height = ny * TILE_PX;
            const ctx = tileCanvas.getContext('2d');
            ctx.fillStyle = '#dfdfdf';
            ctx.fillRect(0, 0, tileCanvas.width, tileCanvas.height);

            const src = TILE_SOURCES[sourceId];
            const tasks = [];
            for (let dx = 0; dx < nx; dx++) {
                for (let dy = 0; dy < ny; dy++) {
                    tasks.push(new Promise(res => {
                        const img = new Image();
                        img.crossOrigin = 'anonymous';
                        img.onload  = () => { ctx.drawImage(img, dx * TILE_PX, dy * TILE_PX); res(); };
                        img.onerror = () => res();
                        img.src = src.url(zoom, x0 + dx, y0 + dy);
                    }));
                }
            }
            await Promise.all(tasks);

            const attrib = src.attrib;
            ctx.font = '11px system-ui, sans-serif';
            const tw = ctx.measureText(attrib).width;
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.fillRect(tileCanvas.width - tw - 10, tileCanvas.height - 17, tw + 8, 15);
            ctx.fillStyle = '#333';
            ctx.fillText(attrib, tileCanvas.width - tw - 6, tileCanvas.height - 6);

            const texture = new THREE.CanvasTexture(tileCanvas);
            texture.colorSpace  = THREE.SRGBColorSpace;
            texture.minFilter   = THREE.LinearFilter;
            texture.anisotropy  = this.renderer.capabilities.getMaxAnisotropy();
            texture.needsUpdate = true;

            const aspect = nx / ny;
            const planeW = aspect >= 1 ? PLANE_SIZE : PLANE_SIZE * aspect;
            const planeH = aspect >= 1 ? PLANE_SIZE / aspect : PLANE_SIZE;

            if (this.mapMesh) {
                this.scene.remove(this.mapMesh);
                this.mapMesh.geometry.dispose();
                this.mapMesh.material.map?.dispose?.();
                this.mapMesh.material.dispose();
            }
            const geo = new THREE.PlaneGeometry(planeW, planeH);
            const mat = new THREE.MeshBasicMaterial({ map: texture });
            this.mapMesh = new THREE.Mesh(geo, mat);
            this.mapMesh.rotation.x = -Math.PI / 2;
            this.scene.add(this.mapMesh);

            this.tileBounds  = { x0, y0, nx, ny, zoom };
            this.planeDim    = { w: planeW, h: planeH };
            this.lastBboxKey = key;

            this._repositionAll();
            this._updateUserMarker();
            this._fitCameraOnce();
        } finally {
            this._mapBusy = false;
        }
    }

    _fitCameraOnce() {
        if (this._cameraFit) return;
        const { w, h } = this.planeDim;
        const r = Math.max(w, h);
        this.camera.position.set(r * 0.4, r * 0.55, r * 0.6);
        this.controls.target.set(0, MAX_HEIGHT * 0.3, 0);
        this.controls.update();
        this._cameraFit = true;
    }

    _latLonToWorld(lat, lon) {
        if (!this.tileBounds || !this.planeDim) return null;
        const { x0, y0, nx, ny, zoom } = this.tileBounds;
        const t  = lonLatToTile(lon, lat, zoom);
        const fx = (t.x - x0) / nx;
        const fy = (t.y - y0) / ny;
        const { w, h } = this.planeDim;
        return new THREE.Vector3((fx - 0.5) * w, 0, (fy - 0.5) * h);
    }

    _rssiToHeight(rssi) {
        const t = (rssi - RSSI_BAD) / (RSSI_GOOD - RSSI_BAD);
        return MIN_HEIGHT + Math.max(0, Math.min(1, t)) * (MAX_HEIGHT - MIN_HEIGHT);
    }

    _disposeInstanced() {
        for (const obj of [this._ptsMeshLit, this._ptsMeshDim, this._iMeshHit, this._lineSegs]) {
            if (!obj) continue;
            this.pointsGroup.remove(obj);
            obj.material?.dispose();
            if (obj !== this._iMeshHit) obj.geometry?.dispose();
        }
        this._ptsMeshLit = null;
        this._ptsMeshDim = null;
        this._iMeshHit   = null;
        this._lineSegs   = null;
        this._iHitClusters = [];
    }

    _repositionAll() {
        this._disposeInstanced();
        if (!this.tileBounds) return;

        const sel     = this._selectedCol;
        const visible = this.filterFn ? this.points.filter(p => this.filterFn(p.col)) : this.points;
        if (!visible.length) return;

        const litPts = sel ? visible.filter(p => p.col === sel) : visible;
        const dimPts = sel ? visible.filter(p => p.col !== sel) : [];

        const _m4 = new THREE.Matrix4(), _v = new THREE.Vector3();
        const _s  = new THREE.Vector3(), _q = new THREE.Quaternion();
        const _col = new THREE.Color();

        // Build a THREE.Points object for a set of data points
        const makePoints = (pts, opacity, sizeMult) => {
            const pos = new Float32Array(pts.length * 3);
            const col = new Float32Array(pts.length * 3);
            for (let i = 0; i < pts.length; i++) {
                const p  = pts[i];
                const wp = this._latLonToWorld(p.lat, p.lon);
                pos[i*3]   = wp ? wp.x : 0;
                pos[i*3+1] = wp ? this._rssiToHeight(p.rssi) : 0;
                pos[i*3+2] = wp ? wp.z : 0;
                _col.set(this.colorFor(p.col));
                col[i*3] = _col.r; col[i*3+1] = _col.g; col[i*3+2] = _col.b;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
            return new THREE.Points(geo, new THREE.PointsMaterial({
                map:             this._sphereTex,
                size:            this.sphereSize * sizeMult,
                sizeAttenuation: true,
                vertexColors:    true,
                transparent:     true,
                opacity,
                depthWrite:      false,
                alphaTest:       0.02,
            }));
        };

        if (litPts.length) {
            this._ptsMeshLit = makePoints(litPts, 1.0, sel ? 3.6 : 2.0);
            this.pointsGroup.add(this._ptsMeshLit);
        }
        if (dimPts.length) {
            this._ptsMeshDim = makePoints(dimPts, 0.07, 2.0);
            this.pointsGroup.add(this._ptsMeshDim);
        }

        // Invisible InstancedMesh for raycasting (stays separate from visual rendering)
        this._iHitClusters = visible;
        this._iMeshHit = new THREE.InstancedMesh(
            this._hitGeo,
            new THREE.MeshBasicMaterial({ visible: false }),
            visible.length
        );
        for (let i = 0; i < visible.length; i++) {
            const p   = visible[i];
            const pos = this._latLonToWorld(p.lat, p.lon);
            if (!pos) { _m4.makeScale(0, 0, 0); this._iMeshHit.setMatrixAt(i, _m4); continue; }
            const h  = this._rssiToHeight(p.rssi);
            const hr = this.sphereSize + 1.8;
            _m4.compose(_v.set(pos.x, h, pos.z), _q, _s.set(hr, hr, hr));
            this._iMeshHit.setMatrixAt(i, _m4);
        }
        this._iMeshHit.instanceMatrix.needsUpdate = true;
        this.pointsGroup.add(this._iMeshHit);

        // All vertical lines as one LineSegments draw call
        const n    = visible.length;
        const lPos = new Float32Array(n * 6);
        const lCol = new Float32Array(n * 6);
        for (let i = 0; i < n; i++) {
            const p   = visible[i];
            const pos = this._latLonToWorld(p.lat, p.lon);
            if (!pos) continue;
            const h = this._rssiToHeight(p.rssi);
            _col.set(this.colorFor(p.col));
            const f = (!sel || sel === p.col) ? 1 : 0.15;
            const j = i * 6;
            lPos[j]   = pos.x; lPos[j+1] = 0; lPos[j+2] = pos.z;
            lPos[j+3] = pos.x; lPos[j+4] = h; lPos[j+5] = pos.z;
            lCol[j]   = _col.r * f; lCol[j+1] = _col.g * f; lCol[j+2] = _col.b * f;
            lCol[j+3] = _col.r * f; lCol[j+4] = _col.g * f; lCol[j+5] = _col.b * f;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(lPos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(lCol, 3));
        const lineOpacity = Math.min(1, 0.25 + 0.35 * this.sphereSize);
        this._lineSegs = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: lineOpacity < 1,
            opacity: lineOpacity,
        }));
        this.pointsGroup.add(this._lineSegs);
    }

    _updateUserMarker() {
        if (!this.userLoc || !this.tileBounds) return;
        const pos = this._latLonToWorld(this.userLoc.lat, this.userLoc.lon);
        if (!pos) return;
        if (!this.userMarker) {
            const group = new THREE.Group();
            const cone = new THREE.Mesh(
                new THREE.ConeGeometry(1.8, 5, 14),
                new THREE.MeshBasicMaterial({ color: 0xff3355 })
            );
            cone.position.y = 2.5;
            group.add(cone);
            const base = new THREE.Mesh(
                new THREE.CircleGeometry(2.6, 24),
                new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.35 })
            );
            base.rotation.x = -Math.PI / 2;
            base.position.y = 0.05;
            group.add(base);
            this.userMarker = group;
            this.scene.add(this.userMarker);
        }
        this.userMarker.position.set(pos.x, 0, pos.z);
    }

    // ---- Lifecycle ----

    dispose() {
        if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
        cancelAnimationFrame(this._rafId);
        window.removeEventListener('resize', this._onResize);
        this._ro?.disconnect();
        this.renderer.dispose();
    }
}
