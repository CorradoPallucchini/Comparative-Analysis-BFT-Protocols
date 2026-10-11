'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseOptions } = require('../src/cli');

const SPECS = {
    'nodes': { type: 'int', min: 1, max: 10, default: 4 },
    'consensus': { type: 'enum', values: ['qbft', 'ibft2'], default: 'qbft' },
    'rate': { type: 'float', min: 0, env: 'RATE', default: 0 },
    'rpc': { type: 'list', env: 'RPC_URL' },
    'no-save': { type: 'bool', default: false },
};

test('uses defaults when nothing is given', () => {
    assert.deepStrictEqual(parseOptions(SPECS, [], {}), { nodes: 4, consensus: 'qbft', rate: 0, rpc: undefined, 'no-save': false });
});

test('accepts "--name value", "--name=value" and bare flags', () => {
    const o = parseOptions(SPECS, ['--nodes', '7', '--consensus=IBFT2', '--no-save'], {});
    assert.strictEqual(o.nodes, 7);
    assert.strictEqual(o.consensus, 'ibft2');
    assert.strictEqual(o['no-save'], true);
});

test('command line wins over environment, environment over default', () => {
    assert.strictEqual(parseOptions(SPECS, [], { RATE: '50' }).rate, 50);
    assert.strictEqual(parseOptions(SPECS, ['--rate', '10'], { RATE: '50' }).rate, 10);
    assert.deepStrictEqual(parseOptions(SPECS, [], { RPC_URL: 'http://a, http://b' }).rpc, ['http://a', 'http://b']);
});

test('rejects invalid values and unknown options', () => {
    assert.throws(() => parseOptions(SPECS, ['--consensus', 'pbft'], {}), /must be one of/);
    assert.throws(() => parseOptions(SPECS, ['--nodes', 'four'], {}), /must be an integer/);
    assert.throws(() => parseOptions(SPECS, ['--nodes', '11'], {}), /<= 10/);
    assert.throws(() => parseOptions(SPECS, ['--node', '3'], {}), /Unknown option/);
    assert.throws(() => parseOptions(SPECS, ['4'], {}), /positional/);
});

test('--help short-circuits validation', () => {
    assert.deepStrictEqual(parseOptions(SPECS, ['--help', '--bogus'], {}), { help: true });
});
