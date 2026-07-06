// 3D signal map: stitched map tiles laid as a floor in Three.js;
// each captured packet is a colored bead floating above its GPS location at a
// height proportional to RSSI.
//
// Several tile sources: Mapy.com (default, requires API key), OpenStreetMap
// flavours, CARTO and Esri basemaps, and "none" (a plain floor, no imagery).

import * as THREE from 'three';
import { MapControls } from './vendor/controls/MapControls.js?v=1';
import { colsOverlap } from './column-key.js?v=2';
import { lonLatToTile, tileToLatLon } from './geo.js?v=1';

const PLANE_SIZE     = 100;   // world units, longest plane edge
const MAX_HEIGHT     = 12;    // world units for strongest signal
const MIN_HEIGHT     = 2;     // world units for weakest signal
const SNR_GOOD       = 15;    // dB — top of the height scale (max height)
const SNR_BAD        = -13;   // dB — bottom of the height scale (min height)
const MAX_TILES_AXIS = 4;
const TILE_PX        = 256;
// Closest zoom shows roughly this much ground across the view, regardless of how
// much area the (fixed-size) plane covers — so a long drive doesn't cap zoom at a
// city-block view. minDistance is derived from it per map scale (see _applyZoomLimits).
const ZOOM_MIN_VIEW_M = 30;
// Markers (my-location cone, device, repeater pins) are sized to this fraction of
// the smaller viewport dimension (clamped to a sensible pixel range), so they
// don't look tiny on a small map nor balloon when the map is made much taller
// (e.g. fullscreen on a phone, where only the height grows).
const MARKER_VIEW_FRAC = 0.10;
// Reference camera distance: distance from origin when camera is at the initial
// fit position (0.4r, 0.55r, 0.6r) with r = PLANE_SIZE.  Derived once so that
// height/size scales are purely a function of current camera distance and never
// depend on when the first tile load happened.
const CAMERA_REF_DIST = PLANE_SIZE * Math.sqrt(0.4*0.4 + 0.55*0.55 + 0.6*0.6); // ≈ 90.7

// GPS outlier rejection (see _gpsAccept). The marker and the packet geotag use
// only accepted/estimated fixes. Tuned for a moving car; conservative so
// legitimate motion (incl. hard braking/cornering) is never dropped, and so a
// stationary receiver's jitter can't build a phantom velocity.
const GPS_MAX_ACCEL  = 12;   // m/s² — plausible accel/brake/cornering
const GPS_BASE_TOL   = 15;   // m — base slack (GPS noise) on top of the accel + accuracy budget
const GPS_MAX_ACC    = 150;  // m — reject fixes less certain than this
const GPS_MAX_REJECT = 4;    // accept after this many consecutive rejects (anti-stuck: real jump / GPS reset)
const GPS_VEL_SMOOTH = 0.4;  // EMA weight for a new velocity sample (driving builds it; standstill jitter cancels)
const GPS_MIN_SPEED  = 3;    // m/s (~11 km/h) — below this the receiver is treated as stationary (no dead-reckon)
const GPS_NOISE_K    = 1.5;  // a step within this × accuracy is jitter, not real motion
const GPS_MOVE_STREAK = 3;   // consecutive above-noise steps needed before we trust the velocity (no fling from one-off jitter)
const GPS_DR_MAX_DT  = 2;    // s — cap on dead-reckon extrapolation time, so a wrong velocity can't fling far

// Mapy.com tile API: path includes tile size (256) before z/x/y.
// Reference: https://developer.mapy.com/rest-api/maptiles/
const MAPYCOM_KEY = '8k8RZ_2rNYvfSzsufejwlKuBnnF0kYmPtfVDhSeBoiE';
const mapycomUrl = type => (z, x, y) =>
    `https://api.mapy.cz/v1/maptiles/${type}/256/${z}/${x}/${y}?apikey=${MAPYCOM_KEY}`;
const cartoUrl = style => (z, x, y) =>
    `https://a.basemaps.cartocdn.com/${style}/${z}/${x}/${y}.png`;
const CARTO_ATTRIB = '© OpenStreetMap contributors, © CARTO';
// Esri tile services take {z}/{y}/{x} — y before x, unlike every other source.
const esriUrl = service => (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`;
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
        maxZoom: 17,
    },
    'cyclosm':         {
        label:  'CyclOSM (cycling)',
        url:    (z, x, y) => `https://a.tile-cyclosm.openstreetmap.fr/cyclosm/${z}/${x}/${y}.png`,
        attrib: '© CyclOSM, © OpenStreetMap contributors',
    },
    'osm-hot':         {
        label:  'Humanitarian (HOT)',
        url:    (z, x, y) => `https://a.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`,
        attrib: '© OpenStreetMap contributors, tiles: HOT / OSM France',
    },
    'osm-de':          {
        label:  'OSM German style',
        url:    (z, x, y) => `https://tile.openstreetmap.de/${z}/${x}/${y}.png`,
        attrib: '© OpenStreetMap contributors',
        maxZoom: 18,
    },
    'osm-fr':          {
        label:  'OSM French style',
        url:    (z, x, y) => `https://a.tile.openstreetmap.fr/osmfr/${z}/${x}/${y}.png`,
        attrib: '© OpenStreetMap contributors, tiles: OSM France',
    },
    // CARTO basemaps (no API key required): dark/light/coloured, each also in a
    // no-labels variant — a label-free floor keeps the signal beads readable.
    'cartodark':              { label: 'CARTO Dark Matter',             url: cartoUrl('dark_all'),                      attrib: CARTO_ATTRIB },
    'cartodark-nolabels':     { label: 'CARTO Dark Matter (no labels)', url: cartoUrl('dark_nolabels'),                 attrib: CARTO_ATTRIB },
    'cartolight':             { label: 'CARTO Positron (light)',        url: cartoUrl('light_all'),                     attrib: CARTO_ATTRIB },
    'cartolight-nolabels':    { label: 'CARTO Positron (no labels)',    url: cartoUrl('light_nolabels'),                attrib: CARTO_ATTRIB },
    'cartovoyager':           { label: 'CARTO Voyager',                 url: cartoUrl('rastertiles/voyager'),           attrib: CARTO_ATTRIB },
    'cartovoyager-nolabels':  { label: 'CARTO Voyager (no labels)',     url: cartoUrl('rastertiles/voyager_nolabels'), attrib: CARTO_ATTRIB },
    // Esri basemaps (no key). The Gray Canvas styles only serve tiles up to z16.
    'esri-darkgray':   { label: 'Esri Dark Gray Canvas',  url: esriUrl('Canvas/World_Dark_Gray_Base'),  attrib: '© Esri', maxZoom: 16 },
    'esri-lightgray':  { label: 'Esri Light Gray Canvas', url: esriUrl('Canvas/World_Light_Gray_Base'), attrib: '© Esri', maxZoom: 16 },
    'esri-imagery':    { label: 'Esri World Imagery',     url: esriUrl('World_Imagery'),                attrib: '© Esri, Maxar, Earthstar Geographics' },
    // No map tiles at all — the floor is rendered as a plain colour (theme-aware).
    'none':            { label: 'None (no map)', url: null, attrib: '' },
};
const DEFAULT_SOURCE = 'mapycom-basic';


// 2*tan(fov/2): the recurring factor converting between world size at a given
// camera distance and on-screen size. Callers needing tan(fov/2) use the
// result divided by 2.
function fovFactor(camera) {
    return 2 * Math.tan((camera.fov / 2) * Math.PI / 180);
}

// Detach a Three.js object from its parent and release its GPU resources
// (geometry + materials, recursively). Pass disposeTextures:false for objects
// whose materials reference shared/cached textures (the signal dots reuse
// sprite textures owned by the map) — disposing those would corrupt every
// other object still using them.
function disposeObject3D(obj, { disposeTextures = true } = {}) {
    if (!obj) return;
    obj.parent?.remove(obj);
    obj.traverse(node => {
        node.geometry?.dispose?.();
        const mat = node.material;
        if (!mat) return;
        for (const m of (Array.isArray(mat) ? mat : [mat])) {
            if (disposeTextures) m.map?.dispose?.();
            m.dispose?.();
        }
    });
}

export class Signal3DMap {
    constructor(opts) {
        this.canvas    = opts.canvas;
        this.statusEl  = opts.statusEl;
        this.btnEl     = opts.btnEl;
        this.centerBtnEl = opts.centerBtnEl;   // "Center on me" — only useful with a fix
        this.emptyEl   = opts.emptyEl;
        this.colorFor  = opts.colorFor  || (() => '#667eea');
        this.displayId = opts.displayId || (col => col);
        this.nameForCol = opts.nameForCol || null;
        // True while the app is actively capturing packets (connected, not
        // paused). When live we keep the user's own position inside the tiled
        // area so fast movement without incoming packets doesn't drive off the
        // map. When just viewing an imported dataset this is false, so a far-away
        // current position never drags the tiles away from the data.
        this.isLiveCapture = opts.isLiveCapture || (() => false);
        // True when the page is in dark mode. Used to paint the map background
        // (the area around the tiled floor) black, independent of the chosen
        // tile source — a dark *basemap* and a dark *page* are two separate things.
        this.isDarkMode = opts.isDarkMode || (() => false);

        this._rxPoints       = [];     // { lat, lon, rssi, snr, col, time }
        this._pins     = [];   // { lat, lon, name, color }
        this._pinGroups = [];
        this._userLoc      = null;
        this._watchId      = null;
        this._gpsLast       = null;          // last accepted fix {lat, lon, t, accuracy} — for outlier rejection
        this._gpsVel        = { x: 0, y: 0 };// smoothed velocity estimate (m/s, east/north)
        this._gpsMoveStreak = 0;             // consecutive above-noise steps (gates "moving"/dead-reckon)
        this._gpsReject     = 0;             // consecutive rejected fixes (anti-stuck counter)
        this._followUser   = false;  // when true, camera tracks the user's GPS position
        this._userDragging = false;  // a pointer gesture on the map is in progress
        this.onFollowChange = opts.onFollowChange || null;
        this._tileBounds   = null;   // { x0, y0, nx, ny, zoom }
        this._planeDim     = null;   // { w, h } in world units
        this._mapMesh      = null;
        this._userMarker   = null;
        this._lastMapKey  = null;
        this._cameraFit   = false;
        this._mapBusy     = false;
        this._overlayMesh  = null;
        this._overlayBusy = false;
        this._overlayRerun = false;   // an update arrived mid-fetch; re-run when it settles
        this._overlayKey  = null;
        this._filterFn     = null;   // col => boolean, or null (show all)
        this._displayCutoff = 0;    // timestamp ms; 0 = no filter
        this._mapSource    = (opts.initialSource && TILE_SOURCES[opts.initialSource])
            ? opts.initialSource : DEFAULT_SOURCE;
        this._sphereSize   = (opts.initialSphereSize > 0) ? opts.initialSphereSize : 1.0;
        this._showLines   = true;    // set from persisted prefs via setShowLines() at init
        this._showMarker  = true;    // … setShowMarker()
        this._showDevice  = false;   // connected-device marker — setShowDeviceMarker()
        this._deviceLoc   = null;                // { lat, lon } of the device, or null
        this._deviceMarker = null;
        this._selectedCol = null;
        this._perspSize   = opts.initialPerspSize !== false; // default on
        // Points / mesh handles — replaced per _rebuildDots call
        this._dotMeshes   = [];     // THREE.Points for spheres (sprite texture), one or more per call
        this._hitMesh     = null;   // invisible InstancedMesh for raycasting only
        this._lineSegs    = null;   // vertical lines for lit (selected/all) points
        this._lineSegsDim = null;   // vertical lines for dim (unselected) points
        this._hitPoints = [];
        this._clickedPoint = null;  // the specific point instance last clicked
        // Shared sprite textures (created once)
        this._sphereTex   = this._makeSphereTex();
        this._starTex     = this._makeStarTex();
        // Black-ringed discs for the pseudo columns (always face the camera, so
        // they read as a circle from any angle): direct=yellow, unknown=white.
        this._ringTexDirect  = this._makeRingTex('#111111', '#ffd400');
        this._ringTexUnknown = this._makeRingTex('#cc0000', '#ffffff');
        this._outgoingPts     = [];   // { lat, lon, snr, col, time } — outgoing SNR points
        // Downsampled historical points loaded from disk for wide / "All" views.
        // When non-null these replace _rxPoints as the render source (they are
        // already spatially gridded, so no further clustering is applied).
        this._histPoints      = null;
        this._histOutgoingPts = null;    // disk-loaded outgoing-SNR points (null = use live _outgoingPts)
        this._histSentAt      = 0;       // time the sent layer reflects; newer live sent points are the tail
        this._dotsDirty       = false;   // a live packet changed _rxPoints; rebuild is coalesced in the frame loop
        this._lastDotsBuild   = 0;
        this._viewChangeTimer = null;
        this.infoEl          = opts.infoEl          || null;
        this.onSelect        = opts.onSelect        || null;
        this.onViewChange    = opts.onViewChange    || null;  // (bbox, metresPerPixel) on zoom/pan, debounced
        this.onFilter        = opts.onFilter        || null;
        this.onRemoveMarker  = opts.onRemoveMarker  || null;
        this.onPinMarker     = opts.onPinMarker     || null;
        this.onToggleMapPin  = opts.onToggleMapPin  || null;
        // Sprite lists for static marker hit-testing
        this._pinSprites  = [];   // [{sprite, col, pubKeyFullHex, isClose}]

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

    // Filled disc with a coloured rim, for the pseudo-column markers. Rendered
    // with a white vertex colour so the baked fill/rim colours show true.
    _makeRingTex(rim, fill) {
        const s = 64, c = s / 2, r = s / 2 - 2;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = s;
        const ctx = canvas.getContext('2d');
        ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        ctx.lineWidth = s * 0.24;
        ctx.strokeStyle = rim;
        ctx.beginPath(); ctx.arc(c, c, r - ctx.lineWidth / 2, 0, Math.PI * 2); ctx.stroke();
        return new THREE.CanvasTexture(canvas);
    }

    // ---- Scene setup ----

    _initScene() {
        const canvas = this.canvas;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this.renderer.setClearColor(this._bgColor());

        const w = Math.max(1, canvas.clientWidth);
        const h = Math.max(1, canvas.clientHeight);
        this.renderer.setSize(w, h, false);

        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 5000);
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
            // While following, keep the orbit pivot at the framing height (user +
            // half a max-height spire); otherwise pin it to the ground plane. Skip
            // during a camera animation so its lerp drives the target height
            // smoothly instead of snapping (see _stepCameraAnim / flyToUser).
            if (!this._camAnim) this.controls.target.y = this._followUser ? this._followCenterY() : 0;
            this._updateHeightScale();
            this._updatePerspUniforms();
            this._notifyViewChange();
            // Refresh detail tiles for the new view — fires for programmatic camera
            // moves too (e.g. "Center on me" following the user), not just drags, so
            // the map doesn't wait for a manual nudge to fetch tiles. Debounced and
            // gated by visibility inside _updateOverlay.
            this._scheduleOverlayUpdate();
        });
        this.controls.addEventListener('end', () => {
            clearTimeout(this._viewUpdateTimer);
            this._viewUpdateTimer = setTimeout(() => this._updateOverlay(), 700);
            // Fire the dot-detail refresh directly here too (not only via the
            // debounced 'change' path). enableDamping makes controls.update()
            // emit a 'change' every frame while the camera settles, which keeps
            // resetting _notifyViewChange's 350 ms timer so it never fires while
            // the tab is foregrounded — only backgrounding it (rAF pauses, the
            // stream stops) let the timer fire, which is why "leave the browser
            // and return" was the ONLY way to load the zoomed-in points. A
            // gesture just ended, so re-query the finer grid now. (The detail
            // TILES above already had this fallback; the dots didn't.)
            this._fireViewChange();
        });
        // User interaction cancels any running camera fly/turn animation.
        // Follow mode is NOT dropped immediately: small adjustments (pan a bit,
        // zoom) that leave the user's marker within the central third of the
        // view keep following active; only a gesture that pushes the marker out
        // of that dead zone disengages it (checked on gesture end).
        this.controls.addEventListener('start', () => { this._camAnim = null; this._userDragging = true; });
        this.controls.addEventListener('end', () => {
            this._userDragging = false;
            if (this._followUser && !this._followTargetInDeadZone()) this.setFollowUser(false);
        });

        // Tile traffic saver: only fetch detail tiles while the map is actually
        // on-screen — the app in the foreground AND the canvas in the viewport
        // (it can be scrolled away or its section collapsed). While hidden we just
        // remember a refresh is due (_overlayPending) and run it once the map is
        // visible again, so following the user with the screen off / map off-screen
        // never hits the network.
        this._mapInView = true;
        this._overlayPending = false;
        this._mapPending = false;
        const onMaybeVisible = () => {
            if (!this._isMapVisible()) return;
            if (this._mapPending) this._scheduleMapUpdate();        // base floor first
            if (this._overlayPending) this._scheduleOverlayUpdate(150);
        };
        document.addEventListener('visibilitychange', onMaybeVisible);
        if (typeof IntersectionObserver !== 'undefined') {
            new IntersectionObserver((entries) => {
                this._mapInView = entries.some(e => e.isIntersecting);
                onMaybeVisible();
            }, { threshold: 0 }).observe(canvas);
        }

        this._initTwistGesture(canvas);

        // The my-location cone is the only lit material in the scene. Its visible
        // (near-vertical) sides only catch the directional light when that light
        // comes from the side, so keep it fairly horizontal and strong for a clear
        // lit/shadow split as the camera orbits; ambient sets the shadow-side floor.
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const dl = new THREE.DirectionalLight(0xffffff, 1.3);
        dl.position.set(90, 70, 50);
        this.scene.add(dl);

        // Placeholder floor until tiles arrive
        const phGeo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
        const phMat = new THREE.MeshBasicMaterial({ color: this._floorColor() });
        this._mapMesh = new THREE.Mesh(phGeo, phMat);
        this._mapMesh.rotation.x = -Math.PI / 2;
        this.scene.add(this._mapMesh);
        this._planeDim = { w: PLANE_SIZE, h: PLANE_SIZE };

        this._rxPointsGroup = new THREE.Group();
        this.scene.add(this._rxPointsGroup);

        this._raycaster = new THREE.Raycaster();

        this._initClickDetection(canvas);

        this._onResize = () => this._resize();
        window.addEventListener('resize', this._onResize);
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(canvas);

        this._initInfoPanelEvents();
        this._startRenderLoop();
    }

    // Two-finger twist: rotate camera azimuth by the angular change between the
    // two touch points.  rotateLeft() is private in Three.js ≥0.155, so we
    // rotate camera.position directly around the Y axis through controls.target
    // and let controls.update() recompute its internal spherical state.
    _initTwistGesture(canvas) {
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
    }

    // Distinguish click from drag: only fire _onCanvasClick when the pointer
    // barely moved between down and up.
    _initClickDetection(canvas) {
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
    }

    // Wire the selected-repeater info panel's action buttons (close, filter,
    // look-at, pin).
    _initInfoPanelEvents() {
        if (!this.infoEl) return;
        this.infoEl.addEventListener('click', e => {
            if (e.target.closest('.smi-close')) {
                this._selectedCol = null;
                this._rebuildDots();
                this._updateInfoPanel();
                this.onSelect?.(null);
            } else if (e.target.closest('.smi-filter')) {
                this.onFilter?.(this._selectedCol);
            } else if (e.target.closest('.smi-look')) {
                const loc = this._repeaterLocation(this._selectedCol);
                if (loc) this.faceLatLon(loc.lat, loc.lon);
            } else if (e.target.closest('.smi-pin')) {
                this.onToggleMapPin?.(this._selectedCol);
                this._updateInfoPanel();   // reflect the new pin state
            }
        });
    }

    // Per-frame render loop, runs for the map's lifetime.
    _startRenderLoop() {
        const tick = () => {
            this._stepCameraAnim();
            this.controls.update();
            this._updateNearPlane();
            this._maybeRebuildDots();
            this._scaleMarkerToScreen();
            this.renderer.render(this.scene, this.camera);
            requestAnimationFrame(tick);
        };
        tick();
    }

    // Keep the camera near plane proportional to the current view distance: small
    // when zoomed in (so a very close minDistance on a large-extent map never
    // clips the floor) and large when zoomed out (so depth precision stays good
    // and dots don't z-fight the map). This is what lets minDistance scale all the
    // way down for the closest zoom without a fixed lower clamp.
    _updateNearPlane() {
        const near = Math.max(0.002, this.controls.getDistance() * 0.02);
        if (Math.abs(near - this.camera.near) > this.camera.near * 0.05) {
            this.camera.near = near;
            this.camera.updateProjectionMatrix();
        }
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
                    if (!this._watchId) this.startWatching();
                } else if (p.state === 'denied') {
                    // Keep the button live so the user can retry — "denied" is also
                    // what some browsers report when location is simply turned off at
                    // the OS level, and that recovers once it's switched back on.
                    // A permanently-disabled button would leave no way back.
                    this._setStatus('Location off or denied — enable it, then tap “Enable location”.');
                    if (this.btnEl) { this.btnEl.disabled = false; this.btnEl.textContent = 'Enable location'; }
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

    // Every status message means "location isn't available (yet)". Show the
    // message where the "Center on me" button normally sits and hide that button
    // — it only makes sense once we have a fix. _locationReady() does the inverse.
    _setStatus(text) {
        if (this.statusEl) {
            this.statusEl.textContent = text;
            this.statusEl.classList.remove('hidden');
        }
        if (this.centerBtnEl) this.centerBtnEl.classList.add('hidden');
    }

    _locationReady() {
        if (this.statusEl) this.statusEl.classList.add('hidden');
        if (this.centerBtnEl) this.centerBtnEl.classList.remove('hidden');
    }

    startWatching() {
        if (!('geolocation' in navigator) || this._watchId != null) return;
        this._setStatus('Requesting location… (allow in browser if prompted)');
        if (this.btnEl) this.btnEl.disabled = true;
        let resolved = false;
        const failTimer = setTimeout(() => {
            if (!resolved) {
                // Don't clear the watch — GPS may just be slow (cold start takes
                // 1–2 min). The success callback will fire and hide the button
                // once a fix arrives. Show a context-appropriate message.
                const msg = window.__MESHCORE_NATIVE__
                    ? 'Waiting for GPS fix… (cold start may take 1–2 minutes outdoors)'
                    : 'No response from browser — check location permissions or browser shields (e.g. Brave).';
                this._setStatus(msg);
            }
        }, 30000);
        this._watchId = navigator.geolocation.watchPosition(
            pos => {
                resolved = true;
                clearTimeout(failTimer);
                if (this.btnEl) this.btnEl.classList.add('hidden');
                const { latitude, longitude, accuracy } = pos.coords;
                // Drop one-off GPS outliers (the ~200 m spikes) before they reach
                // the marker or get stamped onto packets; a rejected fix returns a
                // dead-reckoned point (or null to hold) instead of the raw spike.
                const fix = this._gpsAccept(latitude, longitude, accuracy, pos.timestamp || Date.now());
                if (!fix) return;
                this._userLoc = { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy };
                this._locationReady();   // swap the status text for the "Center on me" button
                if (this.emptyEl && !this._rxPoints.length) {
                    this.emptyEl.textContent = 'Waiting for data…';
                }
                this._scheduleMapUpdate();
                this._updateUserMarker();
                // In follow mode, glide after the user only once their marker
                // drifts out of the central-third dead zone — small moves don't
                // nudge the map. Never recentre mid-gesture (it would fight the
                // user's drag).
                if (this._followUser && !this._userDragging && !this._followTargetInDeadZone()) this.flyToUser(450);
            },
            err => {
                resolved = true;
                clearTimeout(failTimer);
                this._setStatus(`Location error: ${err.message}`);
                if (this.btnEl) { this.btnEl.disabled = false; this.btnEl.classList.remove('hidden'); }
                // Kill the underlying watch before dropping the id: a transient
                // error (e.g. timeout) leaves it alive, so a re-tap would
                // otherwise start a second concurrent watch.
                if (this._watchId != null) navigator.geolocation.clearWatch(this._watchId);
                this._watchId = null;
            },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
        );
    }

    // Outlier rejection for GPS fixes, with a moving/stationary split:
    //  • Moving (a sustained, above-noise track — see the streak below): gate on
    //    acceleration — reject a fix that deviates from the constant-velocity
    //    prediction by more than plausible accel (0.5·a·Δt²) + accuracy + noise;
    //    for a rejected fix dead-reckon along the smoothed velocity so the marker
    //    keeps gliding.
    //  • Stationary / starting from rest: the velocity estimate is just noise, so
    //    don't dead-reckon. Accept jitter and a plausible first move, reject
    //    spikes, and HOLD on a reject (this kills the standstill "fling").
    // "Moving" needs GPS_MOVE_STREAK consecutive above-noise steps, so a one-off
    // jitter (even a big one) can't masquerade as velocity and fling the marker.
    // Anti-stuck: after GPS_MAX_REJECT rejects in a row, trust the fix (real jump /
    // tunnel exit) and re-seed. State only advances on real accepted fixes.
    // Returns { lat, lon, accuracy } to use, or null to hold the last position.
    _gpsAccept(lat, lon, accuracy, t) {
        const last = this._gpsLast;
        if (!last) { this._gpsLast = { lat, lon, t, accuracy }; this._gpsVel = { x: 0, y: 0 }; this._gpsMoveStreak = 0; this._gpsReject = 0; return { lat, lon, accuracy }; }

        const dt = Math.max(0.001, (t - last.t) / 1000);   // seconds since last accepted fix
        const mPerDegLat = 111320;
        const mPerDegLon = 111320 * Math.cos(last.lat * Math.PI / 180);
        const nx = (lon - last.lon) * mPerDegLon;          // metres moved from last fix
        const ny = (lat - last.lat) * mPerDegLat;
        const step  = Math.hypot(nx, ny);
        const noise = GPS_NOISE_K * Math.max(accuracy || 0, last.accuracy || 0);
        const vel   = this._gpsVel;
        const moving = this._gpsMoveStreak >= GPS_MOVE_STREAK && Math.hypot(vel.x, vel.y) > GPS_MIN_SPEED;

        let reject;
        if (moving) {
            const residual = Math.hypot(nx - vel.x * dt, ny - vel.y * dt);  // deviation from prediction
            reject = accuracy > GPS_MAX_ACC || residual > 0.5 * GPS_MAX_ACCEL * dt * dt + 2 * (accuracy || 0) + GPS_BASE_TOL;
        } else {
            // From rest: a plausible move is bounded by acceleration; anything more
            // (beyond jitter noise) is a spike.
            reject = accuracy > GPS_MAX_ACC || step > 0.5 * GPS_MAX_ACCEL * dt * dt + noise + GPS_BASE_TOL;
        }

        if (reject && this._gpsReject < GPS_MAX_REJECT) {
            this._gpsReject++;
            if (!moving) return null;   // stationary — hold (don't fling along noise)
            // Dead-reckon: glide along the smoothed velocity. dt grows while we
            // keep rejecting (so the point advances) but is capped so even a wrong
            // velocity can't fling far. State stays on real fixes.
            const ddt = Math.min(dt, GPS_DR_MAX_DT);
            return {
                lat: last.lat + (vel.y * ddt) / mPerDegLat,
                lon: last.lon + (vel.x * ddt) / mPerDegLon,
                accuracy: last.accuracy,
            };
        }

        // Accept. Update the smoothed velocity; build the "moving" streak only from
        // sustained above-noise steps so standstill jitter can't trip it.
        const instX = nx / dt, instY = ny / dt, a = GPS_VEL_SMOOTH;
        if (reject) {                  // forced accept after holding — trust & re-seed
            this._gpsVel = { x: instX, y: instY };
            this._gpsMoveStreak = 0;
        } else {
            this._gpsVel = { x: a * instX + (1 - a) * vel.x, y: a * instY + (1 - a) * vel.y };
            if (step > noise && Math.hypot(this._gpsVel.x, this._gpsVel.y) > GPS_MIN_SPEED) this._gpsMoveStreak++;
            else this._gpsMoveStreak = 0;
        }
        this._gpsLast = { lat, lon, t, accuracy };
        this._gpsReject = 0;
        return { lat, lon, accuracy };
    }

    currentLocation() {
        return this._userLoc;
    }

    // ---- Filter ----

    // Pass col => boolean to show only matching repeaters; null to show all.
    // Migrate stored points/state when the main app renames a repeater column
    // (e.g. promotion or demote-to-collision). Without this, beads would
    // keep the stale col and lose their selection / color sync.
    renameCol(oldCol, newCol) {
        if (oldCol === newCol) return;
        for (const p of this._rxPoints) {
            if (p.col === oldCol) p.col = newCol;
        }
        // Live sent stars share the col namespace, so migrate them too (but not
        // _histOutgoingPts — those are rebuilt from disk).
        for (const p of this._outgoingPts) {
            if (p.col === oldCol) p.col = newCol;
        }
        if (this._selectedCol === oldCol) {
            this._selectedCol = newCol;
            this._updateInfoPanel();
        }
        this._rebuildDots();
    }

    // For un-merging a previously-promoted column. classifier(rawId) returns
    // a new col to migrate the point to, or null/undefined to leave it.
    splitPoints(oldCol, classifier) {
        let touched = false;
        for (const p of this._rxPoints) {
            if (p.col !== oldCol) continue;
            const target = classifier(p.rawId);
            if (target && target !== oldCol) {
                p.col = target;
                touched = true;
            }
        }
        // Same reassignment for live sent stars (leave _histOutgoingPts alone).
        for (const p of this._outgoingPts) {
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
            this._rebuildDots();
        }
    }

    setFilterFn(fn) {
        this._filterFn = fn;
        // If the currently selected repeater is now filtered out, deselect it
        if (this._selectedCol && fn && !fn(this._selectedCol)) {
            this._selectedCol = null;
            this._updateInfoPanel();
            this.onSelect?.(null);
        }
        this._rebuildDots();
    }

    setDisplayCutoff(cutoffMs) {
        this._displayCutoff = cutoffMs || 0;
        this._rebuildDots();
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

        // Pick the front-most dot first so its camera distance can override an
        // occluded emoji-icon sprite: icons use depthTest, so a lit ball drawn
        // in front of one hides it on screen — clicking there must select the
        // ball, not the hidden icon. Label sprites render on top and keep
        // priority (maxDist only gates non-label icon hits).
        const dot = this._pickRxPoint(e, rect);
        if (this._pickPinSprite(e, rect, dot.camDist)) return;
        this._commitSelection(dot.newCol, dot.clickedPt);
    }

    // Apply a new selection: rebuild dots, notify the host and refresh the info
    // panel. `clickedPt` is the picked RX/TX point (null for non-point sources).
    _commitSelection(newCol, clickedPt = null) {
        this._clickedPoint = clickedPt;
        this._selectedCol = newCol;
        this._rebuildDots();
        this.onSelect?.(newCol);   // may call selectColumn() back, which resets _infoPanelFromClick
        this._infoPanelFromClick = !!newCol;   // set after the feedback loop so panel stays visible
        this._updateInfoPanel();
    }

    // Hit-test the static marker sprites. Returns true if the click was handled
    // (toggling a pin via the label's [x] corner, or selecting the marker's
    // column); false if no sprite was hit.
    _pickPinSprite(e, rect, maxDist = Infinity) {
        if (!this._pinSprites.length) return false;
        const clickableEntries = this._pinSprites.filter(s => !s.isClose);
        const sprites = clickableEntries.map(s => s.sprite);
        const hits = this._raycaster.intersectObjects(sprites);
        if (hits.length === 0) return false;
        const hit = hits[0];
        const entry = clickableEntries.find(s => s.sprite === hit.object);
        if (!entry) return false;
        // Emoji-icon sprites use depthTest, so a closer lit dot hides them on
        // screen. Reject a hit on an occluded icon (hit point farther from the
        // camera than the front-most dot under the cursor) so picking agrees
        // with rendering, falling through to the dot. Labels render on top and
        // keep priority.
        if (!entry.isLabel && this.camera.position.distanceTo(hit.point) > maxDist) return false;
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
            // Confine the toggle to the 📌/✕ glyph at the right edge. The glyph is
            // ~1 label-height wide, so scale the hotspot by the sprite aspect
            // ratio — otherwise a long repeater name's tail (far left of the
            // glyph) would accidentally pin/remove the marker.
            const hotspotFrac = 0.5 - (ss.y / ss.x) * 0.5;
            if (nx > hotspotFrac && ny > 0.05) {
                if (entry.isPinned) this.onRemoveMarker?.(entry.col, entry.pubKeyFullHex);
                else               this.onPinMarker?.(entry.col, entry.pubKeyFullHex);
                return true;
            }
        }
        const newCol = entry.col === this._selectedCol ? null : entry.col;
        this._commitSelection(newCol);
        return true;
    }

    // Screen-space pick against the actually-rendered dot positions. The dots
    // are drawn at ~constant screen size (dampened-perspective shader), so a
    // 3D ray-vs-world-sphere test mis-selects when dots stack vertically
    // (same lat/lon, different SNR height) or sit near each other. Projecting
    // each dot and choosing the one nearest the cursor matches what the user
    // sees — and clicking the guide line (away from the ball) no longer hits.
    // Returns { newCol, clickedPt } (both null when nothing is hit).
    _pickRxPoint(e, rect) {
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        const groupSy = this._rxPointsGroup?.scale.y ?? 1;
        const PICK_RADIUS = 16; // CSS px around a dot centre
        const TIE = 8;          // dots this close on screen count as overlapping
        const _v = new THREE.Vector3();
        const candidates = [];
        for (const p of this._hitPoints) {
            const wp = this._latLonToWorld(p.lat, p.lon);
            if (!wp) continue;
            _v.set(wp.x, this._signalToHeight(p.snr) * groupSy, wp.z);
            const camDist = this.camera.position.distanceTo(_v);
            _v.project(this.camera);
            if (_v.z > 1) continue; // behind the camera
            const sx = (_v.x * 0.5 + 0.5) * rect.width;
            const sy = (-_v.y * 0.5 + 0.5) * rect.height;
            const d = Math.hypot(sx - px, sy - py);
            if (d <= PICK_RADIUS) candidates.push({ p, d, camDist });
        }
        // Nearest to the cursor wins; for dots overlapping on screen prefer the
        // front-most (the one visually on top).
        let best = null;
        for (const c of candidates) {
            if (!best) { best = c; continue; }
            if (Math.abs(c.d - best.d) <= TIE) { if (c.camDist < best.camDist) best = c; }
            else if (c.d < best.d) best = c;
        }
        if (best) {
            // camDist lets _onCanvasClick reject emoji icons occluded by this dot.
            if (this._clickedPoint === best.p) return { newCol: null, clickedPt: null, camDist: best.camDist };
            return { newCol: best.p.col, clickedPt: best.p, camDist: best.camDist };
        }
        return { newCol: null, clickedPt: null, camDist: Infinity };
    }

    _updateInfoPanel() {
        if (!this.infoEl) return;
        const col = this._selectedCol;
        if (!col || !this._infoPanelFromClick) { this.infoEl.classList.add('hidden'); return; }
        // Consider both received (sphere) and sent (star) points so a repeater
        // we've only ever transmitted to still shows a panel when clicked.
        const pts = this._rxPoints.filter(p => p.col === col)
            .concat((this._histOutgoingPts ?? this._outgoingPts).filter(p => p.col === col));
        if (!pts.length) { this.infoEl.classList.add('hidden'); return; }
        const isPseudo = col === 'direct' || col === 'unknown';
        const dotStyle = isPseudo
            ? `background:${col === 'direct' ? '#ffd400' : '#fff'};border:2px solid ${col === 'direct' ? '#111' : '#c00'};box-sizing:border-box`
            : `background:${this.colorFor(col)}`;
        const dot      = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;${dotStyle};margin-right:5px;flex-shrink:0"></span>`;
        const name     = this.nameForCol ? this.nameForCol(col) : null;
        const nameHtml = name ? ` <span class="smi-colname">${this._escHtml(name)}</span>` : '';
        // Use the exact clicked point; fall back to latest point for the column
        const p = (this._clickedPoint?.col === col) ? this._clickedPoint
            : pts.reduce((best, q) => q.time > best.time ? q : best, pts[0]);
        const snrStr  = p.snr  != null ? `${p.snr  >= 0 ? '+' : ''}${p.snr.toFixed(1)} dB`  : null;
        const rssiStr = p.rssi != null ? `${p.rssi} dBm` : null;
        const timeStr = new Date(p.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const sigParts = [snrStr ? `SNR <b>${this._escHtml(snrStr)}</b>` : null,
                          rssiStr ? `RSSI <b>${this._escHtml(rssiStr)}</b>` : null].filter(Boolean);
        const sigHtml = sigParts.length
            ? `<div class="smi-sig">${sigParts.join(' &nbsp; ')}<span class="smi-time">${timeStr}</span></div>` : '';
        // When the repeater's own GPS location is known (it has a static marker),
        // offer an "eye" button (turn the map toward it) and a pushpin button
        // (keep it on the map permanently / remove). Tilted pin = shown only
        // temporarily; upright pin = kept on the map.
        const hasLoc = this._repeaterLocation(col) != null;
        let actionsHtml = '';
        if (hasLoc) {
            const pinned = (this._pins || []).some(m => m.col === col && (m.lat || m.lon) && m.isPinned);
            const pinTitle = pinned
                ? 'Kept on the map — click to remove'
                : 'Shown temporarily — click to keep on the map';
            // Inline SVG pushpin (orientation is controlled by CSS rotation, not by
            // platform emoji rendering): tilted = temporary, upright = kept.
            const pinSvg = `<svg class="smi-pin-svg" viewBox="0 0 24 24" aria-hidden="true">` +
                `<rect x="10.5" y="7" width="3" height="6" fill="currentColor"/>` +
                `<path d="M12 22 L10.5 13 L13.5 13 Z" fill="currentColor"/>` +
                `<ellipse cx="12" cy="6" rx="7.5" ry="3.6" fill="#e53935"/></svg>`;
            actionsHtml =
                `<button class="smi-look" title="Turn the map toward this repeater">👁</button>` +
                `<button class="smi-pin${pinned ? ' pinned' : ''}" title="${pinTitle}">${pinSvg}</button>`;
        }
        this.infoEl.innerHTML =
            `<button class="smi-close" title="Deselect">✕</button>` +
            `<div class="smi-name">${dot}<b>${this._escHtml(this.displayId(col))}</b>${nameHtml}${actionsHtml}</div>` +
            sigHtml;
        this.infoEl.classList.remove('hidden');
    }

    _escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- Static contact markers ----

    setStaticMarkers(markers) {
        this._disposePins();
        this._pins = markers || [];
        if (this._pins.length && this.emptyEl) this.emptyEl.classList.add('hidden');
        this._rebuildPins();
    }

    _disposePins() {
        for (const g of this._pinGroups) disposeObject3D(g);
        this._pinGroups = [];
        this._pinSprites = [];
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
        // depthTest: true so the icon is occluded by spheres standing in front of
        // it — it should sit in the 3D scene, not float permanently on top. Lit
        // dots write depth (see _makeDotPoints), so the billboard is hidden behind
        // any ball nearer the camera than the icon's anchor. depthWrite stays false:
        // the emoji's antialiased edges shouldn't stamp a hard depth halo. The
        // renderOrder (10, after the dots at 2) ensures the dots have written their
        // depth before the icon is tested against it.
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true });
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
        // depthTest: false so the text label always stays on top and readable, even
        // when a sphere is in front of it. (The repeater icon itself is depth-tested
        // and does hide behind nearer balls — only the label floats above.)
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        sprite.renderOrder = 10;
        const aspect = c.width / c.height;
        sprite.scale.set(aspect * 2.4, 2.4, 1);
        sprite.position.set(0, 3.6, 0);
        return sprite;
    }

    _rebuildPins() {
        this._disposePins();
        if (!this._pins.length || !this._tileBounds) return;
        for (const m of this._pins) {
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

            // 📡 emoji sprite — sits on the ground (no mast). Click target for selection.
            const emojiSprite = this._makeEmojiSprite('📡', 1.2);
            group.add(emojiSprite);
            this._pinSprites.push({ sprite: emojiSprite, col: markerCol, pubKeyFullHex, isClose: false, isLabel: false });

            // Text label sprite — click target; corner region detected by normalized hit coords
            const labelSprite = this._makeMarkerLabel(m.id ?? '', m.name ?? null, hexColor, isPinned);
            group.add(labelSprite);
            this._pinSprites.push({ sprite: labelSprite, col: markerCol, pubKeyFullHex, isClose: false, isLabel: true, isPinned });

            group.position.set(pos.x, 0, pos.z);
            this.scene.add(group);
            this._pinGroups.push(group);
        }
    }

    // ---- Map source ----

    clearPoints() {
        this._rxPoints = [];
        this._outgoingPts = [];
        this._histPoints = null;
        this._histOutgoingPts = null;
        this._selectedCol = null;
        this._disposeDots();
        this._removeOverlay();
        this._updateInfoPanel();
        this.onSelect?.(null);
        if (this.emptyEl) {
            this.emptyEl.classList.remove('hidden');
            this.emptyEl.textContent = 'Waiting for data…';
        }
    }

    setSphereSize(n) {
        if (n === this._sphereSize) return;
        this._sphereSize = n;
        this._rebuildDots();
    }

    setPerspSize(v) {
        if (!!v === this._perspSize) return;
        this._perspSize = !!v;
        this._rebuildDots();
    }

    setShowLines(v) {
        this._showLines = !!v;
        if (this._lineSegs)    this._lineSegs.visible    = this._showLines;
        if (this._lineSegsDim) this._lineSegsDim.visible = this._showLines;
    }

    setShowMarker(v) {
        this._showMarker = !!v;
        if (this._userMarker) this._userMarker.visible = this._showMarker;
        this._scheduleMapUpdate();
    }

    setShowDeviceMarker(v) {
        this._showDevice = !!v;
        if (this._deviceMarker) this._deviceMarker.visible = this._showDevice && !!this._deviceLoc;
        this._scheduleMapUpdate();
    }

    // The connected device's own (configured/advertised) position. Pass null —
    // or 0,0 — to clear it (no position / unsupported).
    setDeviceLocation(lat, lon) {
        if (lat == null || lon == null || (lat === 0 && lon === 0)) {
            this._deviceLoc = null;
            if (this._deviceMarker) this._deviceMarker.visible = false;
            this._scheduleMapUpdate();
            return;
        }
        this._deviceLoc = { lat, lon };
        this._updateDeviceMarker();
        this._scheduleMapUpdate();
    }

    setMapSource(source) {
        if (!TILE_SOURCES[source] || source === this._mapSource) return;
        this._mapSource = source;
        this._lastMapKey = null;
        this._removeOverlay();
        this._scheduleMapUpdate();
    }

    // Map background (clear colour) and plain-floor colour, both theme-aware.
    // The background matches the app's content/table background (the --bg-content
    // var, e.g. behind "Seen repeaters") so the map sky — and the placeholder
    // shown mid-resize — blends with the rest of the UI instead of a flat black.
    _bgColor() {
        try {
            const c = getComputedStyle(document.documentElement).getPropertyValue('--bg-content').trim();
            if (c) return new THREE.Color(c);
        } catch (_) {}
        return new THREE.Color(this.isDarkMode() ? 0x091525 : 0xeef2f7);
    }
    _floorColor() { return this.isDarkMode() ? 0x000000 : 0xdcdcdc; }

    // Called by the host app when the page theme (light/dark) toggles.
    applyTheme() {
        this.renderer.setClearColor(this._bgColor());
        // When no tiles are drawn (placeholder floor, or "none" source) the floor
        // colour comes from the theme — refresh it. With real tiles the floor is
        // the imagery itself, so only the background needed updating above.
        if (!this._tileBounds) {
            this._mapMesh?.material.color.set(this._floorColor());
        } else if (this._mapSource === 'none') {
            this._lastMapKey = null;
            this._scheduleMapUpdate();
        }
    }

    // ---- Packet ingestion ----

    addPacket(opts) {
        if (opts.lat == null || opts.lon == null || opts.snr == null) return;
        this._rxPoints.push({ ...opts });
        if (this.emptyEl) this.emptyEl.classList.add('hidden');
        if (opts.col === this._selectedCol) this._updateInfoPanel();
        // Coalesced rebuild (see _maybeRebuildDots): throttled to ≤1/200ms and
        // skipped while dragging, so it never starves the frame loop. In a wide
        // ("All") view this folds the new point into the rendered tail on top of
        // the disk grid (see _rebuildDots), so it shows without a disk re-scan.
        this._dotsDirty = true;
        this._scheduleMapUpdate();
    }

    addSentSnrPacket(opts) {
        if (opts.lat == null || opts.lon == null || opts.snr == null) return;
        this._outgoingPts.push({ ...opts });
        if (this.emptyEl) this.emptyEl.classList.add('hidden');
        // Rendered immediately: live mode draws _outgoingPts directly; in hist
        // mode the render adds points newer than the disk layer as a tail.
        this._dotsDirty = true;
    }

    // Rebuild dots from a coalesced dirty flag, throttled and never mid-gesture,
    // so live capture doesn't fight the camera. Called once per frame from tick.
    _maybeRebuildDots() {
        if (!this._dotsDirty || this._userDragging) return;
        const now = performance.now();
        if (now - this._lastDotsBuild < 200) return;
        this._dotsDirty = false;
        this._lastDotsBuild = now;
        this._rebuildDots();
    }

    // Replace the render source with a pre-gridded set of historical points from
    // disk (wide / "All" view). Pass null to return to the live in-RAM points.
    // Each point: { lat, lon, snr, rssi, col, time, rawId, count }.
    setHistoricalPoints(arr) {
        this._histPoints = (arr && arr.length) ? arr : (arr ? [] : null);
        if (this.emptyEl && this._histPoints && this._histPoints.length) this.emptyEl.classList.add('hidden');
        // Coalesced rebuild (≤1/200 ms, skipped while dragging) — live upserts
        // push updated point sets frequently during capture.
        this._dotsDirty = true;
        this._scheduleMapUpdate();
    }

    // Disk-loaded outgoing-SNR points for wide / "All" views (parallel to
    // setHistoricalPoints for incoming). Pass null to use the live _outgoingPts.
    // Each point: { lat, lon, snr, col, time, rawId }.
    setHistoricalSentPoints(arr) {
        this._histOutgoingPts = (arr && arr.length) ? arr : (arr ? [] : null);
        this._histSentAt = Date.now();   // live sent points after this are the tail
        this._dotsDirty = true;
    }

    // Fire onViewChange (debounced) so the host can re-query a finer disk grid
    // for the now-visible region when the user zooms or pans.
    _notifyViewChange() {
        if (!this.onViewChange) return;
        clearTimeout(this._viewChangeTimer);
        this._viewChangeTimer = setTimeout(() => this._fireViewChange(), 350);
    }

    // Fire onViewChange NOW for the current camera view (bypasses the debounce).
    // Called directly on gesture 'end' so a continuous damping 'change' stream
    // can't starve the debounced path (see the 'end' handler).
    _fireViewChange() {
        clearTimeout(this._viewChangeTimer);
        this._viewChangeTimer = null;
        if (!this.onViewChange) return;
        const bb = this._cameraViewBbox();
        if (bb) this.onViewChange(bb, this._metersPerPixel());
    }

    // True when the map can be seen right now: app foreground and the canvas in
    // the viewport. Gates detail-tile fetches so off-screen following is silent.
    _isMapVisible() {
        return !document.hidden && this._mapInView !== false;
    }

    // Debounced detail-tile refresh. Coalesces the stream of camera-change events
    // (drag, zoom, follow animation) into one _updateOverlay once movement settles.
    _scheduleOverlayUpdate(delay = 700) {
        clearTimeout(this._overlayTimer);
        this._overlayTimer = setTimeout(() => this._updateOverlay(), delay);
    }

    _metersPerPixel() {
        const bb = this._cameraViewBbox();
        if (!bb) return null;
        const h = this.canvas.clientHeight || 600;
        return ((bb.maxLat - bb.minLat) * 111320) / h;
    }

    // Set the closest zoom (controls.minDistance) from the map's real-world scale,
    // so the deepest zoom shows ~ZOOM_MIN_VIEW_M across whether the plane covers a
    // few hundred metres or tens of km. The plane is always PLANE_SIZE world units,
    // so metres-per-world-unit grows with the area covered; without this, a large
    // map could only zoom to a city-block view.
    _applyZoomLimits() {
        if (!this._tileBounds) return;
        const { x0, y0, nx, ny, zoom } = this._tileBounds;
        const lat = tileToLatLon(x0 + nx / 2, y0 + ny / 2, zoom).lat;
        // Web-Mercator ground resolution: 156543.03 m/px at the equator, zoom 0.
        const mPerPx = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
        const realLongEdge = Math.max(nx, ny) * TILE_PX * mPerPx;   // metres across the plane's long edge
        const mPerUnit = realLongEdge / PLANE_SIZE;
        const ff = fovFactor(this.camera);
        // World-unit distance for a ~ZOOM_MIN_VIEW_M-wide view. It scales with the
        // map's metres-per-unit precisely so the *real* closest zoom is the same at
        // any extent. Only an upper cap (0.5) remains, so small maps can still zoom
        // even closer; there's no lower clamp — _updateNearPlane keeps the near
        // plane out of the way however small this gets.
        const desired = ZOOM_MIN_VIEW_M / (mPerUnit * ff);
        this.controls.minDistance = Math.min(0.5, Math.max(0.002, desired));
    }

    // Called by the host app when chart/legend selection changes.
    selectColumn(col) {
        this._infoPanelFromClick = false;   // always hide info panel on external selection
        if (this._selectedCol === col) {
            this._updateInfoPanel();
            return;
        }
        this._selectedCol = col ?? null;
        this._rebuildDots();
        this._updateInfoPanel();
    }

    // Drop packets older than the given timestamp. Disposes their meshes and
    // refreshes selection / info panel if the active repeater goes away.
    // Whether `col` still has any rendered point — across every source
    // _rebuildDots draws: live or historical RX dots, plus live or historical
    // outgoing-SNR stars. Used to decide if a dropped point should clear the
    // selection.
    _isColShown(col) {
        // Collision keys are "a/b" (two merged repeater prefixes). A point's col
        // and the selected col can legitimately differ across the merge boundary
        // (an ambiguous packet may sit under "a/b" while a sibling is under "a"),
        // so match leniently: equal, or sharing any "/"-segment. A strict ===
        // wrongly reported a collision selection as gone on a cleanup tick and
        // deselected it (clearing the table filter and notice too).
        const shown = p => colsOverlap(p.col, col);
        const rx = this._histPoints != null ? this._histPoints : this._rxPoints;
        if (rx.some(shown)) return true;
        const sent = this._histOutgoingPts != null
            ? this._histOutgoingPts.concat(this._outgoingPts)
            : this._outgoingPts;
        return sent.some(shown);
    }

    purgeOlderThan(cutoff) {
        if (!Number.isFinite(cutoff)) return;
        const before     = this._rxPoints.length;
        const sentBefore = this._outgoingPts.length;
        this._rxPoints   = this._rxPoints.filter(p => p.time >= cutoff);
        this._outgoingPts = this._outgoingPts.filter(p => p.time >= cutoff);
        if (this._rxPoints.length === before && this._outgoingPts.length === sentBefore) return;
        // Only drop the selection if the selected repeater is no longer rendered
        // at all (see _isColShown). Checking just _rxPoints wrongly deselected a
        // repeater shown only via _histPoints (wide/"All" mode) or only as an
        // outgoing-SNR star — which fired intermittently, whenever a point
        // happened to expire on a cleanup tick.
        if (this._selectedCol && !this._isColShown(this._selectedCol)) {
            this._selectedCol = null;
            this._updateInfoPanel();
            this.onSelect?.(null);
        }
        this._rebuildDots();
    }

    _scheduleMapUpdate() {
        clearTimeout(this._mapTimer);
        this._mapTimer = setTimeout(() => this._updateMap(), 500);
    }

    // Fetch an nx×ny grid of map tiles, stitch them onto a single canvas and
    // return it as a ready-to-use THREE texture.  Used for both the base map
    // and the high-zoom detail overlay.  When withAttrib is true the source's
    // attribution string is painted into the bottom-right corner.
    async _stitchTiles(sourceId, zoom, x0, y0, nx, ny, withAttrib) {
        const src = TILE_SOURCES[sourceId];
        const canvas = document.createElement('canvas');
        canvas.width  = nx * TILE_PX;
        canvas.height = ny * TILE_PX;
        const ctx = canvas.getContext('2d');
        // Placeholder for missing/failed tiles: match the theme so it doesn't
        // glare as a light block on the dark basemap.
        ctx.fillStyle = this.isDarkMode() ? '#1a1a1a' : '#dfdfdf';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // "None" source: no imagery, just a plain theme-aware floor (no fetches,
        // no attribution).
        if (!src.url) {
            ctx.fillStyle = this.isDarkMode() ? '#000000' : '#eef2f7';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const tex = new THREE.CanvasTexture(canvas);
            tex.colorSpace  = THREE.SRGBColorSpace;
            tex.minFilter   = THREE.LinearFilter;
            tex.needsUpdate = true;
            return tex;
        }

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

        if (withAttrib) {
            ctx.font = '11px system-ui, sans-serif';
            const tw = ctx.measureText(src.attrib).width;
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.fillRect(canvas.width - tw - 10, canvas.height - 17, tw + 8, 15);
            ctx.fillStyle = '#333';
            ctx.fillText(src.attrib, canvas.width - tw - 6, canvas.height - 6);
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace  = THREE.SRGBColorSpace;
        texture.minFilter   = THREE.LinearFilter;
        texture.anisotropy  = this.renderer.capabilities.getMaxAnisotropy();
        texture.needsUpdate = true;
        return texture;
    }

    _bbox() {
        const cutoff = this._displayCutoff;
        const source = this._histPoints ?? this._rxPoints;
        const locs = source
            .filter(p => (!cutoff || p.time >= cutoff) && (!this._filterFn || this._filterFn(p.col)))
            .map(p => ({ lat: p.lat, lon: p.lon }));
        // Include the user's own position in the tile bbox when the marker is
        // shown OR we're live-capturing — the latter keeps tiles under the user
        // even if they've hidden their marker and are moving with no packets
        // arriving. (When viewing a static import this is false, so a position
        // somewhere else doesn't pull the map off the data.)
        if (this._userLoc && (this._showMarker || this.isLiveCapture()))
            locs.push({ lat: this._userLoc.lat, lon: this._userLoc.lon });
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
        // Traffic saver: don't fetch the base floor while the map is off-screen;
        // remember it's due and rebuild once visible. When it does run it fits the
        // *current* data extent into a bounded tile grid (≤ MAX_TILES_AXIS²) — so
        // even after travelling 100 km it's a handful of tiles for where you are
        // now, never the whole path.
        if (!this._isMapVisible()) { this._mapPending = true; return; }
        this._mapPending = false;
        const bb = this._bbox();
        if (!bb) return;

        // Save the camera's entire orientation in geography + absolute-height units
        // so we can restore it exactly after the world coordinate system is rebuilt.
        // Both camera eye and look-at target are saved as lat/lon; height is
        // saved as absolute world units — the plane is always PLANE_SIZE wide so
        // camera.y has a consistent meaning regardless of tile zoom level.
        let savedCam = null;
        if (this._tileBounds && this._planeDim) {
            savedCam = {
                targetLL: this._worldToLatLon(this.controls.target.x, this.controls.target.z),
                eyeLL:    this._worldToLatLon(this.camera.position.x,  this.camera.position.z),
                eyeY:     this.camera.position.y,
            };
        }

        // Only pad when bbox has zero extent (single point) — otherwise the
        // +1 tile margin below already gives plenty of context, and bbox
        // padding here would only shrink the data area on screen.
        let { minLat, maxLat, minLon, maxLon } = bb;
        const padLat = (maxLat - minLat) || 0.0008;
        const padLon = (maxLon - minLon) || 0.0008;
        if (maxLat === minLat) { minLat -= padLat / 2; maxLat += padLat / 2; }
        if (maxLon === minLon) { minLon -= padLon / 2; maxLon += padLon / 2; }

        // Start from the current zoom so the world scale never changes unless
        // the bbox genuinely can't fit within MAX_TILES_AXIS tiles at that level.
        // Starting from 19 (the old approach) would eagerly drop zoom for any
        // bbox that the current level can already accommodate. Sources that
        // don't serve tiles all the way to z19 cap the starting level.
        const srcMaxZoom = TILE_SOURCES[this._mapSource].maxZoom ?? 19;
        const startZoom = Math.min(srcMaxZoom, this._tileBounds ? this._tileBounds.zoom : 19);
        const { zoom, tl, br } = this._fitZoomForBbox(minLon, maxLat, maxLon, minLat, startZoom);

        // Fixed 1-tile margin around the data bbox. A margin that scaled with the
        // bbox span (ceil(span/2), 1–2) flipped between 1 and 2 as the span
        // fluctuated by a tile while walking, which pulsed the grid — a tile ahead
        // would appear and then vanish a second later. A constant margin only
        // changes the grid monotonically as you cross tile boundaries.
        const maxTile = Math.pow(2, zoom) - 1;
        const padX = 1, padY = 1;
        const x0 = Math.max(0, Math.floor(tl.x) - padX);
        const y0 = Math.max(0, Math.floor(tl.y) - padY);
        const x1 = Math.min(maxTile, Math.floor(br.x) + padX);
        const y1 = Math.min(maxTile, Math.floor(br.y) + padY);
        const nx = x1 - x0 + 1;
        const ny = y1 - y0 + 1;

        const sourceId = this._mapSource;
        const key = `${sourceId}/${zoom}/${x0}/${y0}/${x1}/${y1}`;
        if (key === this._lastMapKey) {
            this._updateUserMarker();  // tiles unchanged — just move the user pin
            this._updateDeviceMarker();
            return;
        }

        this._mapBusy = true;
        try {
            const texture = await this._stitchTiles(sourceId, zoom, x0, y0, nx, ny, true);

            const aspect = nx / ny;
            const planeW = aspect >= 1 ? PLANE_SIZE : PLANE_SIZE * aspect;
            const planeH = aspect >= 1 ? PLANE_SIZE / aspect : PLANE_SIZE;

            if (this._mapMesh) disposeObject3D(this._mapMesh);
            const geo = new THREE.PlaneGeometry(planeW, planeH);
            const mat = new THREE.MeshBasicMaterial({ map: texture });
            this._mapMesh = new THREE.Mesh(geo, mat);
            this._mapMesh.rotation.x = -Math.PI / 2;
            this.scene.add(this._mapMesh);

            this._tileBounds  = { x0, y0, nx, ny, zoom };
            this._planeDim    = { w: planeW, h: planeH };
            this._lastMapKey = key;
            this._applyZoomLimits();  // let zoom reach street level regardless of map extent
            this._removeOverlay();   // scale changed — overlay must be rebuilt

            this._rebuildDots();
            this._rebuildPins();   // reposition markers against the new tile scale
            this._updateUserMarker();
            this._updateDeviceMarker();
            this._fitCameraOnce();         // no-op after the first tile load

            // Restore the camera to the same geographic look-at point and eye position.
            // Skipped when fitCamera() was called (e.g. after CSV import) — in that
            // case _fitCameraOnce() above has already centred the view on the data.
            if (savedCam && !this._forceFit) {
                const newTarget = this._latLonToWorld(savedCam.targetLL.lat, savedCam.targetLL.lon);
                const newEye    = this._latLonToWorld(savedCam.eyeLL.lat,    savedCam.eyeLL.lon);
                if (newTarget && newEye) {
                    this.controls.target.set(newTarget.x, 0, newTarget.z);
                    this.camera.position.set(newEye.x, savedCam.eyeY, newEye.z);
                    this.controls.update();
                    // Recompute with the now-correct camera distance so ball sizes
                    // match what they were before the tile rebuild.
                    this._updateHeightScale();
                }
            }
            this._forceFit = false;
        } finally {
            this._mapBusy = false;
        }
    }

    _fitCameraOnce() {
        if (this._cameraFit) return;
        const { w, h } = this._planeDim;
        const r = Math.max(w, h);
        this.camera.position.set(r * 0.4, r * 0.55, r * 0.6);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
        this._cameraFit = true;
        this._updateHeightScale();
    }

    // Force the camera to fit all current data on the next tile rebuild.
    // Call after bulk-importing points so the view centres on the imported data.
    fitCamera() {
        this._cameraFit = false;
        this._forceFit  = true;
    }

    // ---- Camera fly / turn animations ----

    // Known GPS location of a repeater column, or null. Looked up from the
    // static markers (a repeater only has a location once it has advertised GPS).
    // On a collision (several repeaters sharing this column, each with its own
    // GPS) we aim at the centroid — the midpoint of all known locations.
    _repeaterLocation(col) {
        if (!col) return null;
        const ms = (this._pins || []).filter(p => p.col === col && (p.lat || p.lon));
        if (!ms.length) return null;
        const lat = ms.reduce((s, p) => s + p.lat, 0) / ms.length;
        const lon = ms.reduce((s, p) => s + p.lon, 0) / ms.length;
        return { lat, lon };
    }

    // Drive a camera animation via a per-frame apply(easedProgress) closure.
    _animate(apply, duration = 700) {
        this._camAnim = { apply, start: performance.now(), duration };
    }

    _stepCameraAnim() {
        const a = this._camAnim;
        if (!a) return;
        const k = Math.min(1, (performance.now() - a.start) / a.duration);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
        a.apply(e);
        // Keep camera-only animations (e.g. faceLatLon) pinned to the ground, but
        // let a follow recenter animate its target height (set by apply) smoothly.
        if (!this._followUser) this.controls.target.y = 0;
        this._updateHeightScale();
        if (k >= 1) this._camAnim = null;
    }

    // Half the world height of a theoretical strongest-possible dot directly
    // above the user (rendered dots are scaled in Y by _rxPointsGroup.scale.y),
    // i.e. the midpoint between the ground and that dot.
    _followCenterY() {
        return MAX_HEIGHT * (this._rxPointsGroup?.scale.y ?? 1) / 2;
    }

    // The point "Center on me" frames: the user's position raised halfway up
    // toward a theoretical max-SNR dot directly above them, so the view shows the
    // marker plus the upward spire direction. Null until the location is known.
    _followTarget() {
        if (!this._userLoc) return null;
        const u = this._latLonToWorld(this._userLoc.lat, this._userLoc.lon);
        if (!u) return null;
        u.y = this._followCenterY();
        return u;
    }

    // Recenter the view on the follow target (keeps angle/zoom). Returns false
    // (and shows a status message) when the location is unknown.
    flyToUser(duration = 700) {
        if (!this._userLoc) {
            this._setStatus('Location not known yet — tap “Enable location” first.');
            return false;
        }
        if (!this._followTarget()) return false;
        const fromT = this.controls.target.clone();
        const fromE = this.camera.position.clone();
        // Recompute the target each frame: its height tracks the live dot scale,
        // which shifts as the camera distance changes during the move. Ending on
        // the live value means it exactly matches the height the follow handler
        // then maintains — no little snap at the end. Camera move is a flat pan.
        this._animate(e => {
            const target = this._followTarget();
            if (!target) return;
            const toE = fromE.clone().add(new THREE.Vector3(target.x - fromT.x, 0, target.z - fromT.z));
            this.controls.target.lerpVectors(fromT, target, e);
            this.camera.position.lerpVectors(fromE, toE, e);
        }, duration);
        return true;
    }

    // True while the user's marker projects within the central third of the
    // canvas (both axes). Follow mode uses this as its dead zone: inside it the
    // map is left alone and manual gestures don't disengage following.
    // True when the follow target (user↔best-dot midpoint) sits in the central
    // third of the view — i.e. already framed, so following needn't recenter and
    // a manual nudge that keeps it centred doesn't disengage follow.
    _followTargetInDeadZone() {
        const target = this._followTarget();
        if (!target) return false;
        const v = target.project(this.camera);   // NDC: visible canvas is -1..1
        return v.z < 1 && Math.abs(v.x) <= 1 / 3 && Math.abs(v.y) <= 1 / 3;
    }

    // "Center on me" is a toggle: pressing it once centres on the user exactly
    // and enters follow mode; pressing it again leaves it. While following, the
    // camera only glides after the user when their marker drifts out of the
    // central-third dead zone, and manual map movement keeps follow mode active
    // as long as the marker stays inside that zone.
    toggleFollowUser() {
        if (this._followUser) { this.setFollowUser(false); return; }
        if (this.flyToUser()) this.setFollowUser(true);
    }

    setFollowUser(on) {
        on = !!on;
        if (this._followUser === on) return;
        this._followUser = on;
        this.onFollowChange?.(on);
    }

    // Turn the camera (orbit around its current target) so it looks toward the
    // given location — i.e. that direction becomes "into the screen". Keeps the
    // zoom (orbit radius) constant. If the target is so far / the view so
    // top-down that it would fall above the frame, the camera is also tilted
    // toward the horizon (polar angle) so the repeater becomes visible.
    faceLatLon(lat, lon) {
        const R = this._latLonToWorld(lat, lon);
        if (!R) return false;
        const T = this.controls.target.clone();
        const dx = R.x - T.x, dz = R.z - T.z;
        const d = Math.hypot(dx, dz);
        if (d < 1e-3) return false; // already centred there

        // Current camera position in spherical coords around the target.
        const cx = this.camera.position.x - T.x;
        const cy = this.camera.position.y - T.y;
        const cz = this.camera.position.z - T.z;
        const r = Math.hypot(cx, cy, cz) || 1;
        const phi0   = Math.acos(Math.max(-1, Math.min(1, cy / r))); // polar from +Y
        const theta0 = Math.atan2(cz, cx);                            // azimuth
        // Camera must sit on the far side of the target from R so the view faces R.
        const thetaTo = Math.atan2(-dz, -dx);
        let dTheta = thetaTo - theta0;
        while (dTheta >  Math.PI) dTheta -= 2 * Math.PI;
        while (dTheta < -Math.PI) dTheta += 2 * Math.PI;

        // Vertical angle of R above the view centre (target) once R is straight
        // ahead. R is always above centre (it's farther along the ground), so if
        // that angle exceeds half the vertical FOV we tilt toward the horizon
        // (larger polar angle) until it fits comfortably.
        const maxPhi  = this.controls.maxPolarAngle ?? (Math.PI / 2 - 0.08);
        const fovRad  = this.camera.fov * Math.PI / 180;
        const offsetAt = phi => (Math.PI / 2 - phi) - Math.atan2(r * Math.cos(phi), d + r * Math.sin(phi));
        // Leave headroom above the repeater for ~4 dot-height units of its spire,
        // so the marker plus that stretch stay in view instead of the repeater
        // sitting near the top edge with the spire cut off. `want` is where the
        // repeater should sit above the view centre; tilt toward the horizon
        // whenever it would sit higher than that.
        const sy = this._rxPointsGroup?.scale.y ?? 1;
        const headroom = Math.atan2(4 * sy, r + d);   // angular height of ~4 units at the repeater
        const want = Math.max(0, fovRad / 2 * 0.6 - headroom);
        let phiTo = phi0;
        if (offsetAt(phi0) > want) {
            if (offsetAt(maxPhi) >= want) {
                phiTo = maxPhi;                  // as horizontal as allowed
            } else {
                let lo = phi0, hi = maxPhi;      // offset decreases as phi grows
                for (let i = 0; i < 24; i++) {
                    const m = (lo + hi) / 2;
                    if (offsetAt(m) > want) lo = m; else hi = m;
                }
                phiTo = hi;
            }
        }
        const dPhi = phiTo - phi0;

        this._animate(e => {
            const theta = theta0 + dTheta * e;
            const phi   = phi0   + dPhi   * e;
            const sinP  = Math.sin(phi);
            this.camera.position.x = T.x + r * sinP * Math.cos(theta);
            this.camera.position.z = T.z + r * sinP * Math.sin(theta);
            this.camera.position.y = T.y + r * Math.cos(phi);
        });
        return true;
    }

    _updateHeightScale() {
        // scale.y ∝ camera distance keeps spires a roughly constant *screen*
        // height across zoom. The floor only guards against zero (it must not bite
        // before deep zoom, or spires balloon on screen once you pass it).
        const ratio = Math.max(1e-6, this.controls.getDistance() / CAMERA_REF_DIST);
        this._rxPointsGroup.scale.y = ratio * 2;
        // Sit the detail overlay just above the base map but below the lowest dot
        // (MIN_HEIGHT·scale.y) and marker. A fixed offset can't do both: at deep
        // zoom the dampened dots/markers are tiny, so a 0.02 overlay would hide
        // them; tying it to scale.y keeps it clear of z-fighting yet under them.
        if (this._overlayMesh) this._overlayMesh.position.y = this._rxPointsGroup.scale.y * 0.1;
    }

    _updatePerspUniforms() {
        if (!this._perspSize) return;
        const camDist = this.controls.getDistance();
        for (const m of this._dotMeshes) {
            const u = m.material.userData.uRefDistUniform;
            if (u) u.value = camDist;
        }
    }

    _latLonToWorld(lat, lon) {
        if (!this._tileBounds || !this._planeDim) return null;
        const { x0, y0, nx, ny, zoom } = this._tileBounds;
        const t  = lonLatToTile(lon, lat, zoom);
        const fx = (t.x - x0) / nx;
        const fy = (t.y - y0) / ny;
        const { w, h } = this._planeDim;
        return new THREE.Vector3((fx - 0.5) * w, 0, (fy - 0.5) * h);
    }

    _worldToLatLon(wx, wz) {
        if (!this._tileBounds || !this._planeDim) return null;
        const { x0, y0, nx, ny, zoom } = this._tileBounds;
        const { w, h } = this._planeDim;
        const tx = (wx / w + 0.5) * nx + x0;
        const ty = (wz / h + 0.5) * ny + y0;
        const n = Math.pow(2, zoom);
        const lon = tx / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
        return { lat, lon };
    }

    _cameraViewBbox() {
        if (!this._tileBounds) return null;
        const center = this._worldToLatLon(this.controls.target.x, this.controls.target.z);
        if (!center) return null;
        // Target is clamped to y=0 so getDistance() ≈ camera-to-floor distance.
        // Multiply by 1.5 to cover tilted views where visible area extends past the
        // target. (No distance floor: at deep zoom it would overstate the view and
        // make the detail overlay pick too low a tile zoom.)
        const r = Math.max(1e-4, this.controls.getDistance()) * (fovFactor(this.camera) / 2) * 1.5;
        // Convert radius in world units → lon/lat delta using current tileBounds scale
        const { nx, ny, zoom } = this._tileBounds;
        const { w, h } = this._planeDim;
        const n = Math.pow(2, zoom);
        const lonDelta = r * nx / (w * n) * 360;
        // Web-Mercator stretches the y axis by 1/cos(lat), so a given world span
        // covers cos(lat)× fewer degrees of latitude than the raw scale implies.
        // Floor cos to avoid a zero/huge span near the poles.
        const latDelta = r * ny / (h * n) * 360 * Math.max(0.01, Math.cos(center.lat * Math.PI / 180));
        return {
            minLat: center.lat - latDelta, maxLat: center.lat + latDelta,
            minLon: center.lon - lonDelta, maxLon: center.lon + lonDelta,
        };
    }

    // ---- Detail overlay (high-zoom tiles when camera is close) ----

    // Highest zoom at which the lon/lat bbox fits within MAX_TILES_AXIS² tiles,
    // counting down from `startZoom`. Returns { zoom, tl, br } (tl/br = the
    // top-left / bottom-right tile coords at that zoom).
    _fitZoomForBbox(minLon, maxLat, maxLon, minLat, startZoom) {
        let zoom = startZoom, tl, br;
        while (zoom > 1) {
            tl = lonLatToTile(minLon, maxLat, zoom);
            br = lonLatToTile(maxLon, minLat, zoom);
            if (Math.floor(br.x) - Math.floor(tl.x) + 1 <= MAX_TILES_AXIS &&
                Math.floor(br.y) - Math.floor(tl.y) + 1 <= MAX_TILES_AXIS) break;
            zoom--;
        }
        return { zoom, tl, br };
    }

    // The detail-overlay target (tile rect + cache key) for the current camera
    // view, or null when no overlay is warranted. Recomputed after the fetch to
    // detect a stale view (camera moved during the await).
    _overlayTarget() {
        if (!this._tileBounds || this._mapSource === 'none') return null;
        const camBb = this._cameraViewBbox();
        if (!camBb) return null;
        // Find highest zoom where camera view fits in MAX_TILES_AXIS × MAX_TILES_AXIS
        // (capped at the source's own maximum tile level)
        const { zoom: overlayZoom, tl: oTl, br: oBr } = this._fitZoomForBbox(
            camBb.minLon, camBb.maxLat, camBb.maxLon, camBb.minLat,
            TILE_SOURCES[this._mapSource].maxZoom ?? 19);
        // Only show overlay when it offers more detail than the base map
        if (overlayZoom <= this._tileBounds.zoom) return null;

        const maxTile = Math.pow(2, overlayZoom) - 1;
        const otx = Math.floor(oBr.x) - Math.floor(oTl.x) + 1;
        const oty = Math.floor(oBr.y) - Math.floor(oTl.y) + 1;
        const opx = Math.max(1, Math.min(2, Math.ceil(otx / 2)));
        const opy = Math.max(1, Math.min(2, Math.ceil(oty / 2)));
        const ox0 = Math.max(0, Math.floor(oTl.x) - opx);
        const oy0 = Math.max(0, Math.floor(oTl.y) - opy);
        const ox1 = Math.min(maxTile, Math.floor(oBr.x) + opx);
        const oy1 = Math.min(maxTile, Math.floor(oBr.y) + opy);
        const sourceId = this._mapSource;
        const key = `ov/${sourceId}/${overlayZoom}/${ox0}/${oy0}/${ox1}/${oy1}`;
        return { key, sourceId, overlayZoom, ox0, oy0, ox1, oy1, onx: ox1 - ox0 + 1, ony: oy1 - oy0 + 1 };
    }

    async _updateOverlay() {
        if (!this._tileBounds) return;
        // Don't silently drop an update that arrives mid-fetch — remember it and
        // re-run once the in-flight fetch settles (see the finally block).
        if (this._overlayBusy) { this._overlayRerun = true; return; }
        // Traffic saver: if the map isn't on-screen, don't fetch — just mark that a
        // refresh is due and let it run when the map becomes visible again.
        if (!this._isMapVisible()) { this._overlayPending = true; return; }
        this._overlayPending = false;

        const target = this._overlayTarget();
        if (!target) { this._removeOverlay(); return; }
        const { key, sourceId, overlayZoom, ox0, oy0, ox1, oy1, onx, ony } = target;
        if (key === this._overlayKey) return;

        this._overlayBusy = true;
        try {
            const texture = await this._stitchTiles(sourceId, overlayZoom, ox0, oy0, onx, ony, false);

            // The camera may have moved during the fetch; if the target key no
            // longer matches what we fetched for, this texture is for a view
            // we've left — drop it rather than install a stale overlay.
            if (this._overlayTarget()?.key !== key) { texture.dispose(); return; }

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

            const geo  = new THREE.PlaneGeometry(oW, oH);
            const mat  = new THREE.MeshBasicMaterial({ map: texture });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.rotation.x = -Math.PI / 2;
            mesh.position.set(ocx, this._rxPointsGroup.scale.y * 0.1, ocz);   // just above base, below the dots (kept in sync by _updateHeightScale)

            this._removeOverlay();
            this._overlayMesh = mesh;
            this.scene.add(mesh);
            this._overlayKey = key;
        } finally {
            this._overlayBusy = false;
            // Run the update that landed while we were fetching, now against the
            // current view.
            if (this._overlayRerun) { this._overlayRerun = false; this._updateOverlay(); }
        }
    }

    _removeOverlay() {
        if (!this._overlayMesh) return;
        disposeObject3D(this._overlayMesh);
        this._overlayMesh = null;
        this._overlayKey = null;
    }

    // Map SNR linearly to a spire height between MIN_HEIGHT and MAX_HEIGHT.
    _signalToHeight(snr) {
        if (snr == null) return MIN_HEIGHT;
        const t = Math.max(0, Math.min(1, (snr - SNR_BAD) / (SNR_GOOD - SNR_BAD)));
        return MIN_HEIGHT + t * (MAX_HEIGHT - MIN_HEIGHT);
    }

    _disposeDots() {
        // disposeTextures:false — dot materials share the cached sprite textures
        // (_sphereTex/_starTex/_ringTex*), which outlive any single rebuild.
        for (const obj of [...this._dotMeshes, this._lineSegs, this._lineSegsDim]) {
            disposeObject3D(obj, { disposeTextures: false });
        }
        this._dotMeshes   = [];
        this._hitMesh     = null;
        this._lineSegs    = null;
        this._lineSegsDim = null;
        this._hitPoints   = [];
    }

    _rebuildDots() {
        this._disposeDots();
        if (!this._tileBounds) return;
        this._updateHeightScale();

        const sel     = this._selectedCol;
        const cutoff  = this._displayCutoff;
        // In wide / "All" mode the source is the pre-gridded historical set; it
        // is already spatially downsampled, so the per-repeater merge is skipped.
        // In histMode the host maintains the cell cache incrementally (live
        // packets upsert their cell), so _histPoints is always current — no tail.
        const histMode = this._histPoints != null;
        let visible = (histMode ? this._histPoints : this._rxPoints).filter(p =>
            (!this._filterFn || this._filterFn(p.col)) &&
            (!cutoff || p.time >= cutoff)
        );
        if (!visible.length) return;

        const litPts = sel ? visible.filter(p => p.col === sel) : visible;
        const dimPts = sel ? visible.filter(p => p.col !== sel) : [];

        const _col = new THREE.Color();

        this._addDotGroup(litPts, 1.0);
        this._addDotGroup(dimPts, 0.07);

        // Points used for screen-space click picking (see _onCanvasClick).
        // Outgoing TX stars are appended further below, once sentAll is built.
        this._hitPoints = visible;

        // Vertical lines — split into lit (coloured) and dim (flat grey, low opacity)
        const litCol = new Float32Array(litPts.length * 6);
        for (let i = 0; i < litPts.length; i++) {
            _col.set(this.colorFor(litPts[i].col));
            const j = i * 6;
            litCol[j]   = _col.r; litCol[j+1] = _col.g; litCol[j+2] = _col.b;
            litCol[j+3] = _col.r; litCol[j+4] = _col.g; litCol[j+5] = _col.b;
        }
        const lineOpacity = Math.min(1, 0.25 + 0.35 * this._sphereSize);
        const litMat = new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true,
            depthWrite: false, depthTest: false, opacity: lineOpacity,
        });
        const dimMat = new THREE.LineBasicMaterial({
            color: 0x888888, transparent: true, depthWrite: false, depthTest: false, opacity: 0.18,
        });

        this._lineSegs = this._makeDotLines(litPts, litMat);
        if (this._lineSegs)
            this._lineSegs.geometry.setAttribute('color', new THREE.BufferAttribute(litCol, 3));
        this._lineSegsDim = this._makeDotLines(dimPts, dimMat);

        // Sent SNR stars — outgoing signal quality (how well the repeater heard
        // us). Disk-loaded historical points when present, plus a live tail
        // (sent points are few, so they're drawn individually — no gridding).
        const sentCutoff = this._displayCutoff;
        const sentSrc = this._histOutgoingPts
            ? this._histOutgoingPts.concat(this._outgoingPts.filter(p => p.time > this._histSentAt))
            : this._outgoingPts;
        const sentAll = sentSrc.filter(p =>
            (!this._filterFn || this._filterFn(p.col)) &&
            (!sentCutoff || p.time >= sentCutoff)
        );
        const sentLit = sel ? sentAll.filter(p => p.col === sel) : sentAll;
        const sentDim = sel ? sentAll.filter(p => p.col !== sel) : [];
        this._addDotPoints(sentLit, 1.0,  3.2, this._starTex);
        this._addDotPoints(sentDim, 0.07, 3.2, this._starTex);

        // Make the TX stars clickable too (clicking one selects its repeater,
        // exactly like clicking an RX sphere).
        this._hitPoints = this._hitPoints.concat(sentAll);

        this._rebuildPins();
        this._updatePerspUniforms();
    }

    // Build a THREE.Points object for a set of data points (used by _rebuildDots).
    _makeDotPoints(pts, opacity, sizeMult, tex = this._sphereTex) {
        const _col = new THREE.Color();
        const pos = new Float32Array(pts.length * 3);
        const col = new Float32Array(pts.length * 3);
        for (let i = 0; i < pts.length; i++) {
            const p  = pts[i];
            const wp = this._latLonToWorld(p.lat, p.lon);
            pos[i*3]   = wp ? wp.x : 0;
            pos[i*3+1] = wp ? this._signalToHeight(p.snr) : 0;
            pos[i*3+2] = wp ? wp.z : 0;
            if (p.col === 'direct' || p.col === 'unknown') {
                col[i*3] = 1; col[i*3+1] = 1; col[i*3+2] = 1;   // white — ring texture carries the rim colour
            } else {
                _col.set(this.colorFor(p.col));
                col[i*3] = _col.r; col[i*3+1] = _col.g; col[i*3+2] = _col.b;
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
        // gl_PointSize / PointsMaterial.size are in device pixels, so on a
        // retina buffer (pixel ratio 2) dots render at half this in CSS px.
        // That per-DPR difference is the look the app was visually tuned to —
        // multiplying by getPixelRatio() to "normalise" it doubled the balls on
        // every phone (regression), so it stays as-is deliberately.
        const dotSize = this._sphereSize * sizeMult * 7;
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
        // uRefDist is updated every frame to controls.getDistance() so that
        // the reference distance tracks the camera rather than being a fixed
        // constant — otherwise high-scaled dots float closer to the camera
        // than the target and appear enormous.
        if (this._perspSize) {
            const uRefDist = { value: this.controls.getDistance() };
            mat.onBeforeCompile = shader => {
                shader.uniforms.uRefDist = uRefDist;
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>',
                             '#include <common>\nuniform float uRefDist;')
                    .replace('gl_PointSize = size;',
                             // Floor the depth relative to uRefDist (not a fixed 0.5) so the
                             // dampening still holds when the whole scene is <0.5 units from
                             // the camera at deep zoom; also caps foreground dots at ~4.5×.
                             'gl_PointSize = size * pow(uRefDist / max(uRefDist * 0.05, -mvPosition.z), 0.5);');
            };
            mat.userData.uRefDistUniform = uRefDist;
        }
        const mesh = new THREE.Points(geo, mat);
        // Render order: lit dots (renderOrder 2) paint over lines (renderOrder 1)
        // so the ball is always visually in front of its own guide line.
        mesh.renderOrder = isLit ? 2 : 0;
        mesh.userData.baseDotSize = dotSize;
        return mesh;
    }

    // Build a dot mesh and register it for rendering + disposal.
    _addDotPoints(pts, opacity, sizeMult, tex) {
        if (!pts.length) return;
        const m = this._makeDotPoints(pts, opacity, sizeMult, tex);
        this._dotMeshes.push(m);
        this._rxPointsGroup.add(m);
    }

    // Split a point set by sprite texture: real repeaters use the shaded sphere,
    // the two pseudo columns ('direct'/'unknown') use white-filled rings.
    _addDotGroup(pts, opacity) {
        const normal = [], direct = [], unknown = [];
        for (const p of pts) {
            if (p.col === 'direct') direct.push(p);
            else if (p.col === 'unknown') unknown.push(p);
            else normal.push(p);
        }
        this._addDotPoints(normal,  opacity, 2.0, this._sphereTex);
        this._addDotPoints(direct,  opacity, 2.0, this._ringTexDirect);
        this._addDotPoints(unknown, opacity, 2.0, this._ringTexUnknown);
    }

    // Build the vertical guide lines (ground → signal height) for a point set.
    _makeDotLines(pts, mat) {
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
        this._rxPointsGroup.add(seg);
        return seg;
    }

    _scaleMarkerToScreen() {
        const screenH = this.canvas.clientHeight || 1;
        const screenW = this.canvas.clientWidth || 1;
        const ff = fovFactor(this.camera);
        // Target a fraction of the SMALLER viewport dimension (clamped), not a
        // fixed pixel count — so markers stay proportional on a small map yet
        // don't blow up when the map is made much taller (e.g. fullscreen on a
        // phone, where only the height grows). screenH stays in scaleFor below
        // because that is the px↔world conversion via the camera's vertical FOV.
        const targetPx = Math.max(30, Math.min(140, MARKER_VIEW_FRAC * Math.min(screenW, screenH)));
        const scaleFor = (group, localH) => {
            const d = this.camera.position.distanceTo(group.position);
            group.scale.setScalar(targetPx * d * ff / (localH * screenH));
        };
        // localH = each marker's model height; targetPx is its on-screen height.
        if (this._userMarker) scaleFor(this._userMarker, 2.8);
        if (this._deviceMarker) scaleFor(this._deviceMarker, 3.1);
        for (const g of this._pinGroups) {
            scaleFor(g, 4.0);
        }
    }

    // Marker meshes have faces lying on (or a hair above) the map plane — the
    // translucent ground disc, and the cone/mast base caps at y≈0. The per-frame
    // screen-space rescale walks those near-coplanar faces through the depth
    // buffer's precision, which showed as flicker. polygonOffset biases their
    // depth slightly toward the camera so the GPU resolves them above the plane
    // deterministically, while keeping normal depth behaviour — the marker is
    // still a regular 3D object that nearby dots can overlap, not an
    // always-on-top overlay.
    _markerNoZFight(group) {
        group.traverse(o => {
            if (!o.isMesh) return;
            const m = o.material;
            m.polygonOffset = true;
            m.polygonOffsetFactor = -2;
            m.polygonOffsetUnits = -2;
            if (m.transparent) m.depthWrite = false;   // translucent disc: don't occlude the blend
        });
    }

    // The translucent ground disc shared by the user and device markers.
    _makeMarkerBase(color) {
        const base = new THREE.Mesh(
            new THREE.CircleGeometry(1.44, 24),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 })
        );
        base.rotation.x = -Math.PI / 2;
        base.position.y = 0.05;
        return base;
    }

    _updateUserMarker() {
        if (!this._userLoc || !this._tileBounds) return;
        const pos = this._latLonToWorld(this._userLoc.lat, this._userLoc.lon);
        if (!pos) return;
        if (!this._userMarker) {
            const COL = 0xff4040;   // vivid red — stays bright on the ambient-lit sides
            const group = new THREE.Group();
            const cone = new THREE.Mesh(
                new THREE.ConeGeometry(1, 2.8, 14),
                // Lambert (not Basic) so the cone is shaded by the scene's ambient
                // + directional lights and reads as a 3D solid, not a flat blob.
                new THREE.MeshLambertMaterial({ color: COL })
            );
            cone.position.y = 1.4;
            group.add(cone);
            group.add(this._makeMarkerBase(COL));
            this._markerNoZFight(group);
            this._userMarker = group;
            this._userMarker.visible = this._showMarker;
            this.scene.add(this._userMarker);
        }
        this._userMarker.position.set(pos.x, 0, pos.z);  // scale handled by _scaleMarkerToScreen()
    }

    // The connected device's own position — drawn as a blue antenna (mast +
    // ball), deliberately distinct from the red "my location" cone and from the
    // repeater pins, so it reads as "this is the radio/repeater I'm talking to".
    _updateDeviceMarker() {
        if (!this._deviceLoc || !this._tileBounds) return;
        const pos = this._latLonToWorld(this._deviceLoc.lat, this._deviceLoc.lon);
        if (!pos) return;
        if (!this._deviceMarker) {
            const COL = 0x2299ff;
            const group = new THREE.Group();
            const mast = new THREE.Mesh(
                new THREE.CylinderGeometry(0.18, 0.18, 2.4, 10),
                new THREE.MeshBasicMaterial({ color: COL })
            );
            mast.position.y = 1.2;
            group.add(mast);
            const ball = new THREE.Mesh(
                new THREE.SphereGeometry(0.5, 16, 12),
                new THREE.MeshBasicMaterial({ color: COL })
            );
            ball.position.y = 2.6;
            group.add(ball);
            group.add(this._makeMarkerBase(COL));
            this._markerNoZFight(group);
            this._deviceMarker = group;
            this.scene.add(this._deviceMarker);
        }
        this._deviceMarker.visible = this._showDevice;
        this._deviceMarker.position.set(pos.x, 0, pos.z);  // scale handled by _scaleMarkerToScreen()
    }

}
