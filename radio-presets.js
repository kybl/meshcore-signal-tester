// MeshCore regional radio presets and the matcher that names the connected
// device's configuration ("which preset is this radio on?").
//
// The table mirrors the official preset list served by the MeshCore API —
// GET https://api.meshcore.nz/api/v1/config, path
// config.suggested_radio_settings.entries (retrieved 2026-07-20). That is the
// live source both the official app and config.meshcore.io load presets from
// (the copy at meshcore.co.uk/configurator/presets.json is a stale mirror).
// Frequencies are normalised to integer kHz so matching never touches float
// equality. Presets are community-maintained and drift a few times a year —
// to refresh, re-fetch the URL above and update this table (titles verbatim).
//
// Pure (no DOM) — unit-tested in test/radio-presets.test.js.

export const RADIO_PRESETS = [
    { title: 'Australia',                 freqKhz: 915800, bwKhz: 250,  sf: 10, cr: 5 },
    { title: 'Australia (Narrow)',        freqKhz: 916575, bwKhz: 62.5, sf: 7,  cr: 8 },
    { title: 'Australia (Mid)',           freqKhz: 915075, bwKhz: 125,  sf: 9,  cr: 5 },
    { title: 'Australia: SA, WA',         freqKhz: 923125, bwKhz: 62.5, sf: 8,  cr: 8 },
    { title: 'Australia: QLD',            freqKhz: 923125, bwKhz: 62.5, sf: 8,  cr: 5 },
    { title: 'Brazil',                    freqKhz: 923125, bwKhz: 62.5, sf: 8,  cr: 8 },
    { title: 'EU/UK (Narrow)',            freqKhz: 869618, bwKhz: 62.5, sf: 8,  cr: 8 },
    { title: 'EU/UK (Deprecated)',        freqKhz: 869525, bwKhz: 250,  sf: 11, cr: 5 },
    { title: 'Czech Republic (Narrow)',   freqKhz: 869432, bwKhz: 62.5, sf: 7,  cr: 5 },
    { title: 'EU 433MHz (Long Range)',    freqKhz: 433650, bwKhz: 250,  sf: 11, cr: 5 },
    { title: 'EU 433MHz (Narrow)',        freqKhz: 433650, bwKhz: 62.5, sf: 8,  cr: 8 },
    { title: 'Netherlands',               freqKhz: 869618, bwKhz: 62.5, sf: 7,  cr: 5 },
    { title: 'New Zealand',               freqKhz: 917375, bwKhz: 250,  sf: 11, cr: 5 },
    { title: 'New Zealand (Narrow)',      freqKhz: 917375, bwKhz: 62.5, sf: 7,  cr: 5 },
    { title: 'Portugal 433',              freqKhz: 433375, bwKhz: 62.5, sf: 9,  cr: 6 },
    { title: 'Portugal 868',              freqKhz: 869618, bwKhz: 62.5, sf: 7,  cr: 6 },
    { title: 'Switzerland',               freqKhz: 869618, bwKhz: 62.5, sf: 8,  cr: 8 },
    { title: 'USA/Canada (Recommended)',  freqKhz: 910525, bwKhz: 62.5, sf: 7,  cr: 5 },
    { title: 'Vietnam (Narrow)',          freqKhz: 920250, bwKhz: 62.5, sf: 8,  cr: 5 },
    { title: 'Vietnam (Deprecated)',      freqKhz: 920250, bwKhz: 250,  sf: 11, cr: 5 },
];

// All preset titles matching a radio configuration, in table order. Several
// presets are intentionally identical (e.g. Switzerland ≡ EU/UK (Narrow)), so
// this returns a list, not a single winner; empty = custom settings.
// freqKhz is compared to the nearest kHz, bwKhz to 0.1 kHz (62.5 must match
// exactly but float noise from a Hz→kHz division must not break it).
export function matchRadioPreset({ freqKhz, bwKhz, sf, cr }) {
    return RADIO_PRESETS
        .filter(p => Math.round(freqKhz) === p.freqKhz
                  && Math.abs(bwKhz - p.bwKhz) < 0.1
                  && sf === p.sf && cr === p.cr)
        .map(p => p.title);
}

// "869.618 MHz, BW 62.5 kHz, SF8, CR4/8" — the raw configuration, for the
// tooltip and for the "no preset matches" display.
export function formatRadioConfig({ freqKhz, bwKhz, sf, cr }) {
    const mhz = (freqKhz / 1000).toFixed(3);
    const bw = Number.isInteger(bwKhz) ? String(bwKhz) : bwKhz.toFixed(1).replace(/\.0$/, '');
    return `${mhz} MHz, BW ${bw} kHz, SF${sf}, CR4/${cr}`;
}
