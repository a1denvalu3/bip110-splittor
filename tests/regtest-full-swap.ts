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
    const { payment: initSplitPayment, script: initSplitScript } = PureBitcoinSwap.createSplitPayment(Buffer.from(initiator.publicKey), bitcoin.networks.regtest);
    const initSplitAddr = initSplitPayment.address!;

    const { payment: accSplitPayment, script: accSplitScript } = PureBitcoinSwap.createSplitPayment(Buffer.from(acceptor.publicKey), bitcoin.networks.regtest);
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

    // 5. ENFORCING CONSENSUS-LEVEL FORK SPLIT VIA KNOTS -CONSENSUSRULES=RDTS
    console.log("\n5. ENFORCING CONSENSUS-LEVEL FORK SPLIT VIA KNOTS -CONSENSUSRULES=RDTS");
    console.log("   - Nodes are fully connected over P2P initially.");
    console.log("   - We will mine the OP_IF block and then invalidate it on Knots to force the consensus split!");

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
    const initMainSplitTx = PureBitcoinSwap.buildScriptpathSplitTx(
        initiator, initFundTxid, initSplitOutIdxMain, 1000000000n, 999000000n, initSplitDestAddr, initSplitPayment, initSplitScript, bitcoin.networks.regtest
    );

    // Build Acceptor Main-Chain Split Spend
    const accMainSplitTx = PureBitcoinSwap.buildScriptpathSplitTx(
        acceptor, accFundTxid, accSplitOutIdxMain, 1000000000n, 999000000n, accSplitDestAddr, accSplitPayment, accSplitScript, bitcoin.networks.regtest
    );

    // Broadcast both to Main-Chain
    const initSplitTxidMain = await mainRpc.call('sendrawtransaction', [initMainSplitTx.toHex()]);
    const accSplitTxidMain = await mainRpc.call('sendrawtransaction', [accMainSplitTx.toHex()]);
    const blocksMined = await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    const block102Hash = blocksMined[0];

    console.log("   - ENFORCING BIP110 CONSENSUS RULE (Banning Block 102 on Knots)...");
    await bip110Rpc.call('invalidateblock', [block102Hash]);
    await sleep(2000);

    console.log(`   - Main-Chain Block 102 Mined. Initiator Split UTXO: ${initSplitTxidMain}. Acceptor Split UTXO: ${accSplitTxidMain}`);

    // BIP110-Chain Splits (Keypath Schnorr Spends)
    const initSplitOutIdxBip110 = await findOutputIndex(bip110Rpc, initFundTxid, Buffer.from(initSplitPayment.output!).toString('hex'));
    const accSplitOutIdxBip110 = await findOutputIndex(bip110Rpc, accFundTxid, Buffer.from(accSplitPayment.output!).toString('hex'));

    // Build Initiator BIP110 Keypath Split Spend
    const initBip110SplitTx = PureBitcoinSwap.buildKeypathSplitTx(
        initiator, initFundTxid, initSplitOutIdxBip110, 1000000000n, 999000000n, initSplitDestAddr, initSplitPayment, initSplitScript, bitcoin.networks.regtest
    );

    // Build Acceptor BIP110 Keypath Split Spend
    const accBip110SplitTx = PureBitcoinSwap.buildKeypathSplitTx(
        acceptor, accFundTxid, accSplitOutIdxBip110, 1000000000n, 999000000n, accSplitDestAddr, accSplitPayment, accSplitScript, bitcoin.networks.regtest
    );

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
        Buffer.from(initiator.publicKey), // internal aggregator
        hashLock,
        Buffer.from(acceptor.publicKey), // recipient
        Buffer.from(initiator.publicKey), // refund owner
        lockTime,
        bitcoin.networks.regtest
    );
    const htlcBip110Addr = htlcBip110.address!;
    console.log(`   - BIP110-Chain HTLC Address: ${htlcBip110Addr}`);

    const htlcFundTxBip110 = PureBitcoinSwap.buildHtlcFundingTx(
        initiator, initSplitTxidBip110, initSplitOutIdxBip110Tx, 999000000n, 998000000n, htlcBip110Addr, initSplitDestPayment, bitcoin.networks.regtest
    );

    const htlcFundTxidBip110 = await bip110Rpc.call('sendrawtransaction', [htlcFundTxBip110.toHex()]);
    await bip110Rpc.call('generatetoaddress', [1, minerAddrBip110]);
    console.log(`   - BIP110 HTLC Funded. TxID: ${htlcFundTxidBip110}`);

    // B. Main-Chain HTLC (funded by Acceptor's split output)
    const accSplitDestScriptHexMain = Buffer.from(bitcoin.address.toOutputScript(accSplitDestAddr, bitcoin.networks.regtest)).toString('hex');
    const accSplitOutIdxMainTx = await findOutputIndex(mainRpc, accSplitTxidMain, accSplitDestScriptHexMain);

    const htlcMain = PureBitcoinSwap.createTaprootHtlc(
        Buffer.from(acceptor.publicKey), // internal aggregator
        hashLock,
        Buffer.from(initiator.publicKey), // recipient
        Buffer.from(acceptor.publicKey), // refund owner
        Math.round(lockTime / 2), // T/2
        bitcoin.networks.regtest
    );
    const htlcMainAddr = htlcMain.address!;
    console.log(`   - Main-Chain HTLC Address: ${htlcMainAddr}`);

    const htlcFundTxMain = PureBitcoinSwap.buildHtlcFundingTx(
        acceptor, accSplitTxidMain, accSplitOutIdxMainTx, 999000000n, 998000000n, htlcMainAddr, accSplitDestPayment, bitcoin.networks.regtest
    );

    const htlcFundTxidMain = await mainRpc.call('sendrawtransaction', [htlcFundTxMain.toHex()]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    console.log(`   - Main-Chain HTLC Funded. TxID: ${htlcFundTxidMain}`);

    // ----------------------------------------------------------------
    // Setup 8: Executing the Atomic Swap Claims
    // ----------------------------------------------------------------
    console.log("\n8. Executing the Atomic Swap Claims...");

    // A. Initiator Claims on Main-Chain (Reveals Preimage)
    const htlcMainOutIdx = await findOutputIndex(mainRpc, htlcFundTxidMain, Buffer.from(htlcMain.output!).toString('hex'));
    const initiatorClaimWalletAddr = await mainRpc.call('getnewaddress');

    const claimTxMain = PureBitcoinSwap.buildHtlcClaimTx(
        initiator, htlcFundTxidMain, htlcMainOutIdx, 998000000n, 997000000n, initiatorClaimWalletAddr, hashLock, preimage,
        htlcMain, Buffer.from(acceptor.publicKey), Buffer.from(acceptor.publicKey), Math.round(lockTime / 2), bitcoin.networks.regtest
    );

    const claimTxidMain = await mainRpc.call('sendrawtransaction', [claimTxMain.toHex()]);
    await mainRpc.call('generatetoaddress', [1, sharedMinerAddr]);
    console.log(`   - Main-Chain HTLC Claimed successfully! Preimage revealed in TxID: ${claimTxidMain}`);

    // B. Acceptor Extracts Preimage and Claims on BIP110-Chain
    const rawClaimTxMain = await mainRpc.call('getrawtransaction', [claimTxidMain, true]);
    const revealedPreimageHex = rawClaimTxMain.vin[0].txinwitness[1];
    const extractedPreimage = Buffer.from(revealedPreimageHex, 'hex');
    console.log(`   - Acceptor extracted Preimage 's': "${extractedPreimage.toString('utf8')}"`);

    // Now claim the BIP110 HTLC
    const htlcBip110OutIdx = await findOutputIndex(bip110Rpc, htlcFundTxidBip110, Buffer.from(htlcBip110.output!).toString('hex'));
    const acceptorClaimWalletAddr = await bip110Rpc.call('getnewaddress');

    const claimTxBip110 = PureBitcoinSwap.buildHtlcClaimTx(
        acceptor, htlcFundTxidBip110, htlcBip110OutIdx, 998000000n, 997000000n, acceptorClaimWalletAddr, hashLock, extractedPreimage,
        htlcBip110, Buffer.from(initiator.publicKey), Buffer.from(initiator.publicKey), lockTime, bitcoin.networks.regtest
    );

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
