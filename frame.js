// Length-prefixed frame extraction for the serial/TCP byte stream, extracted
// from app.js so it can be unit-tested in isolation (see test/frame.test.js).
// This is the ingestion boundary: a bug here silently loses or corrupts
// received packets, so its resync/partial-frame handling is worth pinning.
//
// Frame = [type, lenLSB, lenMSB, ...payload(len bytes)].
//   type 0x3e ('>') = radio→app,  0x3c ('<') = app→radio.
// Unknown leading bytes are skipped one at a time to resynchronise after any
// corruption or mid-frame connection.

const FRAME_HDR = 3;
const FRAME_IN = 0x3e;   // radio → app
const FRAME_OUT = 0x3c;  // app → radio

// Pull every complete frame out of `buf` (a Uint8Array). Returns
//   { frames: [{ type, payload }], rest }
// where `rest` is the trailing bytes of an incomplete frame (or an unknown
// byte run) to be prepended to the next chunk. `payload` is a copy, so callers
// may retain it after `buf` is reused.
export function extractFrames(buf) {
    const frames = [];
    let offset = 0;
    while (buf.length - offset >= FRAME_HDR) {
        const type = buf[offset];
        if (type !== FRAME_IN && type !== FRAME_OUT) { offset++; continue; }  // resync
        const len = buf[offset + 1] | (buf[offset + 2] << 8);
        if (len === 0) { offset++; continue; }                                // not a real frame
        if (buf.length - offset < FRAME_HDR + len) break;                     // wait for the rest
        frames.push({ type, payload: buf.slice(offset + FRAME_HDR, offset + FRAME_HDR + len) });
        offset += FRAME_HDR + len;
    }
    return { frames, rest: offset > 0 ? buf.slice(offset) : buf };
}

export { FRAME_IN, FRAME_OUT };
