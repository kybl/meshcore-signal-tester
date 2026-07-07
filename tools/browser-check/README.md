# Browser regression check

A headless-browser harness that drives the real page in Chromium and asserts
DOM-level behaviour that the pure unit tests (`node --test`) can't reach: that
imported data flows into the stats/tables, that the Received Packets column
**sort order** is right, and that Clear data resets the view.

It is deliberately **outside** `test/` (so `node --test` ignores it) and outside
the APK's `copyWebApp` list / CI path filters, because it needs a browser and is
an agent/local tool, not a shipped artifact.

## What it does not cover

- **Live BLE/USB/WiFi capture** — there's no device; data is injected via CSV
  import (timestamps are relative to `now()` so the recent-window sort key is
  deterministic).
- **3D-map visuals** — WebGL runs in software (swiftshader), so map appearance
  (clustering, dot rendering, camera) must still be checked on-device.
- **Android WebView specifics** — native `confirm()` dialogs, IndexedDB quotas,
  on-device performance.

## Run

```sh
cd tools/browser-check
npm i                 # installs playwright-core (no browser download)
node check.mjs
```

Chromium is auto-detected from `PLAYWRIGHT_BROWSERS_PATH` or `/opt/pw-browsers`
(the pre-provisioned build). The script starts its own static server, so no
other setup is needed. Exit code is non-zero if any check fails.

## Adding checks

Each check is a `check(name, condition, detail)` call in `check.mjs`. When you
fix a DOM-observable bug, add a check that would have failed before the fix —
e.g. the current column-order check would fail under the pre-fix sort (which
ranked by last RSSI instead of first-page presence).
