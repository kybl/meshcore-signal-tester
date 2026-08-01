// Unit tests for ConnectionState + ReconnectController (connection-state.js)
// — the connection lifecycle that used to be ~8 loose flags on the app object.
// The reconnect cycle runs on injected fake timers, so the whole
// try/backoff/give-up schedule is driven synchronously. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionState, ReconnectController } from '../connection-state.js';

// ---- ConnectionState ---------------------------------------------------------

test('attempt lifecycle: BLE implies companion, serial detects later', () => {
    const c = new ConnectionState();
    assert.equal(c.transportKind, null);
    assert.equal(c.mode, null);
    c.beginAttempt('ble');
    assert.equal(c.transportKind, 'ble');
    assert.equal(c.mode, 'companion');
    c.drop();
    c.beginAttempt('serial');
    assert.equal(c.mode, null, 'serial mode unknown until detection');
    c.setMode('repeater');
    assert.equal(c.mode, 'repeater');
});

test('drop before finalise is never a surprise', () => {
    const c = new ConnectionState();
    c.beginAttempt('ble');
    assert.equal(c.drop(), false, 'attempt failed / user cancelled — no alarm');
    assert.equal(c.lastDropWasSurprise, false);
    assert.equal(c.transportKind, null);
    assert.equal(c.mode, null);
});

test('established + uninitiated drop = surprise; intentional = not', () => {
    const c = new ConnectionState();
    c.beginAttempt('ble');
    c.finalise();
    assert.equal(c.established, true);
    assert.equal(c.drop(), true, 'surprise');
    assert.equal(c.lastDropWasSurprise, true, 'remembered for adapter-on');
    assert.equal(c.established, false);

    c.beginAttempt('ble');
    c.finalise();
    c.intendDisconnect();
    assert.equal(c.drop(), false, 'user asked for it');
    assert.equal(c.lastDropWasSurprise, false);
});

test('mid-reconnect drops never report and never clobber the remembered surprise', () => {
    const c = new ConnectionState();
    c.beginAttempt('serial');
    c.setMode('companion');
    c.finalise();
    assert.equal(c.drop(), true);                              // the original surprise
    c.beginAttempt('serial');                                  // retry attempt fails…
    assert.equal(c.drop({ midReconnect: true }), false, 'cycle owns recovery');
    assert.equal(c.lastDropWasSurprise, true, 'original intent survives failed retries');
});

test('finalise clears the pending surprise gate and teardown intent', () => {
    const c = new ConnectionState();
    c.beginAttempt('ble'); c.finalise(); c.drop();             // surprise remembered
    c.beginAttempt('ble'); c.finalise();
    assert.equal(c.lastDropWasSurprise, false, 'fresh connection clears it');
});

// ---- ReconnectController -------------------------------------------------------

function fakeTimers() {
    let queue = [], id = 0;
    return {
        opts: {
            setTimeoutFn:   (fn, d) => { queue.push({ id: ++id, fn, d }); return id; },
            clearTimeoutFn: tid => { queue = queue.filter(t => t.id !== tid); },
        },
        // Fire the next pending timer; returns its delay (undefined if none).
        async fire() { const t = queue.shift(); if (t) { const d = t.d; await t.fn(); return d; } },
        pending: () => queue.length,
    };
}

function harness({ backAfter = Infinity, keepGoing = false } = {}) {
    const t = fakeTimers();
    const log = { attempts: 0, starts: 0, gaveUp: 0 };
    const rc = new ReconnectController({
        attempt:        async () => { log.attempts++; },
        isBack:         () => log.attempts >= backAfter,
        onAttemptStart: () => { log.starts++; },
        onGiveUp:       () => { log.gaveUp++; },
        keepGoing:      () => keepGoing,
    }, t.opts);
    return { t, log, rc };
}

test('failing attempts: 500 ms first try, capped exponential backoff, give up after 5', async () => {
    const { t, log, rc } = harness();
    rc.start();
    assert.equal(rc.active, true);
    const delays = [];
    delays.push(await t.fire());   // try 1
    delays.push(await t.fire());   // try 2
    delays.push(await t.fire());   // try 3
    delays.push(await t.fire());   // try 4
    delays.push(await t.fire());   // try 5 → give up
    assert.deepEqual(delays, [500, 2000, 4000, 8000, 8000]);
    assert.equal(log.attempts, 5);
    assert.equal(log.gaveUp, 1);
    assert.equal(rc.active, false);
    assert.equal(t.pending(), 0, 'nothing left scheduled');
});

test('keepGoing: never gives up — slow steady retry past the fast burst', async () => {
    const { t, log, rc } = harness({ keepGoing: true });
    rc.start();
    const delays = [];
    for (let i = 0; i < 8; i++) delays.push(await t.fire());
    // Fast burst (500→8000) then a fixed 60 s cadence, forever, no give-up.
    assert.deepEqual(delays, [500, 2000, 4000, 8000, 8000, 60000, 60000, 60000]);
    assert.equal(log.gaveUp, 0, 'keepGoing must not give up');
    assert.equal(rc.active, true, 'still trying');
    assert.equal(log.attempts, 8);
});

test('keepGoing recovers when the link finally returns', async () => {
    const { t, log, rc } = harness({ keepGoing: true, backAfter: 7 });
    rc.start();
    for (let i = 0; i < 7; i++) await t.fire();   // 7th attempt "connects"
    assert.equal(rc.active, false, 'stopped once back');
    assert.equal(log.gaveUp, 0);
    assert.equal(t.pending(), 0);
});

test('success stops the cycle without the alarm', async () => {
    const { t, log, rc } = harness({ backAfter: 2 });
    rc.start();
    await t.fire();                       // try 1 fails (isBack still false)
    await t.fire();                       // try 2 succeeds
    assert.equal(rc.active, false);
    assert.equal(log.gaveUp, 0);
    assert.equal(t.pending(), 0);
});

test('already back at tick time: cancels before wasting an attempt', async () => {
    const { t, log, rc } = harness({ backAfter: 0 });   // isBack true from the start
    rc.start();
    await t.fire();
    assert.equal(log.attempts, 0);
    assert.equal(rc.active, false);
});

test('cancel clears the pending timer; start while active is a no-op', async () => {
    const { t, log, rc } = harness();
    rc.start();
    rc.start();                            // no-op — no double schedule
    assert.equal(t.pending(), 1);
    await t.fire();                        // try 1 → reschedules
    rc.cancel();
    assert.equal(rc.active, false);
    assert.equal(t.pending(), 0, 'backoff timer cleared');
    assert.equal(log.attempts, 1);
});
