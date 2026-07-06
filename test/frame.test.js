// Unit tests for serial/TCP frame extraction (frame.js). This is the ingestion
// boundary — a bug loses or corrupts received packets — so cover resync,
// partial frames, and cross-chunk accumulation. Run with `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFrames, FRAME_IN, FRAME_OUT } from '../frame.js';

// Build a framed byte array: [type, lenLSB, lenMSB, ...payload].
function frame(type, payload) {
    const len = payload.length;
    return [type, len & 0xff, (len >> 8) & 0xff, ...payload];
}
const buf = (...bytes) => new Uint8Array(bytes);

test('empty buffer yields no frames and empty rest', () => {
    const { frames, rest } = extractFrames(buf());
    assert.equal(frames.length, 0);
    assert.equal(rest.length, 0);
});

test('a single complete radio→app frame is extracted with its payload', () => {
    const { frames, rest } = extractFrames(buf(...frame(FRAME_IN, [1, 2, 3])));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, FRAME_IN);
    assert.deepEqual([...frames[0].payload], [1, 2, 3]);
    assert.equal(rest.length, 0);
});

test('leading garbage is skipped one byte at a time (resync)', () => {
    const { frames, rest } = extractFrames(buf(0x00, 0xff, 0x99, ...frame(FRAME_IN, [42])));
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].payload], [42]);
    assert.equal(rest.length, 0);
});

test('multiple back-to-back frames are all returned, in order, with types', () => {
    const bytes = buf(...frame(FRAME_IN, [1]), ...frame(FRAME_OUT, [2, 2]), ...frame(FRAME_IN, [3, 3, 3]));
    const { frames, rest } = extractFrames(bytes);
    assert.equal(frames.length, 3);
    assert.deepEqual(frames.map(f => f.type), [FRAME_IN, FRAME_OUT, FRAME_IN]);
    assert.deepEqual([...frames[2].payload], [3, 3, 3]);
    assert.equal(rest.length, 0);
});

test('a zero-length "frame" is not a frame — the type byte is skipped', () => {
    // type + len=0, then a real frame right after
    const { frames } = extractFrames(buf(FRAME_IN, 0, 0, ...frame(FRAME_IN, [7])));
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].payload], [7]);
});

test('an incomplete frame is held back entirely as rest (from its type byte)', () => {
    // header claims 4 payload bytes but only 2 are present
    const partial = buf(FRAME_IN, 4, 0, 0xaa, 0xbb);
    const { frames, rest } = extractFrames(partial);
    assert.equal(frames.length, 0);
    assert.deepEqual([...rest], [FRAME_IN, 4, 0, 0xaa, 0xbb]);
});

test('a complete frame followed by a partial: emit the first, keep the partial', () => {
    const bytes = buf(...frame(FRAME_IN, [9]), FRAME_IN, 3, 0, 0x01);   // second frame truncated
    const { frames, rest } = extractFrames(bytes);
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].payload], [9]);
    assert.deepEqual([...rest], [FRAME_IN, 3, 0, 0x01]);
});

test('cross-chunk accumulation: prepend rest to the next chunk to complete a frame', () => {
    const whole = frame(FRAME_IN, [10, 20, 30, 40]);
    // Split mid-payload across two chunks.
    const a = extractFrames(buf(...whole.slice(0, 5)));
    assert.equal(a.frames.length, 0);
    const merged = new Uint8Array(a.rest.length + (whole.length - 5));
    merged.set(a.rest, 0);
    merged.set(new Uint8Array(whole.slice(5)), a.rest.length);
    const b = extractFrames(merged);
    assert.equal(b.frames.length, 1);
    assert.deepEqual([...b.frames[0].payload], [10, 20, 30, 40]);
    assert.equal(b.rest.length, 0);
});

test('payload is a copy, independent of the source buffer', () => {
    const src = buf(...frame(FRAME_IN, [5, 6]));
    const { frames } = extractFrames(src);
    src[3] = 0xff;   // mutate the original payload byte
    assert.deepEqual([...frames[0].payload], [5, 6]);   // extracted copy unaffected
});
