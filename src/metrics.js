'use strict';

const { summarize } = require('./stats');

/**
 * Throughput over a contiguous run of blocks, measured on-chain:
 * benchmark transactions included in `blocks` divided by the time between
 * the parent of the first block and the last block (block timestamps).
 */
function onChainTps(blocks, parentTimestamp) {
    if (blocks.length === 0 || parentTimestamp === undefined) return null;
    const span = blocks[blocks.length - 1].timestamp - parentTimestamp;
    if (span <= 0) return null;
    const txs = blocks.reduce((acc, b) => acc + b.benchmarkTxCount, 0);
    return txs / span;
}

/**
 * Computes the run summary.
 *
 * @param {object} input
 * @param {Array} input.txs     [{ status, submittedAt, includedAt }] (ms timestamps)
 * @param {Array} input.blocks  [{ number, timestamp (s), txCount, benchmarkTxCount, gasUsed }]
 *                              sorted by number, starting at the head observed before load started
 * @param {number} input.trimRatio fraction of the load window's blocks dropped at each end
 *                                 for the steady-state figure
 */
function computeMetrics({ txs, blocks, trimRatio }) {
    const confirmed = txs.filter(t => t.status === 'confirmed');
    const counts = {
        planned: txs.length,
        submitted: txs.filter(t => t.submittedAt !== undefined).length,
        confirmed: confirmed.length,
        failed: txs.filter(t => t.status === 'failed').length,
        unconfirmed: txs.filter(t => t.status !== 'confirmed' && t.status !== 'failed').length,
    };

    // reduce instead of Math.min(...xs): spreading large arrays overflows the stack.
    const firstSubmit = txs.reduce((m, t) => (t.submittedAt !== undefined && t.submittedAt < m ? t.submittedAt : m), Infinity);
    const lastInclusion = confirmed.reduce((m, t) => Math.max(m, t.includedAt), -Infinity);
    const e2eSeconds = confirmed.length > 0 ? (lastInclusion - firstSubmit) / 1000 : null;

    // Load window: from the first to the last block carrying benchmark txs.
    const firstIdx = blocks.findIndex(b => b.benchmarkTxCount > 0);
    let lastIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].benchmarkTxCount > 0) { lastIdx = i; break; }
    }
    const window = firstIdx >= 0 ? blocks.slice(firstIdx, lastIdx + 1) : [];
    const parentOf = idx => (idx > 0 ? blocks[idx - 1].timestamp : undefined);

    const trim = Math.floor(window.length * trimRatio);
    const steady = window.length - 2 * trim >= 3 ? window.slice(trim, window.length - trim) : [];
    const steadyStart = firstIdx + trim;

    const intervals = [];
    for (let i = 1; i < window.length; i++) intervals.push(window[i].timestamp - window[i - 1].timestamp);

    return {
        counts,
        throughput: {
            // Client view: confirmed txs / (last inclusion seen - first submission).
            endToEndTps: e2eSeconds ? confirmed.length / e2eSeconds : null,
            // Chain view: benchmark txs in the load window / block-timestamp span.
            onChainTps: firstIdx >= 0 ? onChainTps(window, parentOf(firstIdx)) : null,
            // Chain view without ramp-up / drain blocks.
            steadyStateTps: steady.length > 0 ? onChainTps(steady, parentOf(steadyStart)) : null,
            durationSeconds: e2eSeconds,
        },
        // Submission -> first observation of the including block. With BFT
        // consensus (immediate finality) inclusion is also finality.
        latencyMs: summarize(confirmed.map(t => t.includedAt - t.submittedAt)),
        blocks: {
            first: window.length ? window[0].number : null,
            last: window.length ? window[window.length - 1].number : null,
            count: window.length,
            steadyStateCount: steady.length,
            txPerBlock: summarize(window.map(b => b.benchmarkTxCount)),
            intervalSeconds: summarize(intervals),
            emptyBlocks: window.filter(b => b.txCount === 0).length,
        },
    };
}

module.exports = { computeMetrics, onChainTps };
