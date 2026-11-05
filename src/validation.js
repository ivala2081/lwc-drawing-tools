// ═══════════════════════════════════════════════════════════════════════════════
// validation — Shared candle/tick sanitization for the chart engine (DRY).
// ═══════════════════════════════════════════════════════════════════════════════
// Single source of truth for asset-class detection and the spike thresholds
// used by:
//   • sanitizeCandles()  — clamps poisoned OHLC bars when you load history
//   • maxLiveJumpPct()   — threshold for rejecting spiking live ticks
//   • robustPriceBand()  — outlier-tolerant auto-scale range
// Pure functions, no DOM: they run in the browser and in Node alike, so a
// tick server can share the exact same thresholds.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-asset-class thresholds.
 *   maxDeltaPct  — a single bar's high/low (or a live tick) may not deviate
 *                  more than this % from the local reference price.
 * Values intentionally generous: they only catch gross corruption (bad prints), not normal volatility.
 */
export const ASSET_PCT = {
    forex:   5,
    metals:  8,
    energy:  10,
    crypto:  15,
    stocks:  12,
    default: 10,
};

/**
 * Classify a symbol into an asset class from its string only (no metadata).
 */
export function assetClassFor(symbol) {
    if (!symbol) return 'default';
    const s = String(symbol).toUpperCase();
    const bare = s.replace(/\//g, '');

    // Metals — XAU/XAG/XPT/XPD/XCU/XAL/XNI (+ currency)
    if (/^(XAU|XAG|XPT|XPD|XCU|XAL|XNI)/.test(bare)) return 'metals';
    // Energy — oil & gas
    if (/(WTI|BRENT|UKOIL|USOIL|NGAS|XNG|XBR|XTI)/.test(bare)) return 'energy';
    // Crypto
    if (/(BTC|ETH|XRP|LTC|BCH|ADA|SOL|DOGE|DOT|BNB)/.test(bare)) return 'crypto';
    // Forex — anything with a slash that wasn't a metal/energy above, or a
    // clean 6-letter pair.
    if (s.includes('/') || /^[A-Z]{6}$/.test(bare)) return 'forex';
    // Bare ticker (1-5 letters) → stock
    if (/^[A-Z]{1,5}$/.test(bare)) return 'stocks';
    return 'default';
}

/** Max % a single bar's high/low (or a live tick) may deviate from reference. */
export function maxDeltaPct(symbol) {
    return ASSET_PCT[assetClassFor(symbol)] ?? ASSET_PCT.default;
}

/** Threshold for rejecting a live tick — same as the candle clamp. */
export function maxLiveJumpPct(symbol) {
    return maxDeltaPct(symbol);
}

/** Median of a numeric array (does not mutate input). Returns NaN if empty. */
function median(arr) {
    if (!arr.length) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated percentile (0..1) of a numeric array. */
function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Robust price band for the chart's auto-scale. Uses median ± K × IQR (tolerant
 * of up to ~25% corrupt bars), widened to include the 2nd/98th percentile of
 * real lows/highs so normal wicks are never clipped. Any residual spike beyond
 * the band simply clips at the chart edge instead of squashing the whole scale.
 * @returns {{min:number, max:number}|null}
 */
export function robustPriceBand(candles) {
    if (!candles || candles.length === 0) return null;
    const closes = candles.map(c => c.close).filter(v => isFinite(v)).sort((a, b) => a - b);
    if (closes.length === 0) return null;
    const med = median(closes);
    const q1 = percentile(closes, 0.25);
    const q3 = percentile(closes, 0.75);
    const iqr = Math.max(q3 - q1, med * 0.0005); // floor so flat data still gets a band
    const K = 6;

    const lows = candles.map(c => c.low).filter(isFinite).sort((a, b) => a - b);
    const highs = candles.map(c => c.high).filter(isFinite).sort((a, b) => a - b);
    const pad = iqr * 0.5;

    let min = Math.min(med - K * iqr, percentile(lows, 0.02)) - pad;
    let max = Math.max(med + K * iqr, percentile(highs, 0.98)) + pad;
    if (!(max > min)) { min = med * 0.999; max = med * 1.001; }
    return { min, max };
}

const HAMPEL_W = 10;    // half-window of neighbours used for the centered median
const HAMPEL_K = 5;     // allowed deviation = K × MAD of the centered window
const FLOOR_PCT = 0.0015; // never clamp tighter than 0.15% (normal noise headroom)

/**
 * Sanitize candle rows with a Hampel filter (centered-median outlier clamp).
 *
 * Why centered (look-ahead) and not trailing: a corrupt spike candle differs
 * from BOTH its neighbours, while a genuine trend agrees with the candles that
 * follow it. A centered median therefore ignores isolated spikes but tracks
 * real trends — so we can clamp ALL of open/high/low/close (the spikes in the
 * data put the corruption in the body, not just the wick) without flattening
 * legitimate moves.
 *
 * Per bar i:
 *   med    = median of closes in [i-W, i+W]
 *   mad    = median(|close_j - med|) over that window (robust spread)
 *   maxDev = clamp(K × mad, floor 0.15%, ceiling assetPct%) of med
 *   each of o/h/l/c is clamped into [med - maxDev, med + maxDev], then OHLC
 *   invariants are re-asserted. Bars are clamped, never dropped (dropping
 *   them would leave gaps in the chart).
 *
 * @param {Array} rows  raw rows: {bucket, open, high, low, close, tick_count}
 * @param {string} symbol  for asset-class threshold
 * @returns {Array} sanitized candles (same shape, chronological order preserved)
 */
export function sanitizeCandles(rows, symbol) {
    const assetPct = maxDeltaPct(symbol);

    // Pass 1 — parse & coerce (PG returns DECIMAL as strings); drop unusable.
    const parsed = [];
    for (const r of rows) {
        const close = Number(r.close);
        if (!isFinite(close) || close <= 0) continue;
        let open = Number(r.open);
        let high = Number(r.high);
        let low  = Number(r.low);
        if (!isFinite(open)) open = close;
        if (!isFinite(high)) high = close;
        if (!isFinite(low))  low  = close;
        parsed.push({
            bucket: typeof r.bucket === 'number' ? r.bucket : new Date(r.bucket).getTime(),
            open, high, low, close, tick_count: r.tick_count,
        });
    }
    if (parsed.length === 0) return parsed;

    const closes = parsed.map(p => p.close);
    const n = closes.length;

    // Pass 2 — centered Hampel clamp.
    return parsed.map((p, i) => {
        const lo = Math.max(0, i - HAMPEL_W);
        const hi = Math.min(n - 1, i + HAMPEL_W);
        const win = closes.slice(lo, hi + 1);
        const med = median(win);
        const mad = median(win.map(v => Math.abs(v - med))) || 0;

        const maxDev = Math.min(
            med * (assetPct / 100),                       // ceiling: never clamp a huge legit move
            Math.max(mad * HAMPEL_K, med * FLOOR_PCT),    // volatility bound w/ noise floor
        );
        const clamp = v => v < med - maxDev ? med - maxDev
                         : v > med + maxDev ? med + maxDev : v;

        let open = clamp(p.open);
        let close = clamp(p.close);
        let high = clamp(p.high);
        let low  = clamp(p.low);
        high = Math.max(high, open, close);
        low  = Math.min(low, open, close);

        return { bucket: p.bucket, open, high, low, close, tick_count: p.tick_count };
    });
}
