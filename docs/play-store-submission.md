# Google Play submission notes

Practical answers and justification texts for the Play Console forms, specific
to this app. Nothing here is code — it is the paperwork that accompanies an
upload. (IzzyOnDroid and F-Droid do not need any of this.)

The app's core function is **mapping MeshCore radio signal**: it records the GPS
location at which each received radio packet arrives so the user can map
coverage as they move. Field use requires capturing with the screen off / app
backgrounded (phone in a pocket). **All captured data stays on the device and
is never transmitted by the app.**

---

## 1. Background location — Permissions Declaration form

Play requires a declaration (and usually a short demo video) for
`ACCESS_BACKGROUND_LOCATION`.

**Justification text:**

> MeshCore Signal Tester is a radio signal-mapping tool. Its core feature
> is recording the GPS location at which each received radio packet arrives, so
> the user can map signal coverage as they move. Field testing requires the
> phone to keep capturing with the screen off and the app in the background
> (e.g. in a pocket while walking or driving). The app therefore needs
> ACCESS_BACKGROUND_LOCATION to continue tagging packets with location while
> backgrounded. All location data is stored only on the device and is never
> transmitted. Background access is requested only after a prominent in-app
> disclosure, and the app remains usable (capture without map positions)
> without it.

**Prominent disclosure:** already implemented in-app — before requesting
background location the app shows a dialog (see `checkBackgroundLocation` in
`MainActivity.kt`) explaining that it collects location "including in the
background, even when the app is closed or not in use."

**Demo video to record:** launch → the disclosure dialog → "Allow all the time"
→ connect to a device → turn the screen off → show that packets are still being
captured and tagged with location (e.g. via the ongoing notification / packet
count after unlocking).

---

## 2. Foreground service types — declaration

Manifest declares `location` and `connectedDevice`. Console justifications:

- **location** — "Records the GPS location of each received radio packet while
  the app is backgrounded or the screen is off; this is the app's core
  signal-mapping function."
- **connectedDevice** — "Maintains the Bluetooth / USB-serial connection to the
  user's MeshCore radio while backgrounded so packet capture continues."

---

## 3. Data safety form

- **Does the app collect or share user data?** Collects — **Location (precise
  and approximate)**. Does **not** share user data with third parties.
- **Purpose:** App functionality (recording where packets were received).
- **Collected optionally** — the app works for capture without granting
  location; positions are simply omitted.
- **Not used for tracking**, advertising, or analytics.
- **Stored on-device**, not sent to any server operated by the developer.
- **Encrypted in transit:** the app transmits no user data; only map tiles are
  fetched, over HTTPS.
- **Data deletion:** users control their data on-device (Auto-remove, starting a
  new session, or uninstalling). No account exists.
- **Note on map tiles:** when a map style is selected, tiles are requested from
  third-party servers (Mapy.com / OpenStreetMap / CARTO / Esri), which see the
  device IP and the viewed map area. The app does not send the user's recorded
  location data to them, and the **None (no map)** style makes no tile requests.

---

## 4. Other sensitive permissions

- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` — justification: "The app's core
  function is continuous background capture of radio packets and GPS while the
  screen is off; battery optimization would suspend the foreground service and
  stop capture. The exemption is requested only via an explanatory in-app
  dialog and is optional." (If review objects, the app already falls back to the
  general battery-settings screen.)
- `POST_NOTIFICATIONS` — the ongoing foreground-service capture notification.
- `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`, `INTERNET` (map tiles), `WAKE_LOCK`
  (keep capture alive) — all tied to core functionality.

---

## 5. Listing

- Privacy policy URL: publish `docs/privacy-policy.md` at a stable URL and enter
  it in the Console.
- Store listing text and screenshots: reuse `fastlane/metadata/android/en-US`.
- Hi-res icon: a 512×512 PNG is required (see `fastlane/README.md`).
