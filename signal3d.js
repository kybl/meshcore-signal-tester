// 3D signal map: stitched map tiles laid as a floor in Three.js;
// each captured packet is a colored bead floating above its GPS location at a
// height proportional to RSSI.
//
// Two tile sources: Mapy.com (default, requires API key) and OpenStreetMap.

import * as THREE from 'https://esm.sh/three@0.160.0';
import { MapControls } from 'https://esm.sh/three@0.160.0/examples/jsm/controls/MapControls.js';

const PLANE_SIZE     = 100;   // world units, longest plane edge
const MAX_HEIGHT     = 12;    // world units for strongest signal
const MIN_HEIGHT     = 2;     // world units for weakest signal
const SNR_GOOD       = 12;    // dB — excellent signal
const SNR_BAD        = -20;   // dB — minimum decodable (LoRa SF12)
const MAX_TILES_AXIS = 4;
const TILE_PX        = 256;
// Reference camera distance: distance from origin when camera is at the initial
// fit position (0.4r, 0.55r, 0.6r) with r = PLANE_SIZE.  Derived once so that
// height/size scales are purely a function of current camera distance and never
// depend on when the first tile load happened.
const CAMERA_REF_DIST = PLANE_SIZE * Math.sqrt(0.4*0.4 + 0.55*0.55 + 0.6*0.6); // ≈ 90.7

// Mapy.com tile API: path includes tile size (256) before z/x/y.
// Reference: https://developer.mapy.com/rest-api/maptiles/
const MAPYCOM_KEY = '8k8RZ_2rNYvfSzsufejwlKuBnnF0kYmPtfVDhSeBoiE';
const mapycomUrl = type => (z, x, y) =>
    `https://api.mapy.cz/v1/maptiles/${type}/256/${z}/${x}/${y}?apikey=${MAPYCOM_KEY}`;
const TILE_SOURCES = {
    'mapycom-basic':   { label: 'Mapy.com — Basic',             url: mapycomUrl('basic'),   attrib: '© Mapy.com' },
    'mapycom-outdoor': { label: 'Mapy.com — Outdoor (hiking)',   url: mapycomUrl('outdoor'), attrib: '© Mapy.com' },
    'mapycom-aerial':  { label: 'Mapy.com — Aerial (orthophoto)', url: mapycomUrl('aerial'),  attrib: '© Mapy.com' },
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

function tileToLatLon(tx, ty, zoom) {
    const n = Math.pow(2, zoom);
    const lon = tx / n * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
    return { lat, lon };
}

export class Signal3DMap {
    constructor(opts) {
        this.canvas    = opts.canvas;
        this.statusEl  = opts.statusEl;
        this.btnEl     = opts.btnEl;
        this.emptyEl   = opts.emptyEl;
        this.colorFor  = opts.colorFor  || (() => '#667eea');
        this.displayId = opts.displayId || (col => col);
        this.nameForCol = opts.nameForCol || null;

        this.points       = [];     // { lat, lon, rssi, snr, col, time }
        this._staticMarkers     = [];   // { lat, lon, name, color }
        this._staticMarkerMeshes = [];
        this.userLoc      = null;
        this.watchId      = null;
        this.tileBounds   = null;   // { x0, y0, nx, ny, zoom }
        this.planeDim     = null;   // { w, h } in world units
        this.mapMesh      = null;
        this.userMarker   = null;
        this.lastBboxKey  = null;
        this._cameraFit   = false;
        this._mapBusy     = false;
        this.overlayMesh  = null;
        this._overlayBusy = false;
        this._overlayKey  = null;
        this.filterFn     = null;   // col => boolean, or null (show all)
        this._displayCutoff = 0;    // timestamp ms; 0 = no filter
        this.mapSource    = (opts.initialSource && TILE_SOURCES[opts.initialSource])
            ? opts.initialSource : DEFAULT_SOURCE;
        this.sphereSize   = (opts.initialSphereSize > 0) ? opts.initialSphereSize : 1.0;
        this._showLines   = opts.showLines !== false;
        this._showMarker  = opts.showMarker !== false;
        this._clusterRadius = (opts.initialClusterRadius > 0) ? opts.initialClusterRadius : 0; // metres; 0 = off
        this._selectedCol = null;
        this._heightMode  = opts.initialHeightMode || 'spires';
        this._perspSize   = opts.initialPerspSize !== false; // default on
        // Points / mesh handles — replaced per _repositionAll call
        this._ptsMeshes   = [];     // THREE.Points for spheres (sprite texture), one or more per call
        this._iMeshHit    = null;   // invisible InstancedMesh for raycasting only
        this._lineSegs    = null;   // vertical lines for lit (selected/all) points
        this._lineSegsDim = null;   // vertical lines for dim (unselected) points
        this._iHitClusters = [];
        // Shared hit-test geometry & sprite textures (created once)
        this._hitGeo      = new THREE.SphereGeometry(1, 6, 4);
        this._sphereTex   = this._makeSphereTex();
        this._starTex     = this._makeStarTex();
        this._sentPts     = [];   // { lat, lon, snr, col, time } — outgoing SNR points
        this.infoEl          = opts.infoEl          || null;
        this.onSelect        = opts.onSelect        || null;
        this.onFilter        = opts.onFilter        || null;
        this.onRemoveMarker  = opts.onRemoveMarker  || null;
        this.onPinMarker     = opts.onPinMarker     || null;
        // Sprite lists for static marker hit-testing
        this._markerSprites  = [];   // [{sprite, col, pubKeyFullHex, isClose}]

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

    _makeStarTex() {
        const s = 64, cx = s / 2, cy = s / 2;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = s;
        const ctx = canvas.getContext('2d');
        const outerR = s / 2 - 3;
        const innerR = outerR * 0.42;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
            const a = (i * Math.PI / 5) - Math.PI / 2;
            const r = i % 2 === 0 ? outerR : innerR;
            const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const grad = ctx.createRadialGradient(cx - outerR * 0.2, cy - outerR * 0.3, 0, cx, cy, outerR);
        grad.addColorStop(0,   'rgba(255,255,255,1)');
        grad.addColorStop(0.5, 'rgba(200,200,200,1)');
        grad.addColorStop(1,   'rgba(60,60,60,1)');
        ctx.fillStyle = grad;
        ctx.fill();
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

        this.controls = new MapControls(this.camera, canvas);
        this.controls.target.set(0, 0, 0);
        this.controls.enableDamping      = true;
        this.controls.dampingFactor      = 0.08;
        this.controls.maxPolarAngle      = Math.PI / 2 - 0.08;
        this.controls.screenSpacePanning = false;  // always pan in world XZ plane, no tilt-fight
        this.controls.minDistance        = 0.5;
        this.controls.maxDistance        = 300;
        // Single finger = pan; two fingers = orbit/tilt (centroid) + pinch-zoom; twist = custom below
        this.controls.touches = { ONE: 1 /* PAN */, TWO: 3 /* DOLLY_ROTATE */ };
        this.controls.update();
        this.controls.addEventListener('change', () => {
            this.controls.target.y = 0;
            this._updateHeightScale();
        });
        this.controls.addEventListener('end', () => {
            clearTimeout(this._viewUpdateTimer);
            this._viewUpdateTimer = setTimeout(() => this._updateOverlay(), 700);
        });

        // Two-finger twist: rotate camera azimuth by the angular change between the
        // two touch points.  rotateLeft() is private in Three.js ≥0.155, so we
        // rotate camera.position directly around the Y axis through controls.target
        // and let controls.update() recompute its internal spherical state.
        let _twistAngle = null;
        canvas.addEventListener('touchstart', e => {
            if (e.touches.length === 2) {
                const t0 = e.touches[0], t1 = e.touches[1];
                _twistAngle = Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX);
            } else {
                _twistAngle = null;
            }
        }, { passive: true });
        canvas.addEventListener('touchmove', e => {
            if (e.touches.length !== 2 || _twistAngle === null) return;
            const t0 = e.touches[0], t1 = e.touches[1];
            const newAngle = Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX);
            let delta = newAngle - _twistAngle;
            if (delta >  Math.PI) delta -= 2 * Math.PI;
            if (delta < -Math.PI) delta += 2 * Math.PI;
            if (Math.abs(delta) > 0.001) {
                const a   = -delta * 1.4;
                const cos = Math.cos(a), sin = Math.sin(a);
                const tx  = this.controls.target.x, tz = this.controls.target.z;
                const dx  = this.camera.position.x - tx;
                const dz  = this.camera.position.z - tz;
                this.camera.position.x = tx + dx * cos - dz * sin;
                this.camera.position.z = tz + dx * sin + dz * cos;
                this.controls.update();
            }
            _twistAngle = newAngle;
        }, { passive: true });
        canvas.addEventListener('touchend',   () => { _twistAngle = null; }, { passive: true });
        canvas.addEventListener('touchcancel',() => { _twistAngle = null; }, { passive: true });

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
            this._scaleMarkerToScreen();
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
                    this._setStatus('Location denied — new packets won\'t be placed on the map. You can still view and rotate existing data.');
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

    setDisplayCutoff(cutoffMs) {
        this._displayCutoff = cutoffMs || 0;
        this._repositionAll();
        this._scheduleMapUpdate();   // re-fit map to the now-visible bbox
    }

    // ---- Click / selection ----

    _onCanvasClick(e) {
        const rect  = this.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width)  * 2 - 1,
            -((e.clientY - rect.top)  / rect.height) * 2 + 1
        );
        this._raycaster.setFromCamera(mouse, this.camera);

        // Check static marker sprites first (emoji icons and labels)
        if (this._markerSprites.length) {
            const clickableEntries = this._markerSprites.filter(s => !s.isClose);
            const sprites = clickableEntries.map(s => s.sprite);
            const hits = this._raycaster.intersectObjects(sprites);
            if (hits.length > 0) {
                const hit = hits[0];
                const entry = clickableEntries.find(s => s.sprite === hit.object);
                if (entry) {
                    // For label sprites, check if click landed in the [x] top-right corner.
                    // Sprites always face the camera, so we must project the hit offset
                    // onto camera right/up vectors (not world X/Y).
                    if (entry.isLabel) {
                        const sp = entry.sprite;
                        const sw = new THREE.Vector3();
                        sp.getWorldPosition(sw);
                        const ss = new THREE.Vector3();
                        sp.getWorldScale(ss);
                        const offset = hit.point.clone().sub(sw);
                        const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
                        const camUp    = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
                        // Normalize to ±0.5 (sprite edge)
                        const nx = offset.dot(camRight) / ss.x;
                        const ny = offset.dot(camUp)    / ss.y;
                        if (nx > 0.27 && ny > 0.05) {
                            if (entry.isPinned) this.onRemoveMarker?.(entry.col, entry.pubKeyFullHex);
                            else               this.onPinMarker?.(entry.col, entry.pubKeyFullHex);
                            return;
                        }
                    }
                    const newCol = entry.col === this._selectedCol ? null : entry.col;
                    this._selectedCol = newCol;
                    this._repositionAll();
                    this.onSelect?.(newCol);
                    this._infoPanelFromClick = !!newCol;
                    this._updateInfoPanel();
                    return;
                }
            }
        }

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
        this.onSelect?.(newCol);   // may call selectColumn() back, which resets _infoPanelFromClick
        this._infoPanelFromClick = !!newCol;   // set after the feedback loop so panel stays visible
        this._updateInfoPanel();
    }

    _updateInfoPanel() {
        if (!this.infoEl) return;
        const col = this._selectedCol;
        if (!col || !this._infoPanelFromClick) { this.infoEl.classList.add('hidden'); return; }
        const pts = this.points.filter(p => p.col === col);
        if (!pts.length) { this.infoEl.classList.add('hidden'); return; }
        const color   = this.colorFor(col);
        const dot     = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;flex-shrink:0"></span>`;
        const name    = this.nameForCol ? this.nameForCol(col) : null;
        const nameHtml = name ? ` <span class="smi-colname">${this._escHtml(name)}</span>` : '';
        this.infoEl.innerHTML =
            `<button class="smi-close" title="Deselect">✕</button>` +
            `<div class="smi-name">${dot}<b>${this._escHtml(this.displayId(col))}</b>${nameHtml}</div>`;
        this.infoEl.classList.remove('hidden');
    }

    _escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- Static contact markers ----

    setStaticMarkers(markers) {
        this._disposeStaticMarkers();
        this._staticMarkers = markers || [];
        if (this._staticMarkers.length && this.emptyEl) this.emptyEl.classList.add('hidden');
        this._updateStaticMarkers();
    }

    _disposeStaticMarkers() {
        for (const g of this._staticMarkerMeshes) {
            this.scene.remove(g);
            g.traverse(obj => {
                obj.geometry?.dispose();
                if (obj.material) {
                    obj.material.map?.dispose();
                    obj.material.dispose();
                }
            });
        }
        this._staticMarkerMeshes = [];
        this._markerSprites = [];
    }

    _makeEmojiSprite(emoji, yPos) {
        const S = 128, dpr = 2;
        const c = document.createElement('canvas');
        c.width = S * dpr; c.height = S * dpr;
        const ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.font = `${S * 0.82}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emoji, S / 2, S / 2 + 4);
        const tex = new THREE.CanvasTexture(c);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        sprite.renderOrder = 10;
        sprite.scale.set(3.0, 3.0, 1);
        sprite.position.set(0, yPos, 0);
        return sprite;
    }

    _makeMarkerLabel(idText, nameText, hexColor, isPinned) {
        const dpr   = 2;
        const fId   = nameText ? 20 : 24;
        const fName = 17;
        const fBtn  = 15;
        const pad   = 6;

        // Measure text widths to build a tight canvas
        const mc = document.createElement('canvas');
        const mctx = mc.getContext('2d');
        mctx.font = `bold ${fId}px sans-serif`;
        const idW   = mctx.measureText(idText).width;
        mctx.font = `bold ${fName}px sans-serif`;
        const nmW   = nameText ? mctx.measureText(nameText).width : 0;
        mctx.font   = `${fBtn}px sans-serif`;
        const btnW  = mctx.measureText(isPinned ? '✕' : '📌').width + 6;

        const lineH  = nameText ? fId + fName + 6 : fId;
        const W      = Math.max(idW, nmW) + btnW + pad * 2 + 4;
        const H      = lineH + pad * 2;

        const c   = document.createElement('canvas');
        c.width   = Math.ceil(W * dpr);
        c.height  = Math.ceil(H * dpr);
        const ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);

        const stroke = (fn) => {
            ctx.save();
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            ctx.lineWidth   = 4;
            ctx.lineJoin    = 'round';
            ctx.miterLimit  = 2;
            fn();
            ctx.stroke();
            ctx.restore();
        };

        // Action button (✕ or 📌) — top-right
        ctx.font = `${fBtn}px sans-serif`;
        ctx.textAlign   = 'right';
        ctx.textBaseline = 'top';
        stroke(() => ctx.strokeText(isPinned ? '✕' : '📌', W - pad, pad));
        ctx.fillStyle = isPinned ? '#e0e0e0' : '#c8d8ff';
        ctx.fillText(isPinned ? '✕' : '📌', W - pad, pad);

        // ID line
        ctx.font = `bold ${fId}px sans-serif`;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        const ty = nameText ? pad : pad + (lineH - fId) / 2;
        stroke(() => ctx.strokeText(idText, pad, ty));
        ctx.fillStyle = hexColor;
        ctx.fillText(idText, pad, ty);

        // Name line
        if (nameText) {
            ctx.font = `bold ${fName}px sans-serif`;
            const ty2 = pad + fId + 6;
            stroke(() => ctx.strokeText(nameText, pad, ty2));
            ctx.fillStyle = '#ffffff';
            ctx.fillText(nameText, pad, ty2);
        }

        const tex = new THREE.CanvasTexture(c);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        sprite.renderOrder = 10;
        const aspect = c.width / c.height;
        sprite.scale.set(aspect * 2.4, 2.4, 1);
        sprite.position.set(0, 7.0, 0);
        return sprite;
    }

    _updateStaticMarkers() {
        this._disposeStaticMarkers();
        if (!this._staticMarkers.length || !this.tileBounds) return;
        for (const m of this._staticMarkers) {
            const pos = this._latLonToWorld(m.lat, m.lon);
            if (!pos) continue;
            const hexColor = m.color || '#ff8800';
            const col3 = new THREE.Color(hexColor);
            const group = new THREE.Group();
            const markerCol = m.col ?? null;
            const pubKeyFullHex = m.pubKeyFullHex ?? null;
            const isPinned = !!m.isPinned;

            // Base shadow circle
            const base = new THREE.Mesh(
                new THREE.CircleGeometry(1.3, 24),
                new THREE.MeshBasicMaterial({ color: col3, transparent: true, opacity: 0.28, depthWrite: false })
            );
            base.rotation.x = -Math.PI / 2;
            base.position.y = 0.06;
            group.add(base);

            // Thin mast
            const mast = new THREE.Mesh(
                new THREE.CylinderGeometry(0.07, 0.1, 2.8, 8),
                new THREE.MeshBasicMaterial({ color: col3 })
            );
            mast.position.y = 1.4;
            group.add(mast);

            // 📡 emoji sprite — click target for selection
            const emojiSprite = this._makeEmojiSprite('📡', 3.8);
            group.add(emojiSprite);
            this._markerSprites.push({ sprite: emojiSprite, col: markerCol, pubKeyFullHex, isClose: false, isLabel: false });

            // Text label sprite — click target; corner region detected by normalized hit coords
            const labelSprite = this._makeMarkerLabel(m.id ?? '', m.name ?? null, hexColor, isPinned);
            group.add(labelSprite);
            this._markerSprites.push({ sprite: labelSprite, col: markerCol, pubKeyFullHex, isClose: false, isLabel: true, isPinned });

            group.position.set(pos.x, 0, pos.z);
            this.scene.add(group);
            this._staticMarkerMeshes.push(group);
        }
    }

    // ---- Map source ----

    clearPoints() {
        this.points = [];
        this._sentPts = [];
        this._selectedCol = null;
        this._disposeInstanced();
        this._removeOverlay();
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

    setHeightMode(mode) {
        if (mode === this._heightMode) return;
        this._heightMode = mode;
        this._updateHeightScale();
        this._repositionAll();
    }

    setPerspSize(v) {
        if (!!v === this._perspSize) return;
        this._perspSize = !!v;
        this._repositionAll();
    }

    setShowLines(v) {
        this._showLines = !!v;
        if (this._lineSegs)    this._lineSegs.visible    = this._showLines;
        if (this._lineSegsDim) this._lineSegsDim.visible = this._showLines;
    }

    setShowMarker(v) {
        this._showMarker = !!v;
        if (this.userMarker) this.userMarker.visible = this._showMarker;
    }

    setClusterRadius(r) {
        if (r === this._clusterRadius) return;
        this._clusterRadius = r;
        this._repositionAll();
    }

    setMapSource(source) {
        if (!TILE_SOURCES[source] || source === this.mapSource) return;
        this.mapSource = source;
        this.lastBboxKey = null;
        this._removeOverlay();
        this._scheduleMapUpdate();
    }

    availableSources() {
        return Object.entries(TILE_SOURCES).map(([id, s]) => ({ id, label: s.label }));
    }

    // ---- Packet ingestion ----

    addPacket(opts) {
        if (opts.lat == null || opts.lon == null || opts.snr == null) return;
        this.points.push({ ...opts });
        if (this.emptyEl) this.emptyEl.classList.add('hidden');
        if (opts.col === this._selectedCol) this._updateInfoPanel();
        this._repositionAll();
        this._scheduleMapUpdate();
    }

    addSentSnrPacket(opts) {
        if (opts.lat == null || opts.lon == null || opts.snr == null) return;
        this._sentPts.push({ ...opts });
        if (this.emptyEl) this.emptyEl.classList.add('hidden');
        this._repositionAll();
    }

    // Called by the host app when chart/legend selection changes.
    selectColumn(col) {
        this._infoPanelFromClick = false;   // always hide info panel on external selection
        if (this._selectedCol === col) {
            this._updateInfoPanel();
            return;
        }
        this._selectedCol = col ?? null;
        this._repositionAll();
        this._scheduleMapUpdate();   // re-fit tiles to include the newly selected repeater
        this._updateInfoPanel();
    }

    // Drop packets older than the given timestamp. Disposes their meshes and
    // refreshes selection / info panel if the active repeater goes away.
    purgeOlderThan(cutoff) {
        if (!Number.isFinite(cutoff)) return;
        const before     = this.points.length;
        const sentBefore = this._sentPts.length;
        this.points   = this.points.filter(p => p.time >= cutoff);
        this._sentPts = this._sentPts.filter(p => p.time >= cutoff);
        if (this.points.length === before && this._sentPts.length === sentBefore) return;
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
        const cutoff = this._displayCutoff;
        const locs = this.points
            .filter(p => (!cutoff || p.time >= cutoff) && (!this.filterFn || this.filterFn(p.col)))
            .map(p => ({ lat: p.lat, lon: p.lon }));
        // Always include the selected repeater's points even if outside the display window or filter
        if (this._selectedCol) {
            for (const p of this.points)
                if (p.col === this._selectedCol) locs.push({ lat: p.lat, lon: p.lon });
        }
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

        // Find highest zoom where data fits within MAX_TILES_AXIS × MAX_TILES_AXIS
        let zoom = 19;
        let tl, br;
        while (zoom > 1) {
            tl = lonLatToTile(minLon, maxLat, zoom);
            br = lonLatToTile(maxLon, minLat, zoom);
            const dtx = Math.floor(br.x) - Math.floor(tl.x) + 1;
            const dty = Math.floor(br.y) - Math.floor(tl.y) + 1;
            if (dtx <= MAX_TILES_AXIS && dty <= MAX_TILES_AXIS) break;
            zoom--;
        }

        // Asymmetric padding: proportional to data extent so elongated shapes don't waste tiles
        const maxTile = Math.pow(2, zoom) - 1;
        const tx = Math.floor(br.x) - Math.floor(tl.x) + 1;
        const ty = Math.floor(br.y) - Math.floor(tl.y) + 1;
        const padX = Math.max(1, Math.min(2, Math.ceil(tx / 2)));
        const padY = Math.max(1, Math.min(2, Math.ceil(ty / 2)));
        const x0 = Math.max(0, Math.floor(tl.x) - padX);
        const y0 = Math.max(0, Math.floor(tl.y) - padY);
        const x1 = Math.min(maxTile, Math.floor(br.x) + padX);
        const y1 = Math.min(maxTile, Math.floor(br.y) + padY);
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
            this._removeOverlay();   // scale changed — overlay must be rebuilt

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
        this.controls.target.set(0, 0, 0);
        this.controls.update();
        this._cameraFit = true;
        this._updateHeightScale();
    }

    _updateHeightScale() {
        if (this._heightMode === 'fixed') {
            this.pointsGroup.scale.y = 2;
        } else if (this._heightMode === 'tile') {
            const ratio = Math.max(0.01, this.controls.getDistance() / CAMERA_REF_DIST);
            this.pointsGroup.scale.y = Math.pow(ratio, 1.7) * 2;
        } else {
            const ratio = Math.max(0.01, this.controls.getDistance() / CAMERA_REF_DIST);
            this.pointsGroup.scale.y = this._heightMode === 'damped'
                ? Math.sqrt(ratio) * 2
                : ratio * 2;
        }
        this._applyDotScale();
    }

    // Scale dot material sizes very gently with height scale so balls remain
    // visibly large even when spires are short.  pow(f, 0.25): scale of 0.1
    // still leaves dots at ~56% size, 0.5 → ~84%.
    _applyDotScale() {
        const f = Math.pow(Math.max(0.05, this.pointsGroup.scale.y / 2), 0.25);
        for (const m of this._ptsMeshes) {
            if (m.userData.baseDotSize !== undefined)
                m.material.size = m.userData.baseDotSize * f;
        }
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

    _worldToLatLon(wx, wz) {
        if (!this.tileBounds || !this.planeDim) return null;
        const { x0, y0, nx, ny, zoom } = this.tileBounds;
        const { w, h } = this.planeDim;
        const tx = (wx / w + 0.5) * nx + x0;
        const ty = (wz / h + 0.5) * ny + y0;
        const n = Math.pow(2, zoom);
        const lon = tx / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
        return { lat, lon };
    }

    _cameraViewBbox() {
        if (!this.tileBounds) return null;
        const center = this._worldToLatLon(this.controls.target.x, this.controls.target.z);
        if (!center) return null;
        // Target is clamped to y=0 so getDistance() ≈ camera-to-floor distance.
        // Multiply by 1.5 to cover tilted views where visible area extends past the target.
        const r = Math.max(1, this.controls.getDistance()) * Math.tan((this.camera.fov / 2) * Math.PI / 180) * 1.5;
        // Convert radius in world units → lon/lat delta using current tileBounds scale
        const { nx, ny, zoom } = this.tileBounds;
        const { w, h } = this.planeDim;
        const n = Math.pow(2, zoom);
        const lonDelta = r * nx / (w * n) * 360;
        const latDelta = r * ny / (h * n) * 360;
        return {
            minLat: center.lat - latDelta, maxLat: center.lat + latDelta,
            minLon: center.lon - lonDelta, maxLon: center.lon + lonDelta,
        };
    }

    // ---- Detail overlay (high-zoom tiles when camera is close) ----

    async _updateOverlay() {
        if (!this.tileBounds || this._overlayBusy) return;
        const camBb = this._cameraViewBbox();
        if (!camBb) { this._removeOverlay(); return; }

        // Find highest zoom where camera view fits in MAX_TILES_AXIS × MAX_TILES_AXIS
        let overlayZoom = 19, oTl, oBr;
        while (overlayZoom > 1) {
            oTl = lonLatToTile(camBb.minLon, camBb.maxLat, overlayZoom);
            oBr = lonLatToTile(camBb.maxLon, camBb.minLat, overlayZoom);
            if (Math.floor(oBr.x) - Math.floor(oTl.x) + 1 <= MAX_TILES_AXIS &&
                Math.floor(oBr.y) - Math.floor(oTl.y) + 1 <= MAX_TILES_AXIS) break;
            overlayZoom--;
        }
        // Only show overlay when it offers more detail than the base map
        if (overlayZoom <= this.tileBounds.zoom) { this._removeOverlay(); return; }

        const maxTile = Math.pow(2, overlayZoom) - 1;
        const otx = Math.floor(oBr.x) - Math.floor(oTl.x) + 1;
        const oty = Math.floor(oBr.y) - Math.floor(oTl.y) + 1;
        const opx = Math.max(1, Math.min(2, Math.ceil(otx / 2)));
        const opy = Math.max(1, Math.min(2, Math.ceil(oty / 2)));
        const ox0 = Math.max(0, Math.floor(oTl.x) - opx);
        const oy0 = Math.max(0, Math.floor(oTl.y) - opy);
        const ox1 = Math.min(maxTile, Math.floor(oBr.x) + opx);
        const oy1 = Math.min(maxTile, Math.floor(oBr.y) + opy);
        const onx = ox1 - ox0 + 1;
        const ony = oy1 - oy0 + 1;

        const sourceId = this.mapSource;
        const key = `ov/${sourceId}/${overlayZoom}/${ox0}/${oy0}/${ox1}/${oy1}`;
        if (key === this._overlayKey) return;

        this._overlayBusy = true;
        try {
            const tileCanvas = document.createElement('canvas');
            tileCanvas.width  = onx * TILE_PX;
            tileCanvas.height = ony * TILE_PX;
            const ctx = tileCanvas.getContext('2d');
            ctx.fillStyle = '#dfdfdf';
            ctx.fillRect(0, 0, tileCanvas.width, tileCanvas.height);

            const src = TILE_SOURCES[sourceId];
            const tasks = [];
            for (let dx = 0; dx < onx; dx++) {
                for (let dy = 0; dy < ony; dy++) {
                    tasks.push(new Promise(res => {
                        const img = new Image();
                        img.crossOrigin = 'anonymous';
                        img.onload  = () => { ctx.drawImage(img, dx * TILE_PX, dy * TILE_PX); res(); };
                        img.onerror = () => res();
                        img.src = src.url(overlayZoom, ox0 + dx, oy0 + dy);
                    }));
                }
            }
            await Promise.all(tasks);

            // Position overlay in world space using the current (fixed) base tileBounds
            const nwLL  = tileToLatLon(ox0,     oy0,     overlayZoom);
            const seLL  = tileToLatLon(ox1 + 1, oy1 + 1, overlayZoom);
            const nwPos = this._latLonToWorld(nwLL.lat, nwLL.lon);
            const sePos = this._latLonToWorld(seLL.lat, seLL.lon);
            if (!nwPos || !sePos) return;

            const oW  = Math.abs(sePos.x - nwPos.x);
            const oH  = Math.abs(sePos.z - nwPos.z);
            const ocx = (nwPos.x + sePos.x) / 2;
            const ocz = (nwPos.z + sePos.z) / 2;

            const texture = new THREE.CanvasTexture(tileCanvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter  = THREE.LinearFilter;
            texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
            texture.needsUpdate = true;

            const geo  = new THREE.PlaneGeometry(oW, oH);
            const mat  = new THREE.MeshBasicMaterial({ map: texture });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.rotation.x = -Math.PI / 2;
            mesh.position.set(ocx, 0.02, ocz);   // 0.02 above base to avoid z-fighting

            this._removeOverlay();
            this.overlayMesh = mesh;
            this.scene.add(mesh);
            this._overlayKey = key;
        } finally {
            this._overlayBusy = false;
        }
    }

    _removeOverlay() {
        if (!this.overlayMesh) return;
        this.scene.remove(this.overlayMesh);
        this.overlayMesh.geometry.dispose();
        this.overlayMesh.material.map?.dispose();
        this.overlayMesh.material.dispose();
        this.overlayMesh = null;
        this._overlayKey = null;
    }

    _signalToHeight(snr) {
        if (snr == null) return MIN_HEIGHT;
        const t = Math.max(0, Math.min(1, (snr - SNR_BAD) / (SNR_GOOD - SNR_BAD)));
        const range = MAX_HEIGHT - MIN_HEIGHT;
        switch (this._heightMode) {
            case 'log':
                return MIN_HEIGHT + (Math.log1p(t * 9) / Math.LN10) * range;
            case 'sqrt':
                return MIN_HEIGHT + Math.sqrt(t) * range;
            case 'inverted':
                return MIN_HEIGHT + (1 - t) * range;
            case 'steps': {
                // 4 discrete levels at meaningful SNR thresholds
                const level = snr >= 5 ? 1.0 : snr >= -5 ? 0.66 : snr >= -12 ? 0.33 : 0.0;
                return MIN_HEIGHT + level * range;
            }
            default:  // 'spires', 'fixed'
                return MIN_HEIGHT + t * range;
        }
    }

    _disposeInstanced() {
        for (const obj of [...this._ptsMeshes, this._iMeshHit, this._lineSegs, this._lineSegsDim]) {
            if (!obj) continue;
            this.pointsGroup.remove(obj);
            obj.material?.dispose();
            if (obj !== this._iMeshHit) obj.geometry?.dispose();
        }
        this._ptsMeshes   = [];
        this._iMeshHit    = null;
        this._lineSegs    = null;
        this._lineSegsDim = null;
        this._iHitClusters = [];
    }

    _repositionAll() {
        this._disposeInstanced();
        if (!this.tileBounds) return;
        this._updateHeightScale();

        const sel     = this._selectedCol;
        const cutoff  = this._displayCutoff;
        let visible = this.points.filter(p =>
            (!this.filterFn || this.filterFn(p.col)) &&
            (!cutoff || p.time >= cutoff)
        );
        if (!visible.length) return;

        // Clustering: for each repeater, merge points within _clusterRadius metres
        if (this._clusterRadius > 0) {
            // 1° latitude ≈ 111 320 m; 1° longitude ≈ 111 320 * cos(lat) m
            const latDeg = this._clusterRadius / 111320;
            const byCols = new Map();
            for (const p of visible) {
                if (!byCols.has(p.col)) byCols.set(p.col, []);
                byCols.get(p.col).push(p);
            }
            const clustered = [];
            for (const pts of byCols.values()) {
                const used = new Uint8Array(pts.length);
                const refLat = pts[0].lat;
                const lonDeg = this._clusterRadius / (111320 * Math.cos(refLat * Math.PI / 180) || 1);
                for (let i = 0; i < pts.length; i++) {
                    if (used[i]) continue;
                    let best = pts[i];
                    used[i] = 1;
                    for (let j = i + 1; j < pts.length; j++) {
                        if (used[j]) continue;
                        if (Math.abs(pts[j].lat - pts[i].lat) < latDeg &&
                            Math.abs(pts[j].lon - pts[i].lon) < lonDeg) {
                            used[j] = 1;
                            if (pts[j].rssi > best.rssi) best = pts[j];
                        }
                    }
                    clustered.push(best);
                }
            }
            visible = clustered;
        }

        const litPts = sel ? visible.filter(p => p.col === sel) : visible;
        const dimPts = sel ? visible.filter(p => p.col !== sel) : [];

        const _m4 = new THREE.Matrix4(), _v = new THREE.Vector3();
        const _s  = new THREE.Vector3(), _q = new THREE.Quaternion();
        const _col = new THREE.Color();

        const fovFactor  = 2 * Math.tan((this.camera.fov / 2) * Math.PI / 180);
        const screenH    = this.canvas.clientHeight || 600;

        // Build a THREE.Points object for a set of data points
        const makePoints = (pts, opacity, sizeMult, tex = this._sphereTex) => {
            const pos = new Float32Array(pts.length * 3);
            const col = new Float32Array(pts.length * 3);
            for (let i = 0; i < pts.length; i++) {
                const p  = pts[i];
                const wp = this._latLonToWorld(p.lat, p.lon);
                pos[i*3]   = wp ? wp.x : 0;
                pos[i*3+1] = wp ? this._signalToHeight(p.snr) : 0;
                pos[i*3+2] = wp ? wp.z : 0;
                _col.set(this.colorFor(p.col));
                col[i*3] = _col.r; col[i*3+1] = _col.g; col[i*3+2] = _col.b;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
            const dotSize = this.sphereSize * sizeMult * 14;
            const isLit = opacity >= 1.0;
            const mat = new THREE.PointsMaterial({
                map:             tex,
                size:            dotSize,
                sizeAttenuation: false,  // we apply our own dampened perspective below
                vertexColors:    true,
                // Keep everything in the transparent pass so renderOrder controls draw
                // order within the same pass (opaque pass always renders before
                // transparent regardless of renderOrder, breaking our layering).
                transparent:     true,
                opacity,
                depthWrite:      isLit,  // lit balls write depth → occlude each other
                alphaTest:       isLit ? 0.5 : 0.02,
            });
            // Dampened perspective: gl_PointSize = size * (refDist / -mvz)^0.5
            // Standard perspective would use exponent 1.0; 0.5 halves the visual
            // size difference between near and far dots in log space.
            if (this._perspSize) {
                mat.onBeforeCompile = shader => {
                    shader.uniforms.uRefDist = { value: CAMERA_REF_DIST };
                    shader.vertexShader = shader.vertexShader
                        .replace('#include <common>',
                                 '#include <common>\nuniform float uRefDist;')
                        .replace('gl_PointSize = size;',
                                 'gl_PointSize = size * pow(uRefDist / max(0.5, -mvPosition.z), 0.5);');
                };
            }
            const mesh = new THREE.Points(geo, mat);
            // Render order: lit dots (renderOrder 2) paint over lines (renderOrder 1)
            // so the ball is always visually in front of its own guide line.
            mesh.renderOrder = isLit ? 2 : 0;
            mesh.userData.baseDotSize = dotSize;
            return mesh;
        };

        const addPoints = (pts, opacity, sizeMult, tex) => {
            if (!pts.length) return;
            const m = makePoints(pts, opacity, sizeMult, tex);
            this._ptsMeshes.push(m);
            this.pointsGroup.add(m);
        };

        addPoints(litPts, 1.0,  2.0);
        addPoints(dimPts, 0.07, 2.0);

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
            const h  = this._signalToHeight(p.snr);
            const hr = this.sphereSize + 1.8;
            _m4.compose(_v.set(pos.x, h, pos.z), _q, _s.set(hr, hr, hr));
            this._iMeshHit.setMatrixAt(i, _m4);
        }
        this._iMeshHit.instanceMatrix.needsUpdate = true;
        this.pointsGroup.add(this._iMeshHit);

        // Vertical lines — split into lit (coloured) and dim (flat grey, low opacity)
        const makeLines = (pts, mat) => {
            if (!pts.length) return null;
            const pos = new Float32Array(pts.length * 6);
            for (let i = 0; i < pts.length; i++) {
                const p  = pts[i];
                const wp = this._latLonToWorld(p.lat, p.lon);
                if (!wp) continue;
                const h = this._signalToHeight(p.snr);
                const j = i * 6;
                pos[j]   = wp.x; pos[j+1] = 0; pos[j+2] = wp.z;
                pos[j+3] = wp.x; pos[j+4] = h; pos[j+5] = wp.z;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            const seg = new THREE.LineSegments(geo, mat);
            seg.renderOrder = 1;  // after dim dots (0), before lit balls (2)
            seg.visible = this._showLines;
            this.pointsGroup.add(seg);
            return seg;
        };

        const litCol = new Float32Array(litPts.length * 6);
        for (let i = 0; i < litPts.length; i++) {
            _col.set(this.colorFor(litPts[i].col));
            const j = i * 6;
            litCol[j]   = _col.r; litCol[j+1] = _col.g; litCol[j+2] = _col.b;
            litCol[j+3] = _col.r; litCol[j+4] = _col.g; litCol[j+5] = _col.b;
        }
        const lineOpacity = Math.min(1, 0.25 + 0.35 * this.sphereSize);
        const litMat = new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true,
            depthWrite: false, depthTest: false, opacity: lineOpacity,
        });
        const dimMat = new THREE.LineBasicMaterial({
            color: 0x888888, transparent: true, depthWrite: false, depthTest: false, opacity: 0.18,
        });

        this._lineSegs = makeLines(litPts, litMat);
        if (this._lineSegs)
            this._lineSegs.geometry.setAttribute('color', new THREE.BufferAttribute(litCol, 3));
        this._lineSegsDim = makeLines(dimPts, dimMat);

        // Sent SNR squares — outgoing signal quality (how well the repeater heard us)
        const sentCutoff = this._displayCutoff;
        const sentAll = this._sentPts.filter(p =>
            (!this.filterFn || this.filterFn(p.col)) &&
            (!sentCutoff || p.time >= sentCutoff)
        );
        const sentLit = sel ? sentAll.filter(p => p.col === sel) : sentAll;
        const sentDim = sel ? sentAll.filter(p => p.col !== sel) : [];
        addPoints(sentLit, 1.0,  1.6, this._starTex);
        addPoints(sentDim, 0.07, 1.6, this._starTex);

        this._updateStaticMarkers();
        this._applyDotScale();
    }

    _scaleMarkerToScreen() {
        const screenH = this.canvas.clientHeight || 1;
        const fovFactor = 2 * Math.tan((this.camera.fov / 2) * Math.PI / 180);
        const scaleFor = (group, localH) => {
            const d = this.camera.position.distanceTo(group.position);
            group.scale.setScalar(40 * d * fovFactor / (localH * screenH));
        };
        // Cone local height = 2.8; target 40 CSS pixels tall on screen
        if (this.userMarker) scaleFor(this.userMarker, 2.8);
        for (const g of this._staticMarkerMeshes) {
            scaleFor(g, 4.0);
        }
    }

    _updateUserMarker() {
        if (!this.userLoc || !this.tileBounds) return;
        const pos = this._latLonToWorld(this.userLoc.lat, this.userLoc.lon);
        if (!pos) return;
        if (!this.userMarker) {
            const group = new THREE.Group();
            const cone = new THREE.Mesh(
                new THREE.ConeGeometry(1, 2.8, 14),
                new THREE.MeshBasicMaterial({ color: 0xff3355 })
            );
            cone.position.y = 1.4;
            group.add(cone);
            const base = new THREE.Mesh(
                new THREE.CircleGeometry(1.44, 24),
                new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.35 })
            );
            base.rotation.x = -Math.PI / 2;
            base.position.y = 0.05;
            group.add(base);
            this.userMarker = group;
            this.userMarker.visible = this._showMarker;
            this.scene.add(this.userMarker);
        }
        this.userMarker.position.set(pos.x, 0, pos.z);  // scale handled by _scaleMarkerToScreen()
    }

    // ---- Lifecycle ----

    dispose() {
        if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
        cancelAnimationFrame(this._rafId);
        window.removeEventListener('resize', this._onResize);
        this._ro?.disconnect();
        this._removeOverlay();
        this.renderer.dispose();
    }
}
