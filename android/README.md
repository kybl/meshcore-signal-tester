# MeshCore Signal Tester — Android app

A thin native wrapper around the web app at the repository root. It exists for
one reason: **keep capturing LoRa RX packets and GPS positions while the phone
is in your pocket with the screen off.** Mobile browsers freeze the page and
drop the Bluetooth connection when the screen turns off; this app doesn't.

## How it works

A plain WebView cannot do Web Bluetooth or Web Serial, so the app does **not**
just show the page. Instead:

- **Native BLE** (`BleManager.kt`) owns the GATT connection (Nordic UART
  Service) and serialises GATT operations.
- **Native USB serial** (`SerialManager.kt`) owns the USB host connection via
  the [`usb-serial-for-android`](https://github.com/mik3y/usb-serial-for-android)
  library (CDC-ACM, CP21xx, CH34x, FTDI, Prolific), so a companion plugged in
  over USB-C works just like a Bluetooth one.
- **Native GPS** (`LocationHelper.kt`) streams fixes from the framework
  `LocationManager` (no Google Play Services needed).
- A **foreground service** (`MeshcoreService.kt`) holds a partial wake lock and
  declares the `location` + `connectedDevice` service types, so Android keeps
  the process — and therefore the BLE/USB/GPS callbacks — running with the
  screen off.
- The web UI runs in a `WebView` (`MainActivity.kt`). `native-bridge.js` (loaded
  by the page) polyfills `navigator.bluetooth`, `navigator.serial` and
  `navigator.geolocation` onto the native interfaces `AndroidBle` /
  `AndroidSerial` / `AndroidGeo`, so the existing `app.js` and `signal3d.js`
  run **unchanged**.

The web files are bundled into the APK at build time (see `copyWebApp` in
`app/build.gradle`) and served from `https://appassets.androidplatform.net/…`,
so everything works offline. (Map *tiles* still need internet, but packet and
position capture do not.)

## Build

Requirements: Android Studio (Koala or newer) **or** a command line with the
Android SDK installed and `ANDROID_HOME` / `local.properties` pointing at it.

```bash
cd android
./gradlew assembleDebug
# APK at app/build/outputs/apk/debug/app-debug.apk
```

Or just open the `android/` folder in Android Studio and press Run. The web
assets are copied from the repo root automatically on every build, so edit the
web app at the root and rebuild.

> The Gradle wrapper targets Gradle 8.7 / AGP 8.5.2 / Kotlin 1.9.24,
> `compileSdk`/`targetSdk` 34, `minSdk` 26.

## One-time phone setup (important)

After installing, for screen-off capture to survive:

1. Grant **Location** → choose **Allow all the time** (the app will prompt; on
   Android 11+ you set "all the time" from the permission screen).
2. Grant **Nearby devices / Bluetooth** and **Notifications** when prompted.
3. Disable **battery optimization** for the app
   (Settings → Apps → MeshCore Signal Tester → Battery → Unrestricted).

Then connect to your device in the app, lock the screen, and walk. The ongoing
notification confirms the capture service is alive.

## Connecting over USB

Tap **Connect USB** instead of **Connect Bluetooth**. Plug the companion into
the phone's USB-C port (an OTG adapter may be needed on some phones) and grant
the "Allow access to the USB device" prompt. Previously authorised devices show
up as one-tap reconnect buttons, the same as Bluetooth devices. Background
capture with the screen off works over USB too — the foreground service's
`connectedDevice` type keeps the process alive even without Bluetooth.

## Package

`cz.kyblsoft.meshcore`

## Author

Created by **Aleš Janda** — feedback, bug reports, and questions welcome at [ales.janda@kyblsoft.cz](mailto:ales.janda@kyblsoft.cz).

Source code: [github.com/kybl/meshcore-signal-tester](https://github.com/kybl/meshcore-signal-tester)
