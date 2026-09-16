# Comparative Analysis of BFT Protocols (Thesis Benchmark)

This repository contains the practical environment to reproduce the benchmarks presented in the Master Thesis: *"Comparative Analysis of PBFT, IBFT, and IBFT 2.0 Protocols"*.

## ⚠️ Security Warning
**This is a TESTING environment.** The private keys included in `config/networkFiles` and `benchmark.js` are publicly exposed for reproducibility purposes. **DO NOT USE these keys on Ethereum Mainnet or any production network.**

## Prerequisites
- Docker & Docker Compose
- Node.js & NPM
- MacBook M1/M2/M3 (Recommended for native compatibility)

## Quick Start

### 1. Prerequisites
- Docker & Docker Compose
- Node.js (v18+) & NPM

### 2. Generate Network Configuration
You can generate deterministic configurations and a customized `docker-compose.yaml` for any number of validator nodes and consensus algorithms:

```bash
# Default: 4-node QBFT (IBFT 2.0) network with 1s block period
npm run generate

# Or customize parameters:
node scripts/generate_network.js --nodes 4 --consensus qbft --block-period 1
node scripts/generate_network.js --nodes 10 --consensus ibft2 --block-period 2
```

### 3. Start the Network
```bash
docker compose up -d
```

### 4. Run the Benchmark
The benchmark script sends transactions using parallel worker accounts, waits for block confirmation, and calculates real Throughput (TPS):

```bash
npm start

# Custom load options:
TX_COUNT=2000 BATCH_SIZE=50 npm start
```

### 5. Stop the Network
```bash
docker compose down -v
```