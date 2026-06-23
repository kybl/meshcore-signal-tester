# Fastlane store metadata

App-store listing metadata in the standard
[Fastlane *supply*](https://docs.fastlane.tools/actions/supply/) /
[F-Droid](https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/)
layout. The same files are consumed by **IzzyOnDroid**, **F-Droid**, and
**Google Play** (via Gradle Play Publisher / fastlane), so the listing is
written once and reused across every channel.

```
metadata/android/<locale>/
├── title.txt              # app name
├── short_description.txt  # one line, max 80 chars
├── full_description.txt   # long description (max 4000 chars)
├── changelogs/
│   └── <versionCode>.txt  # "what's new" for that build; filename = versionCode
└── images/
    ├── icon.png           # optional; stores otherwise use the APK's icon
    └── phoneScreenshots/
        ├── 1.png
        ├── 2.png
        └── 3.png
```

Locales present: `en-US` (primary) and `cs`. Screenshots live only under
`en-US`; clients fall back to the primary locale when a translation has none.

## Adding a release changelog

Each release needs a changelog file **named after the build's `versionCode`**
(see `versionCode` in `android/app/build.gradle`). For example the next release
after versionCode 3 adds `changelogs/4.txt` in each locale. IzzyOnDroid and
F-Droid show it as the "What's New" text; keep it short and plain-text.

## Icon for Google Play

Google Play additionally needs a **512×512 PNG** hi-res icon uploaded in the
Play Console (it is not taken from the APK). Export it from the app's adaptive
icon (`android/app/src/main/res` → `ic_launcher`) — e.g. Android Studio's
*Image Asset* tool or `rsvg-convert`/Inkscape on the foreground vector over the
brand background. IzzyOnDroid and F-Droid don't need it (they use the APK icon).
