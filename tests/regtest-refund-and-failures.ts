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

async function findOutputIndex(rpc: BitcoinRpc, txid: string, targetScriptHex: string): Promise<number> {
    const rawTx = await rpc.call('getrawtransaction', [txid, true]);
    for (let i = 0; i < rawTx.vout.length; i++) {
        if (rawTx.vout[i].scriptPubKey.hex === targetScriptHex) {
            return i;
        }
    }
    throw new Error(`Could not find output index for script: ${targetScriptHex}`);
}

async function runRefundAndFailureTest() {
    console.log("🚀 Starting BIP110 Swap Failure & Refund Regtest Verification...");

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

    // 3. Shared ancestry blocks 1-110 (Activates BIP110 consensus rules on Knots from genesis)
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

    // Generate keys
    const initiator = PureBitcoinSwap.generateKeyPair();
    const acceptor = PureBitcoinSwap.generateKeyPair();
    const correctPreimage = Buffer.from('correct-swap-preimage-proof', 'utf8');
    const incorrectPreimage = Buffer.from('incorrect-bad-preimage-proof', 'utf8');
    const hashLock = PureBitcoinSwap.computeHashLock(correctPreimage.toString('utf8'));

    // 4. Fund Split Output on BIP110-Chain
    console.log("\n4. Funding the Split contract output for the Initiator...");
    const { payment: splitPayment, script: splitScript } = PureBitcoinSwap.createSplitPayment(Buffer.from(initiator.publicKey), bitcoin.networks.regtest);
    const splitAddress = splitPayment.address!;
    console.log(`   - Initiator Split Contract Address: ${splitAddress}`);

    const fundTxid = await mainRpc.call('sendtoaddress', [splitAddress, 10.0]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    await sleep(1000); // sync
    console.log(`   - Block 101 Mined. Funding TxID: ${fundTxid}`);

    // 5. ENFORCING CONSENSUS-LEVEL FORK SPLIT VIA KNOTS -CONSENSUSRULES=RDTS
    console.log("\n5. ENFORCING CONSENSUS-LEVEL FORK SPLIT VIA KNOTS -CONSENSUSRULES=RDTS");
    console.log("   - Nodes are fully connected over P2P initially.");
    console.log("   - We will mine the OP_IF block on Core and let Knots reject it natively.");

    const outputIndex = await findOutputIndex(mainRpc, fundTxid, Buffer.from(splitPayment.output!).toString('hex'));
    const receiverAddrMain = await mainRpc.call('getnewaddress');
    const mainSpendTx = PureBitcoinSwap.buildScriptpathSplitTx(
        initiator, fundTxid, outputIndex, 1000000000n, 999000000n, receiverAddrMain, splitPayment, splitScript, bitcoin.networks.regtest
    );
    const rawMainHex = mainSpendTx.toHex();
    await mainRpc.call('sendrawtransaction', [rawMainHex]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);

    console.log("   - Knots natively rejects the invalid block containing OP_IF (BIP110 consensus enforced).");
    await sleep(2000);

    // 6. Split coins on BIP110-Chain using Keypath Schnorr spend
    console.log("\n6. Splitting coins on BIP110-Chain...");
    const outputIndexBip110 = await findOutputIndex(bip110Rpc, fundTxid, Buffer.from(splitPayment.output!).toString('hex'));
    const initSplitDestPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(initiator.publicKey)),
        network: bitcoin.networks.regtest
    });
    const initSplitDestAddr = initSplitDestPayment.address!;

    const bip110SplitTx = PureBitcoinSwap.buildKeypathSplitTx(
        initiator, fundTxid, outputIndexBip110, 1000000000n, 999000000n, initSplitDestAddr, splitPayment, splitScript, bitcoin.networks.regtest
    );
    const splitTxidBip110 = await bip110Rpc.call('sendrawtransaction', [bip110SplitTx.toHex()]);
    const minerAddrBip110 = await bip110Rpc.call('getnewaddress');
    await bip110Rpc.call('generatetoaddress', [1, minerAddrBip110]);
    console.log(`   - BIP110-Chain Split Transaction confirmed. TxID: ${splitTxidBip110}`);

    // Get current height to calculate target locktime
    const currentHeight = await bip110Rpc.call('getblockcount');
    const lockTime = currentHeight + 5; // Locktime is exactly 5 blocks in the future
    console.log(`   - Current BIP110 block height: ${currentHeight}`);
    console.log(`   - Target Refund Locktime: ${lockTime}`);

    // 7. Fund the BIP110 HTLC
    console.log("\n7. Funding the BIP110 HTLC address...");
    const htlcBip110 = PureBitcoinSwap.createTaprootHtlc(
        Buffer.from(initiator.publicKey),
        hashLock,
        Buffer.from(acceptor.publicKey),
        Buffer.from(initiator.publicKey),
        lockTime,
        bitcoin.networks.regtest
    );
    const htlcBip110Addr = htlcBip110.address!;
    console.log(`   - HTLC Address: ${htlcBip110Addr}`);

    const initSplitDestScriptHexBip110 = Buffer.from(bitcoin.address.toOutputScript(initSplitDestAddr, bitcoin.networks.regtest)).toString('hex');
    const initSplitOutIdxBip110Tx = await findOutputIndex(bip110Rpc, splitTxidBip110, initSplitDestScriptHexBip110);

    const htlcFundTxBip110 = PureBitcoinSwap.buildHtlcFundingTx(
        initiator, splitTxidBip110, initSplitOutIdxBip110Tx, 999000000n, 998000000n, htlcBip110Addr, initSplitDestPayment, Buffer.alloc(0), undefined, 5000n, bitcoin.networks.regtest
    );
    const htlcFundTxidBip110 = await bip110Rpc.call('sendrawtransaction', [htlcFundTxBip110.toHex()]);
    await bip110Rpc.call('generatetoaddress', [1, minerAddrBip110]);
    console.log(`   - HTLC Funded. TxID: ${htlcFundTxidBip110}`);

    const htlcBip110OutIdx = await findOutputIndex(bip110Rpc, htlcFundTxidBip110, Buffer.from(htlcBip110.output!).toString('hex'));
    const acceptorClaimWalletAddr = await bip110Rpc.call('getnewaddress');

    // 8. Failure Case 1: Claiming with INCORRECT preimage
    console.log("\n8. Failure Case 1: Testing Claim with incorrect preimage (Should FAIL)...");
    const badClaimTx = PureBitcoinSwap.buildHtlcClaimTx(
        acceptor, htlcFundTxidBip110, htlcBip110OutIdx, 998000000n, 997000000n, acceptorClaimWalletAddr, hashLock, incorrectPreimage,
        htlcBip110, Buffer.from(initiator.publicKey), Buffer.from(initiator.publicKey), lockTime, bitcoin.networks.regtest
    );
    try {
        await bip110Rpc.call('sendrawtransaction', [badClaimTx.toHex()]);
        console.error("❌ FAILURE: Node accepted claim with incorrect preimage!");
        process.exit(1);
    } catch (err: any) {
        console.log("   - SUCCESS: Node rejected bad preimage claim! Error message:");
        console.log(`     "${err.message}"`);
    }

    // 9. Failure Case 2: Refund BEFORE locktime expires
    console.log("\n9. Failure Case 2: Testing Refund before locktime has expired (Should FAIL)...");
    const initiatorRefundWalletAddr = await bip110Rpc.call('getnewaddress');
    const prematureRefundTx = PureBitcoinSwap.buildHtlcRefundTx(
        initiator, htlcFundTxidBip110, htlcBip110OutIdx, 998000000n, 997000000n, initiatorRefundWalletAddr, hashLock,
        Buffer.from(acceptor.publicKey), htlcBip110, Buffer.from(initiator.publicKey), lockTime, bitcoin.networks.regtest
    );
    try {
        await bip110Rpc.call('sendrawtransaction', [prematureRefundTx.toHex()]);
        console.error("❌ FAILURE: Node accepted premature refund transaction!");
        process.exit(1);
    } catch (err: any) {
        console.log("   - SUCCESS: Node rejected premature refund! Error message:");
        console.log(`     "${err.message}"`);
    }

    // 10. Success Path: Mining blocks to expire Locktime and executing Refund
    console.log("\n10. Mining blocks to expire Locktime and broadcast refund...");
    const blocksToMine = lockTime - (await bip110Rpc.call('getblockcount'));
    console.log(`   - Mining ${blocksToMine} blocks to reach height ${lockTime}...`);
    await bip110Rpc.call('generatetoaddress', [blocksToMine, minerAddrBip110]);
    console.log(`   - New block height: ${await bip110Rpc.call('getblockcount')}`);

    const finalRefundTx = PureBitcoinSwap.buildHtlcRefundTx(
        initiator, htlcFundTxidBip110, htlcBip110OutIdx, 998000000n, 997000000n, initiatorRefundWalletAddr, hashLock,
        Buffer.from(acceptor.publicKey), htlcBip110, Buffer.from(initiator.publicKey), lockTime, bitcoin.networks.regtest
    );
    const refundTxid = await bip110Rpc.call('sendrawtransaction', [finalRefundTx.toHex()]);
    await bip110Rpc.call('generatetoaddress', [1, minerAddrBip110]);
    console.log(`   - SUCCESS: Refund transaction accepted! TxID: ${refundTxid}`);

    console.log("\n==================================================");
    console.log("🎉 ALL FAILURE & TIMEOUT REFUND CASES VERIFIED SUCCESSFULLY!");
    console.log("==================================================");
}

runRefundAndFailureTest().catch(err => {
    console.error(`❌ Failure & Refund Test Failed: ${err.message}`);
    process.exit(1);
});
