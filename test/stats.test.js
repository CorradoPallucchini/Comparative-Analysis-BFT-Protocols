'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { percentile, summarize } = require('../src/stats');

test('percentile interpolates between ranks', () => {
    const s = [1, 2, 3, 4];
    assert.strictEqual(percentile(s, 0), 1);
    assert.strictEqual(percentile(s, 100), 4);
    assert.strictEqual(percentile(s, 50), 2.5);
    assert.strictEqual(percentile([7], 99), 7);
    assert.strictEqual(percentile([], 50), null);
});

test('summarize computes sample statistics', () => {
    const s = summarize([4, 2, 6, 8]);
    assert.strictEqual(s.count, 4);
    assert.strictEqual(s.min, 2);
    assert.strictEqual(s.max, 8);
    assert.strictEqual(s.mean, 5);
    assert.ok(Math.abs(s.stddev - Math.sqrt(20 / 3)) < 1e-12);
    assert.strictEqual(s.p50, 5);
});

test('summarize handles empty and single samples', () => {
    assert.strictEqual(summarize([]).mean, null);
    assert.strictEqual(summarize([3]).stddev, 0);
});
