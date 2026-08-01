# Comparative Analysis of BFT Protocols (Thesis Benchmark)

This repository contains the practical environment to reproduce the benchmarks presented in the Master Thesis: *"Comparative Analysis of PBFT, IBFT, and IBFT 2.0 Protocols"*.

## ⚠️ Security Warning
**This is a TESTING environment.** The private keys included in `config/networkFiles` and `benchmark.js` are publicly exposed for reproducibility purposes. **DO NOT USE these keys on Ethereum Mainnet or any production network.**

## Prerequisites
- Docker & Docker Compose
- Node.js & NPM
- MacBook M1/M2/M3 (Recommended for native compatibility)

## How to run (IBFT 2.0 / QBFT)
1. Start the network:
   ```bash
   docker-compose up -d
   ```

## Running the Benchmark
The benchmark script sends thousands of zero-value transactions to test the throughput (TPS) of the network.

1. Install Node.js dependencies:
   ```bash
   npm install
   ```
2. Run the benchmark:
   ```bash
   npm start
   ```
   *(You can also configure the load via env variables: `TX_COUNT=5000 BATCH_SIZE=100 npm start`)*