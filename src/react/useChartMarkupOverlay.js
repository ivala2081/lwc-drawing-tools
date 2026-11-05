// ═══════════════════════════════════════════════════════════════════════════════
// useChartMarkupOverlay — canvas overlay + pointer/keyboard wiring for markups.
// ═══════════════════════════════════════════════════════════════════════════════
// Owns the transparent <canvas> that sits over a lightweight-charts pane: sizing,
// DPR, redraw, tool clicks, drag, and the keyboard shortcuts. The tool state
// machine (useMarkupTools) and storage (useMarkupStore, or your own) stay separate; this
// is only the part that has to touch the DOM.
//
// WHY AN OVERLAY AND NOT A SERIES PRIMITIVE
// lightweight-charts 4.2.3 does expose attachPrimitive/ISeriesPrimitive — the
// long-standing comment claiming otherwise was wrong. The real reason is
// lifetime: a primitive belongs to a series, and on the trader chart the series
// are destroyed on every [code, timeframe] remount and again whenever the
// indicator effect calls removeSeries. A sibling canvas outlives both.
//
// DESIGN NOTES
//
// 1. The canvas is cleared BEFORE the null-guard, not after. The overlay does
//    not remount when the symbol changes (only the inner chart does), so an
//    early return would leave the previous symbol's drawings painted over the
//    new symbol's candles.
// 2. Redraw is coalesced into one requestAnimationFrame. lightweight-charts
//    repaints asynchronously, so a synchronous redraw right after series.update()
//    can read a price scale that has not settled yet.
// 3. Pointer Events, not mouse events, so touch support is a flag flip rather
//    than a rewrite. (Creating drawings on touch is still off — see `enabled`.)
// 4. The keyboard listener bails on INPUT / TEXTAREA / contentEditable and is
//    only bound while a tool is active or something is selected. Otherwise
//    Backspace inside a lot-size, SL, TP or symbol-search field on the same
//    screen would silently delete a drawing.
// 5. Tools are one-shot — committing resets to the cursor. Otherwise a trader
//    trying to pan after drawing sprays trendlines across their own chart.
// ═══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef } from 'react';
import { makeAdapter } from '../lwcAdapters.js';
import { drawMarkup, drawMarkups, markupBBoxPx } from '../drawers.js';
import { hitHandle } from '../chartMath.js';

const DRAG_TOLERANCE_PX = 3;

export function useChartMarkupOverlay({
    chartRef,
    seriesRef,
    hostRef,        // stable element the canvas overlays and pointer coords are relative to
    canvasRef,
    tools,          // useMarkupTools()
    persist,        // useMarkupStore() — or any object with the same shape
    theme,
    decimals = 2,
    enabled = true, // false → inert: no listeners, no painting
    // Optional: { bars, intervalMs } handed straight to makeAdapter. With it the
    // time axis becomes continuous and unbounded, which is what lets a drawing
    // live past the last candle. Without it the adapter snaps to existing bars.
    adapterOpts,
    // Optional: called after every paint with the selected markup's screen-px
    // bbox ({x1,y1,x2,y2} or null). Lets the caller anchor UI (a selection
    // toolbar) to the drawing — and because every pan/zoom/data change already
    // repaints, the anchor tracks the drawing for free.
    onSelectionBox,
    // Optional: (px, py, adapter) → {t, price}|null. When provided, drawing
    // clicks and draft moves snap to what it returns — unless Ctrl/Cmd is held,
    // the universal "precise mode" escape hatch.
    getSnapPoint,
}) {
    // Handlers bind once and read through refs, so a re-render never detaches and
    // re-attaches listeners mid-drag.
    const toolsRef = useRef(tools);
    const persistRef = useRef(persist);
    const themeRef = useRef(theme);
    const decimalsRef = useRef(decimals);
    const enabledRef = useRef(enabled);
    const onSelectionBoxRef = useRef(onSelectionBox);
    const getSnapPointRef = useRef(getSnapPoint);
    const adapterOptsRef = useRef(adapterOpts);
    useEffect(() => { toolsRef.current = tools; }, [tools]);
    useEffect(() => { persistRef.current = persist; }, [persist]);
    useEffect(() => { themeRef.current = theme; }, [theme]);
    useEffect(() => { decimalsRef.current = decimals; }, [decimals]);
    useEffect(() => { enabledRef.current = enabled; }, [enabled]);
    useEffect(() => { onSelectionBoxRef.current = onSelectionBox; }, [onSelectionBox]);
    useEffect(() => { getSnapPointRef.current = getSnapPoint; }, [getSnapPoint]);
    useEffect(() => { adapterOptsRef.current = adapterOpts; }, [adapterOpts]);

    const rafRef = useRef(0);
    // `handleId` null → the whole shape translates; set → only that handle moves.
    const dragRef = useRef({ active: false, id: null, handleId: null, start: null, original: null, moved: false });

    /** The adapter every handler and the paint pass must agree on. */
    const buildAdapter = useCallback((chart, series) =>
        makeAdapter(chart, series, adapterOptsRef.current), []);

    /**
     * Pixel bounds of the chart pane. Extracted because the pointer handlers now
     * need it too — a trend line's ray is clipped to `plot.right`, so the
     * hit-test cannot answer without it.
     */
    const getPlot = useCallback((chart, host) => {
        try {
            return {
                left: 0,
                top: 0,
                right: host.clientWidth - chart.priceScale('right').width(),
                bottom: host.clientHeight - chart.timeScale().height(),
            };
        } catch {
            return null;   // chart disposed mid-gesture
        }
    }, []);

    // ── Paint ──────────────────────────────────────────────────────────────
    const paint = useCallback(() => {
        const cv = canvasRef.current;
        const host = hostRef.current;
        if (!cv || !host) return;

        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w === 0 || h === 0) return;

        const dpr = window.devicePixelRatio || 1;
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
            cv.width = Math.round(w * dpr);
            cv.height = Math.round(h * dpr);
            cv.style.width = `${w}px`;
            cv.style.height = `${h}px`;
        }
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // ► Deviation 1: clear FIRST. Everything below may bail out, and a bail
        //   after a symbol change must leave an empty overlay, not a stale one.
        ctx.clearRect(0, 0, w, h);

        const chart = chartRef.current;
        const series = seriesRef.current;
        if (!chart || !series || !enabledRef.current) {
            onSelectionBoxRef.current?.(null);
            return;
        }

        const plot = getPlot(chart, host);
        if (!plot) {
            onSelectionBoxRef.current?.(null);
            return; // chart disposed between the guard and here
        }

        const adapter = buildAdapter(chart, series);
        const t = toolsRef.current;
        drawMarkups(ctx, persistRef.current?.markups || [], adapter, plot,
            themeRef.current, t.selectedId, decimalsRef.current);
        if (t.draftMarkup) {
            drawMarkup(ctx, t.draftMarkup, adapter, plot, themeRef.current, true, decimalsRef.current);
        }

        if (onSelectionBoxRef.current) {
            const sel = t.selectedId
                ? (persistRef.current?.markups || []).find(m => m.id === t.selectedId)
                : null;
            onSelectionBoxRef.current(sel ? markupBBoxPx(sel, adapter, plot) : null);
        }
    }, [canvasRef, hostRef, chartRef, seriesRef, buildAdapter, getPlot]);

    // ► Deviation 2: coalesce. Callers fire this from range changes, data
    //   updates, indicator rebuilds and theme changes, several of which land in
    //   the same frame.
    const redraw = useCallback(() => {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            paint();
        });
    }, [paint]);

    // Exposed as a ref so callers can fire it from inside effects without ever
    // putting it in a dependency array — adding it to the chart's
    // [code, timeframe] effect would remount the chart on every identity change
    // and destroy pan-left history paging and scroll position.
    const redrawRef = useRef(redraw);
    useEffect(() => { redrawRef.current = redraw; }, [redraw]);

    // Clearing the id is not tidiness, it is the whole fix. `redraw` early-returns
    // while `rafRef.current` is truthy, so cancelling the frame without resetting
    // the ref leaves it permanently "already scheduled" and paint never runs
    // again. StrictMode reproduces it every time in development: React mounts,
    // runs effects, cleans up, and re-runs them on the SAME instance, so the ref
    // survives the cancel and the overlay stays blank forever.
    useEffect(() => () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
    }, []);

    // Repaint whenever what is drawn changes.
    useEffect(() => { redraw(); },
        [redraw, persist.markups, tools.selectedId, tools.draftMarkup, theme, decimals, enabled]);

    // Follow container resizes.
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const ro = new ResizeObserver(() => redraw());
        ro.observe(host);
        return () => ro.disconnect();
    }, [hostRef, redraw]);

    // ── Coordinate helpers ─────────────────────────────────────────────────
    const localXY = useCallback((e) => {
        const r = hostRef.current.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }, [hostRef]);

    const toDataPoint = useCallback((x, y, ev) => {
        const chart = chartRef.current, series = seriesRef.current;
        if (!chart || !series) return { t: null, price: null };
        const adapter = buildAdapter(chart, series);
        if (getSnapPointRef.current && !(ev?.ctrlKey || ev?.metaKey)) {
            const snapped = getSnapPointRef.current(x, y, adapter);
            if (snapped) return snapped;
        }
        return { t: adapter.xToTime(x), price: adapter.yToPrice(y) };
    }, [chartRef, seriesRef, buildAdapter]);

    // ── Draw mode: the canvas captures pointers ────────────────────────────
    const onCanvasPointerDown = useCallback((e) => {
        const t = toolsRef.current;
        if (!enabledRef.current || t.activeTool === 'cursor') return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const { x, y } = localXY(e);
        const dp = toDataPoint(x, y, e);
        if (dp.t == null || dp.price == null) return;
        const res = t.handleClick({ dataPoint: dp });
        if (res?.commit) {
            persistRef.current.addMarkup(res.commit);
            // ► Deviation 5: one-shot.
            t.setActiveTool('cursor');
        }
    }, [localXY, toDataPoint]);

    const onCanvasPointerMove = useCallback((e) => {
        const t = toolsRef.current;
        if (!enabledRef.current || t.activeTool === 'cursor' || !t.draft) return;
        const { x, y } = localXY(e);
        const dp = toDataPoint(x, y, e);
        if (dp.t == null || dp.price == null) return;
        t.handleMove({ dataPoint: dp });
    }, [localXY, toDataPoint]);

    // ── Cursor mode: select and drag (canvas is click-through, host listens) ──
    useEffect(() => {
        const host = hostRef.current;
        if (!host || !enabled) return;

        const onDown = (e) => {
            // UI chrome overlaid on the chart (the selection toolbar) opts out
            // of hit-testing with data-markup-ui. React's synthetic
            // stopPropagation can NOT protect it here: this is a native
            // listener on the host, which fires before React's delegated
            // handlers at the root — so a toolbar click would hit-test as a
            // miss and deselect, unmounting the button mid-gesture.
            if (e.target?.closest?.('[data-markup-ui]')) return;
            const t = toolsRef.current;
            if (t.activeTool !== 'cursor') return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            const chart = chartRef.current, series = seriesRef.current;
            if (!chart || !series) return;
            const r = host.getBoundingClientRect();
            const px = e.clientX - r.left, py = e.clientY - r.top;
            const adapter = buildAdapter(chart, series);
            const plot = getPlot(chart, host);
            if (!plot) return;
            const markups = persistRef.current?.markups || [];

            const begin = (id, handleId, payload) => {
                dragRef.current = {
                    active: true, id, handleId, start: { x: px, y: py },
                    original: payload, moved: false,
                };
                // Freeze pan/zoom for the duration, or dragging a line drags the
                // whole chart underneath it.
                chart.applyOptions({ handleScroll: false, handleScale: false });
            };

            // A handle on the ALREADY-SELECTED drawing wins over everything,
            // including the drawing's own body. Otherwise a rectangle — whose
            // whole filled area is grabbable — would swallow every corner and
            // resizing would be unreachable.
            if (t.selectedId) {
                const sel = markups.find(m => m.id === t.selectedId);
                const h = sel && hitHandle(sel, px, py, adapter, plot);
                if (h) { begin(sel.id, h.id, sel.payload); return; }
            }

            const hitId = t.hitTest(markups, px, py, adapter, plot);
            if (!hitId) {
                if (t.selectedId) t.setSelectedId(null);
                return;                       // let the chart pan
            }
            t.setSelectedId(hitId);
            begin(hitId, null, markups.find(m => m.id === hitId)?.payload);
        };

        const onMove = (e) => {
            const d = dragRef.current;
            const t = toolsRef.current;
            const chart = chartRef.current, series = seriesRef.current;
            if (!chart || !series) return;

            if (!d.active) {
                // Hover feedback. Without a cursor change the handles look like
                // decoration, which is exactly what they were until now.
                if (t.activeTool !== 'cursor' || !t.selectedId) return;
                const sel = (persistRef.current?.markups || []).find(m => m.id === t.selectedId);
                if (!sel) return;
                const plot = getPlot(chart, host);
                if (!plot) return;
                const rr = host.getBoundingClientRect();
                const h = hitHandle(sel, e.clientX - rr.left, e.clientY - rr.top,
                    buildAdapter(chart, series), plot);
                host.style.cursor = h ? h.cursor : '';
                return;
            }

            if (!d.original) return;
            const r = host.getBoundingClientRect();
            const dx = (e.clientX - r.left) - d.start.x;
            const dy = (e.clientY - r.top) - d.start.y;
            // A click that never really moved must not queue a write.
            if (!d.moved && Math.abs(dx) < DRAG_TOLERANCE_PX && Math.abs(dy) < DRAG_TOLERANCE_PX) return;
            d.moved = true;
            const target = (persistRef.current?.markups || []).find(m => m.id === d.id);
            if (!target) return;
            const adapter = buildAdapter(chart, series);
            const next = d.handleId
                ? t.resizePayload(d.original, target.tool, d.handleId, dx, dy, adapter)
                : t.movePayload(d.original, target.tool, dx, dy, adapter);
            persistRef.current.queueUpdate(d.id, next);
        };

        const onUp = () => {
            if (!dragRef.current.active) return;
            dragRef.current = { active: false, id: null, handleId: null, start: null, original: null, moved: false };
            chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
        };

        const onLeave = () => { host.style.cursor = ''; };

        // Right-click = select (and thereby open the selection toolbar). Only
        // hijacks the native menu when it actually lands on a drawing.
        const onContextMenu = (e) => {
            if (e.target?.closest?.('[data-markup-ui]')) return;
            const t = toolsRef.current;
            if (t.activeTool !== 'cursor') return;
            const chart = chartRef.current, series = seriesRef.current;
            if (!chart || !series) return;
            const r = host.getBoundingClientRect();
            const hitId = t.hitTest(persistRef.current?.markups || [],
                e.clientX - r.left, e.clientY - r.top,
                buildAdapter(chart, series), getPlot(chart, host));
            if (hitId) {
                e.preventDefault();
                t.setSelectedId(hitId);
            }
        };

        host.addEventListener('pointerdown', onDown);
        host.addEventListener('contextmenu', onContextMenu);
        host.addEventListener('pointerleave', onLeave);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            host.removeEventListener('pointerdown', onDown);
            host.removeEventListener('contextmenu', onContextMenu);
            host.removeEventListener('pointerleave', onLeave);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            // A drag interrupted by unmount must not leave the chart frozen —
            // or the host wearing a resize cursor it can no longer clear.
            onUp();
            onLeave();
        };
    }, [hostRef, chartRef, seriesRef, enabled, buildAdapter, getPlot]);

    // ── Keyboard ───────────────────────────────────────────────────────────
    // ► Deviation 4. Bound only while there is something to act on, and never
    //   acts on a keystroke aimed at a form field. On this screen those fields
    //   are lot size, stop loss, take profit and symbol search.
    const armed = enabled && (Boolean(tools.selectedId) || tools.activeTool !== 'cursor');
    useEffect(() => {
        if (!armed) return;
        const onKey = (e) => {
            const el = e.target;
            const tag = el?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
            const t = toolsRef.current;
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (t.selectedId) {
                    e.preventDefault();
                    persistRef.current.deleteMarkup(t.selectedId);
                    t.setSelectedId(null);
                }
            } else if (e.key === 'Escape') {
                t.cancelDraft();
                t.setSelectedId(null);
                t.setActiveTool('cursor');
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [armed]);

    const drawingMode = enabled && tools.activeTool !== 'cursor';

    return {
        redrawRef,
        drawingMode,
        canvasProps: {
            onPointerDown: onCanvasPointerDown,
            onPointerMove: onCanvasPointerMove,
        },
    };
}
