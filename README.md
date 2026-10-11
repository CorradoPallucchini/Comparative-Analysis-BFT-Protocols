# Comparative Analysis of BFT Protocols (Thesis Benchmark)

This repository contains the practical environment to reproduce the benchmarks presented in the Master Thesis: *"Comparative Analysis of PBFT, IBFT, and IBFT 2.0 Protocols"*.

It builds a [Hyperledger Besu](https://besu.hyperledger.org/) permissioned network running a BFT consensus protocol in Docker, and measures its throughput and transaction latency under load.

| Protocol  | `--consensus` | Status |
|-----------|---------------|--------|
| QBFT      | `qbft`        | Supported (Besu's recommended BFT protocol) |
| IBFT 2.0  | `ibft2`       | Supported (Besu keeps it for existing networks and recommends QBFT) |
| PBFT      | –             | Not available in Besu; planned |

> QBFT and IBFT 2.0 are **different** protocols in Besu: QBFT is the EEA-standardised successor of IBFT 2.0, not an alias for it.

## ⚠️ Security Warning
**This is a TESTING environment.** The validator keys in `config/networkFiles` and the sender accounts (derived from the well-known test mnemonic `test test … junk`) are public. **DO NOT USE these keys on Ethereum Mainnet or any production network.** The RPC ports are bound to `127.0.0.1` only.

## Prerequisites
- Docker & Docker Compose
- Node.js v18+ & NPM

```bash
npm install
```

## Quick Start

### 1. Generate the network
The generator runs `besu operator generate-blockchain-config` in a pinned Besu image and writes the genesis, validator keys, `static-nodes.json`, `docker-compose.yaml` and `config/networkFiles/network.json` (a manifest the benchmark reads).

```bash
# Default: 4-node QBFT network, 1 s block period, 64 funded sender accounts
npm run generate

# Customised
node scripts/generate_network.js --nodes 7 --consensus ibft2 --block-period 2
node scripts/generate_network.js --help
```

| Option | Default | Description |
|--------|---------|-------------|
| `--nodes` | `4` | Number of validators (tolerates `f = ⌊(n−1)/3⌋` faults) |
| `--consensus` | `qbft` | `qbft` or `ibft2` |
| `--block-period` | `1` | Block period in seconds |
| `--request-timeout` | `4` | Round timeout in seconds |
| `--accounts` | `64` | Pre-funded sender accounts |
| `--besu-version` | `26.8.1` | `hyperledger/besu` image tag (env `BESU_VERSION`) |
| `--rpc-base-port` | `8545` | Host RPC port of `node1`; `nodeN` uses `base + N − 1` |
| `--tx-pool-max-future-by-sender` | `1000` | Besu tx pool limit per sender |

Stop a running network (`docker compose down -v`) before regenerating it.

### 2. Start the network
```bash
docker compose up -d
```

### 3. Run the benchmark
```bash
npm start

# Custom load
npm start -- --tx-count 10000 --senders 32 --batch-size 25 --window 100
npm start -- --tx-count 3000 --rate 200 --label offered-200
node benchmark.js --help
```

Every option can also be set through the environment variable shown in `--help` (e.g. `TX_COUNT=2000 BATCH_SIZE=50 npm start`).

| Option | Default | Description |
|--------|---------|-------------|
| `--tx-count` | `2000` | Total transactions |
| `--senders` | `32` | Parallel sender accounts (≤ `--accounts` of the generator) |
| `--batch-size` | `25` | Transactions per JSON-RPC batch request |
| `--window` | `100` | Max unconfirmed transactions per sender |
| `--rate` | `0` | Offered load in tx/s (`0` = as fast as possible) |
| `--target` | `all` | Spread senders over `all` nodes or send only to the `first` |
| `--rpc` | from manifest | Comma-separated RPC URLs |
| `--stall-timeout` | `60` | Abort after this many seconds without confirmations |
| `--trim-ratio` | `0.1` | Blocks dropped at each end of the load window for steady-state TPS |
| `--output` | `results` | Output directory |
| `--label` | – | Tag stored with the results |
| `--no-save` | – | Do not write result files |

### 4. Stop the network
```bash
docker compose down -v
```

## How the benchmark works

1. Checks every RPC endpoint, that they share a chain id and that blocks are being produced.
2. Derives the sender accounts, verifies they are funded and reads their pending nonces.
3. **Pre-signs** all transactions (0-value self-transfers, 21 000 gas) so that client-side signing is not part of the measurement.
4. Starts a **block tracker** that polls the first node every `--poll-ms` (100 ms) and records when each block is first observed.
5. Each sender submits its transactions in JSON-RPC **batches** of `--batch-size`, keeping at most `--window` unconfirmed. Senders are spread round-robin over the nodes. With `--rate` a global token bucket limits the offered load (open loop). Submission errors are retried idempotently (same signed payload).
6. The run ends when every transaction is confirmed, or after `--stall-timeout` seconds without progress (for example if the network loses its quorum). In that case the partial results are saved and the process exits with code `2`.

### Metrics

| Metric | Definition |
|--------|------------|
| **End-to-end TPS** | confirmed txs / (last inclusion observed − first submission). The client's view, including ramp-up and drain. |
| **On-chain TPS** | benchmark txs in the load window / (timestamp of last block − timestamp of the block before the first). The load window spans the first to the last block containing benchmark txs. |
| **Steady-state TPS** | Same as on-chain TPS after dropping `--trim-ratio` of the window's blocks at each end. Omitted when fewer than 3 blocks remain. |
| **Latency** | Inclusion observed − submission, per transaction (mean, p50, p90, p95, p99, max). BFT consensus gives immediate finality, so inclusion is finality. Resolution is `--poll-ms`. |
| **Blocks** | Blocks in the load window, tx/block and block intervals. |

Block timestamps have a 1 s resolution, so on-chain figures over only a few blocks are coarse: use enough transactions to span at least ~10 blocks.

### Output

Each run writes to `results/` (git-ignored):

- `<runId>.json`: parameters, network manifest, client version, git commit, host info, summary and per-block data
- `<runId>_txs.csv`: per-transaction submission/inclusion times and latency
- `summary.csv`: one row per run, appended, ready for comparing configurations

## Tests

```bash
npm test
```

Unit tests cover option parsing, network configuration, the load generator (batching, retries, window, abort) and the metric computations. They need neither Docker nor a running network.

## Project layout

```
benchmark.js               benchmark entry point
scripts/generate_network.js network generator entry point
src/cli.js                 option parsing (CLI flags + env variables)
src/accounts.js            deterministic sender accounts
src/network.js             genesis / compose / static-nodes builders
src/rpc.js                 JSON-RPC client with batch support
src/loadgen.js             pre-signing, senders, rate limiter
src/blockTracker.js        block polling and inclusion tracking
src/metrics.js, stats.js   throughput / latency computation
src/report.js              console summary, JSON and CSV export
test/                      unit tests (node:test)
```
