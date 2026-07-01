import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// In-memory Offer and TX Database
interface Offer {
    id: string;
    status: 'OPEN' | 'ACCEPTED' | 'FUNDED_INITIATOR' | 'FUNDED_ACCEPTOR' | 'CLAIMED' | 'REFUNDED';
    initiatorPubKey: string;      // 33-byte compressed pubkey hex
    initiatorB110Amount: number;   // satoshis
    acceptorPubKey?: string;       // 33-byte compressed pubkey hex
    acceptorBtcAmount: number;     // satoshis
    hashLock: string;              // sha256 hash hex
    lockTime: number;              // lockTime block height or timestamp
    b110HtlcAddress?: string;
    btcHtlcAddress?: string;
    b110HtlcTxid?: string;
    btcHtlcTxid?: string;
    preimage?: string;             // Revealed on claim
    networkMode: 'mainnet' | 'regtest';
    createdAt: number;
}

const offers: Record<string, Offer> = {};

// Bitcoin RPC helper for Regtest
class BitcoinRpc {
    private url: string;
    constructor(port: number, walletName?: string) {
        if (walletName) {
            this.url = `http://user:password@127.0.0.1:${port}/wallet/${walletName}`;
        } else {
            this.url = `http://user:password@127.0.0.1:${port}/`;
        }
    }

    async call(method: string, params: any[] = []): Promise<any> {
        try {
            const response = await axios.post(this.url, {
                jsonrpc: '1.0',
                id: 'regtest-web',
                method,
                params
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            });
            return response.data.result;
        } catch (err: any) {
            if (err.response && err.response.data && err.response.data.error) {
                throw new Error(`[RPC ${method}] ${err.response.data.error.message}`);
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

// Initialize dual wallets on startup
async function initNodeWallets() {
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
            // Second param is disable_private_keys = true
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
}

// ==========================================
// STANDARD MARKETPLACE & BLOCK EXPLORER ENDPOINTS
// ==========================================

// 1. Get Marketplace Offers
app.get('/api/offers', (req: Request, res: Response) => {
    const mode = (req.query.networkMode || 'regtest') as 'mainnet' | 'regtest';
    const filteredOffers = Object.values(offers)
        .filter(o => o.networkMode === mode)
        .sort((a, b) => b.createdAt - a.createdAt);
    res.json(filteredOffers);
});

// 2. Create a Marketplace Offer
app.post('/api/offers', (req: Request, res: Response) => {
    const { initiatorPubKey, initiatorB110Amount, acceptorBtcAmount, hashLock, lockTime, networkMode } = req.body;

    if (!initiatorPubKey || !initiatorB110Amount || !acceptorBtcAmount || !hashLock || !lockTime) {
        return res.status(400).json({ error: "Missing required parameters" });
    }

    const id = Math.random().toString(36).substring(2, 11);
    const newOffer: Offer = {
        id,
        status: 'OPEN',
        initiatorPubKey,
        initiatorB110Amount: Number(initiatorB110Amount),
        acceptorBtcAmount: Number(acceptorBtcAmount),
        hashLock,
        lockTime: Number(lockTime),
        networkMode: networkMode || 'regtest',
        createdAt: Date.now()
    };

    offers[id] = newOffer;
    res.status(201).json(newOffer);
});

// 3. Accept a Marketplace Offer
app.post('/api/offers/:id/accept', (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { acceptorPubKey } = req.body;

    const offer = offers[id];
    if (!offer) {
        return res.status(404).json({ error: "Offer not found" });
    }
    if (offer.status !== 'OPEN') {
        return res.status(400).json({ error: "Offer is not in OPEN status" });
    }
    if (!acceptorPubKey) {
        return res.status(400).json({ error: "Missing acceptorPubKey" });
    }

    offer.acceptorPubKey = acceptorPubKey;
    offer.status = 'ACCEPTED';

    res.json(offer);
});

// 4. Update HTLC Contracts / Txids
app.post('/api/offers/:id/update', (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { b110HtlcAddress, btcHtlcAddress, b110HtlcTxid, btcHtlcTxid, preimage, status } = req.body;

    const offer = offers[id];
    if (!offer) {
        return res.status(404).json({ error: "Offer not found" });
    }

    if (b110HtlcAddress) offer.b110HtlcAddress = b110HtlcAddress;
    if (btcHtlcAddress) offer.btcHtlcAddress = btcHtlcAddress;
    if (b110HtlcTxid) offer.b110HtlcTxid = b110HtlcTxid;
    if (btcHtlcTxid) offer.btcHtlcTxid = btcHtlcTxid;
    if (preimage) offer.preimage = preimage;
    if (status) offer.status = status;

    res.json(offer);
});

// 5. Wallet Balance and UTXOs tracking (supports Mempool.space for Mainnet)
app.post('/api/wallet/utxos', async (req: Request, res: Response) => {
    const { address, chain, networkMode } = req.body; 
    if (!address || !chain) {
        return res.status(400).json({ error: "Missing address or chain" });
    }
    const mode = (networkMode || 'regtest') as 'mainnet' | 'regtest';

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
    const { chain, blocks } = req.body;
    const minerRpc = chain === 'main' ? mainMinerRpc : bip110MinerRpc;
    const numBlocks = Number(blocks) || 1;

    try {
        const minerAddress = await minerRpc.call('getnewaddress');
        const hashes = await minerRpc.call('generatetoaddress', [numBlocks, minerAddress]);
        res.json({ success: true, hashes });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 8. Broadcast Signed Raw Transaction (supports Mempool.space in Production)
app.post('/api/tx/broadcast', async (req: Request, res: Response) => {
    const { hex, chain, networkMode } = req.body;
    if (!hex || !chain) {
        return res.status(400).json({ error: "Missing raw transaction hex or chain parameter" });
    }
    const mode = (networkMode || 'regtest') as 'mainnet' | 'regtest';

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

// Start the Express backend
app.listen(PORT, async () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    await initNodeWallets();
});
