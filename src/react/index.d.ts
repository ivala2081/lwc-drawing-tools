// Type definitions for lwc-drawing-tools/react.

import type { MutableRefObject, PointerEventHandler, RefObject } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type {
    AdapterOptions, CoordinateAdapter, DataPoint, Markup, MarkupPayload, MarkupTool, PlotRect, Theme,
} from '../index';

export type ActiveTool = 'cursor' | MarkupTool;

export const TOOLS: ActiveTool[];
export const TWO_POINT_TOOLS: Set<MarkupTool>;

export interface MarkupDraft {
    tool: MarkupTool;
    p1: DataPoint;
    p2?: DataPoint;
}

export interface MarkupTools {
    activeTool: ActiveTool;
    setActiveTool(tool: ActiveTool): void;
    draft: MarkupDraft | null;
    draftMarkup: Markup | null;
    cancelDraft(): void;
    selectedId: string | null;
    setSelectedId(id: string | null): void;
    handleClick(e: { dataPoint: DataPoint }): { commit: Omit<Markup, 'id'> } | null;
    handleMove(e: { dataPoint: DataPoint }): void;
    hitTest(markups: Markup[], px: number, py: number, adapter: CoordinateAdapter, plot?: PlotRect): string | null;
    movePayload(payload: MarkupPayload, tool: MarkupTool, dxPx: number, dyPx: number, adapter: CoordinateAdapter): MarkupPayload;
    resizePayload(
        payload: MarkupPayload, tool: MarkupTool, handleId: string, dxPx: number, dyPx: number, adapter: CoordinateAdapter,
    ): MarkupPayload;
}

export function useMarkupTools(): MarkupTools;

/** Storage shape the overlay expects. Implement it to save drawings anywhere. */
export interface MarkupStore {
    markups: Markup[];
    loading?: boolean;
    addMarkup(m: Omit<Markup, 'id'>): unknown;
    deleteMarkup(id: string): unknown;
    queueUpdate(id: string, payload: MarkupPayload): unknown;
    clearAll?(): unknown;
}

export interface LocalMarkupStore extends MarkupStore {
    loading: false;
    addMarkup(m: Omit<Markup, 'id'>): Markup;
    deleteMarkup(id: string): void;
    queueUpdate(id: string, payload: MarkupPayload): void;
    clearAll(): void;
}

export function useMarkupStore(opts?: { storageKey?: string; initial?: Markup[] }): LocalMarkupStore;

export interface ChartMarkupOverlayOptions {
    chartRef: RefObject<IChartApi | null>;
    seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
    /** Stable element the canvas overlays; pointer coordinates are relative to it. */
    hostRef: RefObject<HTMLElement | null>;
    canvasRef: RefObject<HTMLCanvasElement | null>;
    tools: MarkupTools;
    persist: MarkupStore;
    theme: Theme;
    decimals?: number;
    /** false → inert: no listeners, no painting. */
    enabled?: boolean;
    adapterOpts?: AdapterOptions;
    onSelectionBox?(box: { x1: number; y1: number; x2: number; y2: number } | null): void;
    getSnapPoint?(px: number, py: number, adapter: CoordinateAdapter): DataPoint | null;
}

export function useChartMarkupOverlay(opts: ChartMarkupOverlayOptions): {
    redrawRef: MutableRefObject<() => void>;
    drawingMode: boolean;
    canvasProps: {
        onPointerDown: PointerEventHandler<HTMLCanvasElement>;
        onPointerMove: PointerEventHandler<HTMLCanvasElement>;
    };
};
