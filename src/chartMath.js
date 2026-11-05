// ═══════════════════════════════════════════════════════════════════════════════
// chartMath — Pure math utilities shared by the chart engine.
// ═══════════════════════════════════════════════════════════════════════════════
// Candle rendering and viewport transforms now live in lightweight-charts; this
// module keeps the interval helpers (for bucketing ticks into candles) and the
// geometry helpers used by markup hit-testing (useMarkupTools).
// ═══════════════════════════════════════════════════════════════════════════════

export const INTERVAL_MS = {
    '1m':  60 * 1000,
    '5m':  5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h':  60 * 60 * 1000,
    '4h':  4 * 60 * 60 * 1000,
    '1d':  24 * 60 * 60 * 1000,
};

/** Align a timestamp (ms) down to the nearest bucket for the given interval. */
export function alignToBucket(tsMs, interval) {
    const step = INTERVAL_MS[interval];
    if (!step) return tsMs;
    return Math.floor(tsMs / step) * step;
}

/** Clamp a value to [min, max]. */
export function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

/**
 * Perpendicular distance from point (px, py) to segment (x1,y1)-(x2,y2)
 * in the same coordinate space. Used for hit-testing trend/horizontal/
 * vertical markups with a pixel tolerance.
 */
export function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        const ax = px - x1;
        const ay = py - y1;
        return Math.sqrt(ax * ax + ay * ay);
    }
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = clamp(t, 0, 1);
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    const ex = px - cx;
    const ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
}

/** Is point inside axis-aligned rectangle? */
export function pointInRect(px, py, x1, y1, x2, y2) {
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/**
 * Extend the segment (x1,y1)→(x2,y2) until it reaches `targetX`.
 *
 * Returns the point ON the line at that x, or null for a vertical segment
 * (no single y exists there). Shared by the renderer and the hit-test so a
 * ray you can see is always a ray you can grab.
 */
export function extendSegmentToX(x1, y1, x2, y2, targetX) {
    const dx = x2 - x1;
    if (dx === 0 || !Number.isFinite(dx)) return null;
    const slope = (y2 - y1) / dx;
    if (!Number.isFinite(slope)) return null;
    return [targetX, y1 + slope * (targetX - x1)];
}

/**
 * The segment a trend line should actually draw and hit-test as, once its
 * optional right-extension is applied. Returns the input unchanged when the ray
 * is off, when the segment is vertical, or when the line already reaches past
 * `rightX` — so a ray never SHORTENS a line the user drew wider than the pane.
 *
 * Both the renderer and the hit-test call this. If they computed it separately
 * the line you can see would stop being the line you can grab.
 */
export function rayEndpoints(x1, y1, x2, y2, extendRight, rightX) {
    if (!extendRight) return [x1, y1, x2, y2];
    const far = extendSegmentToX(x1, y1, x2, y2, rightX);
    if (!far || far[0] <= Math.max(x1, x2)) return [x1, y1, x2, y2];
    return x2 >= x1 ? [x1, y1, far[0], far[1]] : [far[0], far[1], x2, y2];
}

// ── Time ↔ logical (bar-index) space ────────────────────────────────────────
//
// lightweight-charts positions bars by INDEX and collapses weekends and session
// gaps, so "half way between Friday and Monday" is a bar-index concept, not a
// wall-clock one. Its own time↔coordinate API refuses anything that is not
// exactly a bar (`timeToIndex(t, findNearest=false)` returns null both past the
// last bar and between two bars), which is why a drawing could never live in the
// future. These two functions are the continuous, invertible mapping the adapter
// layers on top of `logicalToCoordinate`.
//
// `bars` is the ascending array of bucket times in ms. Outside the data the
// mapping extrapolates at a fixed `intervalMs` — the same assumption every
// terminal makes when it projects a trendline forward.

/** Ascending bucket times (ms) → fractional bar index. May be < 0 or > n-1. */
export function timeToLogical(bars, intervalMs, tMs) {
    const n = bars?.length ?? 0;
    if (!n || !(intervalMs > 0) || !Number.isFinite(tMs)) return null;
    const first = bars[0];
    const last = bars[n - 1];
    if (tMs <= first) return (tMs - first) / intervalMs;
    if (tMs >= last) return (n - 1) + (tMs - last) / intervalMs;

    // Largest i with bars[i] <= tMs. The caller guarantees ascending order.
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (bars[mid] <= tMs) lo = mid; else hi = mid;
    }
    const span = bars[lo + 1] - bars[lo];
    return span > 0 ? lo + (tMs - bars[lo]) / span : lo;
}

/** Fractional bar index → time (ms). Exact inverse of timeToLogical. */
export function logicalToTime(bars, intervalMs, logical) {
    const n = bars?.length ?? 0;
    if (!n || !(intervalMs > 0) || !Number.isFinite(logical)) return null;
    if (logical <= 0) return bars[0] + logical * intervalMs;
    if (logical >= n - 1) return bars[n - 1] + (logical - (n - 1)) * intervalMs;
    const i = Math.floor(logical);
    const span = bars[i + 1] - bars[i];
    return bars[i] + span * (logical - i);
}

// ── Resize handles ──────────────────────────────────────────────────────────
//
// A handle is described by which payload fields it writes, never by where it
// happens to sit on screen — a rectangle dragged past its opposite corner flips,
// and screen-space names ("top left") would then be lying. `t` and `p` say which
// point supplies the time and which supplies the price; null means that axis is
// pinned. The two off-diagonal corners are the interesting case: `rect` stores a
// DIAGONAL p1/p2, so their corners mix one field from each point.

export const HANDLE_HIT_PX = 8;

/** Handle descriptors for a tool. Pure — no adapter, no screen coordinates. */
export function markupHandleSpecs(tool) {
    if (tool === 'horizontal') return [{ id: 'p1', t: null, p: 'p1' }];
    if (tool === 'vertical') return [{ id: 'p1', t: 'p1', p: null }];
    if (tool === 'trend' || tool === 'fib') {
        return [
            { id: 'p1', t: 'p1', p: 'p1' },
            { id: 'p2', t: 'p2', p: 'p2' },
        ];
    }
    if (tool === 'rect') {
        return [
            // corners — both axes move
            { id: 'p1', t: 'p1', p: 'p1' },
            { id: 'p2', t: 'p2', p: 'p2' },
            { id: 'p1t-p2p', t: 'p1', p: 'p2' },
            { id: 'p2t-p1p', t: 'p2', p: 'p1' },
            // edges — one axis pinned
            { id: 'edge-t1', t: 'p1', p: null },
            { id: 'edge-t2', t: 'p2', p: null },
            { id: 'edge-p1', t: null, p: 'p1' },
            { id: 'edge-p2', t: null, p: 'p2' },
        ];
    }
    return [];
}

/**
 * Screen positions of a markup's handles.
 * @returns [{ id, x, y, cursor }] — only the handles that resolve on screen.
 */
export function markupHandlePoints(markup, adapter, plot) {
    const tool = markup?.tool;
    const p1 = markup?.payload?.p1;
    const p2 = markup?.payload?.p2;
    if (!p1) return [];

    const midX = (plot.left + plot.right) / 2;
    const midY = (plot.top + plot.bottom) / 2;
    const x1 = adapter.timeToX(p1.t), y1 = adapter.priceToY(p1.price);

    if (tool === 'horizontal') {
        return y1 == null ? [] : [{ id: 'p1', x: midX, y: y1, cursor: 'ns-resize' }];
    }
    if (tool === 'vertical') {
        return x1 == null ? [] : [{ id: 'p1', x: x1, y: midY, cursor: 'ew-resize' }];
    }
    if (!p2) return [];
    const x2 = adapter.timeToX(p2.t), y2 = adapter.priceToY(p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return [];

    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    // A corner's cursor follows the diagonal it actually sits on, so it stays
    // correct after the shape is dragged inside-out.
    const diag = (x, y) => ((x < cx) === (y < cy) ? 'nwse-resize' : 'nesw-resize');

    if (tool === 'trend' || tool === 'fib') {
        return [
            { id: 'p1', x: x1, y: y1, cursor: diag(x1, y1) },
            { id: 'p2', x: x2, y: y2, cursor: diag(x2, y2) },
        ];
    }
    if (tool === 'rect') {
        return [
            { id: 'p1', x: x1, y: y1, cursor: diag(x1, y1) },
            { id: 'p2', x: x2, y: y2, cursor: diag(x2, y2) },
            { id: 'p1t-p2p', x: x1, y: y2, cursor: diag(x1, y2) },
            { id: 'p2t-p1p', x: x2, y: y1, cursor: diag(x2, y1) },
            { id: 'edge-t1', x: x1, y: cy, cursor: 'ew-resize' },
            { id: 'edge-t2', x: x2, y: cy, cursor: 'ew-resize' },
            { id: 'edge-p1', x: cx, y: y1, cursor: 'ns-resize' },
            { id: 'edge-p2', x: cx, y: y2, cursor: 'ns-resize' },
        ];
    }
    return [];
}

/**
 * Nearest handle within HANDLE_HIT_PX of (px, py), or null.
 * Nearest — not first — so the four rect edge handles never shadow a corner.
 */
export function hitHandle(markup, px, py, adapter, plot, tolPx = HANDLE_HIT_PX) {
    let best = null;
    for (const h of markupHandlePoints(markup, adapter, plot)) {
        const d = Math.hypot(h.x - px, h.y - py);
        if (d <= tolPx && (!best || d < best.d)) best = { ...h, d };
    }
    return best;
}

// ── Fibonacci ───────────────────────────────────────────────────────────────

/**
 * Default retracement ratios. Persisted PER DRAWING (see FIB payload below), so
 * changing this list never silently re-interprets someone's existing drawing.
 */
export const FIB_DEFAULT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/**
 * Price of one fib level.
 *
 * r = 0 sits on p2 (the SECOND click) and r = 1 on p1 (the first), which is the
 * convention every terminal uses: you drag from the swing start to the swing
 * end, and 0% is where you finished.
 *
 * ► Callers must map this price through `adapter.priceToY` and must NOT
 *   interpolate between y1 and y2 in pixel space. The two agree on a linear
 *   price scale and disagree on logarithmic/percentage
 *   (`rightPriceScale.mode`), where a pixel-space lerp puts every intermediate
 *   level at the wrong price — silently, and only for the users who switched
 *   scale mode. The hit-test has to obey the same rule or the line you grab
 *   stops being the line you see.
 */
export function fibLevelPrice(p1, p2, r) {
    return p2.price + (p1.price - p2.price) * r;
}

/** "61.8%" — trailing zeros trimmed, so 0.5 reads "50%" not "50.0%". */
export function fibLevelLabel(r) {
    return `${Number((r * 100).toFixed(1))}%`;
}

// ── OHLC snap ───────────────────────────────────────────────────────────────

/**
 * Snap a pointer position to the nearest candle's open/high/low/close.
 *
 * Both axes snap: the returned point sits ON the bar (its bucket time) at the
 * exact O/H/L/C price, so a trendline drawn between two "roughly there" clicks
 * anchors to real prices. Returns null when nothing is within `tolPx` on either
 * axis — the caller then uses the raw pointer position.
 *
 * `candles` are the chart's own {bucket(ms), open, high, low, close} rows,
 * ascending by bucket; the binary search relies on that order.
 */
export function snapToOHLC(candles, px, py, adapter, tolPx = 8) {
    if (!Array.isArray(candles) || !candles.length) return null;
    const t = adapter.xToTime(px);
    if (t == null) return null;

    // Nearest bar by time: binary search for the insertion point, then compare
    // the neighbours on either side IN PIXELS (bar spacing varies with zoom).
    let lo = 0, hi = candles.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candles[mid].bucket < t) lo = mid + 1; else hi = mid;
    }
    let best = null;
    for (const idx of [lo - 1, lo, lo + 1]) {
        const c = candles[idx];
        if (!c) continue;
        const x = adapter.timeToX(c.bucket);
        if (x == null || Math.abs(x - px) > tolPx) continue;
        for (const price of [c.open, c.high, c.low, c.close]) {
            if (!Number.isFinite(price)) continue;
            const y = adapter.priceToY(price);
            if (y == null) continue;
            const dy = Math.abs(y - py);
            if (dy > tolPx) continue;
            // Rank by the pointer's total offset so the visually closest of the
            // four values wins, not merely the first within tolerance.
            const score = dy + Math.abs(x - px) * 0.25;
            if (!best || score < best.score) best = { t: c.bucket, price, score };
        }
    }
    return best ? { t: best.t, price: best.price } : null;
}
