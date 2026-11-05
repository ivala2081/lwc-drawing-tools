// ═══════════════════════════════════════════════════════════════════════════════
// useMarkupTools — Active drawing tool, in-progress draft, hit-testing.
// ═══════════════════════════════════════════════════════════════════════════════
// State machine per tool:
//   trend / rect / fib: click(p1) → move(preview) → click(p2) → commit
//   horizontal:        click → commit (price only)
//   vertical:          click → commit (time only)
//
// Hit-test & move run in pixel space via an injected coordinate `adapter`
// (backed by lightweight-charts), so this hook is renderer-agnostic:
//   adapter.timeToX(tMs)   → x|null      adapter.xToTime(px) → tMs|null
//   adapter.priceToY(p)    → y|null      adapter.yToPrice(py) → price|null
// Markups store actual time {t (ms), price}.
// ═══════════════════════════════════════════════════════════════════════════════

import { useCallback, useMemo, useState } from 'react';
import {
    distToSegment, pointInRect, fibLevelPrice, FIB_DEFAULT_LEVELS,
    rayEndpoints, markupHandleSpecs,
} from '../chartMath.js';

export const TOOLS = ['cursor', 'trend', 'horizontal', 'vertical', 'rect', 'fib'];
export const TWO_POINT_TOOLS = new Set(['trend', 'rect', 'fib']);
const HIT_TOLERANCE_PX = 6;

export function useMarkupTools() {
    const [activeTool, setActiveTool] = useState('cursor');
    const [draft, setDraft] = useState(null); // { tool, p1, p2? } in data space
    const [selectedId, setSelectedId] = useState(null);

    const cancelDraft = useCallback(() => setDraft(null), []);

    /**
     * Handle a click in the plot area. Returns an object describing what to do
     * next: `null` when nothing to commit, or `{ commit: markupPayload }`.
     */
    const handleClick = useCallback(({ dataPoint }) => {
        if (activeTool === 'cursor') return null;

        if (activeTool === 'horizontal') {
            return { commit: { tool: 'horizontal', payload: { p1: { t: dataPoint.t, price: dataPoint.price } } } };
        }
        if (activeTool === 'vertical') {
            return { commit: { tool: 'vertical', payload: { p1: { t: dataPoint.t, price: dataPoint.price } } } };
        }

        if (TWO_POINT_TOOLS.has(activeTool)) {
            if (!draft) {
                setDraft({ tool: activeTool, p1: dataPoint });
                return null;
            }
            setDraft(null);
            const payload = { p1: draft.p1, p2: dataPoint };
            // Freeze the ratios into the drawing. If they were read from the
            // constant at render time instead, changing the default set later
            // would silently re-interpret every fib anyone had already drawn.
            if (activeTool === 'fib') payload.levels = [...FIB_DEFAULT_LEVELS];
            return { commit: { tool: activeTool, payload } };
        }
        return null;
    }, [activeTool, draft]);

    /** Call on mousemove while a draft is in progress. */
    const handleMove = useCallback(({ dataPoint }) => {
        if (!draft) return;
        setDraft(prev => prev ? { ...prev, p2: dataPoint } : null);
    }, [draft]);

    /**
     * Pixel-space hit test against a list of markups. Returns the first
     * (top-most) markup id whose shape is within tolerance of (px, py), or null.
     * `adapter` maps {t, price} → pixel coords.
     *
     * `plot` is OPTIONAL and only matters for a trend line with `extendRight`:
     * without it the ray is grabbable along its drawn anchors but not along its
     * projection.
     */
    const hitTest = useCallback((markups, px, py, adapter, plot) => {
        for (let i = markups.length - 1; i >= 0; i--) {
            const m = markups[i];
            const { tool, payload } = m;
            if (!payload) continue;
            if (tool === 'trend' && payload.p1 && payload.p2) {
                const x1 = adapter.timeToX(payload.p1.t), y1 = adapter.priceToY(payload.p1.price);
                const x2 = adapter.timeToX(payload.p2.t), y2 = adapter.priceToY(payload.p2.price);
                if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
                const [ax, ay, bx, by] = plot
                    ? rayEndpoints(x1, y1, x2, y2, payload.extendRight, plot.right)
                    : [x1, y1, x2, y2];
                if (distToSegment(px, py, ax, ay, bx, by) <= HIT_TOLERANCE_PX) return m.id;
            } else if (tool === 'horizontal' && payload.p1) {
                const y = adapter.priceToY(payload.p1.price);
                if (y != null && Math.abs(py - y) <= HIT_TOLERANCE_PX) return m.id;
            } else if (tool === 'vertical' && payload.p1) {
                const x = adapter.timeToX(payload.p1.t);
                if (x != null && Math.abs(px - x) <= HIT_TOLERANCE_PX) return m.id;
            } else if (tool === 'fib' && payload.p1 && payload.p2) {
                // Same rule as the renderer: level PRICE first, then through the
                // adapter. Interpolating in pixel space here would make the line
                // you can grab drift away from the line you can see as soon as
                // the price scale is logarithmic.
                const x1 = adapter.timeToX(payload.p1.t);
                const x2 = adapter.timeToX(payload.p2.t);
                if (x1 == null || x2 == null) continue;
                if (px < Math.min(x1, x2) - HIT_TOLERANCE_PX) continue;
                if (px > Math.max(x1, x2) + HIT_TOLERANCE_PX) continue;
                const levels = Array.isArray(payload.levels) && payload.levels.length
                    ? payload.levels
                    : FIB_DEFAULT_LEVELS;
                let hit = false;
                for (const r of levels) {
                    const y = adapter.priceToY(fibLevelPrice(payload.p1, payload.p2, r));
                    if (y != null && Math.abs(py - y) <= HIT_TOLERANCE_PX) { hit = true; break; }
                }
                if (hit) return m.id;
            } else if (tool === 'rect' && payload.p1 && payload.p2) {
                const x1 = adapter.timeToX(payload.p1.t), y1 = adapter.priceToY(payload.p1.price);
                const x2 = adapter.timeToX(payload.p2.t), y2 = adapter.priceToY(payload.p2.price);
                if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
                if (pointInRect(px, py, x1, y1, x2, y2)) return m.id;
            }
        }
        return null;
    }, []);

    /**
     * Move the entire markup by pixel delta. Converts each point to pixels,
     * shifts, and converts back to data space via the adapter.
     */
    const movePayload = useCallback((payload, tool, dxPx, dyPx, adapter) => {
        const shift = (pt) => {
            if (!pt) return pt;
            const x = adapter.timeToX(pt.t);
            const y = adapter.priceToY(pt.price);
            if (x == null || y == null) return pt; // off-screen — leave as-is
            const newT = adapter.xToTime(x + dxPx);
            const newPrice = adapter.yToPrice(y + dyPx);
            return {
                t: newT == null ? pt.t : newT,
                price: newPrice == null ? pt.price : newPrice,
            };
        };
        // A horizontal line has no time and a vertical one has no price, so
        // moving the axis they do not render would only let their stored value
        // wander — now visibly, since the adapter no longer quantises time to
        // whole bars.
        if (tool === 'horizontal') {
            const moved = shift(payload.p1);
            return { ...payload, p1: { ...payload.p1, price: moved.price } };
        }
        if (tool === 'vertical') {
            const moved = shift(payload.p1);
            return { ...payload, p1: { ...payload.p1, t: moved.t } };
        }
        return { ...payload, p1: shift(payload.p1), p2: shift(payload.p2) };
    }, []);

    /**
     * Resize by dragging ONE handle: the grabbed handle moves, everything else
     * stays pinned.
     *
     * The handle spec says which payload field supplies the time and which
     * supplies the price (`chartMath.markupHandleSpecs`). That indirection is
     * what makes a rectangle work: it stores a DIAGONAL p1/p2, so its two
     * off-diagonal corners take their time from one point and their price from
     * the other, and its edge handles pin one axis entirely. Dragging a corner
     * past its opposite is allowed — the renderer normalises with min/max.
     */
    const resizePayload = useCallback((payload, tool, handleId, dxPx, dyPx, adapter) => {
        const spec = markupHandleSpecs(tool).find(s => s.id === handleId);
        if (!spec || !payload?.p1) return payload;
        const next = { ...payload, p1: { ...payload.p1 } };
        if (payload.p2) next.p2 = { ...payload.p2 };

        if (spec.t && next[spec.t]) {
            const x = adapter.timeToX(payload[spec.t].t);
            const nt = x == null ? null : adapter.xToTime(x + dxPx);
            if (nt != null) next[spec.t].t = nt;
        }
        if (spec.p && next[spec.p]) {
            const y = adapter.priceToY(payload[spec.p].price);
            const np = y == null ? null : adapter.yToPrice(y + dyPx);
            if (np != null) next[spec.p].price = np;
        }
        return next;
    }, []);

    const draftMarkup = useMemo(() => {
        if (!draft) return null;
        return {
            id: '__draft__',
            tool: draft.tool,
            payload: { p1: draft.p1, p2: draft.p2 },
        };
    }, [draft]);

    return {
        activeTool, setActiveTool,
        draft, draftMarkup, cancelDraft,
        selectedId, setSelectedId,
        handleClick, handleMove, hitTest, movePayload, resizePayload,
    };
}
