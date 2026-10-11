'use strict';

/**
 * BFT throughput / latency benchmark for a Besu network.
 *
 *   npm start -- --tx-count 5000 --senders 32 --batch-size 25
 *
 * Run `node benchmark.js --help` for every option.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { parseOptions, formatHelp } = require('./src/cli');
const { deriveWallets } = require('./src/accounts');
const { JsonRpcClient } = require('./src/rpc');
const { BlockTracker } = require('./src/blockTracker');
const { RateLimiter, Sender, presign } = require('./src/loadgen');
const { computeMetrics } = require('./src/metrics');
const { writeResults, printSummary } = require('./src/report');
const { sleep } = require('./src/util');

const SPECS = {
    'tx-count': { type: 'int', min: 1, env: 'TX_COUNT', default: 2000, description: 'Total transactions to send' },
    'senders': { type: 'int', min: 1, env: 'SENDERS', default: 32, description: 'Parallel sender accounts (must be pre-funded)' },
    'batch-size': { type: 'int', min: 1, env: 'BATCH_SIZE', default: 25, description: 'Transactions per JSON-RPC batch request' },
    'window': { type: 'int', min: 1, env: 'WINDOW', default: 100, description: 'Max unconfirmed transactions per sender' },
    'rate': { type: 'float', min: 0, env: 'RATE', default: 0, description: 'Offered load in tx/s across all senders (0 = as fast as possible)' },
    'target': { type: 'enum', values: ['all', 'first'], env: 'TARGET', default: 'all', description: 'Spread senders over all nodes or use only the first RPC' },
    'rpc': { type: 'list', env: 'RPC_URL', description: 'Comma-separated RPC URLs (default: from the network file)' },
    'network-file': { type: 'string', env: 'NETWORK_FILE', default: 'config/networkFiles/network.json', description: 'Manifest written by the generator' },
    'gas-price-gwei': { type: 'float', min: 0, env: 'GAS_PRICE_GWEI', description: 'Fixed gas price (default: 2x current base fee, at least 1 gwei)' },
    'poll-ms': { type: 'int', min: 10, env: 'POLL_MS', default: 100, description: 'Block polling interval (latency resolution)' },
    'stall-timeout': { type: 'int', min: 1, env: 'STALL_TIMEOUT', default: 60, description: 'Seconds without new confirmations before giving up' },
    'trim-ratio': { type: 'float', min: 0, max: 0.45, env: 'TRIM_RATIO', default: 0.1, description: 'Fraction of load-window blocks dropped at each end for steady-state TPS' },
    'max-retries': { type: 'int', min: 0, env: 'MAX_RETRIES', default: 10, description: 'Retries per transaction on submission errors' },
    'output': { type: 'string', env: 'OUTPUT_DIR', default: 'results', description: 'Directory for JSON/CSV results' },
    'label': { type: 'string', env: 'LABEL', default: '', description: 'Free-form tag stored with the results' },
    'no-save': { type: 'bool', default: false, description: 'Do not write result files' },
};

const ONE_GWEI = 1_000_000_000n;

function loadManifest(file) {
    const p = path.resolve(file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function gitInfo() {
    try {
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
        return { commit, dirty };
    } catch {
        return { commit: null, dirty: null };
    }
}

function hostInfo() {
    const cpus = os.cpus();
    return {
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpuModel: cpus.length ? cpus[0].model : null,
        cpuCount: cpus.length,
        totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
        node: process.version,
    };
}

async function waitForConsensus(client) {
    const initial = parseInt(await client.call('eth_blockNumber'), 16);
    console.log(`⏳ Connected, block height #${initial}. Waiting for a new block to confirm consensus is live...`);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const current = parseInt(await client.call('eth_blockNumber'), 16);
        if (current > initial) {
            console.log(`✅ Consensus is producing blocks (#${current}).\n`);
            return;
        }
        await sleep(500);
    }
    throw new Error('No new block within 30 s: the network is not producing blocks (is a quorum of validators up?)');
}

function splitEvenly(total, parts) {
    const base = Math.floor(total / parts);
    return Array.from({ length: parts }, (_, i) => base + (i < total % parts ? 1 : 0));
}

function startProgress(txs, tracker, startedAt) {
    const tty = process.stdout.isTTY;
    let lastLine = 0;
    return setInterval(() => {
        const confirmed = txs.filter(t => t.status === 'confirmed').length;
        const submitted = txs.filter(t => t.submittedAt !== undefined).length;
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const line = `⏳ [${elapsed}s] submitted ${submitted}/${txs.length}, confirmed ${confirmed} (block #${tracker.lastNumber})`;
        if (tty) {
            process.stdout.write(`\r${line}   `);
        } else if (Date.now() - lastLine >= 5000) {
            console.log(line);
            lastLine = Date.now();
        }
    }, 500);
}

/**
 * Aborts the run when no transaction has been confirmed for `stallTimeoutMs`
 * while some are still outstanding (e.g. the network lost its quorum).
 */
function startWatchdog(txs, abort, stallTimeoutMs) {
    let lastConfirmed = -1;
    let lastProgress = Date.now();
    const timer = setInterval(() => {
        const confirmed = txs.filter(t => t.status === 'confirmed').length;
        if (confirmed !== lastConfirmed) {
            lastConfirmed = confirmed;
            lastProgress = Date.now();
        } else if (Date.now() - lastProgress > stallTimeoutMs && !abort.aborted) {
            abort.aborted = true;
            const outstanding = txs.filter(t => t.status !== 'confirmed' && t.status !== 'failed').length;
            console.warn(`\n⚠️  No confirmation for ${stallTimeoutMs / 1000}s: aborting with ${outstanding} transaction(s) unconfirmed.`);
        }
    }, 200);
    return () => clearInterval(timer);
}

async function waitForConfirmations(txs, abort) {
    while (!abort.aborted && txs.some(t => t.status === 'submitted')) {
        await sleep(100);
    }
}

async function main() {
    const opts = parseOptions(SPECS);
    if (opts.help) {
        console.log(formatHelp('Usage: node benchmark.js [options]', SPECS));
        return;
    }

    const manifest = loadManifest(opts['network-file']);
    const rpcUrls = opts.rpc || (manifest && manifest.rpcUrls) || ['http://127.0.0.1:8545'];
    const targetUrls = opts.target === 'first' ? rpcUrls.slice(0, 1) : rpcUrls;
    const clients = targetUrls.map(url => new JsonRpcClient(url));
    const observer = clients[0];

    if (!manifest) console.warn(`⚠️  ${opts['network-file']} not found: network metadata will be missing from the results.`);
    if (manifest && opts.senders > manifest.fundedAccounts) {
        throw new Error(`--senders ${opts.senders} exceeds the ${manifest.fundedAccounts} accounts funded in genesis (regenerate with --accounts)`);
    }

    console.log(`🔍 Checking ${targetUrls.length} RPC endpoint(s)...`);
    const nodeInfo = await Promise.all(clients.map(async c => {
        try {
            const [chainId, clientVersion] = await Promise.all([c.call('eth_chainId'), c.call('web3_clientVersion')]);
            return { url: c.url, chainId: parseInt(chainId, 16), clientVersion };
        } catch (err) {
            throw new Error(`Cannot reach ${c.url} (${err.message}). Is the network up? Try: docker compose up -d`);
        }
    }));
    const chainId = nodeInfo[0].chainId;
    if (nodeInfo.some(n => n.chainId !== chainId)) throw new Error('RPC endpoints report different chain ids');
    await waitForConsensus(observer);

    const wallets = deriveWallets(opts.senders);
    const addrs = wallets.map(w => w.address);
    const [balances, nonces] = await Promise.all([
        observer.batch(addrs.map(a => ({ method: 'eth_getBalance', params: [a, 'latest'] }))),
        observer.batch(addrs.map(a => ({ method: 'eth_getTransactionCount', params: [a, 'pending'] }))),
    ]);
    const unfunded = addrs.filter((a, i) => balances[i].error || BigInt(balances[i].result) === 0n);
    if (unfunded.length > 0) {
        throw new Error(`${unfunded.length} sender account(s) have no balance (e.g. ${unfunded[0]}); regenerate the network with more --accounts`);
    }

    let gasPrice;
    if (opts['gas-price-gwei'] !== undefined) {
        gasPrice = BigInt(Math.round(opts['gas-price-gwei'] * 1e9));
    } else {
        const latest = await observer.call('eth_getBlockByNumber', ['latest', false]);
        const baseFee = latest.baseFeePerGas ? BigInt(latest.baseFeePerGas) : 0n;
        gasPrice = baseFee * 2n > ONE_GWEI ? baseFee * 2n : ONE_GWEI;
    }

    const perSender = splitEvenly(opts['tx-count'], opts.senders);
    const signStart = Date.now();
    const plans = wallets.map((wallet, i) => presign({
        wallet, count: perSender[i], startNonce: parseInt(nonces[i].result, 16), chainId, gasPrice,
    }));
    console.log(`✍️  Pre-signed ${opts['tx-count']} transactions in ${((Date.now() - signStart) / 1000).toFixed(1)}s`);

    const limiter = new RateLimiter(opts.rate);
    const abort = { aborted: false };
    const senders = plans.map((txs, i) => new Sender({
        txs,
        client: clients[i % clients.length],
        batchSize: opts['batch-size'],
        window: opts.window,
        maxRetries: opts['max-retries'],
        limiter,
        abort,
    }));
    const allTxs = plans.flat();
    const byHash = new Map();
    plans.forEach((txs, i) => txs.forEach(tx => byHash.set(tx.hash, { tx, sender: senders[i] })));

    const tracker = new BlockTracker(observer, {
        pollMs: opts['poll-ms'],
        onBlock: (block, hashes) => {
            let ours = 0;
            for (const h of hashes) {
                const entry = byHash.get(h);
                if (!entry) continue;
                ours++;
                if (entry.tx.status === 'confirmed') continue;
                entry.tx.status = 'confirmed';
                entry.tx.includedAt = block.observedAt;
                entry.tx.blockNumber = block.number;
                entry.sender.onConfirmed();
            }
            return ours;
        },
    });

    console.log('🚀 Starting load:');
    console.log(`- Transactions : ${opts['tx-count']} (${perSender[0]}${perSender[0] !== perSender[perSender.length - 1] ? `/${perSender[perSender.length - 1]}` : ''} per sender)`);
    console.log(`- Senders      : ${opts.senders} over ${clients.length} node(s)`);
    console.log(`- Batch/window : ${opts['batch-size']} / ${opts.window}`);
    console.log(`- Offered rate : ${opts.rate || 'unlimited'}${opts.rate ? ' tx/s' : ''}`);
    console.log(`- Gas price    : ${Number(gasPrice) / 1e9} gwei\n`);

    const startedAt = new Date();
    await tracker.start(parseInt(await observer.call('eth_blockNumber'), 16));
    const progress = startProgress(allTxs, tracker, startedAt.getTime());
    const stopWatchdog = startWatchdog(allTxs, abort, opts['stall-timeout'] * 1000);
    await Promise.all(senders.map(s => s.run()));
    await waitForConfirmations(allTxs, abort);
    stopWatchdog();
    clearInterval(progress);
    await tracker.stop();
    const finishedAt = new Date();
    if (process.stdout.isTTY) process.stdout.write('\n');

    const failed = allTxs.filter(t => t.status === 'failed' && t.lastError);
    if (failed.length > 0) console.warn(`⚠️  ${failed.length} transaction(s) failed; last error: ${failed[0].lastError}`);

    const summary = computeMetrics({ txs: allTxs, blocks: tracker.blocks, trimRatio: opts['trim-ratio'] });
    const network = manifest
        ? {
            consensus: manifest.consensus, nodes: manifest.nodes, faultTolerance: manifest.faultTolerance,
            blockPeriodSeconds: manifest.blockPeriodSeconds, requestTimeoutSeconds: manifest.requestTimeoutSeconds,
            besuImage: manifest.besuImage, chainId,
        }
        : { consensus: 'unknown', nodes: rpcUrls.length, chainId };
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const result = {
        runId: `${stamp}_${network.consensus}_n${network.nodes}${opts.label ? `_${opts.label.replace(/[^\w.-]+/g, '-')}` : ''}`,
        meta: {
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            clientVersion: nodeInfo[0].clientVersion,
            git: gitInfo(),
            host: hostInfo(),
            sendErrors: senders.reduce((a, s) => a + s.sendErrors, 0),
            trackerErrors: tracker.errors,
        },
        params: {
            txCount: opts['tx-count'], senders: opts.senders, batchSize: opts['batch-size'], window: opts.window,
            rate: opts.rate, target: opts.target, rpcUrls: targetUrls, gasPriceWei: gasPrice.toString(),
            pollMs: opts['poll-ms'], stallTimeoutSeconds: opts['stall-timeout'], trimRatio: opts['trim-ratio'],
            maxRetries: opts['max-retries'], label: opts.label,
        },
        aborted: abort.aborted,
        network,
        summary,
        blocks: tracker.blocks,
    };

    printSummary(result);
    if (!opts['no-save']) {
        const out = writeResults(path.resolve(opts.output), result, allTxs);
        console.log(`💾 Results: ${path.relative(process.cwd(), out.jsonPath)}`);
        console.log(`   Per-tx:  ${path.relative(process.cwd(), out.txPath)}`);
        console.log(`   Summary: ${path.relative(process.cwd(), out.summaryPath)}\n`);
    }
    if (summary.counts.confirmed < summary.counts.planned) process.exitCode = 2;
}

main().catch(err => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
});
