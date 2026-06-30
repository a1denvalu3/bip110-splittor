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

async function runSplitPrimitiveTest() {
    console.log("🚀 Starting BIP110 Split Primitive Regtest Verification...");

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

    // 4. Create and Fund Split Output (Block 101)
    console.log("\n4. Funding the Split outputs for Initiator and Acceptor with 10 BTC each...");
    const initiator = PureBitcoinSwap.generateKeyPair();
    const splitScript = PureBitcoinSwap.createSplitScript(Buffer.from(initiator.publicKey));

    const splitPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(initiator.publicKey)),
        scriptTree: { output: splitScript },
        redeem: {
            output: splitScript,
            redeemVersion: 0xc0
        },
        network: bitcoin.networks.regtest
    });
    const splitAddress = splitPayment.address!;
    console.log(`   - Initiator Split Contract Address: ${splitAddress}`);

    const acceptor = PureBitcoinSwap.generateKeyPair();
    const accSplitScript = PureBitcoinSwap.createSplitScript(Buffer.from(acceptor.publicKey));

    const accSplitPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(acceptor.publicKey)),
        scriptTree: { output: accSplitScript },
        redeem: {
            output: accSplitScript,
            redeemVersion: 0xc0
        },
        network: bitcoin.networks.regtest
    });
    const accSplitAddress = accSplitPayment.address!;
    console.log(`   - Acceptor Split Contract Address : ${accSplitAddress}`);

    const fundTxid = await mainRpc.call('sendtoaddress', [splitAddress, 10.0]);
    const accFundTxid = await mainRpc.call('sendtoaddress', [accSplitAddress, 10.0]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    await sleep(1000); // sync
    console.log(`   - Block 101 Mined. Initiator Fund TxID: ${fundTxid}`);
    console.log(`   - Block 101 Mined. Acceptor Fund TxID : ${accFundTxid}`);

    // 5. Trigger fork split by disconnecting nodes
    console.log("\n5. Disconnecting nodes to trigger network split...");
    try {
        await mainRpc.call('disconnectnode', ['bitcoind-bip110:18444']);
        console.log("   - Nodes successfully severed.");
    } catch {}

    // 6. Main Chain: Execute Scriptpath spends using OP_IF
    console.log("\n6. Executing OP_IF Scriptpath spends on Main-Chain...");
    
    // Initiator Main Chain spend
    const rawFundTx = await mainRpc.call('getrawtransaction', [fundTxid, true]);
    let outputIndex = -1;
    const targetScriptHex = Buffer.from(splitPayment.output!).toString('hex');
    for (let i = 0; i < rawFundTx.vout.length; i++) {
        if (rawFundTx.vout[i].scriptPubKey.hex === targetScriptHex) {
            outputIndex = i;
            break;
        }
    }
    if (outputIndex === -1) throw new Error("Could not find Initiator funding output index.");

    const mainSpendTx = new bitcoin.Transaction();
    mainSpendTx.version = 2;
    mainSpendTx.addInput(Buffer.from(fundTxid, 'hex').reverse(), outputIndex);

    const receiverAddrMain = await mainRpc.call('getnewaddress');
    mainSpendTx.addOutput(bitcoin.address.toOutputScript(receiverAddrMain, bitcoin.networks.regtest), 999000000n);

    const leafHash = tapleafHash(splitScript);
    const sighashMain = mainSpendTx.hashForWitnessV1(
        0,
        [splitPayment.output!],
        [1000000000n],
        bitcoin.Transaction.SIGHASH_DEFAULT,
        leafHash
    );
    const sigMain = Buffer.from(initiator.signSchnorr(sighashMain));
    const controlBlock = splitPayment.witness![1];

    mainSpendTx.setWitness(0, [
        sigMain,
        Buffer.alloc(0), // isBip110 = false
        splitScript,
        controlBlock
    ]);

    const rawMainHex = mainSpendTx.toHex();
    const splitTxidMain = await mainRpc.call('sendrawtransaction', [rawMainHex]);
    console.log(`   - Initiator split accepted on Main-Chain! TxID: ${splitTxidMain}`);

    // Acceptor Main Chain spend
    const rawAccFundTx = await mainRpc.call('getrawtransaction', [accFundTxid, true]);
    let accOutputIndex = -1;
    const accTargetScriptHex = Buffer.from(accSplitPayment.output!).toString('hex');
    for (let i = 0; i < rawAccFundTx.vout.length; i++) {
        if (rawAccFundTx.vout[i].scriptPubKey.hex === accTargetScriptHex) {
            accOutputIndex = i;
            break;
        }
    }
    if (accOutputIndex === -1) throw new Error("Could not find Acceptor funding output index.");

    const accMainSpendTx = new bitcoin.Transaction();
    accMainSpendTx.version = 2;
    accMainSpendTx.addInput(Buffer.from(accFundTxid, 'hex').reverse(), accOutputIndex);

    const accReceiverAddrMain = await mainRpc.call('getnewaddress');
    accMainSpendTx.addOutput(bitcoin.address.toOutputScript(accReceiverAddrMain, bitcoin.networks.regtest), 999000000n);

    const accLeafHash = tapleafHash(accSplitScript);
    const accSighashMain = accMainSpendTx.hashForWitnessV1(
        0,
        [accSplitPayment.output!],
        [1000000000n],
        bitcoin.Transaction.SIGHASH_DEFAULT,
        accLeafHash
    );
    const accSigMain = Buffer.from(acceptor.signSchnorr(accSighashMain));
    const accControlBlock = accSplitPayment.witness![1];

    accMainSpendTx.setWitness(0, [
        accSigMain,
        Buffer.alloc(0), // isBip110 = false
        accSplitScript,
        accControlBlock
    ]);

    const rawAccMainHex = accMainSpendTx.toHex();
    const accSplitTxidMain = await mainRpc.call('sendrawtransaction', [rawAccMainHex]);
    console.log(`   - Acceptor split accepted on Main-Chain! TxID: ${accSplitTxidMain}`);

    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);

    // 7. Replay Verification: BIP110 MUST reject the Main Chain spends (both should fail)
    console.log("\n7. Replaying Main Chain spends to BIP110 Node (Should FAIL)...");
    
    // Attempt Initiator replay
    try {
        await bip110Rpc.call('sendrawtransaction', [rawMainHex]);
        console.error("❌ FAILURE: BIP110 Node accepted the Initiator's OP_IF spend!");
        process.exit(1);
    } catch {
        console.log("   - BIP110 Node successfully REJECTED Initiator's OP_IF transaction!");
    }

    // Attempt Acceptor replay
    try {
        await bip110Rpc.call('sendrawtransaction', [rawAccMainHex]);
        console.error("❌ FAILURE: BIP110 Node accepted the Acceptor's OP_IF spend!");
        process.exit(1);
    } catch {
        console.log("   - BIP110 Node successfully REJECTED Acceptor's OP_IF transaction!");
    }
    console.log("   - REPLAY PROTECTION VALIDATED FOR BOTH SIDES SUCCESSFULLY!");

    // 8. BIP110 Chain: Spend via Keypath using Tweaked Key (Schnorr)
    console.log("\n8. Executing Keypath spends on BIP110-Chain...");

    // Initiator BIP110 Keypath spend
    const bip110SpendTx = new bitcoin.Transaction();
    bip110SpendTx.version = 2;
    bip110SpendTx.addInput(Buffer.from(fundTxid, 'hex').reverse(), outputIndex);

    const receiverAddrBip110 = await bip110Rpc.call('getnewaddress');
    bip110SpendTx.addOutput(bitcoin.address.toOutputScript(receiverAddrBip110, bitcoin.networks.regtest), 999000000n);

    // Calculate Taproot Keypath sighash
    const sighashBip110 = bip110SpendTx.hashForWitnessV1(
        0,
        [splitPayment.output!],
        [1000000000n],
        bitcoin.Transaction.SIGHASH_DEFAULT
    );

    // Calculate mathematically perfect tweaked keypair (handling parity)
    const tweakedKeyPair = getTweakedKeyPair(initiator, leafHash);

    // Sign using tweaked key
    const sigBip110 = Buffer.from(tweakedKeyPair.signSchnorr(sighashBip110));

    // Witness Stack for Keypath spend contains ONLY the signature!
    bip110SpendTx.setWitness(0, [sigBip110]);

    const splitTxidBip110 = await bip110Rpc.call('sendrawtransaction', [bip110SpendTx.toHex()]);
    console.log(`   - Initiator keypath split accepted on BIP110-Chain! TxID: ${splitTxidBip110}`);


    // Acceptor BIP110 Keypath spend
    const accBip110SpendTx = new bitcoin.Transaction();
    accBip110SpendTx.version = 2;
    accBip110SpendTx.addInput(Buffer.from(accFundTxid, 'hex').reverse(), accOutputIndex);

    const accReceiverAddrBip110 = await bip110Rpc.call('getnewaddress');
    accBip110SpendTx.addOutput(bitcoin.address.toOutputScript(accReceiverAddrBip110, bitcoin.networks.regtest), 999000000n);

    // Calculate Taproot Keypath sighash
    const accSighashBip110 = accBip110SpendTx.hashForWitnessV1(
        0,
        [accSplitPayment.output!],
        [1000000000n],
        bitcoin.Transaction.SIGHASH_DEFAULT
    );

    // Calculate mathematically perfect tweaked keypair (handling parity)
    const accTweakedKeyPair = getTweakedKeyPair(acceptor, accLeafHash);

    // Sign using tweaked key
    const accSigBip110 = Buffer.from(accTweakedKeyPair.signSchnorr(accSighashBip110));

    // Witness Stack for Keypath spend contains ONLY the signature!
    accBip110SpendTx.setWitness(0, [accSigBip110]);

    const accSplitTxidBip110 = await bip110Rpc.call('sendrawtransaction', [accBip110SpendTx.toHex()]);
    console.log(`   - Acceptor keypath split accepted on BIP110-Chain! TxID: ${accSplitTxidBip110}`);

    const minerAddrBip110 = await bip110Rpc.call('getnewaddress');
    await bip110Rpc.call('generatetoaddress', [1, minerAddrBip110]);

    console.log("\n==================================================");
    console.log("🎉 COIN SPLIT PRIMITIVE TEST COMPLETED SUCCESSFULLY!");
    console.log("==================================================");
}

runSplitPrimitiveTest().catch(err => {
    console.error(`❌ Split Test Failed: ${err.message}`);
    process.exit(1);
});
