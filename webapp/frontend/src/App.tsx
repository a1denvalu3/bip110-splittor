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
  Flame,
  UserCheck,
  User,
  Check
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
  backingTxid?: string;
  backingVout?: number;
  backingChain?: 'main' | 'bip110';
  isPending?: boolean;
  acceptorClaimed?: boolean;
}

export default function App() {
  // Navigation & Network Mode
  const [activeTab, setActiveTab] = useState<'wallet' | 'splitter' | 'marketplace' | 'my-offers' | 'wizard'>('wallet');
  
  // Get initial networkMode from URL query params or environment variables immediately
  const getInitialNetworkMode = (): 'mainnet' | 'regtest' => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlNetwork = urlParams.get('network');
    if (urlNetwork === 'mainnet' || urlNetwork === 'regtest') {
      return urlNetwork;
    }
    const envNetwork = import.meta.env.VITE_NETWORK_MODE;
    if (envNetwork === 'mainnet' || envNetwork === 'regtest') {
      return envNetwork;
    }
    return 'regtest'; // Default fallback
  };

  const [networkMode, setNetworkMode] = useState<'mainnet' | 'regtest'>(getInitialNetworkMode());
  const [isNetworkLocked, setIsNetworkLocked] = useState<boolean>(false);

  // Wallet State
  const [privateKey, setPrivateKey] = useState<string>('');
  const [publicKey, setPublicKey] = useState<string>('');
  const [splitAddress, setSplitAddress] = useState<string>('');
  const [ownAddress, setOwnAddress] = useState<string>('');
  const [revealPrivKey, setRevealPrivKey] = useState<boolean>(false);
  const [loadingKeys, setLoadingKeys] = useState<boolean>(false);

  // Balances of split contract address
  const [mainBalance, setMainBalance] = useState<number>(0);
  const [bip110Balance, setBip110Balance] = useState<number>(0);
  const [mainUtxos, setMainUtxos] = useState<UTXO[]>([]);
  const [bip110Utxos, setBip110Utxos] = useState<UTXO[]>([]);

  // Balances of own split destination address (already split)
  const [ownMainBalance, setOwnMainBalance] = useState<number>(0);
  const [ownBip110Balance, setOwnBip110Balance] = useState<number>(0);
  const [ownMainUtxos, setOwnMainUtxos] = useState<UTXO[]>([]);
  const [ownBip110Utxos, setOwnBip110Utxos] = useState<UTXO[]>([]);

  // Selected UTXO to split
  const [nodeInfo, setNodeInfo] = useState<{ mainHeight: number; bip110Height: number }>({ mainHeight: 0, bip110Height: 0 });
  const [selectedUtxoToSplit, setSelectedUtxoToSplit] = useState<UTXO | null>(null);
  const [splittingBilateral, setSplittingBilateral] = useState<boolean>(false);
  const [bilateralSplitResult, setBilateralSplitResult] = useState<{
    mainSuccess?: boolean;
    mainTxid?: string;
    mainError?: string;
  } | null>(null);

  // Faucet & Block Mining (Regtest only)
  const [faucetAmount, setFaucetAmount] = useState<string>('1000000000'); // 10 BTC/B110 in sats
  const [faucetLoading, setFaucetLoading] = useState<Record<string, boolean>>({});

  // Marketplace State
  const [offersList, setOffersList] = useState<Offer[]>([]);
  const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null);
  
  // Offer Form
  const [newOfferB110, setNewOfferB110] = useState<string>(''); // Auto-calculated from split UTXO
  const [newOfferBtc, setNewOfferBtc] = useState<string>('50000000'); // 0.5 BTC
  const [newOfferPreimage, setNewOfferPreimage] = useState<string>('secret-swap-preimage-proof');
  const [newOfferLocktime, setNewOfferLocktime] = useState<string>('2000');
  const [sellAmountSats, setSellAmountSats] = useState<string>('');
  const [premiumPercent, setPremiumPercent] = useState<string>('0');
  const [publishing, setPublishing] = useState<boolean>(false);
  const [selectedBackingUtxoKey, setSelectedBackingUtxoKey] = useState<string>('');

  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Helpers
  const getNetwork = (): bitcoin.Network => {
    return networkMode === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.regtest;
  };

  // Helper to determine if a BIP110-Chain contract UTXO is split
  // It is split if it exists on BIP110 but does NOT exist on the Main-Chain (meaning the Main-Chain has successfully spent it!)
  const isBip110UtxoSplit = (u: UTXO): boolean => {
    return !mainUtxos.some(mainU => mainU.txid === u.txid && mainU.vout === u.vout);
  };

  // Helper to get total BIP110 split balance
  const getBip110SplitBalance = (): number => {
    const splitContractB110 = bip110Utxos
      .filter(u => isBip110UtxoSplit(u))
      .reduce((sum, u) => sum + u.amount, 0);
    return splitContractB110 + ownBip110Balance;
  };

  // Helper to get total BIP110 unsplit balance
  const getBip110UnsplitBalance = (): number => {
    return bip110Utxos
      .filter(u => !isBip110UtxoSplit(u))
      .reduce((sum, u) => sum + u.amount, 0);
  };

  // Helper to get all available split UTXOs on either chain/address
  const getAvailableSplitUtxos = () => {
    const list: { txid: string; vout: number; amount: number; chain: 'main' | 'bip110'; address: string }[] = [];
    
    // 1. Add BIP110-Chain split UTXOs on ownAddress
    ownBip110Utxos.forEach(u => {
      if (!list.some(item => item.txid === u.txid && item.vout === u.vout)) {
        list.push({ txid: u.txid, vout: u.vout, amount: u.amount, chain: 'bip110', address: ownAddress });
      }
    });
    
    // 2. Add BIP110-Chain split UTXOs on splitAddress
    bip110Utxos.filter(u => isBip110UtxoSplit(u)).forEach(u => {
      if (!list.some(item => item.txid === u.txid && item.vout === u.vout)) {
        list.push({ txid: u.txid, vout: u.vout, amount: u.amount, chain: 'bip110', address: splitAddress });
      }
    });

    // 3. Add Main-Chain split UTXOs on ownAddress
    ownMainUtxos.forEach(u => {
      if (!list.some(item => item.txid === u.txid && item.vout === u.vout)) {
        list.push({ txid: u.txid, vout: u.vout, amount: u.amount, chain: 'main', address: ownAddress });
      }
    });

    return list;
  };

  // Helper to get matching split UTXO on the other chain for taker to accept an offer
  const getMatchingTakerUtxo = (o: Offer): UTXO | null => {
    console.log("getMatchingTakerUtxo - Offer ID:", o.id, "BackingChain:", o.backingChain, "B110Amount:", o.initiatorB110Amount, "BtcAmount:", o.acceptorBtcAmount);
    console.log("Taker Split UTXOs - BTC (ownMainUtxos):", ownMainUtxos);
    console.log("Taker Split UTXOs - BIP110 (ownBip110Utxos):", ownBip110Utxos);
    console.log("Taker Split UTXOs - BIP110 on splitAddress (isBip110UtxoSplit):", bip110Utxos.filter(u => isBip110UtxoSplit(u)));

    if (o.backingChain === 'bip110') {
      const match = ownMainUtxos.find(u => u.amount >= o.acceptorBtcAmount);
      return match || null;
    } else if (o.backingChain === 'main') {
      const splitBip110Utxos = [
        ...ownBip110Utxos,
        ...bip110Utxos.filter(u => isBip110UtxoSplit(u))
      ];
      // De-duplicate if any overlap
      const uniqueBip110Utxos = splitBip110Utxos.filter((v, i, a) => a.findIndex(t => t.txid === v.txid && t.vout === v.vout) === i);
      const match = uniqueBip110Utxos.find(u => u.amount >= o.initiatorB110Amount);
      return match || null;
    } else {
      // Robust Fallback (for older offers without backingChain explicitly populated)
      // Check if taker has a matching split UTXO on EITHER chain!
      const btcMatch = ownMainUtxos.find(u => u.amount >= o.acceptorBtcAmount);
      if (btcMatch) return btcMatch;

      const splitBip110Utxos = [
        ...ownBip110Utxos,
        ...bip110Utxos.filter(u => isBip110UtxoSplit(u))
      ];
      const uniqueBip110Utxos = splitBip110Utxos.filter((v, i, a) => a.findIndex(t => t.txid === v.txid && t.vout === v.vout) === i);
      const b110Match = uniqueBip110Utxos.find(u => u.amount >= o.initiatorB110Amount);
      return b110Match || null;
    }
  };

  const getActiveStepUtxo = (step: number): any => {
    if (!selectedOffer) return null;
    const isBtcBacking = selectedOffer.backingChain === 'main';

    if (step === 2) {
      let utxo;
      if (isBtcBacking) {
        utxo = ownMainUtxos.find(u => u.txid === selectedOffer.backingTxid && u.vout === selectedOffer.backingVout);
      } else {
        utxo = bip110Utxos.find(u => u.txid === selectedOffer.backingTxid && u.vout === selectedOffer.backingVout)
          || ownBip110Utxos.find(u => u.txid === selectedOffer.backingTxid && u.vout === selectedOffer.backingVout);
      }
      return utxo || { txid: selectedOffer.backingTxid, vout: selectedOffer.backingVout, amount: isBtcBacking ? selectedOffer.acceptorBtcAmount : selectedOffer.initiatorB110Amount };
    }

    if (step === 3) {
      if (isBtcBacking) {
        const splitB110Utxos = [
          ...ownBip110Utxos,
          ...bip110Utxos.filter(u => isBip110UtxoSplit(u))
        ];
        const uniqueBip110Utxos = splitB110Utxos.filter((v: any, i: any, a: any) => a.findIndex((t: any) => t.txid === v.txid && t.vout === v.vout) === i);
        return uniqueBip110Utxos[0] || null;
      } else {
        return ownMainUtxos[0] || null;
      }
    }

    return null;
  };

  const handleSellAmountChange = (valStr: string) => {
    setSellAmountSats(valStr);
    const amountVal = Number(valStr) || 0;
    const premium = Number(premiumPercent) || 0;
    const calculatedBuy = String(Math.round(amountVal * (1 + premium / 100)));
    
    const utxo = getAvailableSplitUtxos().find(u => `${u.txid}-${u.vout}` === selectedBackingUtxoKey);
    if (utxo) {
      if (utxo.chain === 'main') {
        setNewOfferBtc(valStr); // Selling BTC
        setNewOfferB110(calculatedBuy); // Buying B110
      } else {
        setNewOfferB110(valStr); // Selling B110
        setNewOfferBtc(calculatedBuy); // Buying BTC
      }
    }
  };

  const handlePremiumChange = (valStr: string) => {
    setPremiumPercent(valStr);
    const premium = Number(valStr) || 0;
    const amountVal = Number(sellAmountSats) || 0;
    const calculatedBuy = String(Math.round(amountVal * (1 + premium / 100)));

    const utxo = getAvailableSplitUtxos().find(u => `${u.txid}-${u.vout}` === selectedBackingUtxoKey);
    if (utxo) {
      if (utxo.chain === 'main') {
        setNewOfferB110(calculatedBuy); // Buying B110
      } else {
        setNewOfferBtc(calculatedBuy); // Buying BTC
      }
    }
  };

  const executeRefund = async () => {
    if (!selectedOffer) return;
    const net = getNetwork();
    const isInitiator = selectedOffer.initiatorPubKey === publicKey;
    const isBtcBacking = selectedOffer.backingChain === 'main';

    try {
      if (isInitiator) {
        // Initiator refunds the first HTLC after lockTime (T)
        const targetChain = isBtcBacking ? 'main' : 'bip110';
        const targetAddress = isBtcBacking ? selectedOffer.btcHtlcAddress! : selectedOffer.b110HtlcAddress!;
        const currentHeight = isBtcBacking ? nodeInfo.mainHeight : nodeInfo.bip110Height;

        if (currentHeight < selectedOffer.lockTime) {
          throw new Error(`Cannot refund yet: current block height is ${currentHeight}, but refund locktime is ${selectedOffer.lockTime}. Please mine more blocks first.`);
        }

        showToast(`Locating funded UTXO on ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC address...`, 'info');

        const htlcUtxosRes = await axios.post(`${API_BASE}/wallet/utxos`, {
          address: targetAddress,
          chain: targetChain,
          networkMode
        });
        const utxo = htlcUtxosRes.data.utxos[0];
        if (!utxo) throw new Error("No funded UTXO found on your HTLC contract. Has it already been claimed or refunded?");

        showToast("Signing Refund transaction using Taproot MAST RefundLeaf...", 'info');

        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        
        // Reconstruct the HTLC payment details
        const recipientPubKey = isBtcBacking 
          ? Buffer.from(selectedOffer.initiatorPubKey, 'hex') 
          : Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const refundPubKey = isBtcBacking 
          ? Buffer.from(selectedOffer.acceptorPubKey!, 'hex') 
          : Buffer.from(selectedOffer.initiatorPubKey, 'hex');

        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          recipientPubKey,
          refundPubKey,
          selectedOffer.lockTime,
          net
        );

        // Build and sign refund transaction
        const tx = PureBitcoinSwap.buildHtlcRefundTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - 2000), // Standard fee deduction
          ownAddress, // Refund goes back to user's safe ownAddress
          Buffer.from(selectedOffer.hashLock, 'hex'),
          recipientPubKey,
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          selectedOffer.lockTime,
          net
        );

        // Broadcast raw tx
        await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        // Update Offer State on server
        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, {
          status: 'REFUNDED'
        });

        setSelectedOffer(updateRes.data);
        showToast("HTLC successfully refunded! Your coins have been reclaimed.", "success");
      } 
      
      else {
        // Acceptor refunds the second HTLC after lockTime / 2 (T/2)
        const targetChain = isBtcBacking ? 'bip110' : 'main';
        const targetAddress = isBtcBacking ? selectedOffer.b110HtlcAddress! : selectedOffer.btcHtlcAddress!;
        const currentHeight = isBtcBacking ? nodeInfo.bip110Height : nodeInfo.mainHeight;
        const requiredLockTime = Math.round(selectedOffer.lockTime / 2);

        if (currentHeight < requiredLockTime) {
          throw new Error(`Cannot refund yet: current block height is ${currentHeight}, but refund locktime is ${requiredLockTime}. Please mine more blocks first.`);
        }

        showToast(`Locating funded UTXO on ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC address...`, 'info');

        const htlcUtxosRes = await axios.post(`${API_BASE}/wallet/utxos`, {
          address: targetAddress,
          chain: targetChain,
          networkMode
        });
        const utxo = htlcUtxosRes.data.utxos[0];
        if (!utxo) throw new Error("No funded UTXO found on your HTLC contract. Has it already been claimed or refunded?");

        showToast("Signing Refund transaction using Taproot MAST RefundLeaf...", 'info');

        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        
        // Reconstruct second HTLC payment details
        const secondHtlcRecipient = isBtcBacking 
          ? Buffer.from(selectedOffer.acceptorPubKey!, 'hex') 
          : Buffer.from(selectedOffer.initiatorPubKey, 'hex');
        const secondHtlcRefund = isBtcBacking 
          ? Buffer.from(selectedOffer.initiatorPubKey, 'hex') 
          : Buffer.from(selectedOffer.acceptorPubKey!, 'hex');

        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          secondHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        // Build and sign refund transaction
        const tx = PureBitcoinSwap.buildHtlcRefundTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - 2000), // Standard fee deduction
          ownAddress, // Refund goes back to user's safe ownAddress
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          selectedOffer.lockTime,
          net
        );

        // Broadcast raw tx
        await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        // Update Offer State on server
        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, {
          status: 'REFUNDED'
        });

        setSelectedOffer(updateRes.data);
        showToast("HTLC successfully refunded! Your coins have been reclaimed.", "success");
      }

      await fetchBalances();
    } catch (err: any) {
      showToast(`Refund failed: ${err.message}`, "error");
    }
  };

  // Synchronize networkMode with backend config on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await axios.get(`${API_BASE}/config`);
        if (res.data && (res.data.networkMode === 'mainnet' || res.data.networkMode === 'regtest')) {
          setNetworkMode(res.data.networkMode);
          setIsNetworkLocked(true);
        }
      } catch (err) {
        console.warn("Backend /api/config unavailable, using default network mode:", err);
      }
    };
    fetchConfig();
  }, []);

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

      // Compute ownAddress
      const net = getNetwork();
      const ownPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(savedPub, 'hex')),
        network: net
      });
      setOwnAddress(ownPayment.address!);
    } else {
      generateNewWallet();
    }
    fetchNodeInfo();
    fetchOffers();
  }, [networkMode]);

  // Sync balances and UTXOs when splitAddress, ownAddress or activeTab/networkMode changes
  useEffect(() => {
    if (splitAddress && ownAddress) {
      fetchBalances();
    }
  }, [splitAddress, ownAddress, activeTab, networkMode]);

  // Poll node info, marketplace offers, and wallet balances/UTXOs every 3 seconds for active, real-time updates
  useEffect(() => {
    const interval = setInterval(() => {
      fetchNodeInfo();
      fetchOffers();
      if (splitAddress && ownAddress) {
        fetchBalances();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [networkMode, splitAddress, ownAddress]);

  // Keep selectedOffer in sync with the polled offersList to transition wizard steps in real-time
  useEffect(() => {
    if (selectedOffer) {
      const updated = offersList.find(o => o.id === selectedOffer.id);
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedOffer)) {
        setSelectedOffer(updated);
      }
    }
  }, [offersList, selectedOffer]);

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
      const ownPayment = bitcoin.payments.p2tr({
        internalPubkey: PureBitcoinSwap.getXOnlyPubKey(pubKeyBuffer),
        network: net
      });

      const privHex = Buffer.from(pair.privateKey!).toString('hex');
      const pubHex = pubKeyBuffer.toString('hex');
      const addrStr = splitPayment.payment.address!;
      const ownAddrStr = ownPayment.address!;

      setPrivateKey(privHex);
      setPublicKey(pubHex);
      setSplitAddress(addrStr);
      setOwnAddress(ownAddrStr);

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
    if (!splitAddress || !ownAddress) return;
    try {
      // 1. Fetch Contract UTXOs (Unsplit)
      const resMain = await axios.post(`${API_BASE}/wallet/utxos`, { address: splitAddress, chain: 'main', networkMode });
      setMainUtxos(resMain.data.utxos);
      const totalMain = resMain.data.utxos.reduce((sum: number, u: UTXO) => sum + u.amount, 0);
      setMainBalance(totalMain);

      const resBip110 = await axios.post(`${API_BASE}/wallet/utxos`, { address: splitAddress, chain: 'bip110', networkMode });
      setBip110Utxos(resBip110.data.utxos);
      const totalBip110 = resBip110.data.utxos.reduce((sum: number, u: UTXO) => sum + u.amount, 0);
      setBip110Balance(totalBip110);

      // 2. Fetch Own Keypath Address UTXOs (Already split)
      const resOwnMain = await axios.post(`${API_BASE}/wallet/utxos`, { address: ownAddress, chain: 'main', networkMode });
      setOwnMainUtxos(resOwnMain.data.utxos);
      const totalOwnMain = resOwnMain.data.utxos.reduce((sum: number, u: UTXO) => sum + u.amount, 0);
      setOwnMainBalance(totalOwnMain);

      const resOwnBip110 = await axios.post(`${API_BASE}/wallet/utxos`, { address: ownAddress, chain: 'bip110', networkMode });
      setOwnBip110Utxos(resOwnBip110.data.utxos);
      const totalOwnBip110 = resOwnBip110.data.utxos.reduce((sum: number, u: UTXO) => sum + u.amount, 0);
      setOwnBip110Balance(totalOwnBip110);

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

  const executeBilateralSplit = async () => {
    if (!selectedUtxoToSplit) {
      showToast('Please select an unsplit UTXO to split!', 'error');
      return;
    }
    if (!ownAddress) {
      showToast('No split destination address computed.', 'error');
      return;
    }

    setSplittingBilateral(true);
    setBilateralSplitResult(null);

    const net = getNetwork();
    const ownerKeyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
    const pubKey = Buffer.from(ownerKeyPair.publicKey);
    const splitPayment = PureBitcoinSwap.createSplitPayment(pubKey, net);

    const inputSats = BigInt(selectedUtxoToSplit.amount);
    const fee = BigInt(2000);
    const outputSats = inputSats - fee;

    let mainTxid = '';
    let mainError = '';
    let mainSuccess = false;

    // We ONLY perform the script-spend split spend on the Main-Chain (Bitcoin Core)
    // The previous pre-fork UTXO will remain valid and unspent on BIP110-Chain because the split-spend is rejected.
    try {
      const txMain = PureBitcoinSwap.buildScriptpathSplitTx(
        ownerKeyPair,
        selectedUtxoToSplit.txid,
        selectedUtxoToSplit.vout,
        inputSats,
        outputSats,
        ownAddress,
        splitPayment.payment,
        splitPayment.script,
        net
      );

      const resMain = await axios.post(`${API_BASE}/tx/broadcast`, {
        hex: txMain.toHex(),
        chain: 'main',
        networkMode,
        isSplit: true
      });

      mainTxid = resMain.data.txid;
      mainSuccess = true;
    } catch (err: any) {
      mainError = err.message;
    }

    setBilateralSplitResult({
      mainSuccess,
      mainTxid,
      mainError
    });

    if (mainSuccess) {
      showToast('Scriptpath split successfully broadcasted on Main-Chain! BIP110 previous UTXO is now marked as split.', 'success');
    } else {
      showToast('Bilateral split failed: ' + mainError, 'error');
    }

    setSelectedUtxoToSplit(null);
    await fetchBalances();
    setSplittingBilateral(false);
  };

  const handleCreateOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishing(true);
    try {
      if (!selectedBackingUtxoKey) {
        throw new Error("Please select a split UTXO to back this offer.");
      }
      const [backingTxid, voutStr] = selectedBackingUtxoKey.split('-');
      const backingVout = Number(voutStr);
      
      const utxo = getAvailableSplitUtxos().find(u => u.txid === backingTxid && u.vout === backingVout);
      const backingChain = utxo?.chain;

      if (!utxo) {
        throw new Error("Please select a split UTXO to back this offer.");
      }

      const sellAmount = Number(sellAmountSats);
      if (!sellAmount || sellAmount <= 0) {
        throw new Error("Please enter a valid sell amount.");
      }

      if (sellAmount > utxo.amount) {
        throw new Error(`Sell amount cannot exceed the selected UTXO size of ${(utxo.amount / 100000000).toFixed(4)}.`);
      }

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
        networkMode,
        backingTxid,
        backingVout,
        backingChain
      });

      // Save preimage locally associated with Offer ID so we can claim later
      localStorage.setItem(`preimage_${res.data.id}`, preimageHex);

      showToast('Swap offer published successfully to the marketplace!', 'success');
      setSelectedBackingUtxoKey('');
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

  const acceptOffer = async (offer: Offer) => {
    const match = getMatchingTakerUtxo(offer);
    if (!match) {
      const requiredChain = (!offer.backingChain || offer.backingChain === 'bip110') ? 'BTC' : 'BIP110';
      const requiredAmount = (!offer.backingChain || offer.backingChain === 'bip110') ? offer.acceptorBtcAmount : offer.initiatorB110Amount;
      showToast(`Cannot accept offer: you need a split ${requiredChain} UTXO with at least ${(requiredAmount / 100000000).toFixed(4)} to accept this offer!`, 'error');
      return;
    }

    try {
      const res = await axios.post(`${API_BASE}/offers/${offer.id}/accept`, {
        acceptorPubKey: publicKey
      });
      showToast('Offer accepted! Launching the Swap Wizard...', 'success');
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
        // Step 2: Fund first HTLC (Performed locally by Initiator)
        const isBtcBacking = selectedOffer.backingChain === 'main';
        const targetChain: 'main' | 'bip110' = isBtcBacking ? 'main' : 'bip110';
        const targetAmount = isBtcBacking ? selectedOffer.acceptorBtcAmount : selectedOffer.initiatorB110Amount;

        showToast(`Building ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC contract locally...`, 'info');
        
        // 1. Generate HTLC outputs locally
        const recipientPubKey = isBtcBacking 
          ? Buffer.from(selectedOffer.initiatorPubKey, 'hex') 
          : Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const refundPubKey = isBtcBacking 
          ? Buffer.from(selectedOffer.acceptorPubKey!, 'hex') 
          : Buffer.from(selectedOffer.initiatorPubKey, 'hex');

        const htlc = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          recipientPubKey,
          refundPubKey,
          selectedOffer.lockTime,
          net
        );

        // 2. Fetch split UTXOs of initiator on targetChain
        let utxo;
        if (isBtcBacking) {
          utxo = ownMainUtxos.find(u => u.txid === selectedOffer.backingTxid && u.vout === selectedOffer.backingVout);
          if (!utxo) {
            utxo = ownMainUtxos[0];
          }
        } else {
          utxo = bip110Utxos.find(u => u.txid === selectedOffer.backingTxid && u.vout === selectedOffer.backingVout)
            || ownBip110Utxos.find(u => u.txid === selectedOffer.backingTxid && u.vout === selectedOffer.backingVout);
          if (!utxo) {
            const splitB110Utxos = bip110Utxos.filter(u => isBip110UtxoSplit(u));
            utxo = splitB110Utxos[0] || ownBip110Utxos[0];
          }
        }

        if (!utxo) throw new Error(`No split UTXO found on ${targetChain === 'main' ? 'Bitcoin' : 'BIP110-Chain'}! Split your coins first.`);

        // 3. Build & sign funding transaction locally!
        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        const pubKey = Buffer.from(keyPair.publicKey);

        let splitDestPayment: bitcoin.payments.Payment;
        let merkleRoot: Buffer = Buffer.alloc(0);
        
        const isParentSplitAddress = !isBtcBacking && !ownBip110Utxos.some(u => u.txid === utxo!.txid && u.vout === utxo!.vout);
        if (isParentSplitAddress) {
          const splitPayment = PureBitcoinSwap.createSplitPayment(pubKey, net);
          splitDestPayment = splitPayment.payment;
          merkleRoot = splitPayment.leafHash;
        } else {
          splitDestPayment = bitcoin.payments.p2tr({
            internalPubkey: PureBitcoinSwap.getXOnlyPubKey(pubKey),
            network: net
          });
        }

        const tx = PureBitcoinSwap.buildHtlcFundingTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(targetAmount),
          htlc.address!,
          splitDestPayment,
          merkleRoot,
          ownAddress,
          net
        );

        // 4. Broadcast via server
        const broadcastRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        // 5. Update Offer State on server
        const updateParams: any = {
          status: 'FUNDED_INITIATOR'
        };
        if (isBtcBacking) {
          updateParams.btcHtlcAddress = htlc.address!;
          updateParams.btcHtlcTxid = broadcastRes.data.txid;
        } else {
          updateParams.b110HtlcAddress = htlc.address!;
          updateParams.b110HtlcTxid = broadcastRes.data.txid;
        }

        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, updateParams);

        setSelectedOffer(updateRes.data);
        showToast(`${targetChain === 'main' ? 'Bitcoin' : 'BIP110'} HTLC successfully funded!`, 'success');
      } 
      
      else if (step === 3) {
        // Step 3: Fund second HTLC (Performed locally by Acceptor)
        const isBtcBacking = selectedOffer.backingChain === 'main';
        const targetChain: 'main' | 'bip110' = isBtcBacking ? 'bip110' : 'main';
        const targetAmount = isBtcBacking ? selectedOffer.initiatorB110Amount : selectedOffer.acceptorBtcAmount;

        // Security check first: Verify the initiator's first HTLC address matches the expected script
        const firstHtlcAddress = isBtcBacking ? selectedOffer.btcHtlcAddress! : selectedOffer.b110HtlcAddress!;
        const firstHtlcRecipient = isBtcBacking 
          ? Buffer.from(selectedOffer.initiatorPubKey, 'hex') 
          : Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const firstHtlcRefund = isBtcBacking 
          ? Buffer.from(selectedOffer.acceptorPubKey!, 'hex') 
          : Buffer.from(selectedOffer.initiatorPubKey, 'hex');

        showToast(`Verifying initiator's ${isBtcBacking ? 'BTC' : 'BIP110'} HTLC address first...`, 'info');

        const isFirstHtlcValid = PureBitcoinSwap.verifyTaprootHtlcAddress(
          firstHtlcAddress,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          firstHtlcRecipient,
          firstHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        if (!isFirstHtlcValid) {
          throw new Error(`CRITICAL SECURITY WARNING: The initiator's ${isBtcBacking ? 'BTC' : 'BIP110'} HTLC address is INVALID or has been tampered with!`);
        }

        showToast(`Building ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC contract locally...`, 'info');

        // 1. Generate second HTLC outputs locally
        const secondHtlcRecipient = isBtcBacking 
          ? Buffer.from(selectedOffer.acceptorPubKey!, 'hex') 
          : Buffer.from(selectedOffer.initiatorPubKey, 'hex');
        const secondHtlcRefund = isBtcBacking 
          ? Buffer.from(selectedOffer.initiatorPubKey, 'hex') 
          : Buffer.from(selectedOffer.acceptorPubKey!, 'hex');

        const htlc = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          secondHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        // 2. Fetch split outputs of acceptor on targetChain
        let utxo;
        if (targetChain === 'main') {
          const splitDestRes = await axios.post(`${API_BASE}/wallet/utxos`, {
            address: ownAddress,
            chain: 'main',
            networkMode
          });
          utxo = splitDestRes.data.utxos[0];
        } else {
          const splitB110Utxos = [
            ...ownBip110Utxos,
            ...bip110Utxos.filter(u => isBip110UtxoSplit(u))
          ];
          const uniqueBip110Utxos = splitB110Utxos.filter((v: any, i: any, a: any) => a.findIndex((t: any) => t.txid === v.txid && t.vout === v.vout) === i);
          utxo = uniqueBip110Utxos[0];
        }

        if (!utxo) throw new Error(`No split UTXO found on ${targetChain === 'main' ? 'Bitcoin' : 'BIP110-Chain'}! Split your coins first.`);

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
          BigInt(targetAmount),
          htlc.address!,
          splitDestPayment,
          Buffer.alloc(0),
          ownAddress,
          net
        );

        // 4. Broadcast via server
        const broadcastRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        // 5. Update Offer State on server
        const updateParams: any = {
          status: 'FUNDED_ACCEPTOR'
        };
        if (targetChain === 'main') {
          updateParams.btcHtlcAddress = htlc.address!;
          updateParams.btcHtlcTxid = broadcastRes.data.txid;
        } else {
          updateParams.b110HtlcAddress = htlc.address!;
          updateParams.b110HtlcTxid = broadcastRes.data.txid;
        }

        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, updateParams);

        setSelectedOffer(updateRes.data);
        showToast(`${targetChain === 'main' ? 'Bitcoin' : 'BIP110'} HTLC successfully funded!`, 'success');
      } 
      
      else if (step === 4) {
        // Step 4: Claim second HTLC (Performed locally by Initiator)
        const isBtcBacking = selectedOffer.backingChain === 'main';
        const targetChain: 'main' | 'bip110' = isBtcBacking ? 'bip110' : 'main';
        const targetAddress = isBtcBacking ? selectedOffer.b110HtlcAddress! : selectedOffer.btcHtlcAddress!;

        showToast(`Verifying acceptor's ${targetChain === 'main' ? 'BTC' : 'BIP110'} HTLC address first...`, 'info');

        // Security check: Verify that the acceptor's HTLC address matches the expected script
        const secondHtlcRecipient = isBtcBacking 
          ? Buffer.from(selectedOffer.acceptorPubKey!, 'hex') 
          : Buffer.from(selectedOffer.initiatorPubKey, 'hex');
        const secondHtlcRefund = isBtcBacking 
          ? Buffer.from(selectedOffer.initiatorPubKey, 'hex') 
          : Buffer.from(selectedOffer.acceptorPubKey!, 'hex');

        const isSecondHtlcValid = PureBitcoinSwap.verifyTaprootHtlcAddress(
          targetAddress,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          secondHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        if (!isSecondHtlcValid) {
          throw new Error(`CRITICAL SECURITY WARNING: The acceptor's ${targetChain === 'main' ? 'BTC' : 'BIP110'} HTLC address is INVALID or has been tampered with!`);
        }

        showToast(`Signing ${targetChain === 'main' ? 'BTC' : 'B110'} Claim transaction with local preimage...`, 'info');

        const htlcUtxosRes = await axios.post(`${API_BASE}/wallet/utxos`, {
          address: targetAddress,
          chain: targetChain,
          networkMode
        });
        const utxo = htlcUtxosRes.data.utxos[0];
        if (!utxo) throw new Error(`Could not find the funded UTXO on the ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC. If on regtest, mine a block.`);

        // Verification of the amount funded inside the HTLC
        const requiredAmount = isBtcBacking ? selectedOffer.initiatorB110Amount : selectedOffer.acceptorBtcAmount;
        if (BigInt(utxo.amount) < BigInt(requiredAmount - 5000)) {
          throw new Error(`CRITICAL SECURITY WARNING: The acceptor funded the HTLC with only ${(utxo.amount / 100000000).toFixed(4)} ${targetChain === 'main' ? 'BTC' : 'B110'}, but the agreed amount was ${(requiredAmount / 100000000).toFixed(4)}! Do NOT release the preimage!`);
        }

        // Retrieve local preimage securely stored
        const savedPreimage = localStorage.getItem(`preimage_${selectedOffer.id}`);
        if (!savedPreimage) throw new Error("Cryptographic preimage not found in secure local storage.");

        // Build and sign claim transaction locally!
        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          secondHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        const tx = PureBitcoinSwap.buildHtlcClaimTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - 2000), 
          ownAddress, // Claim destination is user's own address!
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(savedPreimage, 'hex'), 
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          secondHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        // Broadcast raw tx
        const broadcastRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        // Update Offer State on server
        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, {
          preimage: savedPreimage,
          status: 'CLAIMED'
        });

        setSelectedOffer(updateRes.data);
        showToast(`${targetChain === 'main' ? 'BTC' : 'B110'} claimed successfully! Preimage revealed.`, 'success');
      } 
      
      else if (step === 5) {
        // Step 5: Claim first HTLC (Performed locally by Acceptor)
        const isBtcBacking = selectedOffer.backingChain === 'main';
        const targetChain: 'main' | 'bip110' = isBtcBacking ? 'main' : 'bip110';
        const targetAddress = isBtcBacking ? selectedOffer.btcHtlcAddress! : selectedOffer.b110HtlcAddress!;

        showToast(`Verifying ${targetChain === 'main' ? 'BTC' : 'BIP110'} HTLC address first...`, 'info');

        // Security check: Verify that the first HTLC address matches the expected script
        const firstHtlcRecipient = isBtcBacking 
          ? Buffer.from(selectedOffer.initiatorPubKey, 'hex') 
          : Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const firstHtlcRefund = isBtcBacking 
          ? Buffer.from(selectedOffer.acceptorPubKey!, 'hex') 
          : Buffer.from(selectedOffer.initiatorPubKey, 'hex');

        const isFirstHtlcValid = PureBitcoinSwap.verifyTaprootHtlcAddress(
          targetAddress,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          firstHtlcRecipient,
          firstHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        if (!isFirstHtlcValid) {
          throw new Error(`CRITICAL SECURITY WARNING: The first HTLC (${targetChain === 'main' ? 'BTC' : 'BIP110'}) address is INVALID or has been tampered with!`);
        }

        showToast(`Signing ${targetChain === 'main' ? 'BTC' : 'B110'} Claim transaction with extracted preimage...`, 'info');

        const htlcUtxosRes = await axios.post(`${API_BASE}/wallet/utxos`, {
          address: targetAddress,
          chain: targetChain,
          networkMode
        });
        const utxo = htlcUtxosRes.data.utxos[0];
        if (!utxo) throw new Error(`Could not find funded UTXO on ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC address.`);

        // Build and sign claim transaction locally!
        const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network: net });
        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          firstHtlcRecipient,
          firstHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        const tx = PureBitcoinSwap.buildHtlcClaimTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - 2000), 
          ownAddress, // Claim destination is user's own address!
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(selectedOffer.preimage!, 'hex'), // preimage hex
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          firstHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        const updateRes = await axios.post(`${API_BASE}/offers/${selectedOffer.id}/update`, {
          status: 'CLAIMED',
          acceptorClaimed: true
        });

        setSelectedOffer(updateRes.data);
        showToast(`${targetChain === 'main' ? 'BTC' : 'B110'} claimed successfully! Swap fully completed.`, 'success');
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
            {!isNetworkLocked ? (
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
            ) : (
              <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-850">
                {networkMode === 'regtest' ? (
                  <div className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 text-indigo-400 bg-slate-900/40 border border-slate-800">
                    <Flame className="w-3.5 h-3.5 animate-pulse" />
                    SIMULATION (REGTEST MODE)
                  </div>
                ) : (
                  <div className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 text-amber-400 bg-amber-500/10 border border-amber-500/20">
                    <Lock className="w-3.5 h-3.5" />
                    PRODUCTION (MAINNET MODE)
                  </div>
                )}
              </div>
            )}

            {networkMode === 'regtest' ? (
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <span className="text-xs text-slate-400 block font-medium">Core Regtest</span>
                    <span className="text-xs font-semibold text-emerald-400 bg-emerald-950/40 border border-emerald-900/60 px-2 py-0.5 rounded-md">
                      Block #{nodeInfo.mainHeight}
                    </span>
                  </div>
                  <button
                    onClick={() => mineBlocks('main', 1)}
                    className="px-2 py-1 text-[10px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-950/30 hover:bg-emerald-900/40 border border-emerald-900/40 hover:border-emerald-500 rounded-md transition-all self-end mb-0.5"
                    title="Mine 1 Block on Bitcoin Core Regtest"
                  >
                    +1 Block
                  </button>
                </div>
                <div className="flex items-center gap-2 border-l border-slate-800 pl-4">
                  <div className="text-right">
                    <span className="text-xs text-slate-400 block font-medium">Knots Regtest</span>
                    <span className="text-xs font-semibold text-sky-400 bg-sky-950/40 border border-sky-900/60 px-2 py-0.5 rounded-md">
                      Block #{nodeInfo.bip110Height}
                    </span>
                  </div>
                  <button
                    onClick={() => mineBlocks('bip110', 1)}
                    className="px-2 py-1 text-[10px] font-bold text-sky-400 hover:text-sky-300 bg-sky-950/30 hover:bg-sky-900/40 border border-sky-900/40 hover:border-sky-500 rounded-md transition-all self-end mb-0.5"
                    title="Mine 1 Block on BIP110 Knots Regtest"
                  >
                    +1 Block
                  </button>
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
                    { id: 'wallet', label: '1. Unified Wallet', icon: Wallet },
                    { id: 'splitter', label: '2. Bilateral Splitter', icon: Coins },
                    { id: 'marketplace', label: '3. Marketplace Lobby', icon: TrendingUp },
                    { id: 'my-offers', label: '4. My Swaps & Offers', icon: User },
                    { id: 'wizard', label: '5. Swap Wizard', icon: Award }
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
                    <span className="text-xl font-bold text-emerald-400">
                      {((mainBalance + ownMainBalance) / 100000000).toFixed(4)} {networkMode === 'mainnet' ? 'BTC' : 'rBTC'}
                    </span>
                    <span className="text-[10px] text-slate-500 block mt-0.5 font-medium leading-none">
                      {(mainBalance / 100000000).toFixed(4)} Unsplit + {(ownMainBalance / 100000000).toFixed(4)} Split
                    </span>
                  </div>
                  <div className="flex-1 border-l border-slate-800 pl-4">
                    <span className="text-xs text-slate-400 block mb-1">BIP110 Balance</span>
                    <span className="text-xl font-bold text-sky-400">
                      {((bip110Balance + ownBip110Balance) / 100000000).toFixed(4)} B110
                    </span>
                    <span className="text-[10px] text-slate-500 block mt-0.5 font-medium leading-none">
                      {(getBip110UnsplitBalance() / 100000000).toFixed(4)} Unsplit + {(getBip110SplitBalance() / 100000000).toFixed(4)} Split
                    </span>
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
                      <h4 className="text-xs font-bold text-slate-200 mb-1">Step 1: Bootstrap BIP110 Consensus & Miner Wallets</h4>
                      <p className="text-[10px] text-slate-400">Mine 450 blocks of shared history. This activates the native BIP110 (reduced_data) consensus rules on Knots (natively activates at block 432) and matures Coinbase miner rewards.</p>
                    </div>
                    <button
                      onClick={() => mineBlocks('main', 450)}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all self-start sm:self-center"
                    >
                      Mine 450 blocks
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
                    {mainUtxos.length === 0 && ownMainUtxos.length === 0 ? (
                      <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-800 rounded-xl">No unspent outputs.</div>
                    ) : (
                      <div className="space-y-2">
                        {/* Render Unsplit UTXOs */}
                        {mainUtxos.map((u, i) => (
                          <div key={`unsplit-${i}`} className="bg-slate-950 border border-slate-800/60 p-2.5 rounded-xl text-xs flex justify-between items-center">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-slate-400 truncate w-24">{u.txid}</span>
                              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                                u.confirmations < 1 
                                  ? 'bg-amber-950/30 border-amber-800/40 text-amber-400 animate-pulse'
                                  : 'bg-slate-900 border border-slate-800 text-slate-400'
                              }`}>
                                {u.confirmations < 1 ? '⏳ PENDING' : '⏳ Unsplit'}
                              </span>
                            </div>
                            <span className="font-semibold text-emerald-400">{(u.amount / 100000000).toFixed(4)} BTC</span>
                          </div>
                        ))}
                        {/* Render Already Split UTXOs */}
                        {ownMainUtxos.map((u, i) => (
                          <div key={`split-${i}`} className="bg-slate-900/40 border border-emerald-950 p-2.5 rounded-xl text-xs flex justify-between items-center shadow-sm shadow-emerald-500/5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-slate-400 truncate w-24">{u.txid}</span>
                              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                                u.confirmations < 1 
                                  ? 'bg-amber-950/30 border-amber-800/40 text-amber-400 animate-pulse'
                                  : 'bg-emerald-950/30 border-emerald-800/40 text-emerald-400 animate-pulse'
                              }`}>
                                {u.confirmations < 1 ? '🛡️ PENDING' : '🛡️ Split'}
                              </span>
                            </div>
                            <span className="font-semibold text-emerald-400">{(u.amount / 100000000).toFixed(4)} BTC</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">BIP110 UTXOs</h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {bip110Utxos.length === 0 && ownBip110Utxos.length === 0 ? (
                      <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-800 rounded-xl">No unspent outputs.</div>
                    ) : (
                      <div className="space-y-2">
                        {/* Render BIP110 UTXOs with dynamic split check */}
                        {bip110Utxos.map((u, i) => {
                          const isSplit = isBip110UtxoSplit(u);
                          return (
                            <div key={`b110-${i}`} className={`p-2.5 rounded-xl text-xs flex justify-between items-center ${
                              isSplit 
                                ? 'bg-slate-900/40 border border-sky-950 shadow-sm shadow-sky-500/5' 
                                : 'bg-slate-950 border border-slate-800/60'
                            }`}>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-slate-400 truncate w-24">{u.txid}</span>
                                {isSplit ? (
                                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                                    u.confirmations < 1 
                                      ? 'bg-amber-950/30 border-amber-800/40 text-amber-400 animate-pulse'
                                      : 'bg-sky-950/30 border-sky-800/40 text-sky-400 animate-pulse'
                                  }`}>
                                    {u.confirmations < 1 ? '🛡️ PENDING' : '🛡️ Split'}
                                  </span>
                                ) : (
                                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                                    u.confirmations < 1 
                                      ? 'bg-amber-950/30 border-amber-800/40 text-amber-400 animate-pulse'
                                      : 'bg-slate-900 border border-slate-800 text-slate-400'
                                  }`}>
                                    {u.confirmations < 1 ? '⏳ PENDING' : '⏳ Unsplit'}
                                  </span>
                                )}
                              </div>
                              <span className="font-semibold text-sky-400">{(u.amount / 100000000).toFixed(4)} B110</span>
                            </div>
                          )
                        })}
                      </div>
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
                Bilateral Replay-Proof Coin Splitter
              </h3>
              <p className="text-xs text-slate-400 mb-6">
                Both the Initiator and the Acceptor must split their coins by script-spending their P2TR split contract outputs to their own safe addresses. This makes their balances 100% replay-protected and safe to fund HTLCs.
              </p>

              {/* Dynamic Read-only Split Destination Panel */}
              <div className="bg-slate-950/60 border border-slate-850 p-5 rounded-xl mb-8">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5 flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-sky-400" />
                  Destination Split Address
                </h4>
                <div className="bg-slate-950 border border-slate-900 px-3 py-2 rounded-xl flex items-center justify-between font-mono text-xs text-sky-300">
                  <span className="truncate mr-4 font-semibold">{ownAddress || 'Computing address...'}</span>
                  <button onClick={() => copyToClipboard(ownAddress)} className="text-slate-500 hover:text-slate-300">
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* UTXO Selection Table / Radio-List */}
              <div className="space-y-6">
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                    Available Contract UTXOs (Select the UTXO to split)
                  </h4>
                  
                  {/* We only allow selecting UNSPLIT UTXOs. A UTXO is unsplit if it is present on the Main-Chain */}
                  {mainUtxos.length === 0 ? (
                    <div className="text-center py-8 border border-dashed border-slate-800 bg-slate-950/40 rounded-xl text-xs text-slate-500">
                      No unsplit contract outputs available on Main-Chain. Deposit some funds via the faucet tab first!
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3">
                      {mainUtxos.map((u, idx) => {
                        const isSelected = selectedUtxoToSplit?.txid === u.txid && selectedUtxoToSplit?.vout === u.vout;
                        return (
                          <div 
                            key={idx}
                            onClick={() => setSelectedUtxoToSplit(u)}
                            className={`p-4 rounded-xl border cursor-pointer transition-all flex justify-between items-center ${
                              isSelected 
                                ? 'bg-indigo-950/30 border-indigo-500 shadow-md shadow-indigo-500/5' 
                                : 'bg-slate-950 border-slate-850 hover:border-slate-800'
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${isSelected ? 'border-indigo-500' : 'border-slate-700'}`}>
                                {isSelected && <div className="w-2 h-2 rounded-full bg-indigo-400" />}
                              </div>
                              <div className="flex flex-col">
                                <span className="font-mono text-slate-300 text-xs truncate w-48 sm:w-80">{u.txid}:{u.vout}</span>
                                <span className="text-[10px] text-slate-500">
                                  Confirmations: {u.confirmations} {u.confirmations < 1 && <span className="text-amber-500 font-bold ml-1.5 animate-pulse">(PENDING)</span>}
                                </span>
                              </div>
                            </div>
                            <span className="font-semibold text-emerald-400">{(u.amount / 100000000).toFixed(4)} BTC</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Show already split UTXOs as non-selectable */}
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                    Already Split UTXOs (Replay-Protected)
                  </h4>
                  <div className="space-y-2">
                    {/* Render split UTXOs on Main-Chain */}
                    {ownMainUtxos.map((u, i) => (
                      <div key={`split-main-tab-${i}`} className="bg-slate-900/30 border border-emerald-950/50 p-3.5 rounded-xl text-xs flex justify-between items-center opacity-80">
                        <div className="flex items-center gap-3">
                          <div className="flex flex-col">
                            <span className="font-mono text-slate-300 text-xs truncate w-32 sm:w-64">{u.txid}:{u.vout}</span>
                            <span className="text-[10px] text-slate-500">
                              Confirmations: {u.confirmations} {u.confirmations < 1 && <span className="text-amber-500 font-bold ml-1.5 animate-pulse">(PENDING)</span>}
                            </span>
                          </div>
                          <span className={`text-[9px] font-bold px-2 py-0.5 rounded self-start ${
                            u.confirmations < 1
                              ? 'bg-amber-950/30 border border-amber-900/40 text-amber-400 animate-pulse'
                              : 'bg-emerald-950/30 border border-emerald-900/40 text-emerald-400'
                          }`}>
                            {u.confirmations < 1 ? '🛡️ Split (PENDING)' : '🛡️ Split (BTC)'}
                          </span>
                        </div>
                        <span className="font-semibold text-slate-300">{(u.amount / 100000000).toFixed(4)} BTC</span>
                      </div>
                    ))}
                    
                    {/* Render split UTXOs on BIP110-Chain */}
                    {bip110Utxos.filter(u => isBip110UtxoSplit(u)).map((u, i) => (
                      <div key={`split-b110-tab-${i}`} className="bg-slate-900/30 border border-sky-950/50 p-3.5 rounded-xl text-xs flex justify-between items-center opacity-80">
                        <div className="flex items-center gap-3">
                          <div className="flex flex-col">
                            <span className="font-mono text-slate-300 text-xs truncate w-32 sm:w-64">{u.txid}:{u.vout}</span>
                            <span className="text-[10px] text-slate-500">
                              Confirmations: {u.confirmations} {u.confirmations < 1 && <span className="text-amber-500 font-bold ml-1.5 animate-pulse">(PENDING)</span>}
                            </span>
                          </div>
                          <span className={`text-[9px] font-bold px-2 py-0.5 rounded self-start ${
                            u.confirmations < 1
                              ? 'bg-amber-950/30 border border-amber-900/40 text-amber-400 animate-pulse'
                              : 'bg-sky-950/30 border border-sky-900/40 text-sky-400'
                          }`}>
                            {u.confirmations < 1 ? '🛡️ Split (PENDING)' : '🛡️ Split (BIP110)'}
                          </span>
                        </div>
                        <span className="font-semibold text-slate-300">{(u.amount / 100000000).toFixed(4)} B110</span>
                      </div>
                    ))}

                    {ownMainUtxos.length === 0 && bip110Utxos.filter(u => isBip110UtxoSplit(u)).length === 0 && (
                      <div className="text-center py-6 border border-slate-900 bg-slate-950/20 rounded-xl text-xs text-slate-600">
                        No split UTXOs detected yet. Select an unsplit UTXO above to split!
                      </div>
                    )}
                  </div>
                </div>

                {/* Single Split Spends Action Button */}
                <div className="pt-4">
                  <button
                    onClick={executeBilateralSplit}
                    disabled={splittingBilateral || !selectedUtxoToSplit}
                    className="w-full sm:w-auto px-6 py-3 font-semibold text-sm rounded-xl text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/10"
                  >
                    {splittingBilateral ? 'Executing Main-Chain Scriptpath Spend...' : 'Split Coins (Scriptpath Spend)'}
                  </button>
                </div>

                {/* Bilateral Split Spend results */}
                {bilateralSplitResult && (
                  <div className="mt-6 border border-slate-800 bg-slate-950 p-5 rounded-2xl space-y-4">
                    <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">Split spend Results Summary</h4>
                    
                    <div className="grid grid-cols-1 gap-4 text-xs font-mono">
                      <div className={`p-4 rounded-xl border ${bilateralSplitResult.mainSuccess ? 'bg-emerald-950/20 border-emerald-900/60 text-emerald-300' : 'bg-rose-950/20 border-rose-900/60 text-rose-300'}`}>
                        <span className="font-bold block mb-1">Bitcoin Core (Main-Chain Scriptpath spend):</span>
                        {bilateralSplitResult.mainSuccess ? (
                          <div>
                            <div className="truncate mb-1">✔️ Success! Split Txid: {bilateralSplitResult.mainTxid}</div>
                            <div className="text-[10px] text-slate-400 leading-normal mt-2">
                              Because this transaction contains the banned OP_IF opcode in its scriptpath, the BIP110-Chain (Knots) will reject it entirely. This guarantees that your original pre-fork UTXO remains unspent, valid, and fully split on Knots!
                            </div>
                          </div>
                        ) : (
                          <div>Failed: {bilateralSplitResult.mainError}</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
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

              <form onSubmit={handleCreateOffer} className="space-y-6">
                <div>
                  <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">
                    Select Split UTXO to back this offer
                  </label>
                  <select
                    value={selectedBackingUtxoKey}
                    onChange={(e) => {
                      const key = e.target.value;
                      setSelectedBackingUtxoKey(key);
                      if (key) {
                        const utxo = getAvailableSplitUtxos().find(u => `${u.txid}-${u.vout}` === key);
                        if (utxo) {
                          const finalAmount = String(utxo.amount);
                          setSellAmountSats(finalAmount);
                          setPremiumPercent('0'); // Default to 0% (parity)
                          setNewOfferB110(finalAmount);
                          setNewOfferBtc(finalAmount);
                        }
                      } else {
                        setSellAmountSats('');
                        setPremiumPercent('0');
                        setNewOfferB110('');
                        setNewOfferBtc('');
                      }
                    }}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  >
                    <option value="">-- Choose a Split UTXO --</option>
                    {getAvailableSplitUtxos().map(u => (
                      <option key={`${u.txid}-${u.vout}`} value={`${u.txid}-${u.vout}`}>
                        {u.chain === 'main' ? 'BTC' : 'BIP110'} ({(u.amount / 100000000).toFixed(4)} {u.chain === 'main' ? 'BTC' : 'B110'} | {u.txid.substring(0, 12)}...:{u.vout})
                      </option>
                    ))}
                  </select>
                  {getAvailableSplitUtxos().length === 0 && (
                    <p className="text-xs text-rose-400 mt-2">
                      ⚠️ You have no split UTXOs. Please go to the **Bilateral Splitter** tab to split some coins first!
                    </p>
                  )}

                  {selectedBackingUtxoKey && (() => {
                    const utxo = getAvailableSplitUtxos().find(u => `${u.txid}-${u.vout}` === selectedBackingUtxoKey);
                    if (!utxo) return null;
                    const chainLabel = utxo.chain === 'main' ? 'BTC' : 'B110';
                    return (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
                        <div>
                          <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">
                            Sell Amount (Sats)
                          </label>
                          <input
                            type="number"
                            min="100000"
                            max={utxo.amount}
                            value={sellAmountSats}
                            onChange={(e) => handleSellAmountChange(e.target.value)}
                            placeholder={`Max ${(utxo.amount).toLocaleString()} Sats`}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                          />
                          <span className="text-[10px] text-slate-500 mt-1 block">
                            Available in UTXO: <span className="font-semibold text-slate-400">{(utxo.amount).toLocaleString()} Sats</span> ({(utxo.amount / 100000000).toFixed(4)} {chainLabel})
                          </span>
                        </div>

                        <div>
                          <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">
                            Market Pricing Adjustment (%)
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            min="-50"
                            max="50"
                            value={premiumPercent}
                            onChange={(e) => handlePremiumChange(e.target.value)}
                            placeholder="e.g. 5 for 5% premium, -2 for 2% discount"
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                          />
                          <span className="text-[10px] text-slate-500 mt-1 block">
                            Adjust buy price relative to 1:1 parity (positive = premium, negative = discount)
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {selectedBackingUtxoKey && newOfferB110 && (() => {
                  const utxo = getAvailableSplitUtxos().find(u => `${u.txid}-${u.vout}` === selectedBackingUtxoKey);
                  const isMain = utxo?.chain === 'main';
                  const premiumVal = Number(premiumPercent) || 0;
                  const premiumText = premiumVal > 0 
                    ? `at a +${premiumVal}% premium` 
                    : premiumVal < 0 
                    ? `at a ${premiumVal}% discount` 
                    : `at 1:1 exact parity`;
                  return (
                    <div className="bg-slate-950/40 border border-indigo-900/30 p-4 rounded-xl flex items-center justify-between">
                      <div>
                        <span className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-1">Swap Exchange Rate ({premiumText})</span>
                        <span className="text-sm font-semibold text-slate-200">
                          {isMain ? (
                            <>
                              Selling <span className="text-emerald-400 font-mono">{(Number(newOfferBtc) / 100000000).toFixed(4)} BTC</span> ⇆ Buying <span className="text-sky-400 font-mono">{(Number(newOfferB110) / 100000000).toFixed(4)} B110</span> on BIP110-Chain
                            </>
                          ) : (
                            <>
                              Selling <span className="text-sky-400 font-mono">{(Number(newOfferB110) / 100000000).toFixed(4)} B110</span> ⇆ Buying <span className="text-emerald-400 font-mono">{(Number(newOfferBtc) / 100000000).toFixed(4)} BTC</span> on Main-Chain
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })()}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end">
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
                      disabled={publishing || !selectedBackingUtxoKey}
                      className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-sm rounded-xl py-2.5 shadow-lg shadow-indigo-600/10 transition-all"
                    >
                      {publishing ? 'Publishing...' : 'Publish Swap Offer'}
                    </button>
                  </div>
                </div>
              </form>
            </div>

            {/* PUBLIC MARKETPLACE LOBBY */}
            <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm space-y-6">
              <h3 className="text-md font-semibold text-slate-200 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-indigo-400" />
                Public Marketplace Lobby ({networkMode === 'mainnet' ? 'Mainnet' : 'Regtest'})
              </h3>
              <p className="text-xs text-slate-400">
                Accept swap offers published by other counterparties.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {offersList.filter(o => o.initiatorPubKey !== publicKey).length === 0 ? (
                  <div className="col-span-2 text-center py-12 text-slate-500 border border-dashed border-slate-800 rounded-2xl bg-slate-950/20 text-xs">
                    No other sellers' offers found in the orderbook.
                  </div>
                ) : (
                  offersList.filter(o => o.initiatorPubKey !== publicKey).map((o) => {
                    const match = getMatchingTakerUtxo(o);
                    const requiredChain = (!o.backingChain || o.backingChain === 'bip110') ? 'BTC' : 'BIP110';
                    const requiredAmount = (!o.backingChain || o.backingChain === 'bip110') ? o.acceptorBtcAmount : o.initiatorB110Amount;
                    return (
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
                              o.isPending ? 'bg-amber-950/40 border-amber-900/60 text-amber-400 animate-pulse' :
                              o.status === 'OPEN' ? 'bg-emerald-950/40 border-emerald-900/60 text-emerald-400' :
                              o.status === 'ACCEPTED' ? 'bg-indigo-950/40 border-indigo-900/60 text-indigo-400' :
                              'bg-amber-950/40 border-amber-900/60 text-amber-400'
                            }`}>
                              {o.isPending ? 'PENDING' : o.status}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-4 mb-4 text-xs">
                            <div>
                              <span className="text-slate-400 block font-medium">They Sell (You Buy)</span>
                              <span className="font-semibold text-sky-400">
                                {o.backingChain === 'main' ? `${(o.acceptorBtcAmount / 100000000).toFixed(4)} BTC` : `${(o.initiatorB110Amount / 100000000).toFixed(4)} B110`}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400 block font-medium">They Ask (You Pay)</span>
                              <span className="font-semibold text-emerald-400">
                                {o.backingChain === 'main' ? `${(o.initiatorB110Amount / 100000000).toFixed(4)} B110` : `${(o.acceptorBtcAmount / 100000000).toFixed(4)} BTC`}
                              </span>
                            </div>
                          </div>

                          <div className="text-[10px] space-y-1.5 border-t border-slate-900 pt-3">
                            <div className="flex justify-between">
                              <span className="text-slate-500 font-medium">Required Split Balance:</span>
                              <span className="font-semibold text-slate-300">
                                {(requiredAmount / 100000000).toFixed(4)} {requiredChain}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500 font-medium">Refund Locktime (T):</span>
                              <span className="font-semibold text-amber-500">
                                {o.lockTime} blocks (~{((o.lockTime * 10) / 60).toFixed(1)} hrs)
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500 font-medium">Taker Status:</span>
                              <span className={`font-semibold ${match ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {match ? '✔️ Match Ready' : `❌ Missing split ${requiredChain}`}
                              </span>
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
                          {o.status === 'OPEN' && (
                            <button
                              onClick={() => acceptOffer(o)}
                              className="flex-1 py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg shadow-indigo-600/10"
                            >
                              Accept Offer
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: MY SWAPS & OPEN OFFERS */}
        {activeTab === 'my-offers' && (
          <div className="space-y-8">
            <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm space-y-6">
              <h3 className="text-md font-semibold text-slate-200 flex items-center gap-2">
                <User className="w-5 h-5 text-indigo-400" />
                My Swaps & Open Offers (You are Initiator)
              </h3>
              <p className="text-xs text-slate-400">
                Monitor the state of swap contracts you published and if they have been taken.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {offersList.filter(o => o.initiatorPubKey === publicKey).length === 0 ? (
                  <div className="col-span-2 text-center py-12 text-slate-500 border border-dashed border-slate-800 rounded-2xl bg-slate-950/20 text-xs">
                    You haven't published any swap offers yet. Go to the **Marketplace Lobby** tab to list one!
                  </div>
                ) : (
                  offersList.filter(o => o.initiatorPubKey === publicKey).map((o) => (
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
                            o.isPending ? 'bg-amber-950/40 border-amber-900/60 text-amber-400 animate-pulse' :
                            o.status === 'OPEN' ? 'bg-slate-900 border-slate-800 text-slate-400' :
                            o.status === 'ACCEPTED' ? 'bg-indigo-950/40 border-indigo-900/60 text-indigo-400 animate-pulse' :
                            'bg-emerald-950/40 border-emerald-900/60 text-emerald-400'
                          }`}>
                            {o.isPending ? 'PENDING' : o.status === 'OPEN' ? 'OPEN (Waiting)' : o.status}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-4 mb-4 text-xs">
                          <div>
                            <span className="text-slate-400 block font-medium">You Sell</span>
                            <span className="font-semibold text-sky-400">
                              {o.backingChain === 'main' ? `${(o.acceptorBtcAmount / 100000000).toFixed(4)} BTC` : `${(o.initiatorB110Amount / 100000000).toFixed(4)} B110`}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block font-medium">You Receive</span>
                            <span className="font-semibold text-emerald-400">
                              {o.backingChain === 'main' ? `${(o.initiatorB110Amount / 100000000).toFixed(4)} B110` : `${(o.acceptorBtcAmount / 100000000).toFixed(4)} BTC`}
                            </span>
                          </div>
                        </div>

                        <div className="text-[10px] space-y-1.5 border-t border-slate-900 pt-3">
                          <div className="flex justify-between">
                            <span className="text-slate-500 font-medium">Refund Locktime (T):</span>
                            <span className="font-semibold text-amber-500">
                              {o.lockTime} blocks (~{((o.lockTime * 10) / 60).toFixed(1)} hrs)
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-500 font-medium">Taker Status:</span>
                            <span className={`font-semibold ${o.status !== 'OPEN' ? 'text-indigo-400' : 'text-slate-400'}`}>
                              {o.status === 'OPEN' ? 'No taker yet' : '✔️ Accepted by Counterparty!'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-5">
                        <button
                          onClick={() => {
                            setSelectedOffer(o);
                            setActiveTab('wizard');
                          }}
                          className="w-full py-2.5 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg shadow-indigo-600/10 flex items-center justify-center gap-1.5"
                        >
                          <Activity className="w-4 h-4" />
                          Open Swap Wizard
                        </button>
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
                    <span className="text-[10px] font-bold text-indigo-400 bg-indigo-950/40 border border-indigo-900/60 px-2.5 py-0.5 rounded-full uppercase tracking-wider mb-2 inline-block font-mono">
                      Active Swap: #{selectedOffer.id} ({selectedOffer.networkMode}) {selectedOffer.isPending && <span className="text-amber-400 ml-1.5 font-bold animate-pulse">(PENDING)</span>}
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
                    <div className="bg-slate-950 border border-slate-850 px-4 py-2.5 rounded-xl text-center">
                      <span className="text-[10px] text-slate-500 uppercase block font-semibold">Locktime (T / T/2)</span>
                      <span className="text-sm font-bold text-amber-500">
                        {selectedOffer.lockTime} / {selectedOffer.lockTime / 2} blocks
                      </span>
                    </div>
                  </div>
                </div>

                {/* Role & Status Banner */}
                {(() => {
                  const isInitiator = selectedOffer.initiatorPubKey === publicKey;
                  const isBtcBacking = selectedOffer.backingChain === 'main';
                  return (
                    <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-md">
                      <div>
                        <span className="text-[10px] text-slate-500 uppercase block font-semibold tracking-wider">Your Custody Role</span>
                        <div className="flex items-center gap-2 mt-1">
                          <div className={`w-2.5 h-2.5 rounded-full ${isInitiator ? 'bg-indigo-500 shadow-lg shadow-indigo-500/50' : 'bg-amber-500 shadow-lg shadow-amber-500/50'}`}></div>
                          <span className="text-md font-bold text-slate-200">
                            {isInitiator 
                              ? 'Initiator (Preimage Creator)' 
                              : 'Acceptor (Preimage Taker)'}
                          </span>
                        </div>
                        <span className="text-xs text-slate-400 mt-1 block">
                          {isInitiator 
                            ? (isBtcBacking ? 'You are Selling BTC on Main-Chain ⇆ Buying B110 on BIP110-Chain' : 'You are Selling B110 on BIP110-Chain ⇆ Buying BTC on Main-Chain')
                            : (isBtcBacking ? 'You are Selling B110 on BIP110-Chain ⇆ Buying BTC on Main-Chain' : 'You are Selling BTC on Main-Chain ⇆ Buying B110 on BIP110-Chain')}
                        </span>
                      </div>

                      <div className="sm:text-right">
                        <span className="text-[10px] text-slate-500 uppercase block font-semibold tracking-wider">Current Swap Status</span>
                        <span className="text-md font-bold text-indigo-400 block mt-1">
                          {selectedOffer.status === 'ACCEPTED' ? 'Offer Accepted (Pending Funding)' :
                           selectedOffer.status === 'FUNDED_INITIATOR' ? 'Initiator Escrow Funded' :
                           selectedOffer.status === 'FUNDED_ACCEPTOR' ? 'Acceptor Escrow Funded' :
                           selectedOffer.status === 'CLAIMED' ? 'Swap Completed Successfully' :
                           selectedOffer.status === 'REFUNDED' ? 'Swap Aborted & Refunded' :
                           selectedOffer.status}
                        </span>
                        <span className="text-[10px] text-slate-500 block mt-0.5 leading-normal max-w-xs sm:ml-auto">
                          {selectedOffer.status === 'ACCEPTED' 
                            ? (isInitiator ? '✔️ Please Lock & Fund the first HTLC contract.' : '⏳ Waiting for Initiator to fund the first HTLC contract...') :
                           selectedOffer.status === 'FUNDED_INITIATOR'
                            ? (isInitiator ? '⏳ Waiting for Acceptor to verify and fund the second HTLC contract...' : '✔️ Please verify the first HTLC and fund the second HTLC contract.') :
                           selectedOffer.status === 'FUNDED_ACCEPTOR'
                            ? (isInitiator ? '✔️ Please claim your coins from the second HTLC (this reveals the preimage).' : '⏳ Waiting for Initiator to claim and reveal the preimage...') :
                           selectedOffer.status === 'CLAIMED'
                            ? '🎉 All escrow claims have been settled. Swap complete!' :
                           selectedOffer.status === 'REFUNDED'
                            ? '⚠️ The timelock expired and funds were reclaimed.' :
                           ''}
                        </span>
                      </div>
                    </div>
                  );
                })()}

                {/* State Machine Step Tracker */}
                <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                  {(() => {
                    const isBtcBacking = selectedOffer.backingChain === 'main';
                    const steps = [
                      { step: 1, title: 'Bilateral Split', desc: 'Secure inputs from replay risk', activeStatus: ['OPEN', 'ACCEPTED'] },
                      { 
                        step: 2, 
                        title: isBtcBacking ? 'BTC Locked' : 'B110 Locked', 
                        desc: isBtcBacking ? 'Initiator funds BTC HTLC' : 'Initiator funds B110 HTLC', 
                        activeStatus: ['ACCEPTED'] 
                      },
                      { 
                        step: 3, 
                        title: isBtcBacking ? 'B110 Locked' : 'BTC Locked', 
                        desc: isBtcBacking ? 'Acceptor funds B110 HTLC' : 'Acceptor funds BTC HTLC', 
                        activeStatus: ['FUNDED_INITIATOR'] 
                      },
                      { 
                        step: 4, 
                        title: isBtcBacking ? 'Claim B110' : 'Claim BTC', 
                        desc: isBtcBacking ? 'Initiator claims with preimage' : 'Initiator claims with preimage', 
                        activeStatus: ['FUNDED_ACCEPTOR'] 
                      },
                      { 
                        step: 5, 
                        title: isBtcBacking ? 'Claim BTC' : 'Claim B110', 
                        desc: isBtcBacking ? 'Acceptor extracts & claims' : 'Acceptor extracts & claims', 
                        activeStatus: ['CLAIMED'] 
                      }
                    ];
                    return steps.map(s => {
                      const isPassed = 
                        (s.step === 1 && selectedOffer.status !== 'OPEN') ||
                        (s.step === 2 && ['FUNDED_INITIATOR', 'FUNDED_ACCEPTOR', 'CLAIMED'].includes(selectedOffer.status)) ||
                        (s.step === 3 && ['FUNDED_ACCEPTOR', 'CLAIMED'].includes(selectedOffer.status)) ||
                        (s.step === 4 && selectedOffer.status === 'CLAIMED' && selectedOffer.preimage) ||
                        (s.step === 5 && selectedOffer.status === 'CLAIMED' && selectedOffer.acceptorClaimed);

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
                      );
                    });
                  })()}
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
                        <span className={`text-xs font-semibold px-2 py-1 rounded border ${ownMainBalance > 0 ? 'bg-emerald-950/40 border-emerald-900/60 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>
                          {ownMainBalance > 0 ? 'BTC Split Ready' : 'BTC Split Pending'}
                        </span>
                        <span className={`text-xs font-semibold px-2 py-1 rounded border ${getBip110SplitBalance() > 0 ? 'bg-sky-950/40 border-sky-900/60 text-sky-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>
                          {getBip110SplitBalance() > 0 ? 'B110 Split Ready' : 'B110 Split Pending'}
                        </span>
                      </div>
                    </div>

                    {/* Step 2: Lock B110 / BTC */}
                    {selectedOffer.status === 'ACCEPTED' && (() => {
                      const isBtcBacking = selectedOffer.backingChain === 'main';
                      const utxo = getActiveStepUtxo(2);
                      const isInitiator = selectedOffer.initiatorPubKey === publicKey;
                      const bgClass = isBtcBacking ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-sky-600 hover:bg-sky-500';

                      if (isInitiator) {
                        return (
                          <div className="bg-slate-950 border border-slate-850 p-5 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            <div>
                              <span className="text-[10px] text-slate-500 block uppercase tracking-wider font-bold">Pending Action (Initiator)</span>
                              <h4 className="text-xs font-bold text-slate-200">Lock {isBtcBacking ? 'Bitcoin' : 'BIP110'} Coins into HTLC Contract</h4>
                              {utxo && (
                                <p className="text-[10px] text-slate-400 font-mono mt-2 bg-slate-900 border border-slate-850 p-2.5 rounded-lg leading-normal">
                                  <span className="block font-semibold text-slate-300 mb-1">Spending Split UTXO:</span>
                                  TxID: {utxo.txid.substring(0, 12)}...{utxo.txid.substring(52)}:{utxo.vout}<br />
                                  Amount: {(utxo.amount / 100000000).toFixed(4)} {isBtcBacking ? 'BTC' : 'B110'}<br />
                                  Address: {utxo.address || 'Split contract / ownAddress'}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => runWizardStep(2)}
                              className={`px-4 py-2 text-white font-semibold text-xs rounded-xl shadow-md transition-all self-end md:self-center ${bgClass}`}
                            >
                              Lock & Fund {isBtcBacking ? 'BTC' : 'B110'} HTLC
                            </button>
                          </div>
                        );
                      } else {
                        return (
                          <div className="bg-slate-950 border border-slate-900 p-6 rounded-xl flex items-center gap-4 text-slate-400">
                            <div className="w-6 h-6 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin flex items-center justify-center"></div>
                            <div>
                              <h4 className="text-xs font-bold text-slate-200">Waiting for Initiator to fund the first HTLC contract</h4>
                              <p className="text-[10px] text-slate-500 mt-0.5 leading-normal">
                                The Initiator is currently locking their split coins into the {isBtcBacking ? 'BTC' : 'BIP110'} HTLC contract. Once broadcasted, this dashboard will update automatically.
                              </p>
                            </div>
                          </div>
                        );
                      }
                    })()}

                    {/* Step 3: Lock BTC / B110 */}
                    {selectedOffer.status === 'FUNDED_INITIATOR' && (() => {
                      const isBtcBacking = selectedOffer.backingChain === 'main';
                      const utxo = getActiveStepUtxo(3);
                      const isInitiator = selectedOffer.initiatorPubKey === publicKey;
                      const bgClass = isBtcBacking ? 'bg-sky-600 hover:bg-sky-500' : 'bg-emerald-600 hover:bg-emerald-500';

                      if (!isInitiator) {
                        return (
                          <div className="bg-slate-950 border border-slate-850 p-5 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            <div>
                              <span className="text-[10px] text-slate-500 block uppercase tracking-wider font-bold">Pending Action (Acceptor)</span>
                              <h4 className="text-xs font-bold text-slate-200">Lock {isBtcBacking ? 'BIP110' : 'Bitcoin'} Coins into HTLC Contract</h4>
                              {utxo && (
                                <p className="text-[10px] text-slate-400 font-mono mt-2 bg-slate-900 border border-slate-850 p-2.5 rounded-lg leading-normal">
                                  <span className="block font-semibold text-slate-300 mb-1">Spending Split UTXO:</span>
                                  TxID: {utxo.txid.substring(0, 12)}...{utxo.txid.substring(52)}:{utxo.vout}<br />
                                  Amount: {(utxo.amount / 100000000).toFixed(4)} {isBtcBacking ? 'B110' : 'BTC'}<br />
                                  Address: {utxo.address || 'Split contract / ownAddress'}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => runWizardStep(3)}
                              className={`px-4 py-2 text-white font-semibold text-xs rounded-xl shadow-md transition-all self-end md:self-center ${bgClass}`}
                            >
                              Lock & Fund {isBtcBacking ? 'B110' : 'BTC'} HTLC
                            </button>
                          </div>
                        );
                      } else {
                        return (
                          <div className="bg-slate-950 border border-slate-900 p-5 rounded-xl flex items-center justify-between opacity-80">
                            <div>
                              <span className="text-[10px] text-slate-500 block uppercase tracking-wider font-bold">Awaiting Action (Counterparty)</span>
                              <h4 className="text-xs font-bold text-slate-300">Waiting for Acceptor to Lock {isBtcBacking ? 'BIP110' : 'Bitcoin'} Coins</h4>
                              <p className="text-[10px] text-slate-500 mt-1">
                                You have successfully funded the first HTLC. Once the Acceptor verifies and locks their coins, we will proceed to Step 4.
                              </p>
                            </div>
                          </div>
                        );
                      }
                    })()}

                    {/* Step 4: Claim BTC / B110 */}
                    {selectedOffer.status === 'FUNDED_ACCEPTOR' && (() => {
                      const isBtcBacking = selectedOffer.backingChain === 'main';
                      const isInitiator = selectedOffer.initiatorPubKey === publicKey;

                      if (isInitiator) {
                        return (
                          <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl flex justify-between items-center">
                            <div>
                              <span className="text-[10px] text-slate-500 block uppercase tracking-wider font-bold">Pending Action (Initiator)</span>
                              <h4 className="text-xs font-bold text-slate-200">Initiator Claims {isBtcBacking ? 'B110' : 'BTC'} (Revealing Preimage)</h4>
                            </div>
                            <button
                              onClick={() => runWizardStep(4)}
                              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all"
                            >
                              Claim {isBtcBacking ? 'B110' : 'BTC'} (Reveal Secret)
                            </button>
                          </div>
                        );
                      } else {
                        return (
                          <div className="bg-slate-950 border border-slate-900 p-6 rounded-xl flex items-center gap-4 text-slate-400">
                            <div className="w-6 h-6 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin flex items-center justify-center"></div>
                            <div>
                              <h4 className="text-xs font-bold text-slate-200">Waiting for Initiator to claim and reveal preimage</h4>
                              <p className="text-[10px] text-slate-500 mt-0.5 leading-normal">
                                Both contracts are now fully funded on both blockchains. The Initiator is currently claiming their {isBtcBacking ? 'B110' : 'BTC'} coins, which will write the preimage secret to the public ledger.
                              </p>
                            </div>
                          </div>
                        );
                      }
                    })()}

                    {/* Step 5: Claim B110 / BTC */}
                    {selectedOffer.status === 'CLAIMED' && selectedOffer.preimage && !selectedOffer.acceptorClaimed && (() => {
                      const isBtcBacking = selectedOffer.backingChain === 'main';
                      const isInitiator = selectedOffer.initiatorPubKey === publicKey;

                      if (!isInitiator) {
                        return (
                          <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl flex justify-between items-center">
                            <div>
                              <span className="text-[10px] text-slate-500 block uppercase tracking-wider font-bold">Pending Action (Acceptor)</span>
                              <h4 className="text-xs font-bold text-slate-200">Acceptor Claims {isBtcBacking ? 'BTC' : 'B110'} using revealed Preimage</h4>
                              <p className="text-[10px] text-amber-400 font-mono mt-1 font-semibold">Found Preimage: "{selectedOffer.preimage}"</p>
                            </div>
                            <button
                              onClick={() => runWizardStep(5)}
                              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all"
                            >
                              Claim {isBtcBacking ? 'BTC' : 'B110'} (Extract Secret)
                            </button>
                          </div>
                        );
                      } else {
                        return (
                          <div className="bg-emerald-950/20 border border-emerald-900/40 p-5 rounded-xl text-center">
                            <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2 animate-pulse" />
                            <h4 className="text-sm font-bold text-emerald-200">You claimed your coins!</h4>
                            <p className="text-[10px] text-slate-400 leading-normal">
                              You have successfully claimed your {isBtcBacking ? 'B110' : 'BTC'} coins and revealed the preimage secret. The Acceptor is now claiming their {isBtcBacking ? 'BTC' : 'B110'} coins.
                            </p>
                          </div>
                        );
                      }
                    })()}

                    {/* Swap Completed / Final State */}
                    {selectedOffer.status === 'CLAIMED' && selectedOffer.acceptorClaimed && (
                      <div className="bg-emerald-950/20 border border-emerald-900/60 p-5 rounded-xl text-center">
                        <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                        <h4 className="text-sm font-bold text-emerald-200">Swap Execution Completed!</h4>
                        <p className="text-[10px] text-slate-400">All coins have successfully switched owners on both blockchains using replay-protected Taproot MAST leaves.</p>
                      </div>
                    )}

                    {/* Safety Refund Panel */}
                    {(selectedOffer.status === 'FUNDED_INITIATOR' || selectedOffer.status === 'FUNDED_ACCEPTOR') && (() => {
                      const isInitiator = selectedOffer.initiatorPubKey === publicKey;
                      const isBtcBacking = selectedOffer.backingChain === 'main';

                      const targetLocktime = isInitiator 
                        ? selectedOffer.lockTime 
                        : Math.round(selectedOffer.lockTime / 2);

                      const targetChain = isInitiator
                        ? (isBtcBacking ? 'main' : 'bip110')
                        : (isBtcBacking ? 'bip110' : 'main');

                      const currentHeight = targetChain === 'main' 
                        ? nodeInfo.mainHeight 
                        : nodeInfo.bip110Height;

                      const isExpired = currentHeight >= targetLocktime;

                      return (
                        <div className="bg-slate-900/30 border border-slate-800 p-5 rounded-xl space-y-3 mt-4">
                          <div className="flex justify-between items-start">
                            <div>
                              <h4 className="text-xs font-bold text-slate-300">Safety Refund Contract Gating</h4>
                              <p className="text-[10px] text-slate-400 mt-0.5 leading-normal">
                                If the counterparty disappears or fails to fulfill their step, you can safely reclaim your locked funds from the HTLC after block height expiration.
                              </p>
                            </div>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${isExpired ? 'bg-amber-950/40 border-amber-900/60 text-amber-400 animate-pulse' : 'bg-slate-950 border-slate-900 text-slate-500'}`}>
                              {isExpired ? 'EXPIRED (REFUND READY)' : 'LOCKED'}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-4 text-[10px] font-mono bg-slate-950 border border-slate-900 p-3 rounded-lg leading-normal">
                            <div>
                              <span className="text-slate-500 block">Your HTLC Locktime:</span>
                              <span className="font-semibold text-slate-300">Block #{targetLocktime}</span>
                            </div>
                            <div>
                              <span className="text-slate-500 block">Current Height ({targetChain === 'main' ? 'BTC' : 'B110'}):</span>
                              <span className={`font-semibold ${isExpired ? 'text-amber-400 font-bold' : 'text-slate-400'}`}>Block #{currentHeight}</span>
                            </div>
                          </div>

                          <div className="flex justify-between items-center pt-1.5 gap-4">
                            <span className="text-[10px] text-slate-500 font-medium leading-normal">
                              {isExpired 
                                ? '✔️ Refund window is OPEN. Reclaim your funds now.' 
                                : `⏳ Refund opens in ${targetLocktime - currentHeight} blocks (~${(((targetLocktime - currentHeight) * 10) / 60).toFixed(1)} hrs).`}
                            </span>
                            <button
                              onClick={executeRefund}
                              disabled={!isExpired}
                              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xs rounded-xl shadow-md transition-all whitespace-nowrap"
                            >
                              Reclaim Locked Funds
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Swap Refunded / Failed State */}
                    {selectedOffer.status === 'REFUNDED' && (
                      <div className="bg-amber-950/20 border border-amber-900/60 p-5 rounded-xl text-center">
                        <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-2 animate-bounce" />
                        <h4 className="text-sm font-bold text-amber-200">Swap Execution Refunded!</h4>
                        <p className="text-[10px] text-slate-400">The timelock expired and locked funds have been successfully recovered back to the owner's safe wallet address.</p>
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
