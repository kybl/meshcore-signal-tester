// native-bridge.js — bridges the web app to the native Android host.
//
// On a normal web page this file does nothing (the AndroidBle / AndroidGeo
// JavaScript interfaces are absent). When the page runs inside the MeshCore
// Signal Tester Android app, the WebView injects those interfaces and this
// script polyfills `navigator.bluetooth` and `navigator.geolocation` so the
// existing app.js / signal3d.js code keeps working unchanged — the actual BLE
// and GPS work happens in native code (a foreground service), which keeps
// running with the screen off.
//
// Loaded as a classic <script> in <head> so it installs the polyfills before
// the deferred ES module (app.js) runs.
(function () {
    'use strict';

    // Detect the native host. addJavascriptInterface objects are present from
    // the very first script execution, so this check is reliable here.
    if (typeof window.AndroidBle === 'undefined') return;
    window.__MESHCORE_NATIVE__ = true;

    // ---- helpers ---------------------------------------------------------

    function norm(u) {
        if (typeof u === 'number') u = u.toString(16);
        u = String(u).toLowerCase().replace(/^0x/, '');
        if (/^[0-9a-f]{1,4}$/.test(u)) {
            u = ('0000' + u).slice(-4) + '-0000-1000-8000-00805f9b34fb';
        }
        return u;
    }

    function b64ToBytes(b64) {
        var bin = atob(b64), a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return a;
    }

    function toBytes(data) {
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        return new Uint8Array(data);
    }

    function bytesToB64(data) {
        var a = toBytes(data), s = '';
        for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
        return btoa(s);
    }

    function nameErr(name, message) {
        var e = new Error(message || name);
        e.name = name;
        return e;
    }

    // ---- request/response plumbing --------------------------------------

    var _seq = 0;
    var _pending = {};

    function call(invoke) {
        return new Promise(function (resolve, reject) {
            var id = 'r' + (++_seq);
            _pending[id] = { resolve: resolve, reject: reject };
            try {
                invoke(id);
            } catch (e) {
                delete _pending[id];
                reject(e);
            }
        });
    }

    // Native calls this to settle a pending request.
    window.__mcBleResolve = function (id, ok, payloadJson) {
        var p = _pending[id];
        if (!p) return;
        delete _pending[id];
        var data = null;
        try { data = payloadJson ? JSON.parse(payloadJson) : null; } catch (e) {}
        if (ok) {
            p.resolve(data);
        } else {
            p.reject(nameErr((data && data.name) || 'NetworkError', (data && data.message) || 'Bluetooth error'));
        }
    };

    // ---- object registries ----------------------------------------------

    var _devices = {};            // id -> device proxy
    var _chars = {};              // "dev|svc|chr" -> characteristic proxy

    function charKey(devId, svc, chr) { return devId + '|' + svc + '|' + chr; }

    function getChar(devId, svc, chr) {
        var k = charKey(devId, svc, chr);
        if (_chars[k]) return _chars[k];

        var listeners = {};
        var ch = {
            uuid: chr,
            value: null,
            properties: {},
            service: null,
            addEventListener: function (type, cb) {
                (listeners[type] = listeners[type] || []).push(cb);
            },
            removeEventListener: function (type, cb) {
                var arr = listeners[type] || [], i = arr.indexOf(cb);
                if (i >= 0) arr.splice(i, 1);
            },
            _dispatch: function (type, ev) {
                (listeners[type] || []).slice().forEach(function (cb) {
                    try { cb.call(ch, ev); } catch (e) { console.error(e); }
                });
            },
            writeValueWithoutResponse: function (data) {
                return call(function (id) {
                    window.AndroidBle.write(id, devId, svc, chr, bytesToB64(data), false);
                });
            },
            writeValue: function (data) {
                return call(function (id) {
                    window.AndroidBle.write(id, devId, svc, chr, bytesToB64(data), true);
                });
            },
            writeValueWithResponse: function (data) {
                return ch.writeValue(data);
            },
            readValue: function () {
                return call(function (id) {
                    window.AndroidBle.read(id, devId, svc, chr);
                }).then(function (r) {
                    var dv = new DataView(b64ToBytes(r.value).buffer);
                    ch.value = dv;
                    return dv;
                });
            },
            startNotifications: function () {
                return call(function (id) {
                    window.AndroidBle.startNotifications(id, devId, svc, chr);
                }).then(function () { return ch; });
            },
            stopNotifications: function () {
                return call(function (id) {
                    window.AndroidBle.stopNotifications(id, devId, svc, chr);
                }).then(function () { return ch; });
            }
        };
        _chars[k] = ch;
        return ch;
    }

    function makeService(devId, svcUuid, charUuids) {
        var svc = {
            uuid: svcUuid,
            getCharacteristic: function (uuid) {
                var cu = norm(uuid);
                if (charUuids.indexOf(cu) < 0) {
                    return Promise.reject(nameErr('NotFoundError', 'Characteristic ' + cu + ' not found'));
                }
                var ch = getChar(devId, svcUuid, cu);
                ch.service = svc;
                return Promise.resolve(ch);
            }
        };
        return svc;
    }

    function makeDevice(info) {
        if (_devices[info.id]) {
            if (info.name) _devices[info.id].name = info.name;
            return _devices[info.id];
        }

        var deviceListeners = {};
        var device = {
            id: info.id,
            name: info.name || '',
            _services: null,
            addEventListener: function (type, cb) {
                (deviceListeners[type] = deviceListeners[type] || []).push(cb);
            },
            removeEventListener: function (type, cb) {
                var arr = deviceListeners[type] || [], i = arr.indexOf(cb);
                if (i >= 0) arr.splice(i, 1);
            },
            _dispatch: function (type, ev) {
                (deviceListeners[type] || []).slice().forEach(function (cb) {
                    try { cb.call(device, ev); } catch (e) { console.error(e); }
                });
            }
        };

        var server = {
            device: device,
            get connected() { return window.AndroidBle.isConnected(device.id); },
            connect: function () { return gatt.connect(); },
            disconnect: function () { gatt.disconnect(); },
            getPrimaryService: function (uuid) {
                var su = norm(uuid);
                if (!device._services || !device._services[su]) {
                    return Promise.reject(nameErr('NotFoundError', 'Service ' + su + ' not found'));
                }
                return Promise.resolve(makeService(device.id, su, device._services[su]));
            }
        };

        var gatt = {
            device: device,
            get connected() { return window.AndroidBle.isConnected(device.id); },
            connect: function () {
                return call(function (id) {
                    window.AndroidBle.connect(id, device.id);
                }).then(function (r) {
                    device._services = {};
                    var map = (r && r.services) || {};
                    Object.keys(map).forEach(function (su) {
                        device._services[norm(su)] = (map[su] || []).map(norm);
                    });
                    return server;
                });
            },
            disconnect: function () {
                try { window.AndroidBle.disconnect(device.id); } catch (e) {}
            }
        };

        device.gatt = gatt;
        _devices[device.id] = device;
        return device;
    }

    // ---- native -> JS events --------------------------------------------

    window.__mcBleNotify = function (devId, svcUuid, charUuid, b64) {
        var ch = _chars[charKey(devId, norm(svcUuid), norm(charUuid))];
        if (!ch) return;
        var dv = new DataView(b64ToBytes(b64).buffer);
        ch.value = dv;
        ch._dispatch('characteristicvaluechanged', { target: ch });
    };

    window.__mcBleDisconnected = function (devId) {
        var d = _devices[devId];
        if (!d) return;
        d._dispatch('gattserverdisconnected', { target: d });
    };

    // ---- navigator.bluetooth polyfill -----------------------------------

    navigator.bluetooth = {
        getAvailability: function () { return Promise.resolve(true); },
        requestDevice: function (options) {
            return call(function (id) {
                window.AndroidBle.requestDevice(id, JSON.stringify(options || {}));
            }).then(function (info) {
                return makeDevice(info);
            });
        },
        getDevices: function () {
            return call(function (id) {
                window.AndroidBle.getDevices(id);
            }).then(function (list) {
                return (list || []).map(makeDevice);
            });
        }
    };

    // ---- navigator.geolocation polyfill ---------------------------------

    if (typeof window.AndroidGeo !== 'undefined') {
        var watchers = {};
        var wseq = 0;

        // Simple assignment fails silently in strict mode when the property is
        // defined as a getter-only on Navigator.prototype — use defineProperty
        // to create an own property that shadows the prototype getter.
        var _geoImpl = {
            watchPosition: function (success, error) {
                var id = ++wseq;
                watchers[id] = { s: success, e: error, once: false };
                try { window.AndroidGeo.startUpdates(); } catch (e) {}
                return id;
            },
            clearWatch: function (id) {
                delete watchers[id];
                var stillWatching = Object.keys(watchers).some(function (k) { return !watchers[k].once; });
                if (!stillWatching) {
                    try { window.AndroidGeo.stopUpdates(); } catch (e) {}
                }
            },
            getCurrentPosition: function (success, error) {
                var id = 'once' + (++wseq);
                watchers[id] = { s: success, e: error, once: true };
                try { window.AndroidGeo.getCurrent(); } catch (e) {}
            }
        };
        try {
            Object.defineProperty(navigator, 'geolocation', {
                configurable: true, enumerable: true,
                get: function () { return _geoImpl; }
            });
        } catch (e) {
            navigator.geolocation = _geoImpl; // non-strict fallback
        }

        window.__mcGeoUpdate = function (lat, lon, accuracy, ts) {
            var pos = {
                coords: {
                    latitude: lat, longitude: lon, accuracy: accuracy,
                    altitude: null, altitudeAccuracy: null, heading: null, speed: null
                },
                timestamp: ts || Date.now()
            };
            Object.keys(watchers).forEach(function (k) {
                var w = watchers[k];
                try { w.s && w.s(pos); } catch (e) { console.error(e); }
                if (w.once) delete watchers[k];
            });
        };

        window.__mcGeoError = function (code, message) {
            var err = { code: code, message: message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
            Object.keys(watchers).forEach(function (k) {
                var w = watchers[k];
                try { w.e && w.e(err); } catch (e) { console.error(e); }
                if (w.once) delete watchers[k];
            });
        };

        // Report geolocation permission as granted so the map auto-starts
        // watching; the native side handles the real Android permission.
        try {
            var _permsObj = navigator.permissions || {};
            var _origQuery = _permsObj.query ? _permsObj.query.bind(_permsObj) : null;
            var _patchedQuery = function (desc) {
                if (desc && desc.name === 'geolocation') {
                    return Promise.resolve({
                        state: 'granted', onchange: null,
                        addEventListener: function () {}, removeEventListener: function () {}
                    });
                }
                return _origQuery ? _origQuery(desc)
                                  : Promise.reject(nameErr('TypeError', 'permission not supported'));
            };
            if (!navigator.permissions) {
                Object.defineProperty(navigator, 'permissions', {
                    configurable: true, enumerable: true,
                    value: { query: _patchedQuery }
                });
            } else {
                try {
                    Object.defineProperty(navigator.permissions, 'query', {
                        configurable: true, writable: true, value: _patchedQuery
                    });
                } catch (e) {
                    navigator.permissions.query = _patchedQuery;
                }
            }
        } catch (e) {}
    }

    // ---- CSV download intercept -----------------------------------------
    // WebView ignores <a download> clicks on blob: URLs. Patch
    // HTMLAnchorElement.prototype.click so we intercept the call before
    // URL.revokeObjectURL runs (which happens synchronously in app.js right
    // after a.click()). We delay the actual revocation until the fetch
    // completes, then hand the content to AndroidFiles.saveCsv().

    if (typeof window.AndroidFiles !== 'undefined') {
        var _pendingRevoke = new Set();
        var _origRevoke = URL.revokeObjectURL.bind(URL);

        URL.revokeObjectURL = function (url) {
            if (_pendingRevoke.has(url)) return; // will be revoked after fetch
            _origRevoke(url);
        };

        // Patch HTMLAnchorElement.prototype.click rather than listening for a
        // DOM click event. The event-listener approach is unreliable in WebView
        // because the capture phase may not fire for programmatic .click() on
        // elements with download attributes. Prototype-patching is synchronous
        // and guaranteed to run before URL.revokeObjectURL is called.
        var _origAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            var href = this.href || '';
            var dl = this.getAttribute('download');
            if (dl !== null && href.indexOf('blob:') === 0) {
                var filename = dl || 'export.csv';
                _pendingRevoke.add(href);
                fetch(href)
                    .then(function (r) { return r.text(); })
                    .then(function (text) {
                        _pendingRevoke.delete(href);
                        _origRevoke(href);
                        window.AndroidFiles.saveCsv(filename, text);
                    })
                    .catch(function () {
                        _pendingRevoke.delete(href);
                        _origRevoke(href);
                    });
                return;
            }
            return _origAnchorClick.call(this);
        };
    }

})();
