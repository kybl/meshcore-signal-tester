# usb-serial-for-android (vendored)

This directory is a **vendored copy** of the runtime library
[`usb-serial-for-android`](https://github.com/mik3y/usb-serial-for-android),
built from source as a Gradle module instead of being pulled as a prebuilt
JitPack artifact.

## Why it's vendored

The app previously depended on `com.github.mik3y:usb-serial-for-android:3.10.0`
via JitPack. JitPack serves on-demand-built binaries that are not
reproducible, are not pinned by checksum, and rely on a third-party build
service. F-Droid's inclusion policy in particular forbids such prebuilt
dependencies — everything must build from source. Vendoring the source here
removes JitPack entirely and lets the whole app build from source for every
distribution channel (Play, F-Droid, IzzyOnDroid).

## Provenance

| | |
|---|---|
| Upstream | https://github.com/mik3y/usb-serial-for-android |
| Version | `3.10.0` |
| Commit | `a8b9ecc7d32ce6df749c44a2b9e8cb208ac30609` (tag `3.10.0`) |
| License | MIT — see [`LICENSE.txt`](LICENSE.txt) |

## What was copied / changed

* Copied only `usbSerialForAndroid/src/main` (the runtime library) plus
  `proguard-rules.pro`. Upstream tests, instrumentation tests, the example
  app, and the `usbSerialExamples` module were **not** vendored.
* Replaced upstream's `build.gradle` with a minimal one (`build.gradle` in this
  directory): no `maven-publish`, no publishing block, no test dependencies,
  and `compileSdk` / Java version / `minSdk` aligned with the app module.
* The Java source under `src/main/java/com/hoho/...` is unmodified.

## Updating

To bump the version, replace `src/main` and `proguard-rules.pro` from the new
upstream tag, update the **Version** / **Commit** above, and re-check that the
list of runtime dependencies in `build.gradle` still matches what the source
imports (currently only `androidx.annotation`).
