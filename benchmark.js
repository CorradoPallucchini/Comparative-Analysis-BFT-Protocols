const { JsonRpcProvider, Wallet } = require('ethers');

// Configuration
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';

// Default Hardhat account #1 private key, funded in genesis.json
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; 

const TX_COUNT = parseInt(process.env.TX_COUNT || '1000', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);

async function runBenchmark() {
    console.log(`🚀 Starting BFT Benchmark`);
    console.log(`Connecting to RPC: ${RPC_URL}`);
    
    const provider = new JsonRpcProvider(RPC_URL);
    
    let network;
    try {
        network = await provider.getNetwork();
        console.log(`Connected to network: ${network.name} (Chain ID: ${network.chainId})`);
    } catch (error) {
        console.error('❌ Failed to connect to the node. Make sure docker-compose is running.');
        process.exit(1);
    }

    const wallet = new Wallet(PRIVATE_KEY, provider);
    const address = await wallet.getAddress();
    
    let balance = await provider.getBalance(address);
    console.log(`Wallet address: ${address}`);
    console.log(`Wallet balance: ${balance.toString()} wei`);

    if (balance === 0n) {
        console.error(`\n⚠️  WARNING: Your balance is 0. Transactions will fail.`);
        console.error(`Make sure to fund this address (${address}) in genesis.json "alloc" block.\n`);
        process.exit(1);
    }

    console.log(`\nPreparing to send ${TX_COUNT} transactions in batches of ${BATCH_SIZE}...`);
    
    const startNonce = await provider.getTransactionCount(address);
    let currentNonce = startNonce;
    
    const startTime = Date.now();
    let sentCount = 0;
    
    // We send zero-value transactions to ourselves to minimize EVM execution time
    // and purely test consensus throughput. We hardcode a low gas price since it's a private net.
    const txTemplate = {
        to: address,
        value: 0n,
        gasLimit: 21000n,
        gasPrice: 1000000000n // 1 gwei
    };

    const pendingTxs = [];

    for (let i = 0; i < TX_COUNT; i++) {
        const tx = { ...txTemplate, nonce: currentNonce++ };
        pendingTxs.push(wallet.sendTransaction(tx));
        sentCount++;
        
        if (sentCount % BATCH_SIZE === 0 || sentCount === TX_COUNT) {
            // Wait for this batch to be accepted into the mempool
            await Promise.all(pendingTxs.map(p => p.catch(e => {
                // Ignore nonce errors which can happen under heavy load in basic testnets
            })));
            pendingTxs.length = 0;
            process.stdout.write(`\rSent ${sentCount}/${TX_COUNT} transactions to mempool...`);
        }
    }
    
    console.log(`\nAll transactions sent. Waiting for blocks to mine them...`);
    
    const targetNonce = startNonce + TX_COUNT;
    let minedNonce = await provider.getTransactionCount(address);
    let stuckCounter = 0;
    
    while (minedNonce < targetNonce) {
        process.stdout.write(`\rMined ${minedNonce - startNonce}/${TX_COUNT} transactions...`);
        await new Promise(r => setTimeout(r, 1000));
        
        let newMinedNonce = await provider.getTransactionCount(address);
        if (newMinedNonce === minedNonce) {
            stuckCounter++;
            if (stuckCounter > 30) { // 30 seconds without progress
                console.log(`\n\n⚠️  Warning: Nonce hasn't increased for 30s. Some transactions might have been dropped by the mempool.`);
                break;
            }
        } else {
            stuckCounter = 0;
            minedNonce = newMinedNonce;
        }
    }
    
    const endTime = Date.now();
    const durationSec = (endTime - startTime) / 1000;
    const actualMined = minedNonce - startNonce;
    const tps = actualMined / durationSec; 
    
    console.log(`\n\n✅ Benchmark Complete!`);
    console.log(`-----------------------------------`);
    console.log(`Total Transactions Mined: ${actualMined} / ${TX_COUNT}`);
    console.log(`Total Time: ${durationSec.toFixed(2)} seconds`);
    console.log(`Avg TPS: ${tps.toFixed(2)} tx/sec`);
    console.log(`Avg Latency per Tx batch: ~${(durationSec / (actualMined/BATCH_SIZE)).toFixed(2)} sec`);
    console.log(`-----------------------------------`);
}

runBenchmark().catch(console.error);
