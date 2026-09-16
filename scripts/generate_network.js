const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
function getArg(name, defaultValue) {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const nodeCount = parseInt(getArg('--nodes', '4'), 10);
const consensus = getArg('--consensus', 'qbft'); // qbft or ibft2
const blockPeriod = parseInt(getArg('--block-period', '1'), 10);

console.log(`\n⚙️  Generating BFT Network:`);
console.log(`- Nodes: ${nodeCount}`);
console.log(`- Consensus: ${consensus.toUpperCase()}`);
console.log(`- Block Period: ${blockPeriod}s\n`);

const rootDir = path.resolve(__dirname, '..');
const configDir = path.join(rootDir, 'config');
const networkFilesDir = path.join(configDir, 'networkFiles');

if (fs.existsSync(networkFilesDir)) {
    fs.rmSync(networkFilesDir, { recursive: true, force: true });
}
fs.mkdirSync(networkFilesDir, { recursive: true });

// Pre-funded test accounts
const fundedAccounts = {
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266": { "balance": "0x1000000000000000000000000000000000000000000000000000000000000000" },
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8": { "balance": "0x1000000000000000000000000000000000000000000000000000000000000000" },
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC": { "balance": "0x1000000000000000000000000000000000000000000000000000000000000000" },
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906": { "balance": "0x1000000000000000000000000000000000000000000000000000000000000000" },
    "0xE483B25EBf35F3551C525a8FDbBeE10E4b2C23C8": { "balance": "0x1000000000000000000000000000000000000000000000000000000000000000" },
    "0x5D3f5BC433281a81aA7eC81Ee34607f4Af1f5f81": { "balance": "0x1000000000000000000000000000000000000000000000000000000000000000" }
};

const consensusConfig = {};
if (consensus === 'qbft') {
    consensusConfig.qbft = {
        blockperiodseconds: blockPeriod,
        epochlength: 30000,
        requesttimeoutseconds: 4
    };
} else {
    consensusConfig.ibft2 = {
        blockperiodseconds: blockPeriod,
        epochlength: 30000,
        requesttimeoutseconds: 4
    };
}

const besuConfig = {
    genesis: {
        nonce: "0x0",
        timestamp: "0x58ee40ba",
        gasLimit: "0x1fffffffffffff",
        difficulty: "0x1",
        mixHash: "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
        coinbase: "0x0000000000000000000000000000000000000000",
        config: {
            chainId: 1337,
            londonBlock: 0,
            ...consensusConfig
        },
        alloc: fundedAccounts
    },
    blockchain: {
        nodes: {
            generate: true,
            count: nodeCount
        }
    }
};

const configFile = path.join(configDir, 'generatorConfig.json');
fs.writeFileSync(configFile, JSON.stringify(besuConfig, null, 2));

console.log('📦 Running official Besu operator to generate genesis and keys...');
const dockerCmd = `docker run --rm --entrypoint /bin/bash -v "${configDir}":/opt/besu/config hyperledger/besu:latest -c "besu operator generate-blockchain-config --config-file=/opt/besu/config/generatorConfig.json --to=/tmp/out --private-key-file-name=key && cp -r /tmp/out/* /opt/besu/config/networkFiles/"`;
execSync(dockerCmd, { stdio: 'inherit' });

fs.unlinkSync(configFile);

const keysDir = path.join(networkFilesDir, 'keys');
const validatorDirs = fs.readdirSync(keysDir).filter(f => fs.statSync(path.join(keysDir, f)).isDirectory());

if (validatorDirs.length !== nodeCount) {
    throw new Error(`Expected ${nodeCount} keys but found ${validatorDirs.length}`);
}

const staticNodes = [];
const nodeKeyMap = [];

validatorDirs.forEach((dirName, index) => {
    const pubKeyPath = path.join(keysDir, dirName, 'key.pub');
    let pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
    if (pubKey.startsWith('0x')) pubKey = pubKey.substring(2);
    
    const ip = `172.16.239.${10 + index}`;
    const enode = `enode://${pubKey}@${ip}:30303`;
    staticNodes.push(enode);
    
    nodeKeyMap.push({
        index: index + 1,
        address: dirName,
        ip: ip,
        keyDir: `keys/${dirName}`
    });
});

fs.writeFileSync(path.join(networkFilesDir, 'static-nodes.json'), JSON.stringify(staticNodes, null, 2));
console.log(`✅ Created static-nodes.json with ${staticNodes.length} enodes.`);

console.log('🐳 Generating docker-compose.yaml...');
let composeServices = {};

nodeKeyMap.forEach((node) => {
    const serviceName = `node${node.index}`;
    const isPrimaryRpc = node.index === 1;
    
    composeServices[serviceName] = {
        image: 'hyperledger/besu:latest',
        container_name: `bft_${serviceName}`,
        restart: 'unless-stopped',
        volumes: [
            './config/networkFiles:/config/networkFiles'
        ],
        command: [
            `--data-path=/opt/besu/data`,
            `--genesis-file=/config/networkFiles/genesis.json`,
            `--node-private-key-file=/config/networkFiles/${node.keyDir}/key`,
            `--rpc-http-enabled=true`,
            `--rpc-http-api=ETH,NET,${consensus.toUpperCase()},WEB3`,
            `--rpc-http-host=0.0.0.0`,
            `--rpc-http-port=8545`,
            `--rpc-http-cors-origins=*`,
            `--p2p-host=${node.ip}`,
            `--p2p-port=30303`,
            `--static-nodes-file=/config/networkFiles/static-nodes.json`
        ].join(' '),
        networks: {
            besu_net: {
                ipv4_address: node.ip
            }
        }
    };
    
    if (isPrimaryRpc) {
        composeServices[serviceName].ports = ["8545:8545"];
    }
});

const dockerCompose = {
    version: '3.8',
    services: composeServices,
    networks: {
        besu_net: {
            driver: 'bridge',
            ipam: {
                config: [
                    { subnet: '172.16.239.0/24' }
                ]
            }
        }
    }
};

const yamlContent = [
  "services:",
  ...Object.entries(composeServices).map(([name, s]) => {
    let out = `  ${name}:\n    image: ${s.image}\n    container_name: ${s.container_name}\n    restart: ${s.restart}\n    volumes:\n      - ./config/networkFiles:/config/networkFiles\n    command: >\n      ${s.command}\n    networks:\n      besu_net:\n        ipv4_address: ${s.networks.besu_net.ipv4_address}`;
    if (s.ports) {
      out += `\n    ports:\n      - "${s.ports[0]}"`;
    }
    return out;
  }),
  "\nnetworks:\n  besu_net:\n    driver: bridge\n    ipam:\n      config:\n        - subnet: 172.16.239.0/24\n"
].join('\n\n');

fs.writeFileSync(path.join(rootDir, 'docker-compose.yaml'), yamlContent);
console.log('✅ Generated docker-compose.yaml successfully!\n');
console.log('🎉 Setup complete! You can now run:\n   docker compose up -d\n');
