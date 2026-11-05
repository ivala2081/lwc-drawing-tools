// Type definitions for lwc-drawing-tools (core, framework-free).

import type { IChartApi, ISeriesApi, SeriesType, UTCTimestamp } from 'lightweight-charts';

// ── Data model ──────────────────────────────────────────────────────────────

export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type MarkupTool = 'trend' | 'horizontal' | 'vertical' | 'rect' | 'fib';

/** A point in data space: time in ms + price. */
export interface DataPoint {
    t: number;
    price: number;
}

export interface MarkupPayload {
    p1: DataPoint;
    p2?: DataPoint;
    color?: string;
    width?: number;
    /** trend: extend to the right edge of the pane as a ray. */
    extendRight?: boolean;
    /** fib: retracement ratios, stored per drawing. */
    levels?: number[];
}

export interface Markup {
    id: string;
    tool: MarkupTool;
    payload: MarkupPayload;
}

/** A candle with its bucket start time in ms. */
export interface Candle {
    bucket: number;
    open: number;
    high: number;
    low: number;
    close: number;
    tick_count?: number;
}

/** Pixel bounds of the chart pane (excluding price and time scales). */
export interface PlotRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Maps between data space and pane pixels. Every method returns null when unresolvable. */
export interface CoordinateAdapter {
    timeToX(tMs: number): number | null;
    priceToY(price: number): number | null;
    xToTime(px: number): number | null;
    yToPrice(py: number): number | null;
}

export interface Theme {
    bull: string;
    bear: string;
    live: string;
    markup: string;
    markupSel: string;
    bg: string;
    rectFill: string;
}

export interface HandleSpec {
    id: string;
    /** Which point supplies the time ('p1' | 'p2'), or null when that axis is pinned. */
    t: 'p1' | 'p2' | null;
    /** Which point supplies the price ('p1' | 'p2'), or null when that axis is pinned. */
    p: 'p1' | 'p2' | null;
}

export interface HandlePoint {
    id: string;
    x: number;
    y: number;
    cursor: string;
}

// ── chartMath ───────────────────────────────────────────────────────────────

export const INTERVAL_MS: Record<Interval, number>;
export const HANDLE_HIT_PX: number;
export const FIB_DEFAULT_LEVELS: number[];

export function alignToBucket(tsMs: number, interval: Interval | string): number;
export function clamp(v: number, min: number, max: number): number;
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number;
export function pointInRect(px: number, py: number, x1: number, y1: number, x2: number, y2: number): boolean;
export function extendSegmentToX(x1: number, y1: number, x2: number, y2: number, targetX: number): [number, number] | null;
export function rayEndpoints(
    x1: number, y1: number, x2: number, y2: number, extendRight: boolean | undefined, rightX: number,
): [number, number, number, number];
export function timeToLogical(bars: number[], intervalMs: number, tMs: number): number | null;
export function logicalToTime(bars: number[], intervalMs: number, logical: number): number | null;
export function markupHandleSpecs(tool: MarkupTool | string): HandleSpec[];
export function markupHandlePoints(markup: Markup, adapter: CoordinateAdapter, plot: PlotRect): HandlePoint[];
export function hitHandle(
    markup: Markup, px: number, py: number, adapter: CoordinateAdapter, plot: PlotRect, tolPx?: number,
): (HandlePoint & { d: number }) | null;
export function fibLevelPrice(p1: DataPoint, p2: DataPoint, r: number): number;
export function fibLevelLabel(r: number): string;
export function snapToOHLC(
    candles: Candle[], px: number, py: number, adapter: CoordinateAdapter, tolPx?: number,
): DataPoint | null;

// ── drawers ─────────────────────────────────────────────────────────────────

export const LIGHT_THEME: Theme;
export const DARK_THEME: Theme;

export function drawMarkup(
    ctx: CanvasRenderingContext2D, markup: Markup, adapter: CoordinateAdapter, plot: PlotRect,
    theme: Theme, selected?: boolean, decimals?: number,
): void;
export function drawMarkups(
    ctx: CanvasRenderingContext2D, markups: Markup[], adapter: CoordinateAdapter, plot: PlotRect,
    theme: Theme, selectedId?: string | null, decimals?: number,
): void;
export function markupBBoxPx(
    markup: Markup, adapter: CoordinateAdapter, plot: PlotRect,
): { x1: number; y1: number; x2: number; y2: number } | null;

// ── lwcAdapters ─────────────────────────────────────────────────────────────

export interface LwcBar {
    time: UTCTimestamp;
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface AdapterOptions {
    /** Ascending bucket times in ms. Enables the continuous, unbounded time axis. */
    bars: number[];
    intervalMs: number;
}

export function msToSec(ms: number): UTCTimestamp;
export function toLwcBar(c: Candle): LwcBar;
export function toLwcData(candles: Candle[]): LwcBar[];
export function makeAdapter(
    chart: IChartApi, series: ISeriesApi<SeriesType>, opts?: AdapterOptions,
): CoordinateAdapter;

// ── validation ──────────────────────────────────────────────────────────────

export type AssetClass = 'forex' | 'metals' | 'energy' | 'crypto' | 'stocks' | 'default';

export const ASSET_PCT: Record<AssetClass, number>;
export function assetClassFor(symbol: string | null | undefined): AssetClass;
export function maxDeltaPct(symbol: string): number;
export function maxLiveJumpPct(symbol: string): number;
export function robustPriceBand(candles: Candle[]): { min: number; max: number } | null;
/** Rows may carry prices as strings and `bucket` as a date string; output is normalized. */
export function sanitizeCandles(
    rows: Array<Record<string, unknown>>, symbol: string,
): Candle[];
