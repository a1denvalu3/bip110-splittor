import { PureBitcoinSwap } from '../src/lib/PureBitcoinSwap';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import axios from 'axios';

// Initialize ECPair API
bitcoin.initEccLib(ecc);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    const { payment: splitPayment, script: splitScript } = PureBitcoinSwap.createSplitPayment(Buffer.from(initiator.publicKey), bitcoin.networks.regtest);
    const splitAddress = splitPayment.address!;
    console.log(`   - Initiator Split Contract Address: ${splitAddress}`);

    const acceptor = PureBitcoinSwap.generateKeyPair();
    const { payment: accSplitPayment, script: accSplitScript } = PureBitcoinSwap.createSplitPayment(Buffer.from(acceptor.publicKey), bitcoin.networks.regtest);
    const accSplitAddress = accSplitPayment.address!;
    console.log(`   - Acceptor Split Contract Address : ${accSplitAddress}`);

    const fundTxid = await mainRpc.call('sendtoaddress', [splitAddress, 10.0]);
    const accFundTxid = await mainRpc.call('sendtoaddress', [accSplitAddress, 10.0]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    await sleep(1000); // sync
    console.log(`   - Block 101 Mined. Initiator Fund TxID: ${fundTxid}`);
    console.log(`   - Block 101 Mined. Acceptor Fund TxID : ${accFundTxid}`);

    // 5. Trigger Fork Split (Sever P2P Peer Connection)
    console.log("\n5. Severing peer connections to simulate the BIP110 consensus hard fork...");
    console.log("   - NOTE ON CONSENSUS VS STANDARDNESS:");
    console.log("     In a production BIP110 deployment, the 'OP_IF' ban is a strict consensus rule.");
    console.log("     A block containing an OP_IF transaction would be invalid on BIP110 nodes,");
    console.log("     forcing automatic peer disconnection at the network layer.");
    console.log("     Since standard Core & Knots nodes on regtest enforce this rule as a policy/standardness");
    console.log("     rule rather than a consensus rule, we call 'disconnectnode' to correctly simulate");
    console.log("     the post-fork separated state of both chains.");
    try {
        await mainRpc.call('disconnectnode', ['bitcoind-bip110:18444']);
        console.log("   - Nodes successfully severed.");
    } catch {}

    // 6. Main Chain: Execute Scriptpath spends using OP_IF
    console.log("\n6. Executing OP_IF Scriptpath spends on Main-Chain...");
    
    // Initiator Main Chain spend
    const outputIndex = await findOutputIndex(mainRpc, fundTxid, Buffer.from(splitPayment.output!).toString('hex'));
    const receiverAddrMain = await mainRpc.call('getnewaddress');
    const mainSpendTx = PureBitcoinSwap.buildScriptpathSplitTx(
        initiator, fundTxid, outputIndex, 1000000000n, 999000000n, receiverAddrMain, splitPayment, splitScript, bitcoin.networks.regtest
    );
    const rawMainHex = mainSpendTx.toHex();
    const splitTxidMain = await mainRpc.call('sendrawtransaction', [rawMainHex]);
    console.log(`   - Initiator split accepted on Main-Chain! TxID: ${splitTxidMain}`);

    // Acceptor Main Chain spend
    const accOutputIndex = await findOutputIndex(mainRpc, accFundTxid, Buffer.from(accSplitPayment.output!).toString('hex'));
    const accReceiverAddrMain = await mainRpc.call('getnewaddress');
    const accMainSpendTx = PureBitcoinSwap.buildScriptpathSplitTx(
        acceptor, accFundTxid, accOutputIndex, 1000000000n, 999000000n, accReceiverAddrMain, accSplitPayment, accSplitScript, bitcoin.networks.regtest
    );
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
    } catch (err: any) {
        console.log("   - BIP110 Node successfully REJECTED Initiator's OP_IF transaction! Error:");
        console.log(`     "${err.message}"`);
    }

    // Attempt Acceptor replay
    try {
        await bip110Rpc.call('sendrawtransaction', [rawAccMainHex]);
        console.error("❌ FAILURE: BIP110 Node accepted the Acceptor's OP_IF spend!");
        process.exit(1);
    } catch (err: any) {
        console.log("   - BIP110 Node successfully REJECTED Acceptor's OP_IF transaction! Error:");
        console.log(`     "${err.message}"`);
    }
    console.log("   - REPLAY PROTECTION VALIDATED FOR BOTH SIDES SUCCESSFULLY!");

    // 8. BIP110 Chain: Spend via Keypath using Tweaked Key (Schnorr)
    console.log("\n8. Executing Keypath spends on BIP110-Chain...");

    const outputIndexBip110 = await findOutputIndex(bip110Rpc, fundTxid, Buffer.from(splitPayment.output!).toString('hex'));
    console.log(`   - Output Index of fundTxid on BIP110-Chain: ${outputIndexBip110}`);

    const txOutBip110 = await bip110Rpc.call('gettxout', [fundTxid, outputIndexBip110]);
    console.log(`   - UTXO status of fundTxid on BIP110-Chain:`, txOutBip110);

    // Initiator BIP110 Keypath spend
    const receiverAddrBip110 = await bip110Rpc.call('getnewaddress');
    const bip110SpendTx = PureBitcoinSwap.buildKeypathSplitTx(
        initiator, fundTxid, outputIndexBip110, 1000000000n, 999000000n, receiverAddrBip110, splitPayment, splitScript, bitcoin.networks.regtest
    );
    const splitTxidBip110 = await bip110Rpc.call('sendrawtransaction', [bip110SpendTx.toHex()]);
    console.log(`   - Initiator keypath split accepted on BIP110-Chain! TxID: ${splitTxidBip110}`);

    // Acceptor BIP110 Keypath spend
    const accOutputIndexBip110 = await findOutputIndex(bip110Rpc, accFundTxid, Buffer.from(accSplitPayment.output!).toString('hex'));
    const accReceiverAddrBip110 = await bip110Rpc.call('getnewaddress');
    const accBip110SpendTx = PureBitcoinSwap.buildKeypathSplitTx(
        acceptor, accFundTxid, accOutputIndexBip110, 1000000000n, 999000000n, accReceiverAddrBip110, accSplitPayment, accSplitScript, bitcoin.networks.regtest
    );
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
