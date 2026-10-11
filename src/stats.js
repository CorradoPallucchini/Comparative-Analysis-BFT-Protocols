'use strict';

/** Percentile with linear interpolation between closest ranks (p in [0, 100]). */
function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    if (sorted.length === 1) return sorted[0];
    const rank = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Descriptive statistics of a numeric sample (null fields when empty). */
function summarize(values) {
    const n = values.length;
    if (n === 0) {
        return { count: 0, min: null, max: null, mean: null, stddev: null, p50: null, p90: null, p95: null, p99: null };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    // Sample standard deviation (n - 1), 0 for a single observation.
    const variance = n > 1 ? sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1) : 0;
    return {
        count: n,
        min: sorted[0],
        max: sorted[n - 1],
        mean,
        stddev: Math.sqrt(variance),
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
    };
}

module.exports = { percentile, summarize };
