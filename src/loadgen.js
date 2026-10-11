'use strict';

const { Transaction, keccak256 } = require('ethers');
const { sleep } = require('./util');

/** Global token bucket shared by all senders (open-loop load). `rate` in tx/s; 0 = unlimited. */
class RateLimiter {
    constructor(rate) {
        this.rate = rate;
        this.nextFree = 0;
    }

    async take(n) {
        if (!this.rate) return;
        const now = Date.now();
        const start = Math.max(now, this.nextFree);
        this.nextFree = start + (n / this.rate) * 1000;
        if (start > now) await sleep(start - now);
    }
}

/**
 * Pre-signs `count` self-transfers for `wallet` starting at `startNonce`.
 * Signing up front keeps client-side CPU out of the measured window.
 */
function presign({ wallet, count, startNonce, chainId, gasPrice }) {
    const txs = [];
    for (let i = 0; i < count; i++) {
        const tx = Transaction.from({
            type: 0,
            chainId,
            nonce: startNonce + i,
            to: wallet.address,
            value: 0n,
            gasLimit: 21000n,
            gasPrice,
        });
        tx.signature = wallet.signingKey.sign(tx.unsignedHash);
        const raw = tx.serialized;
        txs.push({ sender: wallet.address, nonce: startNonce + i, raw, hash: keccak256(raw), status: 'planned', attempts: 0 });
    }
    return txs;
}

// Errors meaning the node already has (or already mined) this exact transaction.
const ALREADY_KNOWN = /already known|known transaction|nonce too low/i;

/**
 * Sends one account's pre-signed transactions over JSON-RPC batches, keeping
 * at most `window` of them unconfirmed. Retries are idempotent because the
 * same signed payload (same hash) is resent.
 */
class Sender {
    constructor({ txs, client, batchSize, window, maxRetries, limiter, abort }) {
        this.txs = txs;
        this.client = client;
        this.batchSize = batchSize;
        this.window = window;
        this.maxRetries = maxRetries;
        this.limiter = limiter;
        this.abort = abort; // shared { aborted } flag set by the stall watchdog
        this.next = 0; // index of the next tx to submit
        this.confirmed = 0;
        this.sendErrors = 0;
        this.waiter = null;
    }

    /** Called by the block tracker when one of this sender's txs is included. */
    onConfirmed() {
        this.confirmed++;
        if (this.waiter) {
            const resolve = this.waiter;
            this.waiter = null;
            resolve();
        }
    }

    inFlight() {
        return this.next - this.confirmed;
    }

    async waitForWindow() {
        while (this.inFlight() >= this.window && !this.abort.aborted) {
            await new Promise(resolve => {
                this.waiter = resolve;
                // Safety net in case a confirmation is never reported.
                setTimeout(resolve, 1000);
            });
        }
    }

    async run() {
        while (this.next < this.txs.length) {
            await this.waitForWindow();
            if (this.abort.aborted) return;
            const n = Math.min(this.batchSize, this.txs.length - this.next, this.window - this.inFlight());
            const batch = this.txs.slice(this.next, this.next + n);
            this.next += n;
            await this.limiter.take(n);
            const ok = await this.submit(batch);
            if (!ok) {
                // A nonce could not be submitted: every later nonce of this sender
                // would stay stuck in the pool, so stop and mark them failed.
                for (let i = this.next; i < this.txs.length; i++) this.txs[i].status = 'failed';
                this.next = this.txs.length;
                return;
            }
        }
    }

    async submit(batch) {
        let pending = batch;
        for (let attempt = 0; pending.length > 0 && !this.abort.aborted; attempt++) {
            if (attempt > 0) await sleep(Math.min(50 * 2 ** (attempt - 1), 2000));
            const now = Date.now();
            for (const tx of pending) {
                if (tx.submittedAt === undefined) tx.submittedAt = now;
                tx.attempts++;
            }
            let responses;
            try {
                responses = await this.client.batch(pending.map(tx => ({ method: 'eth_sendRawTransaction', params: [tx.raw] })));
            } catch (err) {
                responses = pending.map(() => ({ error: { message: err.message } }));
            }
            const retry = [];
            responses.forEach((r, i) => {
                const tx = pending[i];
                if (!r.error || ALREADY_KNOWN.test(r.error.message)) {
                    if (tx.status === 'planned') tx.status = 'submitted';
                } else {
                    this.sendErrors++;
                    tx.lastError = r.error.message;
                    retry.push(tx);
                }
            });
            if (retry.length > 0 && attempt >= this.maxRetries) {
                for (const tx of retry) if (tx.status !== 'confirmed') tx.status = 'failed';
                return false;
            }
            pending = retry;
        }
        return true;
    }
}

module.exports = { RateLimiter, Sender, presign };
