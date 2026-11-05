// ═══════════════════════════════════════════════════════════════════════════════
// useMarkupStore — Minimal storage for markups, with optional localStorage.
// ═══════════════════════════════════════════════════════════════════════════════
// useChartMarkupOverlay only needs an object of this shape:
//   { markups, loading, addMarkup({tool, payload}), deleteMarkup(id),
//     queueUpdate(id, payload), clearAll() }
// This hook is the zero-dependency default. To save drawings to your own
// backend, write a hook that returns the same shape — the overlay never
// touches storage directly.
// ═══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';

function readStored(key) {
    if (!key) return [];
    try {
        const raw = globalThis.localStorage?.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object}  [opts]
 * @param {string}  [opts.storageKey]  localStorage key. Use one key per
 *                                     symbol + timeframe, e.g. `markups:EURUSD:1h`.
 *                                     Omit for in-memory only.
 * @param {Array}   [opts.initial]     starting markups when nothing is stored.
 */
export function useMarkupStore({ storageKey, initial = [] } = {}) {
    const [markups, setMarkups] = useState(() => {
        const stored = readStored(storageKey);
        return stored.length ? stored : initial;
    });

    // Switching symbol/timeframe swaps the key — reload that key's drawings.
    useEffect(() => {
        const stored = readStored(storageKey);
        setMarkups(stored.length ? stored : initial);
        // `initial` is a starting value, not a live input.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey]);

    useEffect(() => {
        if (!storageKey) return;
        try {
            globalThis.localStorage?.setItem(storageKey, JSON.stringify(markups));
        } catch {
            // Private mode or quota exceeded: keep working in memory.
        }
    }, [storageKey, markups]);

    const addMarkup = useCallback(({ tool, payload }) => {
        const markup = { id: newId(), tool, payload };
        setMarkups(prev => [...prev, markup]);
        return markup;
    }, []);

    const deleteMarkup = useCallback((id) => {
        setMarkups(prev => prev.filter(m => m.id !== id));
    }, []);

    // Called on every pointer move while dragging. Local state only, so it is
    // cheap; debounce inside your own store if it writes to a server.
    const queueUpdate = useCallback((id, payload) => {
        setMarkups(prev => prev.map(m => (m.id === id ? { ...m, payload } : m)));
    }, []);

    const clearAll = useCallback(() => setMarkups([]), []);

    return { markups, loading: false, addMarkup, deleteMarkup, queueUpdate, clearAll };
}
