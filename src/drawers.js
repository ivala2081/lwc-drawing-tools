// ═══════════════════════════════════════════════════════════════════════════════
// drawers — Markup drawing primitives for the lightweight-charts overlay.
// ═══════════════════════════════════════════════════════════════════════════════
// The candlestick chart itself (grid, axes, candles, crosshair, live price) is
// rendered natively by lightweight-charts. This module only draws user markups
// (trend / horizontal / vertical / rect / fib) onto a transparent overlay <canvas>
// positioned over the chart pane.
//
// Coordinate mapping is injected via an `adapter` so this stays renderer-
// agnostic and pure:
//   adapter.timeToX(tMs)  → pixel x (or null if off-screen)
//   adapter.priceToY(p)   → pixel y (or null if off-screen)
// Markups persist their points as actual time {t (ms), price}.
// ═══════════════════════════════════════════════════════════════════════════════

import {
    FIB_DEFAULT_LEVELS, fibLevelPrice, fibLevelLabel, rayEndpoints, markupHandlePoints,
} from './chartMath.js';

/**
 * Selection glow width, in CSS px. DELIBERATELY CONSTANT.
 *
 * It used to be `width + 3`, and since the width picker only exists while a
 * drawing is selected, that meant picking 1 / 2 / 3 moved the visible silhouette
 * by one pixel per click while doubling the ratio of saturated core to washed-out
 * amber. Users read that as "the colour changes but the thickness doesn't" —
 * which was the literal, correct description of what they were seeing. With a
 * fixed envelope the only thing that moves when you change width is the line.
 */
const HALO_PX = 8;

/**
 * Snap a coordinate so a stroke of `width` lands on whole device pixels.
 *
 * Adapter coordinates are fractional. A 1px stroke centred on a fractional y
 * spreads over two rows at ~50% coverage each and renders as a faded 2px band,
 * so thin lines look pale rather than thin and the width steps read as opacity.
 * Odd widths want a half-pixel centre, even widths want an integer one.
 *
 * Axis-aligned geometry only — snapping the endpoints of a diagonal would tilt
 * it, which is worse than a soft edge.
 */
function snapAxis(v, width) {
    if (!Number.isFinite(v)) return v;
    return Math.round(v) + (Math.round(width) % 2 === 1 ? 0.5 : 0);
}

// ── Theme presets ──────────────────────────────────────────────────────────
export const LIGHT_THEME = {
    bull:      '#16a34a',
    bear:      '#dc2626',
    live:      '#2563eb',
    markup:    '#2563eb',
    markupSel: '#f59e0b',
    bg:        '#ffffff',
    rectFill:  'rgba(37, 99, 235, 0.12)',
};

export const DARK_THEME = {
    bull:      '#22c55e',
    bear:      '#ef4444',
    live:      '#3b82f6',
    markup:    '#60a5fa',
    markupSel: '#fbbf24',
    bg:        '#0f141c',
    rectFill:  'rgba(96, 165, 250, 0.16)',
};

function formatPrice(v, decimals = 2) {
    if (!isFinite(v)) return '';
    return v.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

// ── Markups ─────────────────────────────────────────────────────────────────

function drawHandle(ctx, x, y, theme) {
    ctx.save();
    ctx.fillStyle = theme.markupSel;
    ctx.strokeStyle = theme.bg;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

/**
 * One rendering pass of a markup's geometry.
 *
 * `halo: true` draws the same geometry as a wide translucent selection glow —
 * no labels, no fills, no handles. Selection used to RECOLOR the markup to the
 * amber selection color, which meant picking a color from the selection toolbar
 * changed nothing visible until you deselected. Now the stroke always keeps the
 * markup's own color and selection is the halo underneath plus the handles.
 */
function paintMarkup(ctx, markup, adapter, plot, theme, opts) {
    const { color, width, halo, decimals } = opts;
    // Both passes snap against the CORE width, or an odd-width line and its
    // even-width halo would sit half a pixel apart.
    const snapW = opts.snapW ?? width;
    const snap = (v) => snapAxis(v, snapW);
    const p1 = markup.payload?.p1;
    const p2 = markup.payload?.p2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
    ctx.clip();
    if (halo) ctx.globalAlpha = 0.35;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash([]);

    if (markup.tool === 'trend' && p1 && p2) {
        const x1 = adapter.timeToX(p1.t), y1 = adapter.priceToY(p1.price);
        const x2 = adapter.timeToX(p2.t), y2 = adapter.priceToY(p2.price);
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
            // No snapping: this is the one shape that is usually diagonal, and
            // rounding its endpoints would visibly change its slope.
            const [ax, ay, bx, by] =
                rayEndpoints(x1, y1, x2, y2, markup.payload?.extendRight, plot.right);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
        }
    } else if (markup.tool === 'horizontal' && p1) {
        const yRaw = adapter.priceToY(p1.price);
        if (yRaw != null) {
            const y = snap(yRaw);
            ctx.beginPath();
            ctx.moveTo(plot.left, y);
            ctx.lineTo(plot.right, y);
            ctx.stroke();
            if (!halo) {
                const text = formatPrice(p1.price, decimals);
                ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
                const padX = 5, h = 14;
                const w = ctx.measureText(text).width + padX * 2;
                ctx.fillStyle = color;
                ctx.fillRect(plot.right - w - 2, y - h / 2, w, h);
                ctx.fillStyle = '#fff';
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'left';
                ctx.fillText(text, plot.right - w - 2 + padX, y + 0.5);
            }
        }
    } else if (markup.tool === 'vertical' && p1) {
        const xRaw = adapter.timeToX(p1.t);
        if (xRaw != null) {
            const x = snap(xRaw);
            ctx.beginPath();
            ctx.moveTo(x, plot.top);
            ctx.lineTo(x, plot.bottom);
            ctx.stroke();
        }
    } else if (markup.tool === 'fib' && p1 && p2) {
        // Each level's PRICE is computed first and then mapped through the
        // adapter — never lerped between y1 and y2 in pixel space. Identical on
        // a linear scale, wrong on logarithmic/percentage, where the levels
        // would silently drift for exactly the users who changed scale mode.
        const x1 = adapter.timeToX(p1.t);
        const x2 = adapter.timeToX(p2.t);
        if (x1 != null && x2 != null) {
            const levels = Array.isArray(markup.payload?.levels) && markup.payload.levels.length
                ? markup.payload.levels
                : FIB_DEFAULT_LEVELS;
            const lx = Math.min(x1, x2);
            const rx = Math.max(x1, x2);
            ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
            ctx.textBaseline = 'bottom';
            ctx.textAlign = 'left';

            let prevY = null;
            for (const r of levels) {
                const price = fibLevelPrice(p1, p2, r);
                const yRaw = adapter.priceToY(price);
                if (yRaw == null) { prevY = null; continue; }
                const anchor = (r === 0 || r === 1);
                // Anchors one step heavier than the retracements. It used to be
                // the other way round — retracements at `max(1, width - 1)` —
                // which made widths 1 and 2 render identically.
                const lw = anchor ? width + 1 : width;
                const y = snapAxis(yRaw, halo ? snapW : lw);

                // Faint band between consecutive levels, so the retracement
                // zones read at a glance without a per-level colour picker.
                if (!halo && prevY != null) {
                    ctx.fillStyle = theme.rectFill;
                    ctx.fillRect(lx, Math.min(prevY, y), rx - lx, Math.abs(y - prevY));
                }
                prevY = y;

                ctx.strokeStyle = color;
                ctx.lineWidth = halo ? width : lw;
                ctx.setLineDash(anchor || halo ? [] : [4, 3]);
                ctx.beginPath();
                ctx.moveTo(lx, y);
                ctx.lineTo(rx, y);
                ctx.stroke();

                ctx.setLineDash([]);
                if (!halo) {
                    ctx.fillStyle = color;
                    ctx.fillText(`${fibLevelLabel(r)}  ${formatPrice(price, decimals)}`, lx + 4, y - 2);
                }
            }
            ctx.setLineDash([]);
        }
    } else if (markup.tool === 'rect' && p1 && p2) {
        const x1 = adapter.timeToX(p1.t), y1 = adapter.priceToY(p1.price);
        const x2 = adapter.timeToX(p2.t), y2 = adapter.priceToY(p2.price);
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
            const sx1 = snap(x1), sx2 = snap(x2), sy1 = snap(y1), sy2 = snap(y2);
            const rx = Math.min(sx1, sx2), ry = Math.min(sy1, sy2);
            const rw = Math.abs(sx2 - sx1), rh = Math.abs(sy2 - sy1);
            if (!halo) {
                // The fill goes on whole pixels; a half-pixel fill edge leaves a
                // pale seam just inside the stroke.
                ctx.fillStyle = theme.rectFill;
                ctx.fillRect(Math.round(rx), Math.round(ry), Math.round(rw), Math.round(rh));
            }
            ctx.strokeRect(rx, ry, rw, rh);
        }
    }
    ctx.restore();
}

/**
 * Draw a single markup onto the overlay.
 * @param adapter  { timeToX(tMs)→x|null, priceToY(price)→y|null }
 * @param plot     { left, top, right, bottom } pixel bounds of the chart pane
 */
export function drawMarkup(ctx, markup, adapter, plot, theme, selected = false, decimals = 2) {
    const color = markup.payload?.color || theme.markup;
    const width = markup.payload?.width || 2;
    if (selected) {
        paintMarkup(ctx, markup, adapter, plot, theme,
            { color: theme.markupSel, width: HALO_PX, snapW: width, halo: true, decimals });
    }
    paintMarkup(ctx, markup, adapter, plot, theme, { color, width, halo: false, decimals });
    if (selected) {
        // Handle geometry lives in chartMath so the circles you see are exactly
        // the targets the hit-test grabs — they used to be a private copy here,
        // painted but never hit-tested at all.
        for (const h of markupHandlePoints(markup, adapter, plot)) drawHandle(ctx, h.x, h.y, theme);
    }
}

export function drawMarkups(ctx, markups, adapter, plot, theme, selectedId = null, decimals = 2) {
    for (const m of markups) {
        drawMarkup(ctx, m, adapter, plot, theme, m.id === selectedId, decimals);
    }
}

/**
 * Screen-pixel bounding box of a markup, for anchoring UI (the selection
 * toolbar) to it. Null when nothing resolvable is on screen.
 */
export function markupBBoxPx(markup, adapter, plot) {
    const p1 = markup?.payload?.p1;
    const p2 = markup?.payload?.p2;
    if (markup?.tool === 'horizontal' && p1) {
        const y = adapter.priceToY(p1.price);
        if (y == null) return null;
        return { x1: plot.left, y1: y, x2: plot.right, y2: y };
    }
    if (markup?.tool === 'vertical' && p1) {
        const x = adapter.timeToX(p1.t);
        if (x == null) return null;
        return { x1: x, y1: plot.top, x2: x, y2: plot.bottom };
    }
    if (p1 && p2) {
        const x1 = adapter.timeToX(p1.t), y1 = adapter.priceToY(p1.price);
        const x2 = adapter.timeToX(p2.t), y2 = adapter.priceToY(p2.price);
        if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
        let top = Math.min(y1, y2), bottom = Math.max(y1, y2);
        // A fib's visual extent is its full level stack, not just the two clicks.
        if (markup.tool === 'fib') {
            const levels = Array.isArray(markup.payload?.levels) && markup.payload.levels.length
                ? markup.payload.levels
                : FIB_DEFAULT_LEVELS;
            for (const r of levels) {
                const y = adapter.priceToY(fibLevelPrice(p1, p2, r));
                if (y != null) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
            }
        }
        return { x1: Math.min(x1, x2), y1: top, x2: Math.max(x1, x2), y2: bottom };
    }
    return null;
}
