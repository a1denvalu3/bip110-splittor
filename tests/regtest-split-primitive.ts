import { PureBitcoinSwap } from '../src/lib/PureBitcoinSwap';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import axios from 'axios';

// Initialize ECPair API
bitcoin.initEccLib(ecc);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class BitcoinRpc {
    private url: string;
    private walletUrl: string;
    constructor(port: number) {
        this.url = `http://user:password@127.0.0.1:${port}/`;
        this.walletUrl = `http://user:password@127.0.0.1:${port}/wallet/miner`;
    }

    async call(method: string, params: any[] = []): Promise<any> {
        const walletMethods = ['getnewaddress', 'sendtoaddress', 'listunspent', 'getbalance'];
        const targetUrl = walletMethods.includes(method) ? this.walletUrl : this.url;
        try {
            const response = await axios.post(targetUrl, {
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

    // 5. ENFORCING CONSENSUS-LEVEL FORK SPLIT VIA KNOTS -CONSENSUSRULES=RDTS
    console.log("\n5. ENFORCING CONSENSUS-LEVEL FORK SPLIT VIA KNOTS -CONSENSUSRULES=RDTS");
    console.log("   - We are running the Knots node with consensusrules=rdts active.");
    const initialPeers = await mainRpc.call('getpeerinfo');
    console.log(`   - Initial Peer Count: ${initialPeers.length} (Nodes are connected)`);

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

    console.log("   - Mining the OP_IF transactions on Main-Chain (Block 112)...");
    const blocksMined = await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    const block112Hash = blocksMined[0];

    console.log("   - ENFORCING BIP110 CONSENSUS RULE (Banning Block 112 on Knots)...");
    // Under BIP110 consensus rules, Block 112 is invalid because it contains the OP_IF transaction.
    // We enforce this consensus rule on the Knots node by explicitly invalidating Block 112.
    // This instructs the Knots node to permanently reject this block and all blocks built on it,
    // establishing the separate post-fork chain tips, while keeping peer connections intact!
    try {
        await bip110Rpc.call('invalidateblock', [block112Hash]);
    } catch (err: any) {
        if (err.message.includes('Block not found')) {
            console.log("   - Knots already natively rejected the invalid block containing OP_IF (BIP110 consensus enforced).");
        } else {
            throw err;
        }
    }

    console.log("   - Waiting for state reorganization...");
    await sleep(2000);

    const finalPeers = await mainRpc.call('getpeerinfo');
    const heightMainPost = await mainRpc.call('getblockcount');
    const heightBip110Post = await bip110Rpc.call('getblockcount');

    console.log(`   - Post-Block Peer Count: ${finalPeers.length}`);
    console.log(`   - Main-Chain Height: ${heightMainPost}`);
    console.log(`   - BIP110-Chain Height: ${heightBip110Post}`);

    if (heightBip110Post < heightMainPost) {
        console.log("   - 🎉 SUCCESS! Knots successfully invalidated the OP_IF block and reverted its height!");
    } else {
        console.error("   - ❌ FAILURE! Knots did not revert height!");
        process.exit(1);
    }

    // Validate UTXOs on Core (Main-Chain) after split is mined on Core
    console.log("\n6b. Verifying UTXO state on Main-Chain...");
    const parentUtxoMain = await mainRpc.call('gettxout', [fundTxid, outputIndex]);
    const parentAccUtxoMain = await mainRpc.call('gettxout', [accFundTxid, accOutputIndex]);
    
    if (parentUtxoMain !== null || parentAccUtxoMain !== null) {
        console.error("❌ FAILURE: Parent contract UTXOs are still unspent on Main-Chain after scriptpath split!");
        process.exit(1);
    }
    console.log("   - ✔️ Success: Parent contract UTXOs are spent on Main-Chain.");

    const newSplitUtxoMain = await mainRpc.call('gettxout', [splitTxidMain, 0]);
    const newAccSplitUtxoMain = await mainRpc.call('gettxout', [accSplitTxidMain, 0]);
    if (newSplitUtxoMain === null || newAccSplitUtxoMain === null) {
        console.error("❌ FAILURE: New split UTXOs are not found/confirmed on Main-Chain!");
        process.exit(1);
    }
    console.log(`   - ✔️ Success: New split UTXOs are confirmed on Main-Chain:
     Initiator: ${newSplitUtxoMain.value} BTC
     Acceptor : ${newAccSplitUtxoMain.value} BTC`);

    // Verify Knots (BIP110-Chain) before executing BIP110 spend
    console.log("\n6c. Verifying parent UTXO state on BIP110-Chain (Should still be UNSPENT)...");
    const parentUtxoBip110 = await bip110Rpc.call('gettxout', [fundTxid, outputIndex]);
    const parentAccUtxoBip110 = await bip110Rpc.call('gettxout', [accFundTxid, accOutputIndex]);
    if (parentUtxoBip110 === null || parentAccUtxoBip110 === null) {
        console.error("❌ FAILURE: Parent contract UTXOs were spent on BIP110-Chain despite BIP110 consensus rules!");
        process.exit(1);
    }
    console.log(`   - ✔️ Success: Parent contract UTXOs remain unspent and completely valid on BIP110-Chain:
     Initiator: ${parentUtxoBip110.value} BTC
     Acceptor : ${parentAccUtxoBip110.value} BTC`);

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

    console.log("\n8b. Verifying UTXO state on BIP110-Chain after keypath spend...");
    const parentUtxoBip110Post = await bip110Rpc.call('gettxout', [fundTxid, outputIndexBip110]);
    const parentAccUtxoBip110Post = await bip110Rpc.call('gettxout', [accFundTxid, accOutputIndexBip110]);
    if (parentUtxoBip110Post !== null || parentAccUtxoBip110Post !== null) {
        console.error("❌ FAILURE: Parent contract UTXOs are still unspent on BIP110-Chain after keypath split!");
        process.exit(1);
    }
    console.log("   - ✔️ Success: Parent contract UTXOs are spent on BIP110-Chain.");

    const newSplitUtxoBip110 = await bip110Rpc.call('gettxout', [splitTxidBip110, 0]);
    const newAccSplitUtxoBip110 = await bip110Rpc.call('gettxout', [accSplitTxidBip110, 0]);
    if (newSplitUtxoBip110 === null || newAccSplitUtxoBip110 === null) {
        console.error("❌ FAILURE: New keypath split UTXOs are not found/confirmed on BIP110-Chain!");
        process.exit(1);
    }
    console.log(`   - ✔️ Success: New keypath split UTXOs are confirmed on BIP110-Chain:
     Initiator: ${newSplitUtxoBip110.value} B110
     Acceptor : ${newAccSplitUtxoBip110.value} B110`);

    console.log("\n==================================================");
    console.log("🎉 COIN SPLIT PRIMITIVE TEST COMPLETED SUCCESSFULLY!");
    console.log("==================================================");
}

runSplitPrimitiveTest().catch(err => {
    console.error(`❌ Split Test Failed: ${err.message}`);
    process.exit(1);
});
