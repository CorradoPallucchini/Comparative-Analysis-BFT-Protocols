'use strict';

const { HDNodeWallet, Mnemonic } = require('ethers');

/**
 * Well-known test mnemonic (the Hardhat/Anvil default). Its first six
 * accounts are the ones the original setup funded, so older genesis files
 * stay compatible. NEVER use it outside a local test network.
 */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

/** Derive `count` wallets along m/44'/60'/0'/0/i. */
function deriveWallets(count, mnemonic = TEST_MNEMONIC) {
    const root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(mnemonic), "m/44'/60'/0'/0");
    const wallets = [];
    for (let i = 0; i < count; i++) {
        wallets.push(root.deriveChild(i));
    }
    return wallets;
}

module.exports = { TEST_MNEMONIC, deriveWallets };
