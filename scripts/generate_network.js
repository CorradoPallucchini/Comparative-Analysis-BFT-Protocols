'use strict';

/**
 * Generates a Hyperledger Besu BFT network (genesis, validator keys,
 * static-nodes.json, docker-compose.yaml and a network.json manifest that the
 * benchmark reads).
 *
 *   node scripts/generate_network.js --nodes 4 --consensus qbft --block-period 1
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { parseOptions, formatHelp } = require('../src/cli');
const { deriveWallets, TEST_MNEMONIC } = require('../src/accounts');
const {
    CONSENSUS, MAX_NODES, nodeIp, buildGeneratorConfig, buildStaticNodes,
    renderCompose, rpcUrls, faultTolerance,
} = require('../src/network');

const DEFAULT_BESU_VERSION = '26.8.1';

const SPECS = {
    'nodes': { type: 'int', min: 1, max: MAX_NODES, default: 4, description: 'Number of validator nodes' },
    'consensus': { type: 'enum', values: Object.keys(CONSENSUS), default: 'qbft', description: 'Consensus protocol (qbft | ibft2)' },
    'block-period': { type: 'int', min: 1, default: 1, description: 'Block period in seconds' },
    'request-timeout': { type: 'int', min: 1, default: 4, description: 'Round timeout in seconds (requesttimeoutseconds)' },
    'accounts': { type: 'int', min: 1, max: 10000, default: 64, description: 'Number of pre-funded sender accounts' },
    'chain-id': { type: 'int', min: 1, default: 1337, description: 'Chain id' },
    'besu-version': { type: 'string', env: 'BESU_VERSION', default: DEFAULT_BESU_VERSION, description: 'hyperledger/besu image tag (pinned for reproducibility)' },
    'rpc-base-port': { type: 'int', min: 1, max: 65535 - MAX_NODES, default: 8545, description: 'Host port of node1 RPC; nodeN uses base + N - 1' },
    'tx-pool-max-future-by-sender': { type: 'int', min: 1, default: 1000, description: 'Besu --tx-pool-max-future-by-sender' },
};

function main() {
    const opts = parseOptions(SPECS);
    if (opts.help) {
        console.log(formatHelp('Usage: node scripts/generate_network.js [options]', SPECS));
        return;
    }

    const besuImage = `hyperledger/besu:${opts['besu-version']}`;
    const f = faultTolerance(opts.nodes);

    console.log('\n⚙️  Generating BFT network:');
    console.log(`- Consensus      : ${CONSENSUS[opts.consensus].name} (${opts.consensus})`);
    console.log(`- Validators     : ${opts.nodes} (tolerates f = ${f} faulty node${f === 1 ? '' : 's'})`);
    console.log(`- Block period   : ${opts['block-period']}s`);
    console.log(`- Funded accounts: ${opts.accounts}`);
    console.log(`- Besu image     : ${besuImage}\n`);
    if (opts.nodes < 4) {
        console.warn(`⚠️  With ${opts.nodes} validator(s) the network tolerates no Byzantine fault (BFT needs n >= 3f + 1 = 4).\n`);
    }
    if (opts.consensus === 'ibft2') {
        console.warn('ℹ️  Besu supports IBFT 2.0 for existing networks but recommends QBFT for new ones.\n');
    }

    const rootDir = path.resolve(__dirname, '..');
    const configDir = path.join(rootDir, 'config');
    const networkFilesDir = path.join(configDir, 'networkFiles');
    const stagingDir = path.join(configDir, '.generator-out');

    const fundedAddresses = deriveWallets(opts.accounts).map(w => w.address);
    const generatorConfig = buildGeneratorConfig({
        consensus: opts.consensus,
        nodes: opts.nodes,
        blockPeriod: opts['block-period'],
        requestTimeout: opts['request-timeout'],
        chainId: opts['chain-id'],
        fundedAddresses,
    });

    fs.rmSync(stagingDir, { recursive: true, force: true });
    const configFile = path.join(configDir, 'generatorConfig.json');
    fs.writeFileSync(configFile, JSON.stringify(generatorConfig, null, 2));

    console.log('📦 Running "besu operator generate-blockchain-config"...');
    // Run as the host user so generated files are not owned by root, and bypass
    // the image entrypoint: when started as root it runs Besu twice (a
    // permission-probing pass first), which makes `operator` fail on the
    // second run with "Output directory already exists".
    const userArgs = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    try {
        execFileSync('docker', [
            'run', '--rm', ...userArgs,
            '--entrypoint', '/opt/besu/bin/besu',
            '-v', `${configDir}:/opt/besu/config`,
            besuImage,
            'operator', 'generate-blockchain-config',
            '--config-file=/opt/besu/config/generatorConfig.json',
            '--to=/opt/besu/config/.generator-out',
            '--private-key-file-name=key',
        ], { stdio: 'inherit' });
    } finally {
        fs.rmSync(configFile, { force: true });
    }

    // Only replace the previous network once generation has succeeded.
    fs.rmSync(networkFilesDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, networkFilesDir);

    const keysDir = path.join(networkFilesDir, 'keys');
    const validators = fs.readdirSync(keysDir)
        .filter(d => fs.statSync(path.join(keysDir, d)).isDirectory())
        .sort()
        .map(address => ({
            address,
            publicKey: fs.readFileSync(path.join(keysDir, address, 'key.pub'), 'utf8').trim(),
        }));
    if (validators.length !== opts.nodes) {
        throw new Error(`Expected ${opts.nodes} validator keys but found ${validators.length}`);
    }

    fs.writeFileSync(path.join(networkFilesDir, 'static-nodes.json'), JSON.stringify(buildStaticNodes(validators), null, 2) + '\n');

    const compose = renderCompose({
        consensus: opts.consensus,
        besuImage,
        rpcBasePort: opts['rpc-base-port'],
        txPoolMaxFutureBySender: opts['tx-pool-max-future-by-sender'],
        validators,
    });
    fs.writeFileSync(path.join(rootDir, 'docker-compose.yaml'), compose);

    const manifest = {
        generatedAt: new Date().toISOString(),
        consensus: opts.consensus,
        nodes: opts.nodes,
        faultTolerance: f,
        blockPeriodSeconds: opts['block-period'],
        requestTimeoutSeconds: opts['request-timeout'],
        chainId: opts['chain-id'],
        besuImage,
        txPoolMaxFutureBySender: opts['tx-pool-max-future-by-sender'],
        fundedAccounts: opts.accounts,
        mnemonic: TEST_MNEMONIC,
        rpcUrls: rpcUrls(opts.nodes, opts['rpc-base-port']),
        validators: validators.map((v, i) => ({ node: `node${i + 1}`, address: v.address, ip: nodeIp(i) })),
    };
    fs.writeFileSync(path.join(networkFilesDir, 'network.json'), JSON.stringify(manifest, null, 2) + '\n');

    console.log(`✅ Wrote genesis, ${validators.length} validator keys, static-nodes.json and network.json`);
    console.log('✅ Wrote docker-compose.yaml');
    console.log('\n🎉 Setup complete! Start the network with:\n   docker compose up -d\n');
}

try {
    main();
} catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
}
