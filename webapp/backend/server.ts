import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { ExplorerChain, ExplorerRequestError, MempoolExplorerClient } from './explorer';
import { assertCoordinatorFee, loadCoordinatorFeeConfig } from './coordinatorFees';

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
const COORDINATOR_FEES = loadCoordinatorFeeConfig();

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

// Accommodates intense parallel loops from multi-index HD wallet balance scans (up to 600 req/min)
app.use('/api', rateLimiter(600, 60000));

// Parse command-line arguments and environment variables for network mode
const args = process.argv.slice(2);
const NETWORK_MODE: 'mainnet' | 'regtest' = 
    (args.includes('--mainnet') || args.includes('--network=mainnet') || process.env.NETWORK_MODE === 'mainnet') 
    ? 'mainnet' 
    : 'regtest';

console.log(`[BOOT] BIP110 Splittoooor Backend starting up in [${NETWORK_MODE.toUpperCase()}] mode.`);
console.log(`[BOOT] Coordinator fees: maker=${COORDINATOR_FEES.makerFeePercent}%, taker=${COORDINATOR_FEES.takerFeePercent}%.`);

const BITCOIN_EXPLORER_URL = (process.env.BITCOIN_EXPLORER_URL || 'https://mempool.space').trim();
const BIP110_EXPLORER_URL = process.env.BIP110_EXPLORER_URL?.trim() || '';
const mainnetExplorer = new MempoolExplorerClient(BITCOIN_EXPLORER_URL);
const bip110Explorer = BIP110_EXPLORER_URL
    ? new MempoolExplorerClient(BIP110_EXPLORER_URL)
    : null;

if (NETWORK_MODE === 'mainnet') {
    console.log(`[BOOT] Bitcoin Mainnet Explorer API URL configured as: [${BITCOIN_EXPLORER_URL}]`);
    console.log(`[BOOT] BIP110 Mainnet Explorer API URL configured as: [${BIP110_EXPLORER_URL || 'MISSING'}]`);
}

function getMainnetExplorer(chain: ExplorerChain): MempoolExplorerClient {
    if (chain === 'main') return mainnetExplorer;
    if (!bip110Explorer) {
        throw new Error('BIP110_EXPLORER_URL is required in mainnet mode');
    }
    return bip110Explorer;
}

function sendExplorerError(res: Response, error: unknown, operation: string) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[EXPLORER] ${operation}: ${message}`);
    return res.status(502).json({
        error: `Explorer unavailable during ${operation}`,
        detail: message
    });
}

// Strict state machine for valid Atomic Swap offer status transitions
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
    'OPEN': ['ACCEPTED'],
    'ACCEPTED': ['OPEN', 'FUNDED_INITIATOR'],
    'FUNDED_INITIATOR': ['FUNDED_ACCEPTOR', 'REFUNDED'],
    'FUNDED_ACCEPTOR': ['CLAIMED', 'REFUNDED'],
    'CLAIMED': [],
    'REFUNDED': []
};

// Bitcoin RPC helper for Regtest or Custom BIP110 Nodes with Auto-Healing Wallet Loader
class BitcoinRpc {
    private port: number;
    private walletName?: string;
    private host: string;
    private user: string;
    private pass: string;
    
    constructor(port: number, walletName?: string, host = '127.0.0.1', user = 'user', pass = 'password') {
        this.port = port;
        this.walletName = walletName;
        this.host = host;
        this.user = user;
        this.pass = pass;
    }

    private getUrl(withWallet: boolean = true): string {
        const auth = `${this.user}:${this.pass}`;
        if (withWallet && this.walletName) {
            return `http://${auth}@${this.host}:${this.port}/wallet/${this.walletName}`;
        }
        return `http://${auth}@${this.host}:${this.port}/`;
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

app.get('/api/fees/coordinator', (_req: Request, res: Response) => {
    res.json(COORDINATOR_FEES);
});

async function getTxConfirmations(
    txid: string | undefined,
    chain: 'main' | 'bip110',
    mode: 'mainnet' | 'regtest' = 'regtest'
): Promise<number> {
    if (!txid) return 0;
    if (mode === 'mainnet') {
        return getMainnetExplorer(chain).getTransactionConfirmations(txid);
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

async function getRawTransaction(txid: string, chain: ExplorerChain): Promise<string> {
    if (NETWORK_MODE === 'mainnet') return getMainnetExplorer(chain).getRawTransaction(txid);
    const rpc = chain === 'bip110' ? bip110MinerRpc : mainMinerRpc;
    return rpc.call('getrawtransaction', [txid, false]);
}

function fundingChainFor(offer: Offer, signer: 'initiator' | 'acceptor'): ExplorerChain {
    if (!offer.backingChain) throw new Error('Offer has no backing chain');
    if (signer === 'initiator') return offer.backingChain;
    return offer.backingChain === 'main' ? 'bip110' : 'main';
}

// 1. Get Marketplace Offers
app.get('/api/offers', async (req: Request, res: Response) => {
    const mode = NETWORK_MODE;
    try {
        const page = req.query.page ? Number(req.query.page) : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const orderBy = req.query.orderBy as 'premium' | 'amount' | 'createdAt' | undefined;
        const orderDir = req.query.orderDir as 'asc' | 'desc' | undefined;
        const excludePubKey = req.query.excludePubKey as string | undefined;
        const initiatorPubKey = req.query.initiatorPubKey as string | undefined;
        const acceptorPubKey = req.query.acceptorPubKey as string | undefined;

        const paginatedResult = await getOffersByMode(mode, { 
            page, 
            limit, 
            orderBy, 
            orderDir, 
            excludePubKey, 
            initiatorPubKey, 
            acceptorPubKey 
        });

        const updatedOffers = await Promise.all(paginatedResult.offers.map(async o => {
            let isPending = false;
            
            // 1. Check if the backing split UTXO is confirmed
            if (o.backingTxid) {
                if (!o.backingChain) {
                    throw new Error(`Offer ${o.id} has a backing transaction without a backing chain`);
                }
                const confs = await getTxConfirmations(o.backingTxid, o.backingChain, mode);
                if (confs < 1) {
                    isPending = true;
                }
            }
            
            // 2. Check if the active Escrow funding transactions are confirmed
            if (!isPending) {
                if (o.status === 'FUNDED_INITIATOR') {
                    const initTxid = o.backingChain === 'main' ? o.btcHtlcTxid : o.b110HtlcTxid;
                    const initChain = o.backingChain === 'main' ? 'main' : 'bip110';
                    if (initTxid) {
                        const confs = await getTxConfirmations(initTxid, initChain, mode);
                        if (confs < 1) isPending = true;
                    }
                } else if (o.status === 'FUNDED_ACCEPTOR') {
                    const accTxid = o.backingChain === 'main' ? o.b110HtlcTxid : o.btcHtlcTxid;
                    const accChain = o.backingChain === 'main' ? 'bip110' : 'main';
                    if (accTxid) {
                        const confs = await getTxConfirmations(accTxid, accChain, mode);
                        if (confs < 1) isPending = true;
                    }
                }
            }
            
            return {
                ...o,
                acceptorPubKey: o.acceptorPubKey || undefined,
                b110HtlcAddress: o.b110HtlcAddress || undefined,
                btcHtlcAddress: o.btcHtlcAddress || undefined,
                b110HtlcTxid: o.b110HtlcTxid || undefined,
                btcHtlcTxid: o.btcHtlcTxid || undefined,
                preimage: o.preimage || undefined,
                backingTxid: o.backingTxid || undefined,
                backingVout: o.backingVout !== null ? Number(o.backingVout) : undefined,
                backingChain: o.backingChain || undefined,
                acceptorClaimed: o.acceptorClaimed === 1,
                isPending
            };
        }));

        res.json({
            offers: updatedOffers,
            total: paginatedResult.total,
            page: paginatedResult.page,
            limit: paginatedResult.limit,
            totalPages: paginatedResult.totalPages
        });
    } catch (err: any) {
        if (err instanceof ExplorerRequestError) {
            return sendExplorerError(res, err, 'offer confirmation lookup');
        }
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

    try {
        await insertOffer({
            id,
            initiatorPubKey,
            initiatorB110Amount: Number(initiatorB110Amount),
            acceptorBtcAmount: Number(acceptorBtcAmount),
            hashLock,
            lockTime: Number(lockTime),
            networkMode: NETWORK_MODE,
            backingTxid: backingTxid || null,
            backingVout: backingVout !== undefined ? Number(backingVout) : null,
            backingChain: backingChain || null
        });

        const newOffer = await getOfferById(id);
        res.status(201).json({
            ...newOffer,
            acceptorPubKey: newOffer?.acceptorPubKey || undefined,
            b110HtlcAddress: newOffer?.b110HtlcAddress || undefined,
            btcHtlcAddress: newOffer?.btcHtlcAddress || undefined,
            b110HtlcTxid: newOffer?.b110HtlcTxid || undefined,
            btcHtlcTxid: newOffer?.btcHtlcTxid || undefined,
            preimage: newOffer?.preimage || undefined,
            backingTxid: newOffer?.backingTxid || undefined,
            backingVout: newOffer?.backingVout !== null ? Number(newOffer?.backingVout) : undefined,
            backingChain: newOffer?.backingChain || undefined,
            acceptorClaimed: newOffer?.acceptorClaimed === 1
        });
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
        const offer = await getOfferById(id);
        if (!offer) {
            return res.status(404).json({ error: "Offer not found" });
        }
        if (offer.status !== 'OPEN') {
            return res.status(400).json({ error: "Offer is not in OPEN status" });
        }

        await acceptOfferById(id, acceptorPubKey);

        const updated = await getOfferById(id);
        res.json({
            ...updated,
            acceptorPubKey: updated?.acceptorPubKey || undefined,
            b110HtlcAddress: updated?.b110HtlcAddress || undefined,
            btcHtlcAddress: updated?.btcHtlcAddress || undefined,
            b110HtlcTxid: updated?.b110HtlcTxid || undefined,
            btcHtlcTxid: updated?.btcHtlcTxid || undefined,
            preimage: updated?.preimage || undefined,
            backingTxid: updated?.backingTxid || undefined,
            backingVout: updated?.backingVout !== null ? Number(updated?.backingVout) : undefined,
            backingChain: updated?.backingChain || undefined,
            acceptorClaimed: updated?.acceptorClaimed === 1
        });
    } catch (err: any) {
        res.status(500).json({ error: "Database error during acceptance: " + err.message });
    }
});

// 4. Update HTLC Contracts / Txids (Enforces Cryptographic Verification)
app.post('/api/offers/:id/update', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { fields, signer, signature } = req.body;

    if (!fields || !signer || !signature) {
        return res.status(400).json({ error: "Missing required update parameters (fields, signer, or signature)" });
    }

    if (signer !== 'initiator' && signer !== 'acceptor') {
        return res.status(400).json({ error: "Invalid signer role. Must be 'initiator' or 'acceptor'" });
    }

    try {
        const offer = await getOfferById(id);
        if (!offer) {
            return res.status(404).json({ error: "Offer not found" });
        }

        // 1a. Validate Status State Machine Transition
        if (fields.status !== undefined && fields.status !== offer.status) {
            const allowedNext = ALLOWED_TRANSITIONS[offer.status] || [];
            if (!allowedNext.includes(fields.status)) {
                return res.status(400).json({ 
                    error: `Disallowed status transition: Cannot transition from '${offer.status}' to '${fields.status}'` 
                });
            }
        }

        // 1. Determine verifying public key
        const pubKeyHex = signer === 'initiator' ? offer.initiatorPubKey : offer.acceptorPubKey;
        if (!pubKeyHex) {
            return res.status(400).json({ error: `Cannot verify signature: No registered public key for '${signer}'` });
        }

        // 2. Build canonical message for deterministic verification
        const canonicalStringify = (obj: any): string => {
            const keys = Object.keys(obj).sort();
            const sortedObj: Record<string, any> = {};
            for (const key of keys) {
                if (obj[key] !== undefined) {
                    sortedObj[key] = obj[key];
                }
            }
            return JSON.stringify(sortedObj);
        };

        const msg = `update-offer:${id}:${canonicalStringify(fields)}`;
        
        // 3. Cryptographically verify signature
        try {
            const msgHash = bitcoin.crypto.sha256(Buffer.from(msg));
            const sigBuf = Buffer.from(signature, 'hex');
            const pubKeyBuf = Buffer.from(pubKeyHex, 'hex');

            const pair = ECPair.fromPublicKey(pubKeyBuf);
            const verified = pair.verify(msgHash, sigBuf);

            if (!verified) {
                return res.status(401).json({ error: "Invalid signature. Update request denied." });
            }
        } catch (sigErr: any) {
            return res.status(401).json({ error: "Signature verification failed: " + sigErr.message });
        }

        // 4. Funding updates must pay the configured role fee in the actual on-chain transaction.
        const fundingChain = fundingChainFor(offer, signer);
        const fundingTxid = fundingChain === 'main' ? fields.btcHtlcTxid : fields.b110HtlcTxid;
        const otherFundingTxid = fundingChain === 'main' ? fields.b110HtlcTxid : fields.btcHtlcTxid;
        const expectedFundingStatus = signer === 'initiator' ? 'FUNDED_INITIATOR' : 'FUNDED_ACCEPTOR';
        if (otherFundingTxid !== undefined) {
            return res.status(400).json({ error: `${signer} cannot register a funding transaction for the other swap chain` });
        }
        if (fields.status === expectedFundingStatus && fundingTxid === undefined) {
            return res.status(400).json({ error: `${expectedFundingStatus} requires the ${fundingChain} HTLC funding transaction id` });
        }
        if (fields.status === 'FUNDED_INITIATOR' && signer !== 'initiator') {
            return res.status(400).json({ error: 'Only the initiator can complete initiator funding' });
        }
        if (fields.status === 'FUNDED_ACCEPTOR' && signer !== 'acceptor') {
            return res.status(400).json({ error: 'Only the acceptor can complete acceptor funding' });
        }
        if (fundingTxid !== undefined) {
            if (typeof fundingTxid !== 'string' || !/^[0-9a-f]{64}$/i.test(fundingTxid)) {
                return res.status(400).json({ error: 'Invalid HTLC funding transaction id' });
            }
            try {
                const rawTransaction = await getRawTransaction(fundingTxid, fundingChain);
                const transaction = bitcoin.Transaction.fromHex(rawTransaction);
                if (transaction.getId().toLowerCase() !== fundingTxid.toLowerCase()) {
                    return res.status(400).json({ error: 'HTLC funding transaction id does not match transaction data' });
                }
                const amount = fundingChain === 'main' ? offer.acceptorBtcAmount : offer.initiatorB110Amount;
                const percent = signer === 'initiator'
                    ? COORDINATOR_FEES.makerFeePercent
                    : COORDINATOR_FEES.takerFeePercent;
                const network = NETWORK_MODE === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.regtest;
                assertCoordinatorFee(rawTransaction, BigInt(amount), percent, COORDINATOR_FEES.receiveAddress, network);
            } catch (feeErr: any) {
                return res.status(400).json({ error: `Invalid coordinator fee: ${feeErr.message}` });
            }
        }

        // 5. Update database fields cleanly
        await updateOfferFieldsById(id, fields);

        const updatedOffer = await getOfferById(id);
        res.json({
            ...updatedOffer,
            acceptorClaimed: updatedOffer?.acceptorClaimed === 1
        });
    } catch (err: any) {
        res.status(500).json({ error: "Database error during verified update: " + err.message });
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
        const offer = await getOfferById(id);
        if (!offer) {
            return res.status(404).json({ error: "Offer not found" });
        }

        // The initiator may abort until their own HTLC has been funded.
        if (offer.status !== 'OPEN' && offer.status !== 'ACCEPTED') {
            return res.status(400).json({ error: "Cannot abort offer after the initiator has locked funds." });
        }
        const initiatorFunded = offer.backingChain === 'main' ? offer.btcHtlcTxid : offer.b110HtlcTxid;
        if (initiatorFunded) {
            return res.status(400).json({ error: "Cannot abort offer after the initiator has locked funds." });
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
        await deleteOfferById(id);
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
        const offer = await getOfferById(id);
        if (!offer) {
            return res.status(404).json({ error: "Offer not found" });
        }

        if (offer.status !== 'ACCEPTED') {
            return res.status(400).json({ error: "The acceptor can only abort before the initiator locks funds." });
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

        await walkbackAcceptanceById(id);
        console.log(`[ABORT] Acceptor left unfunded offer #${id}. Reset to OPEN.`);
        return res.json({
            success: true,
            status: 'OPEN',
            message: `Swap #${id} aborted before funding. The offer is OPEN again.`
        });
    } catch (err: any) {
        res.status(500).json({ error: "Database error during walkback: " + err.message });
    }
});

// 5. Wallet Balance and UTXOs tracking (supports Mempool.space for Mainnet, and custom nodes for BIP110)
app.post('/api/wallet/utxos', async (req: Request, res: Response) => {
    const { address, chain } = req.body; 
    if (!address || !chain) {
        return res.status(400).json({ error: "Missing address or chain" });
    }
    if (chain !== 'main' && chain !== 'bip110') {
        return res.status(400).json({ error: "Invalid chain. Must be 'main' or 'bip110'" });
    }
    const mode = NETWORK_MODE;

    if (mode === 'mainnet') {
        try {
            const utxos = await getMainnetExplorer(chain).getAddressUtxos(address);
            return res.json({ address, chain, utxos });
        } catch (err: any) {
            return sendExplorerError(res, err, `${chain} UTXO lookup`);
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

// 8. Broadcast Signed Raw Transaction (supports Mempool.space on Main Chain, and custom user nodes on BIP110 Chain)
app.post('/api/tx/broadcast', async (req: Request, res: Response) => {
    const { hex, chain } = req.body;
    if (!hex || !chain) {
        return res.status(400).json({ error: "Missing raw transaction hex or chain parameter" });
    }
    if (chain !== 'main' && chain !== 'bip110') {
        return res.status(400).json({ error: "Invalid chain. Must be 'main' or 'bip110'" });
    }
    const mode = NETWORK_MODE;

    if (mode === 'mainnet') {
        try {
            const txid = await getMainnetExplorer(chain).broadcastTransaction(hex);
            return res.json({ success: true, txid });
        } catch (err: any) {
            return sendExplorerError(res, err, `${chain} transaction broadcast`);
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

// 9. Node Chain Height Info (Supports both Mainnet and Regtest for real-time safety monitoring)
app.get('/api/node/info', async (req: Request, res: Response) => {
    if (NETWORK_MODE === 'mainnet') {
        try {
            const [mainHeight, bip110Height] = await Promise.all([
                getMainnetExplorer('main').getTipHeight(),
                getMainnetExplorer('bip110').getTipHeight()
            ]);
            return res.json({
                mainHeight,
                bip110Height
            });
        } catch (err: any) {
            return sendExplorerError(res, err, 'chain-tip lookup');
        }
    }

    // Regtest Mode
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

// 11. Fee Estimates Proxy Endpoint
app.get('/api/fees/recommended', async (req: Request, res: Response) => {
    if (req.query.chain !== 'main' && req.query.chain !== 'bip110') {
        return res.status(400).json({ error: "Invalid chain. Must be 'main' or 'bip110'" });
    }
    const chain = req.query.chain;

    if (NETWORK_MODE === 'regtest') {
        return res.json({
            fastestFee: 15,
            halfHourFee: 15,
            hourFee: 15,
            economyFee: 15,
            minimumFee: 15
        });
    }

    try {
        const fees = await getMainnetExplorer(chain).getRecommendedFees();
        return res.json(fees);
    } catch (err: any) {
        return sendExplorerError(res, err, `${chain} fee estimate`);
    }
});

async function startServer() {
    await runMigrations();

    if (NETWORK_MODE === 'regtest') {
        await initNodeWallets();
    } else {
        if (!bip110Explorer) {
            throw new Error('BIP110_EXPLORER_URL must be configured in mainnet mode');
        }
        await Promise.all([
            mainnetExplorer.assertHealthy('Bitcoin'),
            bip110Explorer.assertHealthy('BIP110')
        ]);
        console.log("[BOOT] Production Mainnet mode: skipping Regtest wallet initialization.");
    }

    app.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
    });
}

startServer().catch((error: any) => {
    console.error(`[BOOT] Fatal startup error: ${error.message}`);
    process.exit(1);
});
