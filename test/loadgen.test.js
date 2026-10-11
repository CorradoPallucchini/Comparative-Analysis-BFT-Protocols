'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Transaction } = require('ethers');
const { deriveWallets } = require('../src/accounts');
const { Sender, RateLimiter, presign } = require('../src/loadgen');

const [wallet] = deriveWallets(1);

function plan(count) {
    return presign({ wallet, count, startNonce: 5, chainId: 1337, gasPrice: 1000000000n });
}

/** Fake RPC client: `respond(raw, callIndex)` returns a JSON-RPC result entry. */
function fakeClient(respond) {
    const client = { calls: [], batch: async calls => {
        client.calls.push(calls.length);
        return calls.map(c => respond(c.params[0], client.calls.length));
    } };
    return client;
}

function sender(txs, client, extra = {}) {
    return new Sender({ txs, client, batchSize: 3, window: 100, maxRetries: 2, limiter: new RateLimiter(0), abort: { aborted: false }, ...extra });
}

test('presign produces valid sequential signed transactions', () => {
    const txs = plan(3);
    txs.forEach((t, i) => {
        const tx = Transaction.from(t.raw);
        assert.strictEqual(tx.from, wallet.address);
        assert.strictEqual(tx.nonce, 5 + i);
        assert.strictEqual(tx.hash, t.hash);
    });
});

test('sends in batches of batchSize', async () => {
    const txs = plan(7);
    const client = fakeClient(() => ({ result: '0x' }));
    await sender(txs, client).run();
    assert.deepStrictEqual(client.calls, [3, 3, 1]);
    assert.ok(txs.every(t => t.status === 'submitted' && t.submittedAt !== undefined));
});

test('treats "already known" as accepted and retries transient errors', async () => {
    const txs = plan(2);
    const client = fakeClient((raw, call) => {
        if (raw === txs[0].raw) return { error: { message: 'Known transaction' } };
        return call === 1 ? { error: { message: 'connection reset' } } : { result: '0x' };
    });
    await sender(txs, client).run();
    assert.deepStrictEqual(client.calls, [2, 1]);
    assert.deepStrictEqual(txs.map(t => t.status), ['submitted', 'submitted']);
    assert.strictEqual(txs[1].attempts, 2);
});

test('after maxRetries the sender stops and fails the remaining nonces', async () => {
    const txs = plan(5);
    const client = fakeClient(raw => (raw === txs[1].raw ? { error: { message: 'insufficient funds' } } : { result: '0x' }));
    const s = sender(txs, client);
    await s.run();
    assert.deepStrictEqual(txs.map(t => t.status), ['submitted', 'failed', 'submitted', 'failed', 'failed']);
    assert.strictEqual(txs[1].lastError, 'insufficient funds');
    assert.strictEqual(s.sendErrors, 3);
});

test('never exceeds the in-flight window and resumes on confirmation', async () => {
    const txs = plan(4);
    const client = fakeClient(() => ({ result: '0x' }));
    const s = sender(txs, client, { window: 2, batchSize: 10 });
    const done = s.run();
    await new Promise(r => setImmediate(r));
    assert.strictEqual(s.next, 2);
    s.onConfirmed();
    s.onConfirmed();
    await done;
    assert.deepStrictEqual(client.calls, [2, 2]);
});

test('abort releases a sender blocked on a full window', async () => {
    const txs = plan(4);
    const abort = { aborted: false };
    const s = sender(txs, fakeClient(() => ({ result: '0x' })), { window: 1, abort });
    const done = s.run();
    await new Promise(r => setTimeout(r, 20));
    abort.aborted = true;
    await done;
    assert.strictEqual(s.next, 1);
});

test('rate limiter spaces out batches', async () => {
    const limiter = new RateLimiter(100); // 100 tx/s
    const start = Date.now();
    await limiter.take(5);
    await limiter.take(5); // must wait ~50 ms for the first 5 tokens
    assert.ok(Date.now() - start >= 45);
});
