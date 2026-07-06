// CSV serialisation and parsing for capture import/export.
//
// These are pure functions: they convert between CSV text and plain data
// structures, with no dependency on app state, the DOM or storage. The app
// gathers the data to export (from RAM or disk) and applies parsed rows back
// into its own state; this module only owns the on-the-wire CSV format, so the
// format lives in one place and can be unit-tested in isolation.

// Column order of the data section. Kept stable so old exports re-import.
export const CSV_HEADER = [
    'time', 'type', 'hash', 'repeater', 'snr', 'uplink_snr',
    'rssi', 'raw_hex', 'lat', 'lon', 'text', 'sender',
];

// Quote a field only when it contains a delimiter, quote or newline (RFC 4180).
export function escapeCsvValue(v) {
    if (v == null || v === '') return '';
    const s = String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Split CSV text into records on newlines, but NOT on a newline inside a quoted
// field (RFC 4180 allows them, and buildCsv emits them for multi-line message
// text). A naive text.split(/\r?\n/) would tear such a record apart and lose
// the row. Quote state toggles on every '"' — an escaped '""' toggles twice
// (net no change), and no newline ever sits between those two quotes.
export function splitCsvRecords(text) {
    const records = [];
    let cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') { inQ = !inQ; cur += ch; continue; }
        if (!inQ && (ch === '\n' || ch === '\r')) {
            if (ch === '\r' && text[i + 1] === '\n') i++;   // treat \r\n as one break
            records.push(cur); cur = '';
            continue;
        }
        cur += ch;
    }
    records.push(cur);
    return records;
}

// Split one CSV line into fields, honouring quotes and escaped ("") quotes.
export function parseCsvLine(line) {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') inQ = false;
            else cur += ch;
        } else {
            if (ch === '"') inQ = true;
            else if (ch === ',') { cols.push(cur); cur = ''; }
            else cur += ch;
        }
    }
    cols.push(cur);
    return cols;
}

// Build the full CSV text for an export.
//   contacts:     [{ pubKeyFullHex, name, lat, lon }]      → '# CONTACT,' comment lines
//   observations: [{ time, type, hash, rawId, snr, remoteSnr, rssi, rawHex, lat, lon, text, sender }]
//   sentRows:     [{ time, col, snr, lat, lon, label }]    → SentSNR history rows
// Numeric/date formatting (ISO time, 2-dp SNR) lives here so callers pass raw
// values. Rows are emitted in the order given.
export function buildCsv({ contacts = [], observations = [], sentRows = [] } = {}) {
    const esc = escapeCsvValue;
    const lines = [];

    for (const c of contacts) {
        lines.push('# CONTACT,' + [c.pubKeyFullHex, c.name || '', c.lat ?? 0, c.lon ?? 0].map(esc).join(','));
    }
    lines.push(CSV_HEADER.join(','));

    for (const o of observations) {
        lines.push([
            new Date(o.time).toISOString(),
            o.type || '',
            o.hash,
            o.rawId || '',
            o.snr?.toFixed(2) ?? '',
            o.remoteSnr?.toFixed(2) ?? '',
            o.rssi ?? '',
            o.rawHex || '',
            o.lat ?? '',
            o.lon ?? '',
            o.text || '',
            o.sender || '',
        ].map(esc).join(','));
    }

    for (const p of sentRows) {
        lines.push([
            new Date(p.time).toISOString(),
            'SentSNR',
            'SENTSNR',
            p.col || '',
            '',
            p.snr.toFixed(2),
            '',
            '',
            p.lat ?? '',
            p.lon ?? '',
            p.label || '',
            '',
        ].map(esc).join(','));
    }

    return lines.join('\r\n');
}

// Parse CSV export text into structured data. Returns:
//   { ok, error, contacts, rows, sentRows }
// where rows/sentRows carry the same field shape the importer expects. On a
// recognised-but-unparseable header `ok` is false and `error` describes why;
// the caller owns user-facing messaging and applying the data.
export function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Quote-aware record split so a newline inside a quoted field doesn't tear
    // the row apart (parseCsvLine then handles the field-level quoting).
    const lines = splitCsvRecords(text);
    if (lines.length < 2) return { ok: false, error: 'empty', contacts: [], rows: [], sentRows: [] };

    // Embedded contact metadata precedes the real header as '# CONTACT,' lines.
    const contacts = [];
    let headerLineIdx = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith('# CONTACT,')) {
            const [pubKeyFullHex, name, latStr, lonStr] = parseCsvLine(line.slice('# CONTACT,'.length));
            if (pubKeyFullHex) {
                contacts.push({
                    pubKeyFullHex,
                    name: name || null,
                    lat: parseFloat(latStr) || 0,
                    lon: parseFloat(lonStr) || 0,
                });
            }
            continue;
        }
        headerLineIdx = i;
        break;
    }

    const header = parseCsvLine(lines[headerLineIdx]);
    const idx = name => header.indexOf(name);
    const iTime = idx('time'), iType = idx('type'), iHash = idx('hash');
    const iRep = idx('repeater'), iRssi = idx('rssi'), iSnr = idx('snr');
    const iUplinkSnr = idx('uplink_snr');
    const iHex = idx('raw_hex'), iLat = idx('lat'), iLon = idx('lon');
    const iTxt = idx('text'), iSnd = idx('sender');

    if (iTime < 0 || iHash < 0 || iRep < 0) {
        return { ok: false, error: 'format', contacts, rows: [], sentRows: [] };
    }

    const all = [];
    for (let i = headerLineIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const c = parseCsvLine(line);
        const time = new Date(c[iTime]).getTime();
        if (isNaN(time)) continue;
        const lat = iLat >= 0 && c[iLat] !== '' ? parseFloat(c[iLat]) : null;
        const lon = iLon >= 0 && c[iLon] !== '' ? parseFloat(c[iLon]) : null;
        all.push({
            time,
            type:      iType >= 0 ? c[iType] : '',
            hash:      c[iHash],
            repeater:  c[iRep],
            rssi:      parseInt(c[iRssi]) || -100,
            snr:       parseFloat(c[iSnr]) || 0,
            rawHex:    iHex >= 0 ? c[iHex] : '',
            lat:       lat != null && !isNaN(lat) ? lat : null,
            lon:       lon != null && !isNaN(lon) ? lon : null,
            uplinkSnr: iUplinkSnr >= 0 && c[iUplinkSnr] !== '' ? parseFloat(c[iUplinkSnr]) : null,
            csvText:   iTxt >= 0 ? c[iTxt] : '',
            csvSender: iSnd >= 0 ? c[iSnd] : '',
        });
    }

    return {
        ok: true,
        error: null,
        contacts,
        rows: all.filter(r => r.type !== 'SentSNR'),
        sentRows: all.filter(r => r.type === 'SentSNR'),
    };
}
