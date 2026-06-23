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
  over USB-C works just like a Bluetooth one. The library is **vendored** as a
  source module in [`usbSerialForAndroid/`](usbSerialForAndroid/README.md) and
  built from source (no JitPack), so the whole app builds purely from source.
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
# APK at app/build/outputs/apk/debug/meshcore-signal-tester-debug.apk
```

Or just open the `android/` folder in Android Studio and press Run. The web
assets are copied from the repo root automatically on every build, so edit the
web app at the root and rebuild.

> The Gradle wrapper targets Gradle 8.7 / AGP 8.6.1 / Kotlin 1.9.24,
> `compileSdk`/`targetSdk` 35, `build-tools` 35.0.0, `minSdk` 26.

## Reproducible builds

The build is pinned and verified from source so the same inputs produce the
same output, and so the whole app builds from source (no JitPack — the
`usb-serial-for-android` library is vendored, see
[`usbSerialForAndroid/`](usbSerialForAndroid/README.md)).

What is pinned:

* **Gradle distribution** — `distributionSha256Sum` in
  `gradle/wrapper/gradle-wrapper.properties`; the wrapper refuses to run a
  distribution that doesn't match.
* **Build tooling** — AGP, Kotlin and `buildToolsVersion '35.0.0'` are fixed
  versions (no dynamic/`+` versions anywhere).
* **Every dependency and Gradle plugin** — `gradle/verification-metadata.xml`
  holds an SHA-256 checksum for each artifact. Gradle refuses to build if a
  downloaded artifact's checksum doesn't match, which blocks a tampered or
  swapped dependency.

Verified: two clean `assembleRelease` builds produce APKs whose every code,
resource and asset entry is byte-for-byte identical; only the cryptographic
signature block differs (expected — it is excluded when comparing reproducible
builds).

### Regenerating the dependency checksums

After changing or bumping a dependency, plugin, or the Android Gradle plugin,
refresh the verification metadata:

```bash
cd android
./gradlew --write-verification-metadata sha256 --refresh-dependencies \
  assembleDebug assembleRelease lintDebug
```

Review the diff to `gradle/verification-metadata.xml` before committing, so a
checksum only changes when you intended to change the corresponding artifact.

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

`cz.kyblsoft.meshcore.signaltester`

(The Kotlin source package and the Android `applicationId` share this name. The
`cz.kyblsoft.meshcore` prefix is reserved as a namespace for other MeshCore apps.)

## Author

Created by **Aleš Janda** — feedback, bug reports, and questions welcome at [ales.janda@kyblsoft.cz](mailto:ales.janda@kyblsoft.cz).

Source code: [github.com/kybl/meshcore-signal-tester](https://github.com/kybl/meshcore-signal-tester)
