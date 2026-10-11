'use strict';

/**
 * Small JSON-RPC 2.0 client over fetch with native batch support.
 * Unlike ethers' provider it reports per-request errors inside a batch,
 * which the load generator needs to retry individual transactions.
 */
class RpcError extends Error {
    constructor(message, code, data) {
        super(message);
        this.code = code;
        this.data = data;
    }
}

class JsonRpcClient {
    constructor(url, { timeoutMs = 30000 } = {}) {
        this.url = url;
        this.timeoutMs = timeoutMs;
        this.nextId = 1;
    }

    async post(body) {
        const res = await fetch(this.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.url}`);
        return res.json();
    }

    async call(method, params = []) {
        const res = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params });
        if (res.error) throw new RpcError(res.error.message, res.error.code, res.error.data);
        return res.result;
    }

    /**
     * Sends `calls` ([{ method, params }]) as one batch request. Resolves to an
     * array aligned with `calls` of `{ result }` or `{ error }` entries; only
     * transport-level failures reject.
     */
    async batch(calls) {
        if (calls.length === 0) return [];
        const firstId = this.nextId;
        this.nextId += calls.length;
        const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: firstId + i, method: c.method, params: c.params || [] }));
        const res = await this.post(body);
        if (!Array.isArray(res)) {
            const msg = res && res.error ? res.error.message : 'malformed batch response';
            throw new RpcError(msg, res && res.error && res.error.code);
        }
        const byId = new Map(res.map(r => [r.id, r]));
        return body.map(req => {
            const r = byId.get(req.id);
            if (!r) return { error: { message: 'missing response in batch' } };
            return r.error ? { error: r.error } : { result: r.result };
        });
    }
}

module.exports = { JsonRpcClient, RpcError };
