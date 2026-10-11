'use strict';

const { sleep } = require('./util');

/**
 * Polls a node for new blocks and reports each one exactly once, in order,
 * together with the local time it was first observed. That observation time
 * is what transaction latency is measured against (resolution: pollMs).
 */
class BlockTracker {
    constructor(client, { pollMs = 100, onBlock }) {
        this.client = client;
        this.pollMs = pollMs;
        this.onBlock = onBlock;
        this.blocks = [];
        this.lastNumber = null;
        this.running = false;
        this.errors = 0;
    }

    /** Records `fromBlock` (normally the current head) as the baseline and starts polling after it. */
    async start(fromBlock) {
        const head = await this.client.call('eth_getBlockByNumber', [toHex(fromBlock), false]);
        this.record(head, Date.now());
        this.lastNumber = fromBlock;
        this.running = true;
        this.loop = this.run();
    }

    async stop() {
        this.running = false;
        await this.loop;
        // Drain anything produced since the last poll.
        await this.poll();
    }

    async run() {
        while (this.running) {
            try {
                await this.poll();
            } catch (err) {
                this.errors++;
            }
            await sleep(this.pollMs);
        }
    }

    async poll() {
        const head = parseInt(await this.client.call('eth_blockNumber'), 16);
        if (head <= this.lastNumber) return;
        const numbers = [];
        for (let n = this.lastNumber + 1; n <= head; n++) numbers.push(n);
        const responses = await this.client.batch(numbers.map(n => ({ method: 'eth_getBlockByNumber', params: [toHex(n), false] })));
        const observedAt = Date.now();
        for (const r of responses) {
            if (r.error || !r.result) throw new Error(`eth_getBlockByNumber failed: ${r.error ? r.error.message : 'null block'}`);
            this.record(r.result, observedAt);
            this.lastNumber = parseInt(r.result.number, 16);
        }
    }

    record(raw, observedAt) {
        const block = {
            number: parseInt(raw.number, 16),
            timestamp: parseInt(raw.timestamp, 16),
            txCount: raw.transactions.length,
            benchmarkTxCount: 0,
            gasUsed: parseInt(raw.gasUsed, 16),
            observedAt,
        };
        if (this.onBlock) block.benchmarkTxCount = this.onBlock(block, raw.transactions);
        this.blocks.push(block);
    }
}

function toHex(n) {
    return '0x' + n.toString(16);
}

module.exports = { BlockTracker, toHex };
