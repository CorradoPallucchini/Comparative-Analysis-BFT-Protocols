'use strict';

const fs = require('fs');
const path = require('path');

const SUMMARY_COLUMNS = [
    ['runId', r => r.runId],
    ['startedAt', r => r.meta.startedAt],
    ['label', r => r.params.label],
    ['consensus', r => r.network.consensus],
    ['nodes', r => r.network.nodes],
    ['blockPeriodSeconds', r => r.network.blockPeriodSeconds],
    ['besuVersion', r => r.meta.clientVersion],
    ['senders', r => r.params.senders],
    ['txCount', r => r.summary.counts.planned],
    ['batchSize', r => r.params.batchSize],
    ['window', r => r.params.window],
    ['rate', r => r.params.rate],
    ['target', r => r.params.target],
    ['confirmed', r => r.summary.counts.confirmed],
    ['failed', r => r.summary.counts.failed],
    ['unconfirmed', r => r.summary.counts.unconfirmed],
    ['endToEndTps', r => r.summary.throughput.endToEndTps],
    ['onChainTps', r => r.summary.throughput.onChainTps],
    ['steadyStateTps', r => r.summary.throughput.steadyStateTps],
    ['durationSeconds', r => r.summary.throughput.durationSeconds],
    ['latencyMeanMs', r => r.summary.latencyMs.mean],
    ['latencyP50Ms', r => r.summary.latencyMs.p50],
    ['latencyP95Ms', r => r.summary.latencyMs.p95],
    ['latencyP99Ms', r => r.summary.latencyMs.p99],
    ['latencyMaxMs', r => r.summary.latencyMs.max],
    ['blocks', r => r.summary.blocks.count],
    ['txPerBlockMean', r => r.summary.blocks.txPerBlock.mean],
    ['blockIntervalMeanSeconds', r => r.summary.blocks.intervalSeconds.mean],
    ['gitCommit', r => r.meta.git.commit],
];

function csvValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function summaryRow(result) {
    return SUMMARY_COLUMNS.map(([, get]) => csvValue(get(result))).join(',');
}

/**
 * Writes `<runId>.json` (full result), `<runId>_txs.csv` (per-transaction
 * timings) and appends a row to `summary.csv` in `outputDir`.
 */
function writeResults(outputDir, result, txs) {
    fs.mkdirSync(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, `${result.runId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');

    const txPath = path.join(outputDir, `${result.runId}_txs.csv`);
    const txLines = ['hash,sender,nonce,status,attempts,submittedAt,includedAt,latencyMs,blockNumber'];
    for (const t of txs) {
        txLines.push([
            t.hash, t.sender, t.nonce, t.status, t.attempts, t.submittedAt, t.includedAt,
            t.includedAt !== undefined ? t.includedAt - t.submittedAt : undefined, t.blockNumber,
        ].map(csvValue).join(','));
    }
    fs.writeFileSync(txPath, txLines.join('\n') + '\n');

    const summaryPath = path.join(outputDir, 'summary.csv');
    const header = SUMMARY_COLUMNS.map(([name]) => name).join(',');
    if (!fs.existsSync(summaryPath)) {
        fs.writeFileSync(summaryPath, header + '\n');
    } else {
        const existingHeader = fs.readFileSync(summaryPath, 'utf8').split('\n', 1)[0];
        if (existingHeader !== header) {
            throw new Error(`${summaryPath} has a different column layout; move it away to start a new one`);
        }
    }
    fs.appendFileSync(summaryPath, summaryRow(result) + '\n');

    return { jsonPath, txPath, summaryPath };
}

function fmt(v, digits = 2) {
    return v === null || v === undefined ? 'n/a' : v.toFixed(digits);
}

function printSummary(result) {
    const { counts, throughput, latencyMs, blocks } = result.summary;
    const lines = [
        '',
        '=============================================================',
        '                     BENCHMARK RESULTS',
        '=============================================================',
        `Protocol / validators   : ${result.network.consensus} / ${result.network.nodes} (block period ${result.network.blockPeriodSeconds ?? '?'}s)`,
        `Client                  : ${result.meta.clientVersion}`,
        `Load                    : ${result.params.senders} senders, batch ${result.params.batchSize}, window ${result.params.window}, rate ${result.params.rate || 'unlimited'}, target ${result.params.target}`,
        '-------------------------------------------------------------',
        `Transactions            : ${counts.confirmed}/${counts.planned} confirmed, ${counts.failed} failed, ${counts.unconfirmed} unconfirmed`,
        `Blocks (load window)    : ${blocks.count} (#${blocks.first ?? '-'} -> #${blocks.last ?? '-'}), ${fmt(blocks.txPerBlock.mean, 1)} tx/block avg, max ${blocks.txPerBlock.max ?? 'n/a'}`,
        `Block interval          : mean ${fmt(blocks.intervalSeconds.mean)} s, max ${blocks.intervalSeconds.max ?? 'n/a'} s`,
        `Duration (end-to-end)   : ${fmt(throughput.durationSeconds)} s`,
        '-------------------------------------------------------------',
        `Throughput end-to-end   : ${fmt(throughput.endToEndTps)} tx/s`,
        `Throughput on-chain     : ${fmt(throughput.onChainTps)} tx/s`,
        `Throughput steady-state : ${fmt(throughput.steadyStateTps)} tx/s (${blocks.steadyStateCount} blocks)`,
        `Latency (ms)            : mean ${fmt(latencyMs.mean, 0)} | p50 ${fmt(latencyMs.p50, 0)} | p95 ${fmt(latencyMs.p95, 0)} | p99 ${fmt(latencyMs.p99, 0)} | max ${fmt(latencyMs.max, 0)}`,
        '=============================================================',
        '',
    ];
    console.log(lines.join('\n'));
}

module.exports = { writeResults, printSummary, summaryRow, SUMMARY_COLUMNS };
