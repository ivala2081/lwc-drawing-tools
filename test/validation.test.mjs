import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetClassFor, maxDeltaPct, sanitizeCandles, robustPriceBand } from '../src/validation.js';

const H = 60 * 60 * 1000;
const flat = (n, price = 100) =>
    Array.from({ length: n }, (_, i) => ({
        bucket: i * H, open: price, high: price + 0.2, low: price - 0.2, close: price,
    }));

test('assetClassFor reads the class from the symbol alone', () => {
    assert.equal(assetClassFor('XAUUSD'), 'metals');
    assert.equal(assetClassFor('XAG/USD'), 'metals');
    assert.equal(assetClassFor('USOIL'), 'energy');
    assert.equal(assetClassFor('BTCUSDT'), 'crypto');
    assert.equal(assetClassFor('EURUSD'), 'forex');
    assert.equal(assetClassFor('EUR/USD'), 'forex');
    assert.equal(assetClassFor('AAPL'), 'stocks');
    assert.equal(assetClassFor(''), 'default');
    assert.equal(maxDeltaPct('EURUSD'), 5);
});

test('sanitizeCandles clamps an isolated spike back into the local band', () => {
    const rows = flat(30);
    rows[15] = { ...rows[15], high: 140, close: 130 };
    const out = sanitizeCandles(rows, 'AAPL');
    assert.equal(out.length, 30, 'bars are clamped, never dropped');
    assert.ok(out[15].high < 101, `spike high should be clamped, got ${out[15].high}`);
    assert.ok(out[15].close < 101, `spike close should be clamped, got ${out[15].close}`);
});

test('sanitizeCandles keeps a genuine trend', () => {
    const rows = Array.from({ length: 40 }, (_, i) => {
        const p = 100 + i;
        return { bucket: i * H, open: p - 0.5, high: p + 0.5, low: p - 1, close: p };
    });
    const out = sanitizeCandles(rows, 'AAPL');
    assert.ok(out[39].close > 135, `trend end should survive, got ${out[39].close}`);
});

test('sanitizeCandles coerces string prices and keeps OHLC invariants', () => {
    const out = sanitizeCandles([{ bucket: '2024-01-01T00:00:00Z', open: '10', high: '9', low: '11', close: '10' }], 'AAPL');
    assert.equal(out.length, 1);
    assert.equal(typeof out[0].bucket, 'number');
    assert.ok(out[0].high >= Math.max(out[0].open, out[0].close));
    assert.ok(out[0].low <= Math.min(out[0].open, out[0].close));
});

test('sanitizeCandles drops rows with no usable close', () => {
    assert.equal(sanitizeCandles([{ bucket: 0, close: 'x' }, { bucket: 1, close: 0 }], 'AAPL').length, 0);
});

test('robustPriceBand ignores a single wild bar', () => {
    const rows = flat(50);
    rows[25] = { ...rows[25], high: 1000 };
    const band = robustPriceBand(rows);
    assert.ok(band.max < 200, `band should not stretch to the spike, got ${band.max}`);
    assert.ok(band.min < 100 && band.max > 100);
    assert.equal(robustPriceBand([]), null);
});
