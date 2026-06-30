import { PureBitcoinSwap } from '../src/lib/PureBitcoinSwap';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory, ECPairAPI } from 'ecpair';
import axios from 'axios';

// Initialize ECPair API
bitcoin.initEccLib(ecc);
const ECPair: ECPairAPI = ECPairFactory(ecc);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to compute Taproot Tapleaf Hash
function tapleafHash(script: any): Buffer {
    const scriptBuffer = Buffer.from(script);
    const prefix = Buffer.concat([
        Buffer.from([0xc0]), // leafVersion
        Buffer.from([scriptBuffer.length]), // compact size
        scriptBuffer
    ]);
    return Buffer.from(bitcoin.crypto.taggedHash('TapLeaf', prefix));
}

// Helper to mathematically calculate the Taproot Tweaked Keypair (including odd y-parity negation)
function getTweakedKeyPair(keyPair: any, merkleRoot: Buffer): any {
    const xOnlyKey = PureBitcoinSwap.getXOnlyPubKey(Buffer.from(keyPair.publicKey));
    const tweak = Buffer.from(bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([xOnlyKey, merkleRoot])));
    
    const isOdd = keyPair.publicKey[0] === 0x03;
    let privKeyBuffer = Buffer.from(keyPair.privateKey);
    if (isOdd) {
        const curveOrder = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
        const privInt = BigInt('0x' + privKeyBuffer.toString('hex'));
        const negatedInt = curveOrder - privInt;
        let negatedHex = negatedInt.toString(16);
        while (negatedHex.length < 64) negatedHex = '0' + negatedHex;
        privKeyBuffer = Buffer.from(negatedHex, 'hex');
    }
    
    const tweakedPrivateKeyBuffer = ecc.privateAdd(privKeyBuffer, tweak)!;
    return ECPair.fromPrivateKey(Buffer.from(tweakedPrivateKeyBuffer), { network: bitcoin.networks.regtest });
}

class BitcoinRpc {
    private url: string;
    constructor(port: number) {
        this.url = `http://user:password@127.0.0.1:${port}/`;
    }

    async call(method: string, params: any[] = []): Promise<any> {
        try {
            const response = await axios.post(this.url, {
                jsonrpc: '1.0',
                id: 'regtest',
                method,
                params
            }, {
                headers: { 'Content-Type': 'application/json' }
            });
            return response.data.result;
        } catch (err: any) {
            if (err.response && err.response.data && err.response.data.error) {
                throw new Error(`RPC Error [${method}]: ${err.response.data.error.message}`);
            }
            throw new Error(`RPC Error [${method}]: ${err.message}`);
        }
    }
}

const mainRpc = new BitcoinRpc(18443);
const bip110Rpc = new BitcoinRpc(18444);

async function setupWallet(rpc: BitcoinRpc) {
    try {
        await rpc.call('createwallet', ['miner']);
        console.log("   - Created new wallet 'miner'");
    } catch (err: any) {
        if (err.message.includes('already exists')) {
            console.log("   - Wallet 'miner' already loaded.");
        } else {
            throw err;
        }
    }
}

// Find output index of a given target scriptPubKey hex
async function findOutputIndex(rpc: BitcoinRpc, txid: string, targetScriptHex: string): Promise<number> {
    const rawTx = await rpc.call('getrawtransaction', [txid, true]);
    for (let i = 0; i < rawTx.vout.length; i++) {
        if (rawTx.vout[i].scriptPubKey.hex === targetScriptHex) {
            return i;
        }
    }
    throw new Error(`Could not find output index for script: ${targetScriptHex}`);
}

async function runFullSwapTest() {
    console.log("🚀 Starting Full Double-Sided Replay-Protected Atomic Swap Integration Test...");

    // 1. Wallets setup
    console.log("\n1. Setting up miner wallets...");
    await setupWallet(mainRpc);
    await setupWallet(bip110Rpc);

    // 2. Connect via P2P
    console.log("\n2. Connecting Main-Chain node to BIP110 node...");
    try {
        await mainRpc.call('addnode', ['bitcoind-bip110:18444', 'add']);
        await sleep(2000);
    } catch {}

    // 3. Shared ancestry blocks 1-110
    console.log("\n3. Mining 110 blocks of shared history...");
    const sharedMinerAddr = await mainRpc.call('getnewaddress');
    await mainRpc.call('generatetoaddress', [110, sharedMinerAddr]);

    let heightMain = 110;
    let heightBip110 = 0;
    for (let i = 0; i < 10; i++) {
        heightMain = await mainRpc.call('getblockcount');
        heightBip110 = await bip110Rpc.call('getblockcount');
        if (heightMain === heightBip110) break;
        await sleep(1000);
    }
    console.log(`   - Main Height: ${heightMain}, BIP110 Height: ${heightBip110}`);

    // 4. Generate Swap parameters
    const initiator = PureBitcoinSwap.generateKeyPair();
    const acceptor = PureBitcoinSwap.generateKeyPair();
    const preimageStr = 'regtest-atomic-swap-preimage-proof';
    const preimage = Buffer.from(preimageStr, 'utf8');
    const hashLock = PureBitcoinSwap.computeHashLock(preimageStr);
    const lockTime = 2000;

    // 5. Fund Split Contract Outputs (Block 101)
    console.log("\n4. Funding the Split contract addresses for both Initiator and Acceptor...");
    const initSplitScript = PureBitcoinSwap.createSplitScript(Buffer.from(initiator.publicKey));
    const initSplitPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(initiator.publicKey)),
        scriptTree: { output: initSplitScript },
        redeem: { output: initSplitScript, redeemVersion: 0xc0 },
        network: bitcoin.networks.regtest
    });
    const initSplitAddr = initSplitPayment.address!;

    const accSplitScript = PureBitcoinSwap.createSplitScript(Buffer.from(acceptor.publicKey));
    const accSplitPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(acceptor.publicKey)),
        scriptTree: { output: accSplitScript },
        redeem: { output: accSplitScript, redeemVersion: 0xc0 },
        network: bitcoin.networks.regtest
    });
    const accSplitAddr = accSplitPayment.address!;

    console.log(`   - Initiator Split Addr: ${initSplitAddr}`);
    console.log(`   - Acceptor Split Addr : ${accSplitAddr}`);

    const initFundTxid = await mainRpc.call('sendtoaddress', [initSplitAddr, 10.0]);
    const accFundTxid = await mainRpc.call('sendtoaddress', [accSplitAddr, 10.0]);

    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    
    // Wait for the block counts to synchronize over P2P before severing
    let heightMain2 = 0;
    let heightBip1102 = 0;
    for (let i = 0; i < 10; i++) {
        heightMain2 = await mainRpc.call('getblockcount');
        heightBip1102 = await bip110Rpc.call('getblockcount');
        if (heightMain2 === heightBip1102) break;
        await sleep(1000);
    }
    console.log(`   - Height post-funding - Main: ${heightMain2}, BIP110: ${heightBip1102}`);
    console.log(`   - Block 101 Mined. Initiator Funded: ${initFundTxid}. Acceptor Funded: ${accFundTxid}`);

    // 6. Trigger Fork (Sever P2P connection)
    console.log("\n5. Disconnecting nodes to trigger network fork split...");
    try {
        await mainRpc.call('disconnectnode', ['bitcoind-bip110:18444']);
        console.log("   - Nodes severed.");
    } catch {}

    // ----------------------------------------------------------------
    // Setup 6: Execute the Splits
    // ----------------------------------------------------------------
    console.log("\n6. Splitting coins on both Chains...");

    // Main-Chain Splits (OP_IF Scriptpath Spends)
    const initSplitOutIdxMain = await findOutputIndex(mainRpc, initFundTxid, Buffer.from(initSplitPayment.output!).toString('hex'));
    const accSplitOutIdxMain = await findOutputIndex(mainRpc, accFundTxid, Buffer.from(accSplitPayment.output!).toString('hex'));

    // Offline Split Destinations (P2TR Keypath Addresses)
    const initSplitDestPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(initiator.publicKey)),
        network: bitcoin.networks.regtest
    });
    const initSplitDestAddr = initSplitDestPayment.address!;

    const accSplitDestPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(acceptor.publicKey)),
        network: bitcoin.networks.regtest
    });
    const accSplitDestAddr = accSplitDestPayment.address!;

    // Build Initiator Main-Chain Split Spend
    const initMainSplitTx = new bitcoin.Transaction();
    initMainSplitTx.version = 2;
    initMainSplitTx.addInput(Buffer.from(initFundTxid, 'hex').reverse(), initSplitOutIdxMain);
    initMainSplitTx.addOutput(bitcoin.address.toOutputScript(initSplitDestAddr, bitcoin.networks.regtest), 999000000n);

    const initLeafHash = tapleafHash(initSplitScript);
    const initSighashMain = initMainSplitTx.hashForWitnessV1(
        0, [initSplitPayment.output!], [1000000000n], bitcoin.Transaction.SIGHASH_DEFAULT, initLeafHash
    );
    const initSigMain = Buffer.from(initiator.signSchnorr(initSighashMain));
    initMainSplitTx.setWitness(0, [initSigMain, Buffer.alloc(0), initSplitScript, initSplitPayment.witness![1]]);

    // Build Acceptor Main-Chain Split Spend
    const accMainSplitTx = new bitcoin.Transaction();
    accMainSplitTx.version = 2;
    accMainSplitTx.addInput(Buffer.from(accFundTxid, 'hex').reverse(), accSplitOutIdxMain);
    accMainSplitTx.addOutput(bitcoin.address.toOutputScript(accSplitDestAddr, bitcoin.networks.regtest), 999000000n);

    const accLeafHash = tapleafHash(accSplitScript);
    const accSighashMain = accMainSplitTx.hashForWitnessV1(
        0, [accSplitPayment.output!], [1000000000n], bitcoin.Transaction.SIGHASH_DEFAULT, accLeafHash
    );
    const accSigMain = Buffer.from(acceptor.signSchnorr(accSighashMain));
    accMainSplitTx.setWitness(0, [accSigMain, Buffer.alloc(0), accSplitScript, accSplitPayment.witness![1]]);

    // Broadcast both to Main-Chain
    const initSplitTxidMain = await mainRpc.call('sendrawtransaction', [initMainSplitTx.toHex()]);
    const accSplitTxidMain = await mainRpc.call('sendrawtransaction', [accMainSplitTx.toHex()]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    console.log(`   - Main-Chain Block 102 Mined. Initiator Split UTXO: ${initSplitTxidMain}. Acceptor Split UTXO: ${accSplitTxidMain}`);

    // BIP110-Chain Splits (Keypath Schnorr Spends via Psbt for automatic parity handling)
    const initSplitOutIdxBip110 = await findOutputIndex(bip110Rpc, initFundTxid, Buffer.from(initSplitPayment.output!).toString('hex'));
    const accSplitOutIdxBip110 = await findOutputIndex(bip110Rpc, accFundTxid, Buffer.from(accSplitPayment.output!).toString('hex'));

    // Create mathematically perfect tweaked keypairs ready for Schnorr signing
    const initTweakedPair = getTweakedKeyPair(initiator, initLeafHash);
    const accTweakedPair = getTweakedKeyPair(acceptor, accLeafHash);

    // Build Initiator BIP110 Keypath Split Spend
    const initBip110SplitTx = new bitcoin.Transaction();
    initBip110SplitTx.version = 2;
    initBip110SplitTx.addInput(Buffer.from(initFundTxid, 'hex').reverse(), initSplitOutIdxBip110);
    initBip110SplitTx.addOutput(bitcoin.address.toOutputScript(initSplitDestAddr, bitcoin.networks.regtest), 999000000n);

    // Calculate sighash for BIP110 Keypath spend
    const initSighashBip110 = initBip110SplitTx.hashForWitnessV1(
        0, [initSplitPayment.output!], [1000000000n], bitcoin.Transaction.SIGHASH_DEFAULT
    );
    const initSigBip110 = Buffer.from(initTweakedPair.signSchnorr(initSighashBip110));
    initBip110SplitTx.setWitness(0, [initSigBip110]);

    // Build Acceptor BIP110 Keypath Split Spend
    const accBip110SplitTx = new bitcoin.Transaction();
    accBip110SplitTx.version = 2;
    accBip110SplitTx.addInput(Buffer.from(accFundTxid, 'hex').reverse(), accSplitOutIdxBip110);
    accBip110SplitTx.addOutput(bitcoin.address.toOutputScript(accSplitDestAddr, bitcoin.networks.regtest), 999000000n);

    // Calculate sighash for BIP110 Keypath spend
    const accSighashBip110 = accBip110SplitTx.hashForWitnessV1(
        0, [accSplitPayment.output!], [1000000000n], bitcoin.Transaction.SIGHASH_DEFAULT
    );
    const accSigBip110 = Buffer.from(accTweakedPair.signSchnorr(accSighashBip110));
    accBip110SplitTx.setWitness(0, [accSigBip110]);

    // Broadcast both to BIP110-Chain
    const initSplitTxidBip110 = await bip110Rpc.call('sendrawtransaction', [initBip110SplitTx.toHex()]);
    const accSplitTxidBip110 = await bip110Rpc.call('sendrawtransaction', [accBip110SplitTx.toHex()]);
    const minerAddrBip110 = await bip110Rpc.call('getnewaddress');
    await bip110Rpc.call('generatetoaddress', [1, minerAddrBip110]);
    console.log(`   - BIP110-Chain Block 102 Mined. Initiator Split UTXO: ${initSplitTxidBip110}. Acceptor Split UTXO: ${accSplitTxidBip110}`);

    // ----------------------------------------------------------------
    // Setup 7: Fund the HTLCs using ONLY the Split Outputs (Replay Safe)
    // ----------------------------------------------------------------
    console.log("\n7. Funding the HTLCs using ONLY the Split Outputs...");

    // A. BIP110-Chain HTLC (funded by Initiator's split output)
    const initSplitDestScriptHexBip110 = Buffer.from(bitcoin.address.toOutputScript(initSplitDestAddr, bitcoin.networks.regtest)).toString('hex');
    const initSplitOutIdxBip110Tx = await findOutputIndex(bip110Rpc, initSplitTxidBip110, initSplitDestScriptHexBip110);

    const htlcBip110 = PureBitcoinSwap.createTaprootHtlc(
        Buffer.from(initiator.publicKey), // internal aggregator (mock)
        hashLock,
        Buffer.from(acceptor.publicKey), // recipient
        Buffer.from(initiator.publicKey), // refund owner
        lockTime,
        bitcoin.networks.regtest
    );
    const htlcBip110Addr = htlcBip110.address!;
    console.log(`   - BIP110-Chain HTLC Address: ${htlcBip110Addr}`);

    const htlcFundTxBip110 = new bitcoin.Transaction();
    htlcFundTxBip110.version = 2;
    htlcFundTxBip110.addInput(Buffer.from(initSplitTxidBip110, 'hex').reverse(), initSplitOutIdxBip110Tx);
    htlcFundTxBip110.addOutput(bitcoin.address.toOutputScript(htlcBip110Addr, bitcoin.networks.regtest), 998000000n); // 9.98 BTC

    // Sign the funding spend (P2TR Keypath spend with empty tweak for pure Keypath output)
    const spendSighashBip110 = htlcFundTxBip110.hashForWitnessV1(
        0, [initSplitDestPayment.output!], [999000000n], bitcoin.Transaction.SIGHASH_DEFAULT
    );
    const initSplitTweakedPair = getTweakedKeyPair(initiator, Buffer.alloc(0));
    const spendSigBip110 = Buffer.from(initSplitTweakedPair.signSchnorr(spendSighashBip110));
    htlcFundTxBip110.setWitness(0, [spendSigBip110]);

    const htlcFundTxidBip110 = await bip110Rpc.call('sendrawtransaction', [htlcFundTxBip110.toHex()]);
    await bip110Rpc.call('generatetoaddress', [1, minerAddrBip110]);
    console.log(`   - BIP110 HTLC Funded. TxID: ${htlcFundTxidBip110}`);


    // B. Main-Chain HTLC (funded by Acceptor's split output)
    const accSplitDestScriptHexMain = Buffer.from(bitcoin.address.toOutputScript(accSplitDestAddr, bitcoin.networks.regtest)).toString('hex');
    const accSplitOutIdxMainTx = await findOutputIndex(mainRpc, accSplitTxidMain, accSplitDestScriptHexMain);

    const htlcMain = PureBitcoinSwap.createTaprootHtlc(
        Buffer.from(acceptor.publicKey), // internal aggregator (mock)
        hashLock,
        Buffer.from(initiator.publicKey), // recipient
        Buffer.from(acceptor.publicKey), // refund owner
        Math.round(lockTime / 2), // T/2
        bitcoin.networks.regtest
    );
    const htlcMainAddr = htlcMain.address!;
    console.log(`   - Main-Chain HTLC Address: ${htlcMainAddr}`);

    const htlcFundTxMain = new bitcoin.Transaction();
    htlcFundTxMain.version = 2;
    htlcFundTxMain.addInput(Buffer.from(accSplitTxidMain, 'hex').reverse(), accSplitOutIdxMainTx);
    htlcFundTxMain.addOutput(bitcoin.address.toOutputScript(htlcMainAddr, bitcoin.networks.regtest), 998000000n); // 9.98 BTC

    // Sign the funding spend (P2TR Keypath spend with empty tweak for pure Keypath output)
    const spendSighashMain = htlcFundTxMain.hashForWitnessV1(
        0, [accSplitDestPayment.output!], [999000000n], bitcoin.Transaction.SIGHASH_DEFAULT
    );
    const accSplitTweakedPair = getTweakedKeyPair(acceptor, Buffer.alloc(0));
    const spendSigMain = Buffer.from(accSplitTweakedPair.signSchnorr(spendSighashMain));
    htlcFundTxMain.setWitness(0, [spendSigMain]);

    const htlcFundTxidMain = await mainRpc.call('sendrawtransaction', [htlcFundTxMain.toHex()]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    console.log(`   - Main-Chain HTLC Funded. TxID: ${htlcFundTxidMain}`);

    // ----------------------------------------------------------------
    // Setup 8: Executing the Atomic Swap Claims
    // ----------------------------------------------------------------
    console.log("\n8. Executing the Atomic Swap Claims...");

    // A. Initiator Claims on Main-Chain (Reveals Preimage)
    const htlcMainOutIdx = await findOutputIndex(mainRpc, htlcFundTxidMain, Buffer.from(htlcMain.output!).toString('hex'));

    const claimScriptMain = PureBitcoinSwap.createHtlcClaimScript(hashLock, Buffer.from(initiator.publicKey));
    const leafHashMain = tapleafHash(claimScriptMain);

    const claimTxMain = new bitcoin.Transaction();
    claimTxMain.version = 2;
    claimTxMain.addInput(Buffer.from(htlcFundTxidMain, 'hex').reverse(), htlcMainOutIdx);

    const initiatorClaimWalletAddr = await mainRpc.call('getnewaddress');
    claimTxMain.addOutput(bitcoin.address.toOutputScript(initiatorClaimWalletAddr, bitcoin.networks.regtest), 997000000n);

    const claimSighashMain = claimTxMain.hashForWitnessV1(
        0, [htlcMain.output!], [998000000n], bitcoin.Transaction.SIGHASH_DEFAULT, leafHashMain
    );
    const claimSigMain = Buffer.from(initiator.signSchnorr(claimSighashMain));

    // Decode target p2tr object's witness parameters
    // In p2tr with multiple leaves, we retrieve the controlBlock corresponding to the correct leaf!
    // Since we constructed p2tr using the scriptTree of [claimLeaf, refundLeaf]:
    const claimLeafInfoMain = { output: claimScriptMain };
    const refundScriptMain = PureBitcoinSwap.createHtlcRefundScript(Buffer.from(acceptor.publicKey), Math.round(lockTime / 2));
    const refundLeafInfoMain = { output: refundScriptMain };

    const claimPaymentMain = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(acceptor.publicKey)),
        scriptTree: [claimLeafInfoMain, refundLeafInfoMain] as any,
        redeem: {
            output: claimScriptMain,
            redeemVersion: 0xc0
        },
        network: bitcoin.networks.regtest
    });

    const controlBlockMain = claimPaymentMain.witness![1];

    claimTxMain.setWitness(0, [
        claimSigMain,
        preimage, // The secret preimage 's'
        claimScriptMain,
        controlBlockMain
    ]);

    const claimTxidMain = await mainRpc.call('sendrawtransaction', [claimTxMain.toHex()]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    console.log(`   - Main-Chain HTLC Claimed successfully! Preimage revealed in TxID: ${claimTxidMain}`);

    // B. Acceptor Extracts Preimage and Claims on BIP110-Chain
    // Read the claim transaction from the main node to extract the preimage
    const rawClaimTxMain = await mainRpc.call('getrawtransaction', [claimTxidMain, true]);
    const revealedPreimageHex = rawClaimTxMain.vin[0].txinwitness[1];
    const extractedPreimage = Buffer.from(revealedPreimageHex, 'hex');
    console.log(`   - Acceptor extracted Preimage 's': "${extractedPreimage.toString('utf8')}"`);

    // Now claim the BIP110 HTLC
    const htlcBip110OutIdx = await findOutputIndex(bip110Rpc, htlcFundTxidBip110, Buffer.from(htlcBip110.output!).toString('hex'));

    const claimScriptBip110 = PureBitcoinSwap.createHtlcClaimScript(hashLock, Buffer.from(acceptor.publicKey));
    const leafHashBip110 = tapleafHash(claimScriptBip110);

    const claimTxBip110 = new bitcoin.Transaction();
    claimTxBip110.version = 2;
    claimTxBip110.addInput(Buffer.from(htlcFundTxidBip110, 'hex').reverse(), htlcBip110OutIdx);

    const acceptorClaimWalletAddr = await bip110Rpc.call('getnewaddress');
    claimTxBip110.addOutput(bitcoin.address.toOutputScript(acceptorClaimWalletAddr, bitcoin.networks.regtest), 997000000n);

    const claimSighashBip110 = claimTxBip110.hashForWitnessV1(
        0, [htlcBip110.output!], [998000000n], bitcoin.Transaction.SIGHASH_DEFAULT, leafHashBip110
    );
    const claimSigBip110 = Buffer.from(acceptor.signSchnorr(claimSighashBip110));

    // Construct the p2tr payment with claimLeaf and refundLeaf to get the correct control block
    const refundScriptBip110 = PureBitcoinSwap.createHtlcRefundScript(Buffer.from(initiator.publicKey), lockTime);
    const claimLeafInfoBip110 = { output: claimScriptBip110 };
    const refundLeafInfoBip110 = { output: refundScriptBip110 };

    const claimPaymentBip110 = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(initiator.publicKey)),
        scriptTree: [claimLeafInfoBip110, refundLeafInfoBip110] as any,
        redeem: {
            output: claimScriptBip110,
            redeemVersion: 0xc0
        },
        network: bitcoin.networks.regtest
    });

    const controlBlockBip110 = claimPaymentBip110.witness![1];

    claimTxBip110.setWitness(0, [
        claimSigBip110,
        extractedPreimage,
        claimScriptBip110,
        controlBlockBip110
    ]);

    const claimTxidBip110 = await bip110Rpc.call('sendrawtransaction', [claimTxBip110.toHex()]);
    await bip110Rpc.call('generatetoaddress', [1, minerAddrBip110]);
    console.log(`   - BIP110-Chain HTLC Claimed successfully! TxID: ${claimTxidBip110}`);

    console.log("\n==================================================");
    console.log("🎉 COMPLETE REPLAY-PROTECTED ATOMIC SWAP SUCCESSFUL!");
    console.log("==================================================");
}

runFullSwapTest().catch(err => {
    console.error(`❌ Swap Test Failed: ${err.message}`);
    process.exit(1);
});
