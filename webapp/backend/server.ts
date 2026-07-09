import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';

import { runMigrations } from './database/migrations';
import {
    getOffersByMode,
    getOfferById,
    insertOffer,
    acceptOfferById,
    updateOfferFieldsById,
    deleteOfferById,
    walkbackAcceptanceById,
    DbOffer as Offer
} from './database/offersCrud';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// In-memory rate-limiter database and middleware
const rateLimitDb: Record<string, { count: number; resetTime: number }> = {};
const rateLimiter = (limit: number, windowMs: number) => {
    return (req: Request, res: Response, next: any) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        
        if (!rateLimitDb[ip]) {
            rateLimitDb[ip] = {
                count: 1,
                resetTime: now + windowMs
            };
            return next();
        }
        
        const record = rateLimitDb[ip];
        if (now > record.resetTime) {
            record.count = 1;
            record.resetTime = now + windowMs;
            return next();
        }
        
        record.count++;
        if (record.count > limit) {
            const secsLeft = Math.ceil((record.resetTime - now) / 1000);
            res.setHeader('Retry-After', String(secsLeft));
            res.status(429).json({
                error: `Too many requests. Please slow down. Retry in ${secsLeft} seconds.`
            });
            return;
        }
        
        next();
    };
};

// Comfortably covers client polling (max 18-20 req/min) while strictly preventing rapid API spam
app.use('/api', rateLimiter(120, 60000));

// Parse command-line arguments and environment variables for network mode
const args = process.argv.slice(2);
const NETWORK_MODE: 'mainnet' | 'regtest' = 
    (args.includes('--mainnet') || args.includes('--network=mainnet') || process.env.NETWORK_MODE === 'mainnet') 
    ? 'mainnet' 
    : 'regtest';

console.log(`[BOOT] BIP110 Splittoooor Backend starting up in [${NETWORK_MODE.toUpperCase()}] mode.`);

// Bitcoin RPC helper for Regtest with Auto-Healing Wallet Loader
class BitcoinRpc {
    private port: number;
    private walletName?: string;
    
    constructor(port: number, walletName?: string) {
        this.port = port;
        this.walletName = walletName;
    }

    private getUrl(withWallet: boolean = true): string {
        if (withWallet && this.walletName) {
            return `http://user:password@127.0.0.1:${this.port}/wallet/${this.walletName}`;
        }
        return `http://user:password@127.0.0.1:${this.port}/`;
    }

    async call(method: string, params: any[] = []): Promise<any> {
        try {
            const response = await axios.post(this.getUrl(true), {
                jsonrpc: '1.0',
                id: 'regtest-web',
                method,
                params
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000 // Increased timeout to 30 seconds for heavy regtest operations
            });
            return response.data.result;
        } catch (err: any) {
            if (err.response && err.response.data && err.response.data.error) {
                const errMsg = err.response.data.error.message;
                if (this.walletName && (errMsg.includes('not loaded') || errMsg.includes('does not exist') || errMsg.includes('not found'))) {
                    console.log(`Auto-healing: Wallet '${this.walletName}' on port ${this.port} is not loaded. Attempting auto-load/create...`);
                    try {
                        await axios.post(this.getUrl(false), {
                            jsonrpc: '1.0',
                            id: 'regtest-web',
                            method: 'loadwallet',
                            params: [this.walletName]
                        }, { headers: { 'Content-Type': 'application/json' } });
                    } catch (loadErr: any) {
                        try {
                            const disableKeys = this.walletName === 'watchonly';
                            await axios.post(this.getUrl(false), {
                                jsonrpc: '1.0',
                                id: 'regtest-web',
                                method: 'createwallet',
                                params: [this.walletName, disableKeys]
                            }, { headers: { 'Content-Type': 'application/json' } });
                        } catch (createErr) {}
                    }
                    
                    try {
                        const response = await axios.post(this.getUrl(true), {
                            jsonrpc: '1.0',
                            id: 'regtest-web',
                            method,
                            params
                        }, {
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 5000
                        });
                        return response.data.result;
                    } catch (retryErr: any) {
                        if (retryErr.response && retryErr.response.data && retryErr.response.data.error) {
                            throw new Error(`[RPC ${method}] ${retryErr.response.data.error.message}`);
                        }
                        throw new Error(`[RPC ${method}] ${retryErr.message}`);
                    }
                }
                throw new Error(`[RPC ${method}] ${errMsg}`);
            }
            throw new Error(`[RPC ${method}] ${err.message}`);
        }
    }
}

// Separate RPC Clients to support Dual-Wallet Architecture:
// 1. Miner Wallets (Have private keys, hold mature coinbase rewards to distribute faucet funds)
const mainMinerRpc = new BitcoinRpc(18443, 'miner');
const bip110MinerRpc = new BitcoinRpc(18444, 'miner');

// 2. Watch-Only Wallets (Have private keys disabled, can watch-only import and scan external P2TR descriptors)
const mainWatchRpc = new BitcoinRpc(18443, 'watchonly');
const bip110WatchRpc = new BitcoinRpc(18444, 'watchonly');

// General root RPC clients for wallet management commands
const mainRootRpc = new BitcoinRpc(18443);
const bip110RootRpc = new BitcoinRpc(18444);

// Initialize dual wallets and P2P connection on startup
async function initNodeWallets() {
    console.log("Connecting to Bitcoin nodes...");
    
    // Wait for RPC ports to become available (polling up to 15 times with 2s delay)
    let retries = 15;
    while (retries > 0) {
        try {
            await mainRootRpc.call('getblockcount');
            await bip110RootRpc.call('getblockcount');
            break; // Both responded successfully!
        } catch (err) {
            console.log(`Waiting for Bitcoin nodes to fully start up... (${retries} retries left)`);
            retries--;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    if (retries === 0) {
        console.error("Fatal Error: Could not connect to Bitcoin nodes after 15 retries.");
        process.exit(1);
    }

    // 1. Setup 'miner' wallet (has private keys enabled)
    for (const rpc of [mainRootRpc, bip110RootRpc]) {
        try {
            await rpc.call('createwallet', ['miner']);
            console.log("Created wallet 'miner'");
        } catch (err: any) {
            if (err.message.includes('already exists')) {
                try {
                    await rpc.call('loadwallet', ['miner']);
                } catch {}
            }
        }
    }

    // 2. Setup 'watchonly' wallet (has private keys disabled, required for watch-only taproot imports)
    for (const rpc of [mainRootRpc, bip110RootRpc]) {
        try {
            await rpc.call('createwallet', ['watchonly', true]);
            console.log("Created watch-only wallet 'watchonly'");
        } catch (err: any) {
            if (err.message.includes('already exists')) {
                try {
                    await rpc.call('loadwallet', ['watchonly']);
                } catch {}
            }
        }
    }

    // 3. Connect Main-Chain node to BIP110 Knots node over P2P natively
    try {
        await mainRootRpc.call('addnode', ['bitcoind-bip110:18444', 'add']);
        console.log("Connected Main-Chain node to BIP110 Knots node over P2P.");
    } catch (err: any) {
        console.warn("Failed to connect P2P nodes:", err.message);
    }
}

// ==========================================
// STANDARD MARKETPLACE & BLOCK EXPLORER ENDPOINTS
// ==========================================

async function getTxConfirmations(txid: string | undefined, chain: 'main' | 'bip110', mode: 'mainnet' | 'regtest' = 'regtest'): Promise<number> {
    if (!txid) return 0;
    if (mode === 'mainnet') {
        try {
            const url = `https://mempool.space/api/tx/${txid}/status`;
            const response = await axios.get(url, { timeout: 3000 });
            return response.data.confirmed ? 1 : 0;
        } catch {
            return 0;
        }
    }
    // Regtest
    try {
        const minerRpc = chain === 'bip110' ? bip110MinerRpc : mainMinerRpc;
        const txInfo = await minerRpc.call('getrawtransaction', [txid, true]);
        return txInfo.confirmations || 0;
    } catch {
        return 0;
    }
}

// 1. Get Marketplace Offers
app.get('/api/offers', async (req: Request, res: Response) => {
    const mode = NETWORK_MODE;
    try {
        const rows = await dbAll(
            "SELECT * FROM offers WHERE networkMode = ? ORDER BY createdAt DESC",
            [mode]
        );

        const fetchedOffers: Offer[] = rows.map(r => ({
            id: r.id,
            status: r.status,
            initiatorPubKey: r.initiatorPubKey,
            initiatorB110Amount: Number(r.initiatorB110Amount),
            acceptorPubKey: r.acceptorPubKey || undefined,
            acceptorBtcAmount: Number(r.acceptorBtcAmount),
            hashLock: r.hashLock,
            lockTime: Number(r.lockTime),
            b110HtlcAddress: r.b110HtlcAddress || undefined,
            btcHtlcAddress: r.btcHtlcAddress || undefined,
            b110HtlcTxid: r.b110HtlcTxid || undefined,
            btcHtlcTxid: r.btcHtlcTxid || undefined,
            preimage: r.preimage || undefined,
            networkMode: r.networkMode,
            createdAt: Number(r.createdAt),
            backingTxid: r.backingTxid || undefined,
            backingVout: r.backingVout !== null ? Number(r.backingVout) : undefined,
            backingChain: r.backingChain || undefined,
            acceptorClaimed: r.acceptorClaimed === 1
        }));

        const updatedOffers = await Promise.all(fetchedOffers.map(async o => {
            let isPending = false;
            
            // 1. Check if the backing split UTXO is confirmed
            if (o.backingTxid) {
                let confs = await getTxConfirmations(o.backingTxid, 'bip110', mode);
                if (confs === 0) {
                    confs = await getTxConfirmations(o.backingTxid, 'main', mode);
                }
                if (confs < 1) {
                    isPending = true;
                }
            }
            
            // 2. Check if the active Escrow funding transactions are confirmed
            if (!isPending) {
                if (o.status === 'FUNDED_INITIATOR' && o.b110HtlcTxid) {
                    const confs = await getTxConfirmations(o.b110HtlcTxid, 'bip110', mode);
                    if (confs < 1) isPending = true;
                } else if (o.status === 'FUNDED_ACCEPTOR' && o.btcHtlcTxid) {
                    const confs = await getTxConfirmations(o.btcHtlcTxid, 'main', mode);
                    if (confs < 1) isPending = true;
                }
            }
            
            return { ...o, isPending };
        }));

        res.json(updatedOffers);
    } catch (err: any) {
        res.status(500).json({ error: "Failed to load offers from database: " + err.message });
    }
});

// 2. Create a Marketplace Offer
app.post('/api/offers', async (req: Request, res: Response) => {
    const { initiatorPubKey, initiatorB110Amount, acceptorBtcAmount, hashLock, lockTime, backingTxid, backingVout, backingChain } = req.body;

    if (!initiatorPubKey || !initiatorB110Amount || !acceptorBtcAmount || !hashLock || !lockTime) {
        return res.status(400).json({ error: "Missing required parameters" });
    }

    const id = Math.random().toString(36).substring(2, 11);
    const createdAt = Date.now();

    try {
        await dbRun(`
            INSERT INTO offers (
                id, status, initiatorPubKey, initiatorB110Amount, acceptorPubKey, acceptorBtcAmount,
                hashLock, lockTime, b110HtlcAddress, btcHtlcAddress, b110HtlcTxid, btcHtlcTxid,
                preimage, networkMode, createdAt, backingTxid, backingVout, backingChain, acceptorClaimed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `, [
            id, 'OPEN', initiatorPubKey, Number(initiatorB110Amount), null, Number(acceptorBtcAmount),
            hashLock, Number(lockTime), null, null, null, null,
            null, NETWORK_MODE, createdAt, backingTxid || null, 
            backingVout !== undefined ? Number(backingVout) : null, backingChain || null
        ]);

        const newOffer: Offer = {
            id,
            status: 'OPEN',
            initiatorPubKey,
            initiatorB110Amount: Number(initiatorB110Amount),
            acceptorBtcAmount: Number(acceptorBtcAmount),
            hashLock,
            lockTime: Number(lockTime),
            networkMode: NETWORK_MODE,
            createdAt,
            backingTxid: backingTxid || undefined,
            backingVout: backingVout !== undefined ? Number(backingVout) : undefined,
            backingChain: backingChain || undefined,
            acceptorClaimed: false
        };

        res.status(201).json(newOffer);
    } catch (err: any) {
        res.status(500).json({ error: "Failed to store offer in database: " + err.message });
    }
});

// 3. Accept a Marketplace Offer
app.post('/api/offers/:id/accept', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { acceptorPubKey } = req.body;

    if (!acceptorPubKey) {
        return res.status(400).json({ error: "Missing acceptorPubKey" });
    }

    try {
        const offer = await dbGet("SELECT * FROM offers WHERE id = ?", [id]);
        if (!offer) {
            return res.status(404).json({ error: "Offer not found" });
        }
        if (offer.status !== 'OPEN') {
            return res.status(400).json({ error: "Offer is not in OPEN status" });
        }

        await dbRun(
            "UPDATE offers SET acceptorPubKey = ?, status = 'ACCEPTED' WHERE id = ?",
            [acceptorPubKey, id]
        );

        const updated = {
            ...offer,
            acceptorPubKey,
            status: 'ACCEPTED',
            acceptorClaimed: offer.acceptorClaimed === 1
        };
        res.json(updated);
    } catch (err: any) {
        res.status(500).json({ error: "Database error during acceptance: " + err.message });
    }
});

// 4. Update HTLC Contracts / Txids
app.post('/api/offers/:id/update', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { b110HtlcAddress, btcHtlcAddress, b110HtlcTxid, btcHtlcTxid, preimage, status, acceptorClaimed } = req.body;

    try {
        const offer = await dbGet("SELECT * FROM offers WHERE id = ?", [id]);
        if (!offer) {
            return res.status(404).json({ error: "Offer not found" });
        }

        const updates: string[] = [];
        const params: any[] = [];

        if (b110HtlcAddress !== undefined) { updates.push("b110HtlcAddress = ?"); params.push(b110HtlcAddress); }
        if (btcHtlcAddress !== undefined) { updates.push("btcHtlcAddress = ?"); params.push(btcHtlcAddress); }
        if (b110HtlcTxid !== undefined) { updates.push("b110HtlcTxid = ?"); params.push(b110HtlcTxid); }
        if (btcHtlcTxid !== undefined) { updates.push("btcHtlcTxid = ?"); params.push(btcHtlcTxid); }
        if (preimage !== undefined) { updates.push("preimage = ?"); params.push(preimage); }
        if (status !== undefined) { updates.push("status = ?"); params.push(status); }
        if (acceptorClaimed !== undefined) { updates.push("acceptorClaimed = ?"); params.push(acceptorClaimed ? 1 : 0); }

        if (updates.length > 0) {
            params.push(id);
            await dbRun(
                `UPDATE offers SET ${updates.join(', ')} WHERE id = ?`,
                params
            );
        }

        const updatedOffer = await dbGet("SELECT * FROM offers WHERE id = ?", [id]);
        res.json({
            ...updatedOffer,
            acceptorClaimed: updatedOffer.acceptorClaimed === 1
        });
    } catch (err: any) {
        res.status(500).json({ error: "Database error during update: " + err.message });
    }
});

// 4a. Delete a Marketplace Offer (Author/Initiator Only)
app.post('/api/offers/:id/delete', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { signature } = req.body;

    if (!signature) {
        return res.status(400).json({ error: "Missing verification signature to delete offer" });
    }

    try {
        const offer = await dbGet("SELECT * FROM offers WHERE id = ?", [id]);
        if (!offer) {
            return res.status(404).json({ error: "Offer not found" });
        }

        // Deletion only permitted before funds are locked (OPEN or ACCEPTED status)
        if (offer.status !== 'OPEN' && offer.status !== 'ACCEPTED') {
            return res.status(400).json({ error: "Cannot delete offer after funds have been locked" });
        }

        // Verify cryptographic signature from the same initiator author
        try {
            const msg = `delete-offer:${id}`;
            const msgHash = bitcoin.crypto.sha256(Buffer.from(msg));
            const sigBuf = Buffer.from(signature, 'hex');
            const pubKeyBuf = Buffer.from(offer.initiatorPubKey, 'hex');

            const pair = ECPair.fromPublicKey(pubKeyBuf);
            const verified = pair.verify(msgHash, sigBuf);

            if (!verified) {
                return res.status(401).json({ error: "Invalid signature. Deletion denied." });
            }
        } catch (sigErr: any) {
            return res.status(401).json({ error: "Signature verification failed: " + sigErr.message });
        }

        // Signature is valid. Delete from SQLite database
        await dbRun("DELETE FROM offers WHERE id = ?", [id]);
        console.log(`[DELETE] Deleted offer #${id} successfully.`);
        res.json({ success: true, message: `Offer #${id} deleted successfully.` });
    } catch (err: any) {
        res.status(500).json({ error: "Database error during deletion: " + err.message });
    }
});

// 4b. Walk Back Acceptance (Acceptor Only, before Initiator locks funds)
app.post('/api/offers/:id/walkback', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { signature } = req.body;

    if (!signature) {
        return res.status(400).json({ error: "Missing walkback verification signature" });
    }

    try {
        const offer = await dbGet("SELECT * FROM offers WHERE id = ?", [id]);
        if (!offer) {
            return res.status(404).json({ error: "Offer not found" });
        }

        if (offer.status !== 'ACCEPTED') {
            return res.status(400).json({ error: "Only accepted offers that have not locked funds can walk back acceptance." });
        }

        // If b110HtlcTxid is already filled, initiator has already locked funds
        if (offer.b110HtlcTxid) {
            return res.status(400).json({ error: "Initiator has already funded the HTLC. Cannot walk back acceptance." });
        }

        if (!offer.acceptorPubKey) {
            return res.status(400).json({ error: "No acceptor is currently registered on this offer." });
        }

        // Verify cryptographic signature from the acceptor
        try {
            const msg = `walkback-offer:${id}`;
            const msgHash = bitcoin.crypto.sha256(Buffer.from(msg));
            const sigBuf = Buffer.from(signature, 'hex');
            const pubKeyBuf = Buffer.from(offer.acceptorPubKey, 'hex');

            const pair = ECPair.fromPublicKey(pubKeyBuf);
            const verified = pair.verify(msgHash, sigBuf);

            if (!verified) {
                return res.status(401).json({ error: "Invalid signature. Walk back denied." });
            }
        } catch (sigErr: any) {
            return res.status(401).json({ error: "Signature verification failed: " + sigErr.message });
        }

        // Reset the offer status back to OPEN and clear acceptorPubKey
        await dbRun(
            "UPDATE offers SET status = 'OPEN', acceptorPubKey = NULL WHERE id = ?",
            [id]
        );

        console.log(`[WALKBACK] Acceptor walked back their acceptance on offer #${id}. Reset to OPEN.`);
        res.json({ success: true, message: `Successfully walked back acceptance on offer #${id}. Status reset to OPEN.` });
    } catch (err: any) {
        res.status(500).json({ error: "Database error during walkback: " + err.message });
    }
});

// 5. Wallet Balance and UTXOs tracking (supports Mempool.space for Mainnet)
app.post('/api/wallet/utxos', async (req: Request, res: Response) => {
    const { address, chain } = req.body; 
    if (!address || !chain) {
        return res.status(400).json({ error: "Missing address or chain" });
    }
    const mode = NETWORK_MODE;

    if (mode === 'mainnet') {
        // Fetch from Mempool.space Mainnet API
        try {
            const response = await axios.get(`https://mempool.space/api/address/${address}/utxo`, { timeout: 5000 });
            const utxos = response.data.map((u: any) => ({
                txid: u.txid,
                vout: u.vout,
                amount: u.value,
                confirmations: u.status.confirmed ? 1 : 0
            }));
            return res.json({ address, chain, utxos });
        } catch (err: any) {
            return res.json({ address, chain, utxos: [] });
        }
    }

    // Regtest Mode - Query via Watch-Only Descriptors Wallet
    const watchRpc = chain === 'main' ? mainWatchRpc : bip110WatchRpc;

    try {
        // Import watch-only descriptor using the proper non-private key wallet
        try {
            const info = await watchRpc.call('getdescriptorinfo', [`addr(${address})`]);
            await watchRpc.call('importdescriptors', [[{
                desc: info.descriptor,
                timestamp: 0,
                internal: false,
                label: 'split-contract'
            }]]);
            console.log(`Successfully imported watch-only descriptor to watchonly wallet: ${info.descriptor}`);
        } catch (err: any) {
            // If importdescriptors fails or is already imported, ignore
        }

        // Query listunspent from our watchonly wallet
        const unspents = await watchRpc.call('listunspent', [0, 999999, [address]]);
        const utxos = unspents.map((u: any) => ({
            txid: u.txid,
            vout: u.vout,
            amount: Math.round(u.amount * 100000000), 
            confirmations: u.confirmations
        }));

        res.json({ address, chain, utxos });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Regtest Faucet / Deposit Simulator
app.post('/api/regtest/faucet', async (req: Request, res: Response) => {
    if (NETWORK_MODE !== 'regtest') {
        return res.status(403).json({ error: "Regtest endpoints are disabled in Production Mainnet mode." });
    }
    const { address, amountSats, chain } = req.body;
    if (!address || !amountSats || !chain) {
        return res.status(400).json({ error: "Missing address, amountSats, or chain" });
    }

    // Spend from the private key enabled Miner wallet
    const minerRpc = chain === 'main' ? mainMinerRpc : bip110MinerRpc;
    const amountBtc = Number(amountSats) / 100000000;

    try {
        const txid = await minerRpc.call('sendtoaddress', [address, amountBtc]);
        
        // Mine block using Miner wallet to secure and propagate
        const minerAddress = await minerRpc.call('getnewaddress');
        await minerRpc.call('generatetoaddress', [1, minerAddress]);
        await new Promise(resolve => setTimeout(resolve, 500));

        res.json({ txid, success: true, message: `Deposited ${amountBtc} BTC to ${address} and mined 1 block.` });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 7. Regtest Block Miner
app.post('/api/regtest/mine', async (req: Request, res: Response) => {
    if (NETWORK_MODE !== 'regtest') {
        return res.status(403).json({ error: "Regtest endpoints are disabled in Production Mainnet mode." });
    }
    const { chain, blocks } = req.body;
    const minerRpc = chain === 'main' ? mainMinerRpc : bip110MinerRpc;
    const numBlocks = Number(blocks) || 1;

    try {
        const minerAddress = await minerRpc.call('getnewaddress');
        const hashes = await minerRpc.call('generatetoaddress', [numBlocks, minerAddress]);

        res.json({ success: true, hashes });
    } catch (err: any) {
        console.error("Mining endpoint error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 8. Broadcast Signed Raw Transaction (supports Mempool.space in Production)
app.post('/api/tx/broadcast', async (req: Request, res: Response) => {
    const { hex, chain, isSplit } = req.body;
    if (!hex || !chain) {
        return res.status(400).json({ error: "Missing raw transaction hex or chain parameter" });
    }
    const mode = NETWORK_MODE;

    if (mode === 'mainnet') {
        try {
            const response = await axios.post(`https://mempool.space/api/tx`, hex, {
                headers: { 'Content-Type': 'text/plain' }
            });
            return res.json({ success: true, txid: response.data });
        } catch (err: any) {
            const msg = err.response && err.response.data ? err.response.data : err.message;
            return res.status(400).json({ error: `[Mempool Broadcaster] ${msg}` });
        }
    }

    // Regtest Mode - Broadcast via Miner wallet RPC
    const minerRpc = chain === 'main' ? mainMinerRpc : bip110MinerRpc;

    try {
        const txid = await minerRpc.call('sendrawtransaction', [hex]);

        res.json({ success: true, txid });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// 9. Node Chain Height Info (Regtest only)
app.get('/api/node/info', async (req: Request, res: Response) => {
    if (NETWORK_MODE !== 'regtest') {
        return res.status(403).json({ error: "Regtest endpoints are disabled in Production Mainnet mode." });
    }
    try {
        const mainHeight = await mainMinerRpc.call('getblockcount');
        const bip110Height = await bip110MinerRpc.call('getblockcount');
        res.json({
            mainHeight,
            bip110Height
        });
    } catch (err: any) {
        res.json({
            mainHeight: 0,
            bip110Height: 0,
            error: err.message
        });
    }
});

// 10. System Configuration Endpoint
app.get('/api/config', (req: Request, res: Response) => {
    res.json({
        networkMode: NETWORK_MODE
    });
});

// Start the Express backend
app.listen(PORT, async () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    
    // Run database migrations on boot
    await runMigrations();

    if (NETWORK_MODE === 'regtest') {
        await initNodeWallets();
    } else {
        console.log("[BOOT] Production Mainnet mode: skipping Regtest wallet initialization.");
    }
});
