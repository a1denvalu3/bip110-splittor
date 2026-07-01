import React, { useState, useEffect } from 'react';
import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory, ECPairAPI } from 'ecpair';
import { PureBitcoinSwap } from './lib/PureBitcoinSwap';
import { 
  Wallet, 
  Coins, 
  Layers, 
  Plus, 
  RefreshCw, 
  CheckCircle, 
  AlertTriangle, 
  Activity, 
  ShieldCheck, 
  Unlock, 
  Copy,
  TrendingUp,
  Award,
  Eye,
  EyeOff,
  Sparkles,
  ExternalLink,
  Lock,
  Globe,
  Flame
} from 'lucide-react';

// Initialize Elliptic Curve library in the browser
bitcoin.initEccLib(ecc);
const ECPair: ECPairAPI = ECPairFactory(ecc);

const API_BASE = 'http://localhost:4000/api';

interface UTXO {
  txid: string;
  vout: number;
  amount: number; // satoshis
  confirmations: number;
}

interface Offer {
  id: string;
  status: 'OPEN' | 'ACCEPTED' | 'FUNDED_INITIATOR' | 'FUNDED_ACCEPTOR' | 'CLAIMED' | 'REFUNDED';
  initiatorPubKey: string;
  initiatorB110Amount: number;
  acceptorPubKey?: string;
  acceptorBtcAmount: number;
  hashLock: string;
  lockTime: number;
  b110HtlcAddress?: string;
  btcHtlcAddress?: string;
  b110HtlcTxid?: string;
  btcHtlcTxid?: string;
  preimage?: string;
  networkMode: 'mainnet' | 'regtest';
  createdAt: number;
}

export default function App() {
  // Navigation & Network Mode
  const [activeTab, setActiveTab] = useState<'wallet' | 'splitter' | 'marketplace' | 'wizard'>('wallet');
  const [networkMode, setNetworkMode] = useState<'mainnet' | 'regtest'>('regtest');

  // Wallet State
  const [privateKey, setPrivateKey] = useState<string>('');
  const [publicKey, setPublicKey] = useState<string>('');
  const [splitAddress, setSplitAddress] = useState<string>('');
  const [revealPrivKey, setRevealPrivKey] = useState<boolean>(false);
  const [loadingKeys, setLoadingKeys] = useState<boolean>(false);

  // Balances
  const [mainBalance, setMainBalance] = useState<number>(0);
  const [bip110Balance, setBip110Balance] = useState<number>(0);
  const [mainUtxos, setMainUtxos] = useState<UTXO[]>([]);
  const [bip110Utxos, setBip110Utxos] = useState<UTXO[]>([]);
  const [nodeInfo, setNodeInfo] = useState<{ mainHeight: number; bip110Height: number }>({ mainHeight: 0, bip110Height: 0 });

  // Faucet & Block Mining (Regtest only)
  const [faucetAmount, setFaucetAmount] = useState<string>('100000000'); // 1 BTC/B110 in sats
  const [faucetLoading, setFaucetLoading] = useState<Record<string, boolean>>({});

  // Splitter Action State
  const [splitDestAddr, setSplitDestAddr] = useState<string>('');
  const [splitting, setSplitting] = useState<Record<string, boolean>>({});
  const [splitResults, setSplitResults] = useState<Record<string, { success: boolean; txid?: string; error?: string }>>({});

  // Marketplace State
  const [offersList, setOffersList] = useState<Offer[]>([]);
  const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null);
  
  // Offer Form
  const [newOfferB110, setNewOfferB110] = useState<string>('50000000'); // 0.5 B110
  const [newOfferBtc, setNewOfferBtc] = useState<string>('50000000'); // 0.5 BTC
  const [newOfferPreimage, setNewOfferPreimage] = useState<string>('secret-swap-preimage-proof');
  const [newOfferLocktime, setNewOfferLocktime] = useState<string>('2000');
  const [publishing, setPublishing] = useState<boolean>(false);

  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Helpers
  const getNetwork = (): bitcoin.Network => {
    return networkMode === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.regtest;
  };

  // Load saved keys from LocalStorage on mount or networkMode change
  useEffect(() => {
    const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';
    const savedPriv = localStorage.getItem(`${keyPrefix}_bip110_privkey`);
    const savedPub = localStorage.getItem(`${keyPrefix}_bip110_pubkey`);
    const savedAddress = localStorage.getItem(`${keyPrefix}_bip110_address`);

    if (savedPriv && savedPub && savedAddress) {
      setPrivateKey(savedPriv);
      setPublicKey(savedPub);
      setSplitAddress(savedAddress);
    } else {
      generateNewWallet();
    }
    fetchNodeInfo();
    fetchOffers();
  }, [networkMode]);

  // Sync balances and UTXOs when splitAddress or activeTab/networkMode changes
  useEffect(() => {
    if (splitAddress) {
      fetchBalances();
    }
  }, [splitAddress, activeTab, networkMode]);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  };

  const generateNewWallet = async () => {
    setLoadingKeys(true);
    try {
      const net = getNetwork();
      const pair = PureBitcoinSwap.generateKeyPair();
      const pubKeyBuffer = Buffer.from(pair.publicKey);
      const splitPayment = PureBitcoinSwap.createSplitPayment(pubKeyBuffer, net);

      const privHex = Buffer.from(pair.privateKey!).toString('hex');
      const pubHex = pubKeyBuffer.toString('hex');
      const addrStr = splitPayment.payment.address!;

      setPrivateKey(privHex);
      setPublicKey(pubHex);
      setSplitAddress(addrStr);

      const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';
      localStorage.setItem(`${keyPrefix}_bip110_privkey`, privHex);
      localStorage.setItem(`${keyPrefix}_bip110_pubkey`, pubHex);
      localStorage.setItem(`${keyPrefix}_bip110_address`, addrStr);
      
      showToast(`Generated fresh ${networkMode} keypair entirely on the client.`, 'success');
    } catch (err: any) {
      showToast('Error generating keys: ' + err.message, 'error');
    } finally {
      setLoadingKeys(false);
    }
  };

  const fetchNodeInfo = async () => {
    if (networkMode === 'mainnet') return;
    try {
      const res = await axios.get(`${API_BASE}/node/info`);
      setNodeInfo({ mainHeight: res.data.mainHeight, bip110Height: res.data.bip110Height });
    } catch (err: any) {
      console.error(err);
    }
  };

  const fetchOffers = async () => {
    try {
      const res = await axios.get(`${API_BASE}/offers?networkMode=${networkMode}`);
      setOffersList(res.data);
    } catch (err: any) {
      console.error(err);
    }
  };

  const fetchBalances = async () => {
    if (!splitAddress) return;
    try {
      const resMain = await axios.post(`${API_BASE}/wallet/utxos`, { address: splitAddress, chain: 'main', networkMode });
      setMainUtxos(resMain.data.utxos);
      const totalMain = resMain.data.utxos.reduce((sum: number, u: UTXO) => sum + u.amount, 0);
      setMainBalance(totalMain);

      const resBip110 = await axios.post(`${API_BASE}/wallet/utxos`, { address: splitAddress, chain: 'bip110', networkMode });
      setBip110Utxos(resBip110.data.utxos);
      const totalBip110 = resBip110.data.utxos.reduce((sum: number, u: UTXO) => sum + u.amount, 0);
      setBip110Balance(totalBip110);

      if (networkMode === 'regtest') {
        fetchNodeInfo();
      }
    } catch (err: any) {
      console.error(err);
    }
  };

  const runFaucet = async (chain: 'main' | 'bip110') => {
    if (networkMode === 'mainnet') return;
    setFaucetLoading(prev => ({ ...prev, [chain]: true }));
    try {
      const res = await axios.post(`${API_BASE}/regtest/faucet`, {
        address: splitAddress,
        amountSats: Number(faucetAmount),
        chain
      });
      showToast(res.data.message, 'success');
      await fetchBalances();
    } catch (err: any) {
      showToast(`Faucet failed: ${err.message}`, 'error');
    } finally {
      setFaucetLoading(prev => ({ ...prev, [chain]: false }));
    }
  };

  const mineBlocks = async (chain: 'main' | 'bip110', blocks: number = 1) => {
    if (networkMode === 'mainnet') return;
    try {
      const res = await axios.post(`${API_BASE}/regtest/mine`, { chain, blocks });
      showToast(`Mined ${blocks} block(s) on ${chain === 'main' ? 'Bitcoin Core' : 'BIP110-Chain'}`, 'success');
      await fetchBalances();
    } catch (err: any) {
      showToast(`Mining failed: ${err.message}`, 'error');
    }
  };

  const executeSplit = async (chain: 'main' | 'bip110') => {
    const utxos = chain === 'main' ? mainUtxos : bip110Utxos;
    if (utxos.length === 0) {
      showToast(`No confirmed UTXOs on ${chain === 'main' ? 'Bitcoin' : 'BIP110'} to split!`, 'error');
      return;
    }
    if (!splitDestAddr) {
      showToast('Please provide a destination split address to receive split coins.', 'error');
      return;
    }

    setSplitting(prev => ({ ...prev, [chain]: true }));
    setSplitResults(prev => ({ ...prev, [chain]: {} as any }));

    try {
      const targetUtxo = [...utxos].sort((a, b) => b.amount - a.amount)[0];
      const net = getNetwork();

      // Perform transaction construction and signing 100% locally on the client!
      const ownerKeyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
      const pubKey = Buffer.from(ownerKeyPair.publicKey);
      const splitPayment = PureBitcoinSwap.createSplitPayment(pubKey, net);

      const inputSats = BigInt(targetUtxo.amount);
      const fee = BigInt(2000);
      const outputSats = inputSats - fee;

      let tx: bitcoin.Transaction;
      if (chain === 'main') {
        tx = PureBitcoinSwap.buildScriptpathSplitTx(
          ownerKeyPair,
          targetUtxo.txid,
          targetUtxo.vout,
          inputSats,
          outputSats,
          splitDestAddr,
          splitPayment.payment,
          splitPayment.script,
          net
        );
      } else {
        tx = PureBitcoinSwap.buildKeypathSplitTx(
          ownerKeyPair,
          targetUtxo.txid,
          targetUtxo.vout,
          inputSats,
          outputSats,
          splitDestAddr,
          splitPayment.payment,
          splitPayment.script,
          net
        );
      }

      const hex = tx.toHex();

      // Post the locally-signed raw transaction hex to the server to broadcast
      const resBroadcast = await axios.post(`${API_BASE}/tx/broadcast`, {
        hex,
        chain,
        networkMode
      });

      setSplitResults(prev => ({
        ...prev,
        [chain]: { success: true, txid: resBroadcast.data.txid }
      }));
      showToast(`Split spent successfully broadcasted on ${chain === 'main' ? 'Bitcoin' : 'BIP110'}!`, 'success');
      await fetchBalances();
    } catch (err: any) {
      setSplitResults(prev => ({
        ...prev,
        [chain]: { success: false, error: err.message }
      }));
      showToast(`Split spend failed: ${err.message}`, 'error');
    } finally {
      setSplitting(prev => ({ ...prev, [chain]: false }));
    }
  };

  const handleCreateOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishing(true);
    try {
      let preimageHex = '';

      if (networkMode === 'mainnet') {
        // Secure random 32-byte preimage generation on-the-fly
        const randBytes = new Uint8Array(32);
        window.crypto.getRandomValues(randBytes);
        preimageHex = Array.from(randBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        showToast('Secure cryptographic preimage generated & stored.', 'info');
      } else {
        // Fallback custom text converted to hex for testing simplicity
        const encoder = new TextEncoder();
        const data = encoder.encode(newOfferPreimage);
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
        preimageHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      }

      // Hash the preimage to get the hashlock
      const preimageBytes = hexToBytes(preimageHex);
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', preimageBytes as any);
      const hashLockHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      const res = await axios.post(`${API_BASE}/offers`, {
        initiatorPubKey: publicKey,
        initiatorB110Amount: Number(newOfferB110),
        acceptorBtcAmount: Number(newOfferBtc),
        hashLock: hashLockHex,
        lockTime: Number(newOfferLocktime),
        networkMode
      });

      // Save preimage locally associated with Offer ID so we can claim later
      localStorage.setItem(`preimage_${res.data.id}`, preimageHex);

      showToast('Swap offer published successfully to the marketplace!', 'success');
      await fetchOffers();
    } catch (err: any) {
      showToast('Publish offer failed: ' + err.message, 'error');
    } finally {
      setPublishing(false);
    }
  };

  const hexToBytes = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  };

  const acceptOffer = async (offerId: string) => {
    try {
      const res = await axios.post(`${API_BASE}/offers/${offerId}/accept`, {
        acceptorPubKey: publicKey
      });
      showToast('Offer accepted! Launching the Atomic Swap Wizard...', 'success');
      setSelectedOffer(res.data);
      setActiveTab('wizard');
      await fetchOffers();
    } catch (err: any) {
      showToast('Accept offer failed: ' + err.message, 'error');
    }
  };

  const runWizardStep = async (step: number) => {
    if (!selectedOffer) return;
    const net = getNetwork();

    try {
      if (step === 2) {
        // Step 2: Fund B110 HTLC (Performed locally)
        showToast('Building B110 HTLC contract locally...', 'info');
        
        // 1. Generate HTLC outputs locally
        const htlc = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(selectedOffer.acceptorPubKey!, 'hex'),
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          selectedOffer.lockTime,
          net
        );

        // 2. Fetch split UTXOs of initiator on Knots
        const splitDestRes = await axios.post(`${API_BASE}/wallet/utxos`, {
          address: splitDestAddr || splitAddress,
          chain: 'bip110',
          networkMode
        });
        
        const utxo = splitDestRes.data.utxos[0];
        if (!utxo) throw new Error("No split UTXO found on BIP110-Chain! Perform your split first.");

        // 3. Build & sign funding transaction locally!
        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        const splitDestPubKey = Buffer.from(keyPair.publicKey);
        const splitDestPayment = bitcoin.payments.p2tr({
          internalPubkey: PureBitcoinSwap.getXOnlyPubKey(splitDestPubKey),
          network: net
        });

        const tx = PureBitcoinSwap.buildHtlcFundingTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(selectedOffer.initiatorB110Amount),
          htlc.address!,
          splitDestPayment,
          net
        );

        // 4. Broadcast via server
        const broadcastRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: 'bip110',
          networkMode
        });

        // 5. Update Offer State on server
        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, {
          b110HtlcAddress: htlc.address!,
          b110HtlcTxid: broadcastRes.data.txid,
          status: 'FUNDED_INITIATOR'
        });

        setSelectedOffer(updateRes.data);
        showToast('BIP110 HTLC successfully funded!', 'success');
      } 
      
      else if (step === 3) {
        // Step 3: Fund BTC HTLC (Performed locally)
        showToast('Building BTC HTLC contract locally...', 'info');

        // 1. Generate HTLC outputs locally
        const htlc = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'), 
          Buffer.from(selectedOffer.acceptorPubKey!, 'hex'),    
          selectedOffer.lockTime,
          net
        );

        // 2. Fetch split outputs of acceptor on Core
        const splitDestRes = await axios.post(`${API_BASE}/wallet/utxos`, {
          address: splitDestAddr || splitAddress,
          chain: 'main',
          networkMode
        });
        
        const utxo = splitDestRes.data.utxos[0];
        if (!utxo) throw new Error("No split UTXO found on Bitcoin! Perform your split first.");

        // 3. Build & sign funding transaction locally!
        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        const splitDestPubKey = Buffer.from(keyPair.publicKey);
        const splitDestPayment = bitcoin.payments.p2tr({
          internalPubkey: PureBitcoinSwap.getXOnlyPubKey(splitDestPubKey),
          network: net
        });

        const tx = PureBitcoinSwap.buildHtlcFundingTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(selectedOffer.acceptorBtcAmount),
          htlc.address!,
          splitDestPayment,
          net
        );

        // 4. Broadcast via server
        const broadcastRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: 'main',
          networkMode
        });

        // 5. Update Offer State on server
        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, {
          btcHtlcAddress: htlc.address!,
          btcHtlcTxid: broadcastRes.data.txid,
          status: 'FUNDED_ACCEPTOR'
        });

        setSelectedOffer(updateRes.data);
        showToast('Bitcoin HTLC successfully funded!', 'success');
      } 
      
      else if (step === 4) {
        // Step 4: Claim BTC (Performed locally)
        showToast('Signing BTC Claim transaction with local preimage...', 'info');

        const htlcUtxosRes = await axios.post(`${API_BASE}/wallet/utxos`, {
          address: selectedOffer.btcHtlcAddress,
          chain: 'main',
          networkMode
        });
        const utxo = htlcUtxosRes.data.utxos[0];
        if (!utxo) throw new Error("Could not find the funded UTXO on the BTC HTLC. If on regtest, mine a block.");

        // Retrieve local preimage securely stored
        const savedPreimage = localStorage.getItem(`preimage_${selectedOffer.id}`);
        if (!savedPreimage) throw new Error("Cryptographic preimage not found in secure local storage.");

        // Build and sign claim transaction locally!
        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(keyPair.publicKey),
          Buffer.from(selectedOffer.acceptorPubKey!, 'hex'),
          selectedOffer.lockTime,
          net
        );

        const tx = PureBitcoinSwap.buildHtlcClaimTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - 2000), 
          splitDestAddr || splitAddress,
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(savedPreimage, 'hex'), 
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.acceptorPubKey!, 'hex'),
          selectedOffer.lockTime,
          net
        );

        // Broadcast raw tx
        const broadcastRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: 'main',
          networkMode
        });

        // Update Offer State on server
        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, {
          preimage: savedPreimage,
          status: 'CLAIMED'
        });

        setSelectedOffer(updateRes.data);
        showToast('BTC claimed successfully! Preimage revealed.', 'success');
      } 
      
      else if (step === 5) {
        // Step 5: Claim B110 (Performed locally)
        showToast('Signing B110 Claim transaction with extracted preimage...', 'info');

        const htlcUtxosRes = await axios.post(`${API_BASE}/wallet/utxos`, {
          address: selectedOffer.b110HtlcAddress,
          chain: 'bip110',
          networkMode
        });
        const utxo = htlcUtxosRes.data.utxos[0];
        if (!utxo) throw new Error("Could not find funded UTXO on B110 HTLC address.");

        // Build and sign claim transaction locally!
        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(selectedOffer.acceptorPubKey!, 'hex'), // recipient
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'), // refund
          selectedOffer.lockTime,
          net
        );

        const tx = PureBitcoinSwap.buildHtlcClaimTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - 2000), 
          splitDestAddr || splitAddress,
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(selectedOffer.preimage!, 'hex'), // preimage hex
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          selectedOffer.lockTime,
          net
        );

        await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: 'bip110',
          networkMode
        });

        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, {
          status: 'CLAIMED'
        });

        setSelectedOffer(updateRes.data);
        showToast('B110 claimed! Atomic swap finished successfully.', 'success');
      }

      await fetchBalances();
    } catch (err: any) {
      showToast(`Wizard action failed: ${err.message}`, 'error');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showToast('Copied to clipboard!', 'success');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-lg shadow-2xl flex items-center gap-3 border transition-all duration-300 ${
          toast.type === 'success' ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200' :
          toast.type === 'error' ? 'bg-rose-950/90 border-rose-500 text-rose-200' :
          'bg-slate-900/90 border-slate-700 text-slate-200'
        }`}>
          {toast.type === 'success' && <CheckCircle className="w-5 h-5 text-emerald-400" />}
          {toast.type === 'error' && <AlertTriangle className="w-5 h-5 text-rose-400" />}
          {toast.type === 'info' && <Activity className="w-5 h-5 text-sky-400" />}
          <span className="text-sm font-medium">{toast.message}</span>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-slate-800/85 bg-slate-900/40 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-tr from-sky-500 to-indigo-500 p-2 rounded-xl shadow-lg shadow-sky-500/10">
              <Layers className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg leading-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                BIP110 Split & Swap Portal
              </h1>
              <p className="text-xs text-slate-400">Atomic Swaps Across Consensus Hard Forks</p>
            </div>
          </div>

          {/* Network Toggle Button and Stats */}
          <div className="flex items-center gap-6">
            <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-850">
              <button
                onClick={() => setNetworkMode('regtest')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                  networkMode === 'regtest' 
                    ? 'bg-slate-900 text-indigo-400 shadow-sm border border-slate-800' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Flame className="w-3.5 h-3.5" />
                Simulation (Regtest)
              </button>
              <button
                onClick={() => setNetworkMode('mainnet')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                  networkMode === 'mainnet' 
                    ? 'bg-amber-500/10 text-amber-400 shadow-sm border border-amber-500/20' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                Production (Mainnet)
              </button>
            </div>

            {networkMode === 'regtest' ? (
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <span className="text-xs text-slate-400 block font-medium">Core Regtest</span>
                  <span className="text-xs font-semibold text-emerald-400 bg-emerald-950/40 border border-emerald-900/60 px-2 py-0.5 rounded-md">
                    Block #{nodeInfo.mainHeight}
                  </span>
                </div>
                <div className="text-right border-l border-slate-800 pl-4">
                  <span className="text-xs text-slate-400 block font-medium">Knots Regtest</span>
                  <span className="text-xs font-semibold text-sky-400 bg-sky-950/40 border border-sky-900/60 px-2 py-0.5 rounded-md">
                    Block #{nodeInfo.bip110Height}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1 bg-amber-950/40 border border-amber-900/50 px-3 py-1.5 rounded-xl text-amber-400 font-bold text-xs shadow-sm">
                <Lock className="w-3.5 h-3.5" />
                MAINNET PRODUCTION
              </div>
            )}

            <button 
              onClick={fetchBalances}
              className="p-2 text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 rounded-lg transition-all"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Navigation tabs */}
      <div className="border-b border-slate-900 bg-slate-950/60 sticky top-16 z-30 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 flex gap-1">
          {[
            { id: 'wallet', label: networkMode === 'mainnet' ? '1. Secure Wallet' : '1. Deposit Faucet', icon: Wallet },
            { id: 'splitter', label: '2. Bilateral Splitter', icon: Coins },
            { id: 'marketplace', label: '3. Marketplace Offers', icon: TrendingUp },
            { id: 'wizard', label: '4. Swap Wizard', icon: Award }
          ].map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-4 px-6 font-medium text-sm flex items-center gap-2 border-b-2 transition-all ${
                  activeTab === tab.id 
                    ? 'border-indigo-500 text-indigo-400' 
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl mx-auto px-6 py-8 w-full">
        
        {/* TAB 1: WALLET / DEPOSIT */}
        {activeTab === 'wallet' && (
          <div className="space-y-8">
            {/* Keypair Card */}
            <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <h3 className="text-md font-semibold text-slate-200 mb-2 flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-indigo-400" />
                  Your Cryptographic Keypair
                </h3>
                <p className="text-xs text-slate-400 mb-6">
                  {networkMode === 'mainnet' 
                    ? '🔒 Keypair generated and retained entirely inside your browser sandbox. Your private key never leaves this tab.' 
                    : 'Ephemeral, regtest-ready cryptographic keys generated entirely offline. Your keys govern split spending and signatures.'}
                </p>

                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-1.5">Private Key (Hex)</label>
                    <div className="bg-slate-950 border border-slate-800 px-3 py-2 rounded-xl flex items-center justify-between font-mono text-xs text-indigo-300">
                      <span className="truncate mr-4">
                        {privateKey 
                          ? (revealPrivKey ? privateKey : '••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••') 
                          : 'No key loaded'}
                      </span>
                      <div className="flex gap-2 shrink-0">
                        <button onClick={() => setRevealPrivKey(!revealPrivKey)} className="text-slate-500 hover:text-slate-300">
                          {revealPrivKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                        <button onClick={() => copyToClipboard(privateKey)} className="text-slate-500 hover:text-slate-300">
                          <Copy className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-1.5">Public Key (Hex)</label>
                    <div className="bg-slate-950 border border-slate-800 px-3 py-2 rounded-xl flex items-center justify-between font-mono text-xs text-slate-300">
                      <span className="truncate mr-4">{publicKey || 'No key loaded'}</span>
                      <button onClick={() => copyToClipboard(publicKey)} className="text-slate-500 hover:text-slate-300">
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex gap-3">
                  <button
                    onClick={generateNewWallet}
                    disabled={loadingKeys}
                    className="px-4 py-2 text-xs font-semibold rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white transition-all"
                  >
                    Generate Fresh Keypair
                  </button>
                </div>
              </div>

              {/* Split Address Details */}
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-slate-200 mb-1 flex items-center gap-2">
                    <Unlock className="w-4 h-4 text-sky-400" />
                    Derived P2TR Split Address
                  </h4>
                  <p className="text-xs text-slate-400 mb-4">
                    Both Core and Knots recognize this exact taproot address. Its spend behavior is dual-sided: Scriptpath on Bitcoin, Keypath on BIP110.
                  </p>

                  <div className="bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-xl flex items-center justify-between font-mono text-xs text-sky-300 mb-4">
                    <span className="truncate mr-4 font-semibold">{splitAddress || 'Computing address...'}</span>
                    <button onClick={() => copyToClipboard(splitAddress)} className="text-slate-500 hover:text-slate-300">
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="space-y-2 text-xs text-slate-400">
                    <div className="flex justify-between border-b border-slate-900 pb-1.5">
                      <span>Internal Pubkey (X-Only):</span>
                      <span className="font-mono text-slate-200">{publicKey ? publicKey.substring(2) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Address Prefix:</span>
                      <span className="font-semibold text-amber-500">{networkMode === 'mainnet' ? 'bc1p (Bitcoin Mainnet)' : 'bcrt1p (Regtest)'}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-800 flex gap-4">
                  <div className="flex-1">
                    <span className="text-xs text-slate-400 block mb-1">Main-Chain Balance</span>
                    <span className="text-xl font-bold text-emerald-400">{(mainBalance / 100000000).toFixed(4)} {networkMode === 'mainnet' ? 'BTC' : 'rBTC'}</span>
                  </div>
                  <div className="flex-1 border-l border-slate-800 pl-4">
                    <span className="text-xs text-slate-400 block mb-1">BIP110 Balance</span>
                    <span className="text-xl font-bold text-sky-400">{(bip110Balance / 100000000).toFixed(4)} B110</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Faucet Card (Regtest only) OR Production Instructions Card */}
            {networkMode === 'regtest' ? (
              <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
                <h3 className="text-md font-semibold text-slate-200 mb-2 flex items-center gap-2">
                  <Coins className="w-5 h-5 text-amber-500" />
                  Regtest Faucet & Node Funder
                </h3>
                <p className="text-xs text-slate-400 mb-6">
                  Follow these steps to fully fund your local regtest environment and pay the P2TR split contract address, completely without using terminal commands or CLI tools.
                </p>

                <div className="space-y-6">
                  {/* Step 1: Fund Nodes */}
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-850 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="max-w-md">
                      <h4 className="text-xs font-bold text-slate-200 mb-1">Step 1: Bootstrap & Fund Node Miner Wallets</h4>
                      <p className="text-[10px] text-slate-400">Mine 110 blocks of shared history. This funds the nodes with mature coinbase rewards so that they have coins to distribute via the faucet.</p>
                    </div>
                    <button
                      onClick={() => mineBlocks('main', 110)}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all self-start sm:self-center"
                    >
                      Mine 110 blocks
                    </button>
                  </div>

                  {/* Step 2: Pay P2TR Split Address */}
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-850">
                    <h4 className="text-xs font-bold text-slate-200 mb-1">Step 2: Pay unified P2TR Split Address</h4>
                    <p className="text-[10px] text-slate-400 mb-4">Transfer simulated coins from the mature miner wallet directly into your unified P2TR split contract address (automatically mines 1 block to confirm).</p>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                      <div>
                        <label className="text-[10px] font-bold text-slate-400 block uppercase tracking-wider mb-2">Deposit Amount (Sats)</label>
                        <input
                          type="number"
                          value={faucetAmount}
                          onChange={(e) => setFaucetAmount(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      <button
                        onClick={() => runFaucet('main')}
                        disabled={faucetLoading['main']}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs rounded-lg py-2.5 transition-all disabled:opacity-50"
                      >
                        {faucetLoading['main'] ? 'Depositing...' : 'Pay from Core Faucet'}
                      </button>

                      <button
                        onClick={() => runFaucet('bip110')}
                        disabled={faucetLoading['bip110']}
                        className="w-full bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs rounded-lg py-2.5 transition-all disabled:opacity-50"
                      >
                        {faucetLoading['bip110'] ? 'Depositing...' : 'Pay from Knots Faucet'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-800 flex justify-between items-center text-xs text-slate-400">
                  <span>Want to simulate standard time or blocks?</span>
                  <div className="flex gap-2">
                    <button onClick={() => mineBlocks('main', 1)} className="hover:text-white border border-slate-800 px-3 py-1.5 rounded-lg bg-slate-950">
                      Mine 1 block (Core)
                    </button>
                    <button onClick={() => mineBlocks('bip110', 1)} className="hover:text-white border border-slate-800 px-3 py-1.5 rounded-lg bg-slate-950">
                      Mine 1 block (Knots)
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-gradient-to-tr from-amber-950/20 to-slate-900 border border-amber-900/30 rounded-2xl p-6 shadow-xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl" />
                <h3 className="text-md font-semibold text-amber-400 mb-2 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-amber-400" />
                  Mainnet Production Funding Instructions
                </h3>
                <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                  To swap real Bitcoin for BIP110-Chain assets, send your desired deposit funds directly to your **Unified P2TR Split Address** shown above.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs mt-4">
                  <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-850">
                    <h4 className="font-semibold text-slate-200 mb-1.5">For Bitcoin Mainnet</h4>
                    <p className="text-slate-400 mb-3">Send BTC to your P2TR address. Track confirmations using any major mainnet block explorer.</p>
                    <a href={`https://mempool.space/address/${splitAddress}`} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline flex items-center gap-1 font-semibold">
                      View on Mempool.space <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-850">
                    <h4 className="font-semibold text-slate-200 mb-1.5">For BIP110-Chain</h4>
                    <p className="text-slate-400 mb-3">Send your fork assets to the same P2TR address on the BIP110-Chain. Ensure transaction settles.</p>
                    <span className="text-slate-500 flex items-center gap-1 font-medium">
                      Requires BIP110 Wallet/Node connection
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* UTXOs Monitor */}
            <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
              <h3 className="text-md font-semibold text-slate-200 mb-4">Confirmed UTXO Ledger</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">Bitcoin UTXOs</h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {mainUtxos.length === 0 ? (
                      <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-800 rounded-xl">No unspent outputs.</div>
                    ) : (
                      mainUtxos.map((u, i) => (
                        <div key={i} className="bg-slate-950 border border-slate-800/60 p-2.5 rounded-xl text-xs flex justify-between items-center">
                          <span className="font-mono text-slate-400 truncate w-32">{u.txid}</span>
                          <span className="font-semibold text-emerald-400">{(u.amount / 100000000).toFixed(4)} BTC</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">BIP110 UTXOs</h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {bip110Utxos.length === 0 ? (
                      <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-800 rounded-xl">No unspent outputs.</div>
                    ) : (
                      bip110Utxos.map((u, i) => (
                        <div key={i} className="bg-slate-950 border border-slate-800/60 p-2.5 rounded-xl text-xs flex justify-between items-center">
                          <span className="font-mono text-slate-400 truncate w-32">{u.txid}</span>
                          <span className="font-semibold text-sky-400">{(u.amount / 100000000).toFixed(4)} B110</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: COIN SPLITTER */}
        {activeTab === 'splitter' && (
          <div className="space-y-8">
            <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
              <h3 className="text-md font-semibold text-slate-200 mb-2 flex items-center gap-2">
                <Layers className="w-5 h-5 text-indigo-400" />
                The Replay-Protected Coin Splitter
              </h3>
              <p className="text-xs text-slate-400 mb-6">
                Before participating in an atomic swap, users must split their coins. This ensures funded HTLC outputs cannot be maliciously replayed on the opposing chain. All transaction construction and signing occurs 100% locally in your browser.
              </p>

              {/* Destination Address Config */}
              <div className="mb-8 max-w-xl">
                <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">Destination Split Address</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={splitDestAddr}
                    onChange={(e) => setSplitDestAddr(e.target.value)}
                    placeholder="Enter offline P2TR address (e.g. your derived split address)"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <button 
                    onClick={() => setSplitDestAddr(splitAddress)}
                    className="px-3 py-2 text-xs font-semibold rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 transition-all"
                  >
                    Use Own Address
                  </button>
                </div>
              </div>

              {/* Split Panel Dual Column */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Main-Chain Column */}
                <div className="bg-slate-950/40 border border-slate-850 p-5 rounded-2xl flex flex-col justify-between">
                  <div>
                    <span className="text-xs font-bold text-emerald-400 uppercase bg-emerald-950/40 px-2 py-0.5 border border-emerald-900/60 rounded-md">
                      Main-Chain Spend Path
                    </span>
                    <h4 className="text-md font-semibold text-slate-200 mt-3 mb-1">
                      Scriptpath MAST Leaf Spend
                    </h4>
                    <p className="text-xs text-slate-400 mb-4">
                      Employs the `OP_IF` branch of the MAST tree. This is fully standard and valid on the Bitcoin Core node.
                    </p>

                    <div className="bg-slate-950 p-3 rounded-xl border border-slate-900 font-mono text-[10px] text-slate-400 space-y-1 mb-6">
                      <div>OP_IF</div>
                      <div className="text-rose-400">  OP_RETURN (Banned on Knots)</div>
                      <div>OP_ELSE</div>
                      <div>  &lt;pubKey&gt; OP_CHECKSIG</div>
                      <div>OP_ENDIF</div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <button
                      onClick={() => executeSplit('main')}
                      disabled={splitting['main']}
                      className="w-full py-2.5 text-xs font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition-all shadow-lg shadow-emerald-600/10"
                    >
                      {splitting['main'] ? 'Broadcasting...' : 'Execute Scriptpath Split (Main-Chain)'}
                    </button>

                    {splitResults['main'] && (
                      <div className={`p-3 rounded-xl border text-xs font-mono ${
                        splitResults['main'].success 
                          ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300' 
                          : 'bg-rose-950/40 border-rose-800 text-rose-300'
                      }`}>
                        {splitResults['main'].success ? (
                          <div className="truncate">Success! Txid: {splitResults['main'].txid}</div>
                        ) : (
                          <div>Failed: {splitResults['main'].error}</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Knots/BIP110 Column */}
                <div className="bg-slate-950/40 border border-slate-850 p-5 rounded-2xl flex flex-col justify-between">
                  <div>
                    <span className="text-xs font-bold text-sky-400 uppercase bg-sky-950/40 px-2 py-0.5 border border-sky-900/60 rounded-md">
                      BIP110 consensus Path
                    </span>
                    <h4 className="text-md font-semibold text-slate-200 mt-3 mb-1">
                      Keypath Tweaked Key Spend
                    </h4>
                    <p className="text-xs text-slate-400 mb-4">
                      Spends the P2TR UTXO using the tweaked keypath signature. Since there are zero script opcodes, it compiles smoothly on BIP110-Chain.
                    </p>

                    <div className="bg-slate-950 p-3 rounded-xl border border-slate-900 font-mono text-[10px] text-slate-400 space-y-1 mb-6">
                      <div className="text-sky-400">// Pure keypath spend utilizing:</div>
                      <div>Tweaked Key: P_tweaked = P_internal + H(P_internal || MerkleRoot)</div>
                      <div>Witness: [ &lt;Schnorr Signature&gt; ]</div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <button
                      onClick={() => executeSplit('bip110')}
                      disabled={splitting['bip110']}
                      className="w-full py-2.5 text-xs font-semibold rounded-xl bg-sky-600 hover:bg-sky-500 text-white transition-all shadow-lg shadow-sky-600/10"
                    >
                      {splitting['bip110'] ? 'Broadcasting...' : 'Execute Keypath Split (BIP110-Chain)'}
                    </button>

                    {splitResults['bip110'] && (
                      <div className={`p-3 rounded-xl border text-xs font-mono ${
                        splitResults['bip110'].success 
                          ? 'bg-sky-950/40 border-sky-800 text-sky-300' 
                          : 'bg-rose-950/40 border-rose-800 text-rose-300'
                      }`}>
                        {splitResults['bip110'].success ? (
                          <div className="truncate">Success! Txid: {splitResults['bip110'].txid}</div>
                        ) : (
                          <div>Failed: {splitResults['bip110'].error}</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: MARKETPLACE LOBBY */}
        {activeTab === 'marketplace' && (
          <div className="space-y-8">
            {/* Publish Form */}
            <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
              <h3 className="text-md font-semibold text-slate-200 mb-2 flex items-center gap-2">
                <Plus className="w-5 h-5 text-indigo-400" />
                Publish Swap Offer (Initiator)
              </h3>
              <p className="text-xs text-slate-400 mb-6">
                Publish a sell contract. You sell BIP110 coins in exchange for Main-Chain Bitcoin.
              </p>

              <form onSubmit={handleCreateOffer} className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
                <div>
                  <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">Sell Amount (B110 Sats)</label>
                  <input
                    type="number"
                    value={newOfferB110}
                    onChange={(e) => setNewOfferB110(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">Buy Amount (BTC Sats)</label>
                  <input
                    type="number"
                    value={newOfferBtc}
                    onChange={(e) => setNewOfferBtc(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:outline-none"
                  />
                </div>

                {networkMode === 'regtest' ? (
                  <div>
                    <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">Preimage Secret (UTF-8)</label>
                    <input
                      type="text"
                      value={newOfferPreimage}
                      onChange={(e) => setNewOfferPreimage(e.target.value)}
                      placeholder="Simulation Preimage"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-slate-200 focus:outline-none font-mono"
                    />
                  </div>
                ) : (
                  <div className="bg-slate-950 p-3 rounded-xl border border-slate-850 flex items-center gap-2 text-[10px] text-amber-400 font-semibold h-11">
                    <Lock className="w-4 h-4" />
                    Preimage generated securely using Web Crypto API.
                  </div>
                )}

                <div>
                  <button
                    type="submit"
                    disabled={publishing}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm rounded-xl py-2.5 shadow-lg shadow-indigo-600/10 transition-all"
                  >
                    {publishing ? 'Publishing...' : 'Publish Swap Offer'}
                  </button>
                </div>
              </form>
            </div>

            {/* Marketplace Grid */}
            <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
              <h3 className="text-md font-semibold text-slate-200 mb-6">Marketplace Offers ({networkMode === 'mainnet' ? 'Mainnet' : 'Regtest'})</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {offersList.length === 0 ? (
                  <div className="col-span-2 text-center py-12 text-slate-500 border border-dashed border-slate-800 rounded-2xl">
                    No active offers in the orderbook. Publish one above!
                  </div>
                ) : (
                  offersList.map((o) => (
                    <div 
                      key={o.id} 
                      className={`bg-slate-950 border p-5 rounded-2xl flex flex-col justify-between transition-all ${
                        selectedOffer?.id === o.id ? 'border-indigo-500 shadow-lg shadow-indigo-500/5' : 'border-slate-850 hover:border-slate-800'
                      }`}
                    >
                      <div>
                        <div className="flex justify-between items-start mb-4">
                          <div>
                            <span className="text-xs font-mono text-slate-400 block">Offer ID: #{o.id}</span>
                            <span className="text-xs text-slate-500">Created: {new Date(o.createdAt).toLocaleTimeString()}</span>
                          </div>
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${
                            o.status === 'OPEN' ? 'bg-emerald-950/40 border-emerald-900/60 text-emerald-400' :
                            o.status === 'ACCEPTED' ? 'bg-indigo-950/40 border-indigo-900/60 text-indigo-400' :
                            'bg-amber-950/40 border-amber-900/60 text-amber-400'
                          }`}>
                            {o.status}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-4 mb-4 text-xs">
                          <div>
                            <span className="text-slate-400 block">Offer (Sell)</span>
                            <span className="font-semibold text-sky-400">{(o.initiatorB110Amount / 100000000).toFixed(4)} B110</span>
                          </div>
                          <div>
                            <span className="text-slate-400 block">Asking (Buy)</span>
                            <span className="font-semibold text-emerald-400">{(o.acceptorBtcAmount / 100000000).toFixed(4)} BTC</span>
                          </div>
                        </div>

                        <div className="text-[10px] space-y-1.5 border-t border-slate-900 pt-3">
                          <div className="flex justify-between">
                            <span className="text-slate-500">Initiator Pubkey:</span>
                            <span className="font-mono text-slate-300 truncate w-40">{o.initiatorPubKey}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-500">Hashlock (SHA256):</span>
                            <span className="font-mono text-slate-300 truncate w-40">{o.hashLock}</span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 flex gap-3">
                        <button
                          onClick={() => {
                            setSelectedOffer(o);
                            setActiveTab('wizard');
                          }}
                          className="flex-1 py-2 text-xs font-semibold rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 transition-all"
                        >
                          View Wizard
                        </button>
                        {o.status === 'OPEN' && o.initiatorPubKey !== publicKey && (
                          <button
                            onClick={() => acceptOffer(o.id)}
                            className="flex-1 py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg shadow-indigo-600/10"
                          >
                            Accept Offer
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: SWAP WIZARD */}
        {activeTab === 'wizard' && (
          <div className="space-y-8">
            {!selectedOffer ? (
              <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-8 shadow-xl text-center">
                <Award className="w-12 h-12 text-slate-500 mx-auto mb-4" />
                <h3 className="text-md font-semibold text-slate-300 mb-1">No Active Swap Selected</h3>
                <p className="text-xs text-slate-500 mb-6">Go to the Marketplace to accept or open an outstanding swap contract.</p>
                <button onClick={() => setActiveTab('marketplace')} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold rounded-xl text-white transition-all">
                  Go to Marketplace
                </button>
              </div>
            ) : (
              <div className="space-y-8">
                {/* Wizard Header Card */}
                <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                  <div>
                    <span className="text-[10px] font-bold text-indigo-400 bg-indigo-950/40 border border-indigo-900/60 px-2.5 py-0.5 rounded-full uppercase tracking-wider mb-2 inline-block">
                      Active Swap: #{selectedOffer.id} ({selectedOffer.networkMode})
                    </span>
                    <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2 mt-1">
                      Trading B110 for Bitcoin
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Coordinating escrow claims using pure, hyper-optimized Taproot MAST script leaves. All transactions are locally constructed and securely signed in your browser.
                    </p>
                  </div>

                  <div className="flex gap-4">
                    <div className="bg-slate-950 border border-slate-850 px-4 py-2.5 rounded-xl text-center">
                      <span className="text-[10px] text-slate-500 uppercase block font-semibold">Sell Volume</span>
                      <span className="text-sm font-bold text-sky-400">{(selectedOffer.initiatorB110Amount / 100000000).toFixed(4)} B110</span>
                    </div>
                    <div className="bg-slate-950 border border-slate-850 px-4 py-2.5 rounded-xl text-center">
                      <span className="text-[10px] text-slate-500 uppercase block font-semibold">Buy Volume</span>
                      <span className="text-sm font-bold text-emerald-400">{(selectedOffer.acceptorBtcAmount / 100000000).toFixed(4)} BTC</span>
                    </div>
                  </div>
                </div>

                {/* State Machine Step Tracker */}
                <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                  {[
                    { step: 1, title: 'Bilateral Split', desc: 'Secure inputs from replay risk', activeStatus: ['OPEN', 'ACCEPTED'] },
                    { step: 2, title: 'B110 Locked', desc: 'Initiator funds B110 HTLC', activeStatus: ['ACCEPTED'] },
                    { step: 3, title: 'BTC Locked', desc: 'Acceptor funds BTC HTLC', activeStatus: ['FUNDED_INITIATOR'] },
                    { step: 4, title: 'Claim BTC', desc: 'Initiator claims with preimage', activeStatus: ['FUNDED_ACCEPTOR'] },
                    { step: 5, title: 'Claim B110', desc: 'Acceptor extracts & claims', activeStatus: ['CLAIMED'] }
                  ].map(s => {
                    const isPassed = 
                      (s.step === 1 && selectedOffer.status !== 'OPEN') ||
                      (s.step === 2 && ['FUNDED_INITIATOR', 'FUNDED_ACCEPTOR', 'CLAIMED'].includes(selectedOffer.status)) ||
                      (s.step === 3 && ['FUNDED_ACCEPTOR', 'CLAIMED'].includes(selectedOffer.status)) ||
                      (s.step === 4 && selectedOffer.status === 'CLAIMED' && selectedOffer.preimage) ||
                      (s.step === 5 && selectedOffer.status === 'CLAIMED' && !selectedOffer.preimage);

                    const isActive = s.activeStatus.includes(selectedOffer.status);

                    return (
                      <div 
                        key={s.step} 
                        className={`border p-4 rounded-2xl transition-all ${
                          isActive 
                            ? 'bg-indigo-950/20 border-indigo-500 shadow-md shadow-indigo-500/5' 
                            : isPassed 
                            ? 'bg-slate-900/20 border-slate-800 opacity-60' 
                            : 'bg-slate-950 border-slate-900 opacity-30'
                        }`}
                      >
                        <span className={`text-xs font-bold block mb-1.5 ${isActive ? 'text-indigo-400' : isPassed ? 'text-emerald-400' : 'text-slate-500'}`}>
                          Step {s.step}
                        </span>
                        <h4 className="text-xs font-bold text-slate-200 mb-1">{s.title}</h4>
                        <p className="text-[10px] text-slate-400 leading-normal">{s.desc}</p>
                      </div>
                    )
                  })}
                </div>

                {/* Interactive Steps Action Board */}
                <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
                  <h3 className="text-md font-semibold text-slate-200 mb-4 flex items-center gap-2">
                    <Activity className="w-5 h-5 text-indigo-400" />
                    Wizard Actions Dashboard
                  </h3>

                  <div className="space-y-6">
                    {/* STEP 1 Checkbox */}
                    <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                      <div>
                        <h4 className="text-xs font-bold text-slate-200 mb-0.5">Bilateral Replay-Proof Splitting Verification</h4>
                        <p className="text-[10px] text-slate-400 font-medium text-amber-500">
                          {selectedOffer.networkMode === 'mainnet' 
                            ? '🔒 Swap operates on real Mainnet. Double-check split transactions settle before proceeding.' 
                            : 'Ensure both players have successfully split their balances to prevent replaying HTLC inputs.'}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <span className={`text-xs font-semibold px-2 py-1 rounded border ${mainBalance > 0 ? 'bg-emerald-950/40 border-emerald-900/60 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>
                          {mainBalance > 0 ? 'BTC Split Ready' : 'BTC Split Pending'}
                        </span>
                        <span className={`text-xs font-semibold px-2 py-1 rounded border ${bip110Balance > 0 ? 'bg-sky-950/40 border-sky-900/60 text-sky-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>
                          {bip110Balance > 0 ? 'B110 Split Ready' : 'B110 Split Pending'}
                        </span>
                      </div>
                    </div>

                    {/* Step 2: Lock B110 */}
                    {selectedOffer.status === 'ACCEPTED' && (
                      <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl flex justify-between items-center">
                        <div>
                          <span className="text-[10px] text-slate-500 block">Pending Action</span>
                          <h4 className="text-xs font-bold text-slate-200">Lock BIP110 Coins into HTLC Contract</h4>
                        </div>
                        <button
                          onClick={() => runWizardStep(2)}
                          className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all"
                        >
                          Lock & Fund B110 HTLC
                        </button>
                      </div>
                    )}

                    {/* Step 3: Lock BTC */}
                    {selectedOffer.status === 'FUNDED_INITIATOR' && (
                      <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl flex justify-between items-center">
                        <div>
                          <span className="text-[10px] text-slate-500 block">Pending Action</span>
                          <h4 className="text-xs font-bold text-slate-200">Lock Bitcoin Coins into HTLC Contract</h4>
                        </div>
                        <button
                          onClick={() => runWizardStep(3)}
                          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all"
                        >
                          Lock & Fund BTC HTLC
                        </button>
                      </div>
                    )}

                    {/* Step 4: Claim BTC */}
                    {selectedOffer.status === 'FUNDED_ACCEPTOR' && (
                      <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl flex justify-between items-center">
                        <div>
                          <span className="text-[10px] text-slate-500 block">Pending Action</span>
                          <h4 className="text-xs font-bold text-slate-200">Initiator Claims BTC (Revealing Preimage)</h4>
                        </div>
                        <button
                          onClick={() => runWizardStep(4)}
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all"
                        >
                          Claim BTC (Reveal Secret)
                        </button>
                      </div>
                    )}

                    {/* Step 5: Claim B110 */}
                    {selectedOffer.status === 'CLAIMED' && selectedOffer.preimage && (
                      <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl flex justify-between items-center">
                        <div>
                          <span className="text-[10px] text-slate-500 block">Pending Action</span>
                          <h4 className="text-xs font-bold text-slate-200">Acceptor Claims B110 using revealed Preimage</h4>
                          <p className="text-[10px] text-amber-400 font-mono mt-1">Found Preimage: "{selectedOffer.preimage}"</p>
                        </div>
                        <button
                          onClick={() => runWizardStep(5)}
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all"
                        >
                          Claim B110 (Extract Secret)
                        </button>
                      </div>
                    )}

                    {/* Swap Completed / Final State */}
                    {selectedOffer.status === 'CLAIMED' && !selectedOffer.preimage && (
                      <div className="bg-emerald-950/20 border border-emerald-900/60 p-5 rounded-xl text-center">
                        <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                        <h4 className="text-sm font-bold text-emerald-200">Swap Execution Completed!</h4>
                        <p className="text-[10px] text-slate-400">All coins have successfully switched owners on both blockchains using replay-protected Taproot MAST leaves.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 py-6 bg-slate-950 text-xs text-slate-500 text-center mt-auto">
        <div className="max-w-7xl mx-auto px-6">
          <p>© 2026 BIP110 Double-Sided Replay-Protected Swap Portal. Standard Taproot Script Leaves on Bitcoin Core & Knots nodes.</p>
        </div>
      </footer>
    </div>
  );
}
