'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeMetrics } = require('../src/metrics');

function block(number, timestamp, benchmarkTxCount) {
    return { number, timestamp, txCount: benchmarkTxCount, benchmarkTxCount, gasUsed: benchmarkTxCount * 21000 };
}

test('computes counts, on-chain and end-to-end throughput and latency', () => {
    const blocks = [
        block(10, 100, 0), // head before load
        block(11, 101, 10),
        block(12, 102, 20),
        block(13, 103, 20),
        block(14, 104, 20),
        block(15, 105, 10),
        block(16, 106, 0), // trailing empty block
    ];
    const txs = [];
    for (let i = 0; i < 80; i++) txs.push({ status: 'confirmed', submittedAt: 1000, includedAt: 1000 + 500 + i });
    txs.push({ status: 'failed', submittedAt: 1000 });
    txs.push({ status: 'pending' });

    const m = computeMetrics({ txs, blocks, trimRatio: 0.2 });

    assert.deepStrictEqual(m.counts, { planned: 82, submitted: 81, confirmed: 80, failed: 1, unconfirmed: 1 });
    // 80 txs over blocks 11..15, span = 105 - 100 = 5 s
    assert.strictEqual(m.throughput.onChainTps, 16);
    // trim 1 block each side -> blocks 12..14: 60 txs over 104 - 101 = 3 s
    assert.strictEqual(m.throughput.steadyStateTps, 20);
    // last inclusion at 1579 ms, first submission at 1000 ms
    assert.ok(Math.abs(m.throughput.endToEndTps - 80 / 0.579) < 1e-9);
    assert.strictEqual(m.latencyMs.min, 500);
    assert.strictEqual(m.latencyMs.max, 579);
    assert.strictEqual(m.blocks.count, 5);
    assert.strictEqual(m.blocks.first, 11);
    assert.strictEqual(m.blocks.last, 15);
    assert.strictEqual(m.blocks.intervalSeconds.mean, 1);
});

test('steady state is omitted when too few blocks remain after trimming', () => {
    const blocks = [block(1, 10, 0), block(2, 11, 5), block(3, 12, 5)];
    const txs = Array.from({ length: 10 }, () => ({ status: 'confirmed', submittedAt: 0, includedAt: 2000 }));
    const m = computeMetrics({ txs, blocks, trimRatio: 0.1 });
    assert.strictEqual(m.throughput.steadyStateTps, null);
    assert.strictEqual(m.throughput.onChainTps, 5);
});

test('handles a run where nothing was confirmed', () => {
    const m = computeMetrics({ txs: [{ status: 'failed', submittedAt: 5 }], blocks: [block(1, 1, 0)], trimRatio: 0.1 });
    assert.strictEqual(m.throughput.endToEndTps, null);
    assert.strictEqual(m.throughput.onChainTps, null);
    assert.strictEqual(m.latencyMs.count, 0);
});

test('scales to large runs without stack overflow', () => {
    const txs = Array.from({ length: 300000 }, (_, i) => ({ status: 'confirmed', submittedAt: i, includedAt: i + 1000 }));
    const blocks = [block(1, 0, 0), block(2, 300, 300000)];
    const m = computeMetrics({ txs, blocks, trimRatio: 0.1 });
    assert.strictEqual(m.counts.confirmed, 300000);
    assert.strictEqual(m.latencyMs.mean, 1000);
});
