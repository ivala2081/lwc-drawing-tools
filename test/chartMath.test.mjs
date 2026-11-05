// Run: node --test src/chart/chartMath.test.mjs
//
// chartMath is pure and React-free, so it runs under node --test with no
// bundler — same arrangement as price-aggregator/lib/pusher.test.mjs.
//
// The fibonacci helpers get the attention here because they carry the one
// mistake that is invisible until a user changes their price scale to
// logarithmic, at which point every intermediate level quietly points at the
// wrong price. See the third test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    fibLevelPrice, fibLevelLabel, FIB_DEFAULT_LEVELS, distToSegment, pointInRect, snapToOHLC,
    extendSegmentToX, rayEndpoints, timeToLogical, logicalToTime,
    markupHandleSpecs, markupHandlePoints, hitHandle, HANDLE_HIT_PX,
} from '../src/chartMath.js';

const p1 = { t: 1_000, price: 100 };   // first click  — the swing start
const p2 = { t: 2_000, price: 200 };   // second click — the swing end

test('fib: r=0 lands on the SECOND click, r=1 on the first', () => {
    assert.equal(fibLevelPrice(p1, p2, 0), p2.price);
    assert.equal(fibLevelPrice(p1, p2, 1), p1.price);
});

test('fib: intermediate ratios retrace from p2 back towards p1', () => {
    assert.equal(fibLevelPrice(p1, p2, 0.5), 150);
    assert.equal(Number(fibLevelPrice(p1, p2, 0.618).toFixed(4)), 138.2);
    // Direction must not depend on which point is higher.
    const down1 = { t: 1_000, price: 200 };
    const down2 = { t: 2_000, price: 100 };
    assert.equal(fibLevelPrice(down1, down2, 0), 100);
    assert.equal(fibLevelPrice(down1, down2, 1), 200);
    assert.equal(fibLevelPrice(down1, down2, 0.5), 150);
});

test('fib: price-space is NOT pixel-space once the scale is logarithmic', () => {
    // The whole reason fibLevelPrice exists. A renderer that lerps between y1
    // and y2 agrees with it on a linear scale and diverges on a log scale — so
    // a linear-only test would pass while the bug shipped.
    const H = 400;
    const linearY = (price) => H - ((price - 100) / (200 - 100)) * H;
    const logY = (price) => {
        const l0 = Math.log(100), l1 = Math.log(200);
        return H - ((Math.log(price) - l0) / (l1 - l0)) * H;
    };

    const r = 0.5;
    const correct = fibLevelPrice(p1, p2, r);          // 150
    const y1Lin = linearY(p1.price), y2Lin = linearY(p2.price);
    const y1Log = logY(p1.price),    y2Log = logY(p2.price);
    // What a pixel-space lerp would produce, in both scale modes:
    const lerp = (a, b) => b + (a - b) * r;

    assert.equal(lerp(y1Lin, y2Lin), linearY(correct), 'linear: the two agree, which is the trap');
    assert.notEqual(lerp(y1Log, y2Log), logY(correct), 'log: a pixel lerp points at the wrong price');
    // And concretely: on a log scale the pixel midpoint is sqrt(100*200) ≈ 141.42, not 150.
    const pixelMidPrice = Math.exp(Math.log(100) + (Math.log(200) - Math.log(100)) * 0.5);
    assert.equal(Number(pixelMidPrice.toFixed(2)), 141.42);
});

test('fib: default level set is the conventional one, ordered, 0..1', () => {
    assert.deepEqual(FIB_DEFAULT_LEVELS, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    const sorted = [...FIB_DEFAULT_LEVELS].sort((a, b) => a - b);
    assert.deepEqual(FIB_DEFAULT_LEVELS, sorted, 'renderer bands assume ascending order');
    assert.ok(FIB_DEFAULT_LEVELS.every(r => r >= 0 && r <= 1));
});

test('fib: labels trim trailing zeros', () => {
    assert.equal(fibLevelLabel(0), '0%');
    assert.equal(fibLevelLabel(0.5), '50%');
    assert.equal(fibLevelLabel(0.618), '61.8%');
    assert.equal(fibLevelLabel(1), '100%');
});

test('geometry helpers still behave (used by every tool hit-test)', () => {
    assert.equal(distToSegment(0, 0, 0, 0, 0, 0), 0);          // degenerate segment
    assert.equal(distToSegment(5, 0, 0, 0, 10, 0), 0);         // on the segment
    assert.equal(distToSegment(0, 3, 0, 0, 10, 0), 3);         // perpendicular
    assert.equal(distToSegment(-4, 0, 0, 0, 10, 0), 4);        // clamped past an end
    assert.ok(pointInRect(5, 5, 0, 0, 10, 10));
    assert.ok(pointInRect(5, 5, 10, 10, 0, 0));                // corner order free
    assert.ok(!pointInRect(11, 5, 0, 0, 10, 10));
});

test('snapToOHLC: snaps both axes to the nearest OHLC value within tolerance', () => {
    // 1px per price unit, 10px per bar — a linear fake adapter.
    const candles = [
        { bucket: 0,     open: 100, high: 110, low: 95,  close: 105 },
        { bucket: 60_000, open: 105, high: 120, low: 100, close: 118 },
    ];
    const adapter = {
        xToTime: (px) => Math.round(px / 10) * 60_000 / 6,   // not used for precision
        timeToX: (t) => (t / 60_000) * 10,
        priceToY: (p) => 200 - p,
        yToPrice: (y) => 200 - y,
    };
    // Pointer near bar 1's high (120 → y=80): y=79 is 1px from the high and
    // 3px from the close (118 → y=82), so the high must win.
    const hit = snapToOHLC(candles, 10, 79, adapter, 8);
    assert.deepEqual(hit, { t: 60_000, price: 120 });
    // ...and 1px the other side (y=81.5) the close must win instead — the
    // visually closest of the four values, not the first within tolerance.
    assert.equal(snapToOHLC(candles, 10, 81.6, adapter, 8).price, 118);
    // Same x, but y far from any OHLC → null
    assert.equal(snapToOHLC(candles, 10, 140, adapter, 8), null);
    // x beyond tolerance of any bar → null (bars at x=0 and x=10; px=30)
    assert.equal(snapToOHLC(candles, 30, 83, adapter, 8), null);
    // The CLOSEST of the four wins: bar 0 at x=0, pointer y between open(100)
    // and close(105) but nearer close → 105.
    const near = snapToOHLC(candles, 0, 200 - 104, adapter, 8);
    assert.equal(near.price, 105);
    // Empty input
    assert.equal(snapToOHLC([], 0, 0, adapter, 8), null);
});

// ── time ↔ logical ──────────────────────────────────────────────────────────
// A one-hour series with a deliberate GAP (a weekend): buckets 0,1,2 are
// contiguous, then a jump. lightweight-charts collapses that gap by index, so
// index space and wall-clock space genuinely disagree here — which is the whole
// reason these two functions exist.
const H = 3_600_000;
const BARS = [0, H, 2 * H, 10 * H, 11 * H];   // gap between index 2 and 3

test('timeToLogical: exact bars map to their integer index', () => {
    BARS.forEach((t, i) => assert.equal(timeToLogical(BARS, H, t), i));
});

test('timeToLogical: between two bars interpolates on the REAL bucket delta', () => {
    // Half way through bar 0's hour → 0.5.
    assert.equal(timeToLogical(BARS, H, H / 2), 0.5);
    // Half way across the 8-hour weekend gap is still logical 2.5 — the chart
    // draws that gap as ONE bar width, not eight.
    assert.equal(timeToLogical(BARS, H, 6 * H), 2.5);
});

test('timeToLogical: extrapolates past both ends at a fixed interval', () => {
    assert.equal(timeToLogical(BARS, H, 12 * H), 5);        // 1 bar past the end
    assert.equal(timeToLogical(BARS, H, 21 * H), 14);       // 10 bars past the end
    assert.equal(timeToLogical(BARS, H, -H), -1);           // 1 bar before the start
    assert.equal(timeToLogical(BARS, H, -10 * H), -10);
});

test('logicalToTime is the exact inverse, inside the data and outside it', () => {
    for (const l of [-10, -1, -0.25, 0, 0.5, 1, 2, 2.5, 3, 3.75, 4, 4.5, 14]) {
        const t = logicalToTime(BARS, H, l);
        assert.equal(timeToLogical(BARS, H, t), l, `round-trip failed at logical ${l}`);
    }
});

test('time↔logical: degenerate inputs return null, never NaN', () => {
    assert.equal(timeToLogical([], H, 0), null);
    assert.equal(timeToLogical(undefined, H, 0), null);
    assert.equal(timeToLogical(BARS, 0, 0), null);
    assert.equal(timeToLogical(BARS, H, NaN), null);
    assert.equal(logicalToTime([], H, 0), null);
    assert.equal(logicalToTime(BARS, H, NaN), null);
    // A single-bar series still extrapolates in both directions.
    assert.equal(logicalToTime([5_000], H, 2), 5_000 + 2 * H);
    assert.equal(timeToLogical([5_000], H, 5_000 + 2 * H), 2);
});

// ── extend right (ray) ──────────────────────────────────────────────────────

test('extendSegmentToX projects along the slope, both directions', () => {
    assert.deepEqual(extendSegmentToX(0, 0, 10, 10, 100), [100, 100]);
    assert.deepEqual(extendSegmentToX(0, 100, 10, 90, 50), [50, 50]);   // falling
    assert.deepEqual(extendSegmentToX(10, 10, 0, 0, 100), [100, 100]);  // point order free
    assert.deepEqual(extendSegmentToX(0, 7, 10, 7, 100), [100, 7]);     // flat
});

test('rayEndpoints only ever lengthens, and only to the right', () => {
    // Off → untouched.
    assert.deepEqual(rayEndpoints(0, 0, 10, 10, false, 500), [0, 0, 10, 10]);
    // On → the right-most endpoint moves to the pane edge.
    assert.deepEqual(rayEndpoints(0, 0, 10, 10, true, 500), [0, 0, 500, 500]);
    // Which endpoint is "right-most" is decided by geometry, not by p1/p2 order.
    assert.deepEqual(rayEndpoints(10, 10, 0, 0, true, 500), [500, 500, 0, 0]);
    // Already past the edge → left alone, so a ray never SHORTENS the drawing.
    assert.deepEqual(rayEndpoints(0, 0, 900, 900, true, 500), [0, 0, 900, 900]);
    // Vertical → no single y at rightX, fall back to the plain segment.
    assert.deepEqual(rayEndpoints(5, 0, 5, 100, true, 500), [5, 0, 5, 100]);
});

test('extendSegmentToX returns null for a vertical segment', () => {
    // No single y exists at targetX — the caller must fall back to the plain
    // segment rather than paint a NaN.
    assert.equal(extendSegmentToX(5, 0, 5, 100, 400), null);
});

// ── resize handles ──────────────────────────────────────────────────────────
// 10px per bar, 1px per price unit, price 200 at the top.
const ADAPTER = {
    timeToX: (t) => (t / H) * 10,
    priceToY: (p) => 200 - p,
    xToTime: (x) => (x / 10) * H,
    yToPrice: (y) => 200 - y,
};
const PLOT = { left: 0, top: 0, right: 500, bottom: 200 };

test('handle specs say which payload FIELDS move, not where they sit', () => {
    assert.deepEqual(markupHandleSpecs('horizontal'), [{ id: 'p1', t: null, p: 'p1' }]);
    assert.deepEqual(markupHandleSpecs('vertical'), [{ id: 'p1', t: 'p1', p: null }]);
    assert.deepEqual(markupHandleSpecs('trend').map(s => s.id), ['p1', 'p2']);
    assert.deepEqual(markupHandleSpecs('fib').map(s => s.id), ['p1', 'p2']);
    assert.equal(markupHandleSpecs('rect').length, 8, '4 corners + 4 edges');
    assert.deepEqual(markupHandleSpecs('nope'), []);

    // The two off-diagonal corners are the ones a diagonal payload makes subtle:
    // each takes its time from one point and its price from the other.
    const rect = markupHandleSpecs('rect');
    assert.deepEqual(rect.find(s => s.id === 'p1t-p2p'), { id: 'p1t-p2p', t: 'p1', p: 'p2' });
    assert.deepEqual(rect.find(s => s.id === 'p2t-p1p'), { id: 'p2t-p1p', t: 'p2', p: 'p1' });
    // Edge handles pin exactly one axis.
    assert.equal(rect.find(s => s.id === 'edge-t1').p, null);
    assert.equal(rect.find(s => s.id === 'edge-p1').t, null);
});

test('rect exposes all four corners even though the payload is a diagonal', () => {
    const rect = { tool: 'rect', payload: { p1: { t: 0, price: 100 }, p2: { t: 3 * H, price: 160 } } };
    const pts = markupHandlePoints(rect, ADAPTER, PLOT);
    const at = (id) => pts.find(h => h.id === id);
    assert.equal(pts.length, 8);
    assert.deepEqual([at('p1').x, at('p1').y], [0, 100]);
    assert.deepEqual([at('p2').x, at('p2').y], [30, 40]);
    assert.deepEqual([at('p1t-p2p').x, at('p1t-p2p').y], [0, 40]);
    assert.deepEqual([at('p2t-p1p').x, at('p2t-p1p').y], [30, 100]);
    // Edge handles sit at the midpoint of the axis they do NOT control.
    assert.deepEqual([at('edge-t1').x, at('edge-t1').y], [0, 70]);
    assert.deepEqual([at('edge-p2').x, at('edge-p2').y], [15, 40]);
});

test('corner cursors follow the diagonal, so they survive an inside-out drag', () => {
    const mk = (p1, p2) => ({ tool: 'rect', payload: { p1, p2 } });
    const cursorOf = (m, id) => markupHandlePoints(m, ADAPTER, PLOT).find(h => h.id === id).cursor;
    // p1 low-and-early → bottom-left on screen → the NE–SW diagonal.
    const a = mk({ t: 0, price: 100 }, { t: 3 * H, price: 160 });
    assert.equal(cursorOf(a, 'p1'), 'nesw-resize');
    assert.equal(cursorOf(a, 'p1t-p2p'), 'nwse-resize');   // same x, other price → top-left
    // Same two corners, price swapped: p1 is now TOP-left, and its cursor must
    // flip with the geometry rather than stay stuck to the field name.
    const b = mk({ t: 0, price: 160 }, { t: 3 * H, price: 100 });
    assert.equal(cursorOf(b, 'p1'), 'nwse-resize');
    assert.equal(cursorOf(b, 'p1t-p2p'), 'nesw-resize');
});

test('one-point tools park their single handle mid-plot on the free axis', () => {
    const h = markupHandlePoints(
        { tool: 'horizontal', payload: { p1: { t: 0, price: 150 } } }, ADAPTER, PLOT);
    assert.deepEqual(h, [{ id: 'p1', x: 250, y: 50, cursor: 'ns-resize' }]);
    const v = markupHandlePoints(
        { tool: 'vertical', payload: { p1: { t: 2 * H, price: 150 } } }, ADAPTER, PLOT);
    assert.deepEqual(v, [{ id: 'p1', x: 20, y: 100, cursor: 'ew-resize' }]);
});

test('hitHandle returns the NEAREST handle, not the first one in range', () => {
    // A short rectangle so a corner and an edge handle are both within
    // tolerance of the same pointer: p1 corner at (0,100), edge-t1 at (0,96).
    // Corners are listed first, so a first-match implementation would always
    // answer 'p1' — and the edge handles would be unreachable in every small
    // rectangle a trader draws.
    const tight = { tool: 'rect', payload: { p1: { t: 0, price: 100 }, p2: { t: 3 * H, price: 108 } } };
    assert.equal(hitHandle(tight, 0, 99, ADAPTER, PLOT).id, 'p1');
    assert.equal(hitHandle(tight, 0, 95, ADAPTER, PLOT).id, 'edge-t1');

    const rect = { tool: 'rect', payload: { p1: { t: 0, price: 100 }, p2: { t: 3 * H, price: 160 } } };
    // Dead centre of the shape touches nothing — the body drag still works there.
    assert.equal(hitHandle(rect, 15, 70, ADAPTER, PLOT), null);
    // Tolerance boundary.
    assert.equal(hitHandle(rect, 0, 100 + HANDLE_HIT_PX + 1, ADAPTER, PLOT), null);
    assert.equal(hitHandle(rect, 0, 100 + HANDLE_HIT_PX - 1, ADAPTER, PLOT).id, 'p1');
});

test('handles vanish rather than resolve to NaN when a point is off-scale', () => {
    const dead = { timeToX: () => null, priceToY: () => null, xToTime: () => null, yToPrice: () => null };
    const rect = { tool: 'rect', payload: { p1: { t: 0, price: 100 }, p2: { t: H, price: 160 } } };
    assert.deepEqual(markupHandlePoints(rect, dead, PLOT), []);
    assert.equal(hitHandle(rect, 0, 0, dead, PLOT), null);
    assert.deepEqual(markupHandlePoints({ tool: 'trend', payload: {} }, ADAPTER, PLOT), []);
});
