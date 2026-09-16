const { JsonRpcProvider, Wallet } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const TOTAL_TX = parseInt(process.env.TX_COUNT || '1000', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '25', 10);

const TEST_PRIVATE_KEYS = [
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    '0x47e179ec34648e80ae330f10e7003a18e0029b83e820400d1647a7fb3f662738',
    '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d336d86463737e2dec'
];

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForConsensus(provider) {
    console.log('🔍 Checking node connectivity and BFT consensus health...');
    let initialBlock;
    try {
        initialBlock = await provider.getBlockNumber();
        console.log(`Connected to RPC! Current block height: #${initialBlock}`);
    } catch (err) {
        console.error('❌ Cannot connect to Besu RPC at', RPC_URL);
        console.error('   Ensure docker compose is up: `docker compose up -d`');
        process.exit(1);
    }

    console.log('⏳ Waiting for blocks to advance to confirm active consensus...');
    const startWait = Date.now();
    while (Date.now() - startWait < 30000) {
        const current = await provider.getBlockNumber();
        if (current > initialBlock) {
            console.log(`✅ Consensus is active and producing blocks! (Now at block #${current})\n`);
            return;
        }
        await sleep(1000);
    }
    console.warn('⚠️  Warning: Block height did not increase within 30s. Proceeding anyway, but network might still be starting.\n');
}

async function runBenchmark() {
    const provider = new JsonRpcProvider(RPC_URL);
    await waitForConsensus(provider);

    const wallets = TEST_PRIVATE_KEYS.map(pk => new Wallet(pk, provider));
    const txPerWallet = Math.ceil(TOTAL_TX / wallets.length);

    console.log(`🚀 Starting BFT Benchmark Benchmark:`);
    console.log(`- Total Transactions: ${wallets.length * txPerWallet}`);
    console.log(`- Parallel Senders (Accounts): ${wallets.length}`);
    console.log(`- Txs per Account: ${txPerWallet}`);
    console.log(`- Batch Size per Sender: ${BATCH_SIZE}\n`);

    const startBlock = await provider.getBlockNumber();
    const startTime = Date.now();

    const initialNonces = await Promise.all(wallets.map(async w => {
        const addr = await w.getAddress();
        return provider.getTransactionCount(addr);
    }));

    const totalTarget = wallets.length * txPerWallet;
    const progressTimer = setInterval(async () => {
        try {
            const currentCounts = await Promise.all(wallets.map(async (w, idx) => {
                const addr = await w.getAddress();
                const n = await provider.getTransactionCount(addr);
                return Math.max(0, n - initialNonces[idx]);
            }));
            const minedNow = currentCounts.reduce((a, b) => a + b, 0);
            const blockNow = await provider.getBlockNumber();
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            process.stdout.write(`\r⏳ [${elapsed}s] Processing... Mined: ${minedNow}/${totalTarget} txs (Block #${blockNow})`);
        } catch (e) {}
    }, 1000);


    const workerPromises = wallets.map(async (wallet, walletIndex) => {
        const address = await wallet.getAddress();
        let nonce = initialNonces[walletIndex];
        const startNonce = nonce;
        const targetNonce = startNonce + txPerWallet;

        const txTemplate = {
            to: address,
            value: 0n,
            gasLimit: 21000n,
            gasPrice: 1000000000n
        };

        for (let i = 0; i < txPerWallet; i++) {
            let sent = false;
            while (!sent) {
                try {
                    await wallet.sendTransaction({ ...txTemplate, nonce: nonce });
                    nonce++;
                    sent = true;
                } catch (e) {
                    await sleep(30);
                }
            }
        }

        let currentMinedNonce = await provider.getTransactionCount(address);
        let stuckTime = 0;
        while (currentMinedNonce < targetNonce) {
            await sleep(500);
            const nextNonce = await provider.getTransactionCount(address);
            if (nextNonce === currentMinedNonce) {
                stuckTime += 500;
                if (stuckTime >= 60000) break;
            } else {
                stuckTime = 0;
                currentMinedNonce = nextNonce;
            }
        }

        return currentMinedNonce - startNonce;
    });

    const results = await Promise.all(workerPromises);
    clearInterval(progressTimer);
    console.log('\n');

    const totalMined = results.reduce((a, b) => a + b, 0);
    const endTime = Date.now();
    const endBlock = await provider.getBlockNumber();

    const durationSec = (endTime - startTime) / 1000;
    const tps = totalMined / durationSec;
    const blocksProduced = endBlock - startBlock;

    console.log('\n=============================================');
    console.log('            BENCHMARK RESULTS                ');
    console.log('=============================================');
    console.log(`Total Transactions Submitted : ${wallets.length * txPerWallet}`);
    console.log(`Total Transactions Mined     : ${totalMined}`);
    console.log(`Blocks Produced              : ${blocksProduced} blocks (#${startBlock} -> #${endBlock})`);
    console.log(`Elapsed Time                 : ${durationSec.toFixed(2)} seconds`);
    console.log(`Measured Throughput (TPS)    : ${tps.toFixed(2)} tx/s`);
    console.log('=============================================\n');
}

runBenchmark().catch(console.error);