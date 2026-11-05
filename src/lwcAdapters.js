// ═══════════════════════════════════════════════════════════════════════════════
// lwcAdapters — Glue between our candle/markup model and lightweight-charts.
// ═══════════════════════════════════════════════════════════════════════════════
// • toLwcBar / toLwcData — map {bucket(ms), o,h,l,c} → {time(sec), o,h,l,c}
// • makeAdapter — wrap a chart+series into the {timeToX, priceToY, xToTime,
//   yToPrice} coordinate adapter the markup layer expects. All map functions
//   return null when the point is off-screen / not resolvable.
// lightweight-charts uses UNIX seconds for `time` and spaces bars by index
// (collapsing real-time gaps), which is exactly the behaviour the old `_vt`
// hack emulated by hand.
// ═══════════════════════════════════════════════════════════════════════════════

import { timeToLogical, logicalToTime } from './chartMath.js';

/** ms → lightweight-charts Time (UNIX seconds). */
export function msToSec(ms) {
    return Math.floor(ms / 1000);
}

/** One candle → a lightweight-charts candlestick bar. */
export function toLwcBar(c) {
    return {
        time: msToSec(c.bucket),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
    };
}

/**
 * Map candles → bars, de-duplicating identical `time` keys (lightweight-charts
 * rejects non-unique / non-ascending times). Keeps the last bar for a time.
 */
export function toLwcData(candles) {
    const out = [];
    let lastTime = -Infinity;
    for (const c of candles) {
        const bar = toLwcBar(c);
        if (bar.time < lastTime) continue;          // out-of-order → skip
        if (bar.time === lastTime) { out[out.length - 1] = bar; continue; } // dup → replace
        out.push(bar);
        lastTime = bar.time;
    }
    return out;
}

/**
 * Build the coordinate adapter the markup layer uses. `chart` and `series`
 * are the live lightweight-charts instances.
 *
 * `opts` is OPTIONAL: `{ bars, intervalMs }`, where `bars` is the ascending
 * array of bucket times in ms. Pass it and the time axis becomes continuous and
 * unbounded — a point can sit between two candles or a hundred bars into the
 * future. Omit it and the adapter snaps to existing bars, which is
 * lightweight-charts' own behaviour.
 *
 * WHY THE OPTIONAL PATH EXISTS AT ALL
 * `timeScale().timeToCoordinate(t)` calls `timeToIndex(t, findNearest=false)`,
 * which returns null for any time past the last bar AND for any time between two
 * bars. Every caller then null-guards and drops the drawing, so a trendline
 * could not be extended forward, a click in the right-hand whitespace was
 * swallowed, and dragging a shape into that whitespace moved its price while its
 * time stuck — the shape deformed instead of translating.
 *
 * ► Both directions interpolate between two ADJACENT INTEGER logicals on
 *   purpose. `logicalToCoordinate` returns 0 — not an interpolated x — for a
 *   non-integer index (`if (!isInteger(index)) return 0`), and
 *   `coordinateToLogical` hands back an integer. Feed either a fraction and
 *   every drawing on the chart stacks up at x = 0. The underlying index→pixel
 *   map is exactly linear, so sampling two integers and interpolating is not an
 *   approximation; it is the same function.
 */
export function makeAdapter(chart, series, opts) {
    const ts = chart.timeScale();
    const bars = opts?.bars;
    const intervalMs = opts?.intervalMs;
    const continuous = Array.isArray(bars) && bars.length > 0 && intervalMs > 0;

    const priceToY = (price) => {
        const y = series.priceToCoordinate(price);
        return y == null ? null : y;
    };
    const yToPrice = (py) => {
        const p = series.coordinateToPrice(py);
        return p == null ? null : p;
    };

    if (!continuous) {
        return {
            timeToX: (tMs) => {
                const x = ts.timeToCoordinate(msToSec(tMs));
                return x == null ? null : x;
            },
            priceToY,
            xToTime: (px) => {
                const t = ts.coordinateToTime(px);
                return t == null ? null : t * 1000; // sec → ms
            },
            yToPrice,
        };
    }

    /** Bar spacing in px around a given integer index, or null. */
    const spacingAt = (lo) => {
        const a = ts.logicalToCoordinate(lo);
        const b = ts.logicalToCoordinate(lo + 1);
        if (a == null || b == null) return null;
        const d = b - a;
        return d === 0 || !Number.isFinite(d) ? null : { a, d };
    };

    return {
        timeToX: (tMs) => {
            const logical = timeToLogical(bars, intervalMs, tMs);
            if (logical == null) return null;
            const lo = Math.floor(logical);
            const s = spacingAt(lo);
            if (!s) return null;
            return s.a + s.d * (logical - lo);
        },
        priceToY,
        xToTime: (px) => {
            const lo = ts.coordinateToLogical(px);   // integer, valid in whitespace
            if (lo == null) return null;
            const s = spacingAt(lo);
            if (!s) return null;
            return logicalToTime(bars, intervalMs, lo + (px - s.a) / s.d);
        },
        yToPrice,
    };
}
