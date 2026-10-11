'use strict';

/**
 * Pure helpers that turn generator options into Besu / Docker configuration.
 * Kept free of I/O so they can be unit tested.
 */

const CONSENSUS = {
    // genesis key, JSON-RPC namespace, human-readable name
    qbft: { genesisKey: 'qbft', rpcApi: 'QBFT', name: 'QBFT' },
    ibft2: { genesisKey: 'ibft2', rpcApi: 'IBFT', name: 'IBFT 2.0' },
};

const SUBNET_PREFIX = '172.16.239';
const FIRST_HOST = 10;
const MAX_NODES = 240;
const FUNDED_BALANCE = '0x1000000000000000000000000000000000000000000000000000000000000000';

function nodeIp(index) {
    return `${SUBNET_PREFIX}.${FIRST_HOST + index}`;
}

function buildGeneratorConfig({ consensus, nodes, blockPeriod, requestTimeout, chainId, fundedAddresses }) {
    const alloc = {};
    for (const addr of fundedAddresses) alloc[addr] = { balance: FUNDED_BALANCE };

    return {
        genesis: {
            nonce: '0x0',
            timestamp: '0x58ee40ba',
            gasLimit: '0x1fffffffffffff',
            difficulty: '0x1',
            mixHash: '0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365',
            coinbase: '0x0000000000000000000000000000000000000000',
            config: {
                chainId,
                londonBlock: 0,
                [CONSENSUS[consensus].genesisKey]: {
                    blockperiodseconds: blockPeriod,
                    epochlength: 30000,
                    requesttimeoutseconds: requestTimeout,
                },
            },
            alloc,
        },
        blockchain: { nodes: { generate: true, count: nodes } },
    };
}

/** `validators` is a list of `{ address, publicKey }` (hex, no 0x prefix required). */
function buildStaticNodes(validators) {
    return validators.map((v, i) => `enode://${v.publicKey.replace(/^0x/, '')}@${nodeIp(i)}:30303`);
}

function nodeCommand({ consensus, keyDir, ip, txPoolMaxFutureBySender }) {
    return [
        '--data-path=/opt/besu/data',
        '--genesis-file=/config/networkFiles/genesis.json',
        `--node-private-key-file=/config/networkFiles/${keyDir}/key`,
        '--static-nodes-file=/config/networkFiles/static-nodes.json',
        `--p2p-host=${ip}`,
        '--p2p-port=30303',
        '--rpc-http-enabled=true',
        `--rpc-http-api=ETH,NET,WEB3,TXPOOL,${CONSENSUS[consensus].rpcApi}`,
        '--rpc-http-host=0.0.0.0',
        '--rpc-http-port=8545',
        '--rpc-http-cors-origins=*',
        '--host-allowlist=*',
        `--tx-pool-max-future-by-sender=${txPoolMaxFutureBySender}`,
    ];
}

function renderCompose({ consensus, besuImage, rpcBasePort, txPoolMaxFutureBySender, validators }) {
    const lines = ['services:'];
    validators.forEach((v, i) => {
        const name = `node${i + 1}`;
        const ip = nodeIp(i);
        lines.push(
            `  ${name}:`,
            `    image: ${besuImage}`,
            `    container_name: bft_${name}`,
            '    restart: unless-stopped',
            '    volumes:',
            '      - ./config/networkFiles:/config/networkFiles:ro',
            '    command:',
            ...nodeCommand({ consensus, keyDir: `keys/${v.address}`, ip, txPoolMaxFutureBySender })
                .map(arg => `      - "${arg}"`),
            '    ports:',
            `      - "127.0.0.1:${rpcBasePort + i}:8545"`,
            '    networks:',
            '      besu_net:',
            `        ipv4_address: ${ip}`,
            ''
        );
    });
    lines.push(
        'networks:',
        '  besu_net:',
        '    driver: bridge',
        '    ipam:',
        '      config:',
        `        - subnet: ${SUBNET_PREFIX}.0/24`,
        ''
    );
    return lines.join('\n');
}

function rpcUrls(nodes, rpcBasePort) {
    return Array.from({ length: nodes }, (_, i) => `http://127.0.0.1:${rpcBasePort + i}`);
}

/** Byzantine fault tolerance of an n-validator network: f = floor((n - 1) / 3). */
function faultTolerance(n) {
    return Math.floor((n - 1) / 3);
}

module.exports = {
    CONSENSUS,
    MAX_NODES,
    nodeIp,
    buildGeneratorConfig,
    buildStaticNodes,
    renderCompose,
    rpcUrls,
    faultTolerance,
};
