'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildGeneratorConfig, buildStaticNodes, renderCompose, rpcUrls, faultTolerance } = require('../src/network');

const validators = [
    { address: '0xaaa', publicKey: '0x' + '11'.repeat(64) },
    { address: '0xbbb', publicKey: '22'.repeat(64) },
];

test('genesis uses the consensus-specific key', () => {
    for (const consensus of ['qbft', 'ibft2']) {
        const cfg = buildGeneratorConfig({ consensus, nodes: 4, blockPeriod: 2, requestTimeout: 4, chainId: 1337, fundedAddresses: ['0x01'] });
        assert.deepStrictEqual(cfg.genesis.config[consensus], { blockperiodseconds: 2, epochlength: 30000, requesttimeoutseconds: 4 });
        assert.strictEqual(cfg.blockchain.nodes.count, 4);
        assert.ok(cfg.genesis.alloc['0x01'].balance);
    }
});

test('static nodes point at the fixed container IPs', () => {
    assert.deepStrictEqual(buildStaticNodes(validators), [
        `enode://${'11'.repeat(64)}@172.16.239.10:30303`,
        `enode://${'22'.repeat(64)}@172.16.239.11:30303`,
    ]);
});

test('IBFT 2.0 nodes enable the IBFT JSON-RPC namespace (IBFT2 is rejected by Besu)', () => {
    const yaml = renderCompose({ consensus: 'ibft2', besuImage: 'hyperledger/besu:1.0', rpcBasePort: 8545, txPoolMaxFutureBySender: 500, validators });
    assert.match(yaml, /--rpc-http-api=ETH,NET,WEB3,TXPOOL,IBFT"/);
    assert.doesNotMatch(yaml, /IBFT2/);
});

test('compose pins the image and exposes one RPC port per node on localhost', () => {
    const yaml = renderCompose({ consensus: 'qbft', besuImage: 'hyperledger/besu:1.0', rpcBasePort: 9000, txPoolMaxFutureBySender: 500, validators });
    assert.strictEqual((yaml.match(/image: hyperledger\/besu:1\.0/g) || []).length, 2);
    assert.match(yaml, /"127\.0\.0\.1:9000:8545"/);
    assert.match(yaml, /"127\.0\.0\.1:9001:8545"/);
    assert.match(yaml, /keys\/0xbbb\/key"/);
    assert.match(yaml, /--rpc-http-api=ETH,NET,WEB3,TXPOOL,QBFT"/);
    assert.deepStrictEqual(rpcUrls(2, 9000), ['http://127.0.0.1:9000', 'http://127.0.0.1:9001']);
});

test('fault tolerance follows n >= 3f + 1', () => {
    assert.deepStrictEqual([1, 3, 4, 6, 7, 10].map(faultTolerance), [0, 0, 1, 1, 2, 3]);
});
