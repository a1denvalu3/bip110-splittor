import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory, ECPairAPI } from 'ecpair';
import { PureBitcoinSwap } from './lib/PureBitcoinSwap';
import { buildOutpointSet, classifyOutpoint, outpointKey } from '../../../src/lib/utxoClassification';
import { selectFundingUtxos } from '../../../src/lib/fundingSelection';
import type { FundingFeeEstimator } from '../../../src/lib/fundingSelection';
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
  Check,
  Download,
  Upload,
  ChevronDown,
  ChevronUp
} from 'lucide-react';

// Initialize Elliptic Curve library in the browser
bitcoin.initEccLib(ecc);
const ECPair: ECPairAPI = ECPairFactory(ecc);

// Deterministically derives child keypair from master private key and index
const deriveKeyPairForIndex = (masterPrivHex: string, index: number, network: bitcoin.Network): any => {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32BE(index, 0);
  const combined = Buffer.concat([Buffer.from(masterPrivHex, 'hex'), indexBuf]);
  const hash = bitcoin.crypto.sha256(combined);
  return ECPair.fromPrivateKey(hash, { network });
};

interface CollapsibleCardProps {
  title: string;
  icon?: React.ComponentType<any>;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  headerRight?: React.ReactNode;
}

function CollapsibleCard({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
  className = "",
  headerRight
}: CollapsibleCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className={`protocol-card bg-slate-900/50 border border-slate-800/80 rounded-2xl shadow-xl backdrop-blur-sm overflow-hidden ${className}`}>
      <div
        className="protocol-card__header w-full px-6 py-4 flex items-center justify-between hover:bg-slate-900/10 transition-colors cursor-pointer select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2">
          {Icon && <span className="protocol-card__icon"><Icon className="w-5 h-5 text-indigo-400" /></span>}
          <h3 className="text-md font-semibold text-slate-200">{title}</h3>
        </div>
        <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
          {headerRight}
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="text-slate-500 hover:text-slate-300 transition-colors p-1"
          >
            {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>
      {isOpen && (
        <div className="protocol-card__body px-6 pb-6 pt-2 border-t border-slate-800/40">
          {children}
        </div>
      )}
    </section>
  );
}

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV ? 'http://localhost:4000/api' : '/api')
).replace(/\/$/, '');

interface UTXO {
  txid: string;
  vout: number;
  amount: number; // satoshis
  confirmations: number;
  index?: number;
  address?: string;
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
  secondLockTime: number;
  b110HtlcAddress?: string;
  btcHtlcAddress?: string;
  b110HtlcTxid?: string;
  btcHtlcTxid?: string;
  b110HtlcVout?: number;
  btcHtlcVout?: number;
  initiatorSettlementTxid?: string;
  acceptorSettlementTxid?: string;
  preimage?: string;
  networkMode: 'mainnet' | 'regtest';
  createdAt: number;
  backingTxid?: string;
  backingVout?: number;
  backingChain?: 'main' | 'bip110';
  isPending?: boolean;
  acceptorClaimed?: boolean;
}

interface CoordinatorFees {
  makerFeePercent: string;
  takerFeePercent: string;
  receiveAddress: string;
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
  const [masterPrivateKey, setMasterPrivateKey] = useState<string>('');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [maxIndex, setMaxIndex] = useState<number>(0);

  // Polling History Ref for Change Detection Notifications
  const prevOffersRef = useRef<Offer[]>([]);

  const [revealMasterPrivKey, setRevealMasterPrivKey] = useState<boolean>(false);
  const [recoveryDownloaded, setRecoveryDownloaded] = useState<boolean>(false);

  // Active derived states (at activeIndex)
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

  // Balances of derived keypath addresses; cross-chain presence determines split state.
  const [ownMainBalance, setOwnMainBalance] = useState<number>(0);
  const [ownBip110Balance, setOwnBip110Balance] = useState<number>(0);
  const [ownMainUtxos, setOwnMainUtxos] = useState<UTXO[]>([]);
  const [ownBip110Utxos, setOwnBip110Utxos] = useState<UTXO[]>([]);
  const [balanceSyncStatus, setBalanceSyncStatus] = useState<'idle' | 'loading' | 'ready' | 'rate-limited' | 'error'>('idle');
  const [hasBalanceSnapshot, setHasBalanceSnapshot] = useState<boolean>(false);
  const balanceFetchInFlightRef = useRef<boolean>(false);
  const balanceRefreshQueuedRef = useRef<boolean>(false);
  const balanceRetryAfterRef = useRef<number>(0);

  // Selected UTXO to split
  const [nodeInfo, setNodeInfo] = useState<{
    mainHeight: number;
    bip110Height: number;
    errors?: { main?: string; bip110?: string };
  }>({ mainHeight: 0, bip110Height: 0 });
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
  const [marketplaceOffers, setMarketplaceOffers] = useState<Offer[]>([]);
  const [myCreatedOffers, setMyCreatedOffers] = useState<Offer[]>([]);
  const [myAcceptedOffers, setMyAcceptedOffers] = useState<Offer[]>([]);
  const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null);
  const [offersPage, setOffersPage] = useState<number>(1);
  const [offersLimit, setOffersLimit] = useState<number>(10);
  const [offersOrderBy, setOffersOrderBy] = useState<'premium' | 'amount' | 'createdAt'>('createdAt');
  const [offersOrderDir, setOffersOrderDir] = useState<'asc' | 'desc'>('desc');
  const [offersTotal, setOffersTotal] = useState<number>(0);
  const [offersTotalPages, setOffersTotalPages] = useState<number>(1);

  const offersList = React.useMemo(() => {
    const all = [...marketplaceOffers, ...myCreatedOffers, ...myAcceptedOffers];
    return all.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
  }, [marketplaceOffers, myCreatedOffers, myAcceptedOffers]);
  
  // Offer Form
  const [newOfferB110, setNewOfferB110] = useState<string>(''); // Auto-calculated from split UTXO
  const [newOfferBtc, setNewOfferBtc] = useState<string>('50000000'); // 0.5 BTC
  const [newOfferPreimage, setNewOfferPreimage] = useState<string>('secret-swap-preimage-proof');
  const [newOfferLocktime, setNewOfferLocktime] = useState<string>('1008');
  const [sellAmountSats, setSellAmountSats] = useState<string>('');
  const [premiumPercent, setPremiumPercent] = useState<string>('0');
  const [publishing, setPublishing] = useState<boolean>(false);
  const [selectedBackingUtxoKey, setSelectedBackingUtxoKey] = useState<string>('');

  // Withdraw State
  const [withdrawDestAddress, setWithdrawDestAddress] = useState<string>('');
  const [selectedWithdrawUtxoKey, setSelectedWithdrawUtxoKey] = useState<string>('');
  const [withdrawAmountSats, setWithdrawAmountSats] = useState<string>('');
  const [withdrawing, setWithdrawing] = useState<boolean>(false);

  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Helpers
  const getNetwork = (): bitcoin.Network => {
    return networkMode === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.regtest;
  };

  const getSecondHtlcLockTime = (offer: Offer, network: bitcoin.Network): number => {
    const intendedLockTime = offer.secondLockTime;
    const secondHtlcAddress = offer.backingChain === 'main' ? offer.b110HtlcAddress : offer.btcHtlcAddress;
    if (!secondHtlcAddress || !offer.acceptorPubKey) return intendedLockTime;

    const commonArgs = [
      secondHtlcAddress,
      Buffer.from(offer.initiatorPubKey, 'hex'),
      Buffer.from(offer.hashLock, 'hex'),
      Buffer.from(offer.initiatorPubKey, 'hex'),
      Buffer.from(offer.acceptorPubKey, 'hex')
    ] as const;

    if (PureBitcoinSwap.verifyTaprootHtlcAddress(...commonArgs, intendedLockTime, network)) {
      return intendedLockTime;
    }
    throw new Error('The acceptor HTLC address does not match its committed second deadline.');
  };

  const formatLockTimeDisplay = (lockTime: number, isHalf: boolean = false, backingChain: 'main' | 'bip110' = 'main') => {
    const currentHeight = backingChain === 'main' ? nodeInfo.mainHeight : nodeInfo.bip110Height;
    const targetHeight = isHalf ? lockTime : lockTime;
    
    if (currentHeight <= 0) {
      return `Block #${targetHeight}`;
    }
    
    const blocksRemaining = targetHeight - currentHeight;
    if (blocksRemaining <= 0) {
      return `Block #${targetHeight} (Expired)`;
    }
    
    const hours = ((blocksRemaining * 10) / 60).toFixed(1);
    return `Block #${targetHeight} (~${blocksRemaining} blks remaining / ~${hours} hrs)`;
  };

  const allMainUtxos = React.useMemo(
    () => [...mainUtxos, ...ownMainUtxos],
    [mainUtxos, ownMainUtxos]
  );
  const allBip110Utxos = React.useMemo(
    () => [...bip110Utxos, ...ownBip110Utxos],
    [bip110Utxos, ownBip110Utxos]
  );
  const mainOutpoints = React.useMemo(() => buildOutpointSet(allMainUtxos), [allMainUtxos]);
  const bip110Outpoints = React.useMemo(() => buildOutpointSet(allBip110Utxos), [allBip110Utxos]);

  // An outpoint is unsplit only while the exact txid:vout exists on both chains.
  const isUtxoUnsplit = (u: UTXO): boolean => {
    return classifyOutpoint(u, mainOutpoints, bip110Outpoints) === 'unsplit';
  };

  // Helper to determine if a UTXO is split (replay-protected on one chain only)
  const isUtxoSplit = (u: UTXO): boolean => {
    return !isUtxoUnsplit(u);
  };

  const uniqueUtxos = (utxos: UTXO[]): UTXO[] => utxos.filter(
    (utxo, index, list) => list.findIndex(candidate => outpointKey(candidate) === outpointKey(utxo)) === index
  );

  const getUnsplitUtxosForChain = (chain: 'main' | 'bip110'): UTXO[] => {
    const candidates = chain === 'main' ? allMainUtxos : allBip110Utxos;
    return uniqueUtxos(candidates).filter(isUtxoUnsplit);
  };

  const getSplitUtxosForChain = (chain: 'main' | 'bip110'): UTXO[] => {
    const candidates = chain === 'main' ? allMainUtxos : allBip110Utxos;
    return uniqueUtxos(candidates).filter(u => u.confirmations >= 1 && isUtxoSplit(u));
  };

  const requireFundingUtxo = (offer: Offer, chain: 'main' | 'bip110', utxos: UTXO[]): UTXO => {
    const txid = chain === 'main' ? offer.btcHtlcTxid : offer.b110HtlcTxid;
    const vout = chain === 'main' ? offer.btcHtlcVout : offer.b110HtlcVout;
    const amount = chain === 'main' ? offer.acceptorBtcAmount : offer.initiatorB110Amount;
    if (!txid || vout === undefined) throw new Error('The server has not committed an exact HTLC funding outpoint.');
    const match = utxos.find(u => u.txid === txid && u.vout === vout);
    if (!match || match.amount !== amount) throw new Error('The committed HTLC funding outpoint is missing or has the wrong amount.');
    return match;
  };

  const verifyFundingOnClient = async (offer: Offer, chain: 'main' | 'bip110'): Promise<UTXO> => {
    if (!offer.acceptorPubKey || !offer.backingChain) throw new Error('Offer contract is incomplete.');
    const firstHtlc = chain === offer.backingChain;
    const address = chain === 'main' ? offer.btcHtlcAddress : offer.b110HtlcAddress;
    const txid = chain === 'main' ? offer.btcHtlcTxid : offer.b110HtlcTxid;
    const vout = chain === 'main' ? offer.btcHtlcVout : offer.b110HtlcVout;
    const amount = chain === 'main' ? offer.acceptorBtcAmount : offer.initiatorB110Amount;
    const recipient = Buffer.from(firstHtlc ? offer.acceptorPubKey : offer.initiatorPubKey, 'hex');
    const refund = Buffer.from(firstHtlc ? offer.initiatorPubKey : offer.acceptorPubKey, 'hex');
    const deadline = firstHtlc ? offer.lockTime : offer.secondLockTime;
    if (!address || !txid || vout === undefined || !deadline) throw new Error('The committed HTLC funding data is incomplete.');

    const validContract = PureBitcoinSwap.verifyTaprootHtlcAddress(
      address, Buffer.from(offer.initiatorPubKey, 'hex'), Buffer.from(offer.hashLock, 'hex'),
      recipient, refund, deadline, getNetwork()
    );
    if (!validContract) throw new Error('The committed HTLC address does not match the independently reconstructed contract.');

    const rawRes = await axios.get(`${API_BASE}/tx/raw`, { params: { txid, chain } });
    const transaction = bitcoin.Transaction.fromHex(rawRes.data.hex);
    if (transaction.getId().toLowerCase() !== txid.toLowerCase()) throw new Error('Raw funding transaction ID does not match the committed transaction ID.');
    if (!Number.isSafeInteger(vout) || vout < 0 || vout >= transaction.outs.length) throw new Error('Committed HTLC output index is invalid.');
    const output = transaction.outs[vout];
    const expectedScript = bitcoin.address.toOutputScript(address, getNetwork());
    if (!Buffer.from(output.script).equals(expectedScript) || output.value !== BigInt(amount)) {
      throw new Error('Committed funding output does not contain the exact HTLC script and agreed amount.');
    }

    const utxoRes = await axios.post(`${API_BASE}/wallet/utxos`, { address, chain, networkMode });
    const utxo = requireFundingUtxo(offer, chain, utxoRes.data.utxos);
    if (utxo.confirmations < 1) throw new Error('The committed HTLC funding output is not yet confirmed.');
    return utxo;
  };

  const assertConstructedFundingOutput = (transaction: bitcoin.Transaction, address: string, amount: bigint): number => {
    const expectedScript = bitcoin.address.toOutputScript(address, getNetwork());
    const matches = transaction.outs
      .map((output, index) => ({ output, index }))
      .filter(({ output }) => Buffer.from(output.script).equals(expectedScript) && output.value === amount);
    if (matches.length !== 1) throw new Error('Locally built transaction does not contain exactly one agreed HTLC output.');
    return matches[0].index;
  };

  // Helper to get total Main-Chain unsplit balance
  const getMainUnsplitBalance = (): number => {
    return getUnsplitUtxosForChain('main')
      .reduce((sum, u) => sum + u.amount, 0);
  };

  // Helper to get total Main-Chain split balance
  const getMainSplitBalance = (): number => {
    return getSplitUtxosForChain('main').reduce((sum, u) => sum + u.amount, 0);
  };

  // Helper to get total BIP110 split balance
  const getBip110SplitBalance = (): number => {
    return getSplitUtxosForChain('bip110').reduce((sum, u) => sum + u.amount, 0);
  };

  // Helper to get total BIP110 unsplit balance
  const getBip110UnsplitBalance = (): number => {
    return getUnsplitUtxosForChain('bip110')
      .reduce((sum, u) => sum + u.amount, 0);
  };

  // Helper to get all available split UTXOs on either chain/address
  const getAvailableSplitUtxos = () => {
    const list: { txid: string; vout: number; amount: number; chain: 'main' | 'bip110'; address: string }[] = [];
    
    getSplitUtxosForChain('bip110').forEach(u => {
      list.push({ txid: u.txid, vout: u.vout, amount: u.amount, chain: 'bip110', address: u.address || ownAddress });
    });
    getSplitUtxosForChain('main').forEach(u => {
      list.push({ txid: u.txid, vout: u.vout, amount: u.amount, chain: 'main', address: u.address || ownAddress });
    });

    return list;
  };

  // Helper to get matching split UTXOs (possibly multiple) on the other chain for taker to accept an offer
  const getMatchingTakerUtxos = (o: Offer): UTXO[] => {
    let availableUtxos: UTXO[] = [];
    let targetAmount = 0;

    if (o.backingChain === 'bip110') {
      availableUtxos = getSplitUtxosForChain('main');
      targetAmount = o.acceptorBtcAmount;
    } else if (o.backingChain === 'main') {
      availableUtxos = getSplitUtxosForChain('bip110');
      targetAmount = o.initiatorB110Amount;
    } else {
      // Fallback
      const splitMainUtxos = getSplitUtxosForChain('main');
      const btcTotal = splitMainUtxos.reduce((sum, u) => sum + u.amount, 0);
      if (btcTotal >= o.acceptorBtcAmount) {
        availableUtxos = splitMainUtxos;
        targetAmount = o.acceptorBtcAmount;
      } else {
        availableUtxos = getSplitUtxosForChain('bip110');
        targetAmount = o.initiatorB110Amount;
      }
    }

    // Sort descending to minimize inputs
    const sorted = [...availableUtxos].sort((a, b) => b.amount - a.amount);
    
    const selected: UTXO[] = [];
    let currentSum = 0;
    for (const utxo of sorted) {
      selected.push(utxo);
      currentSum += utxo.amount;
      if (currentSum >= targetAmount) {
        return selected;
      }
    }
    
    return []; // Not enough total balance
  };

  // Helper to get matching split UTXO on the other chain for taker to accept an offer
  const getMatchingTakerUtxo = (o: Offer): UTXO | null => {
    const selected = getMatchingTakerUtxos(o);
    return selected.length > 0 ? selected[0] : null;
  };

  const getActiveStepUtxo = (step: number): any => {
    if (!selectedOffer) return null;
    const isBtcBacking = selectedOffer.backingChain === 'main';

    if (step === 2) {
      const chain = isBtcBacking ? 'main' : 'bip110';
      const utxo = getSplitUtxosForChain(chain).find(
        u => u.txid === selectedOffer.backingTxid && u.vout === selectedOffer.backingVout
      );
      return utxo || { txid: selectedOffer.backingTxid, vout: selectedOffer.backingVout, amount: isBtcBacking ? selectedOffer.acceptorBtcAmount : selectedOffer.initiatorB110Amount };
    }

    if (step === 3) {
      return getSplitUtxosForChain(isBtcBacking ? 'bip110' : 'main')[0] || null;
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
      const hasRefundableEscrow = isInitiator
        ? selectedOffer.status === 'FUNDED_INITIATOR' || selectedOffer.status === 'FUNDED_ACCEPTOR'
        : selectedOffer.acceptorPubKey === publicKey && selectedOffer.status === 'FUNDED_ACCEPTOR';
      if (!hasRefundableEscrow) {
        throw new Error('You have not funded an HTLC in the current swap state, so there is nothing to refund.');
      }

      if (isInitiator) {
        // Initiator refunds the first HTLC after lockTime (T)
        const targetChain = isBtcBacking ? 'main' : 'bip110';
        const targetAddress = isBtcBacking ? selectedOffer.btcHtlcAddress! : selectedOffer.b110HtlcAddress!;
        const currentHeight = isBtcBacking ? nodeInfo.mainHeight : nodeInfo.bip110Height;

        if (currentHeight < selectedOffer.lockTime) {
          throw new Error(`Cannot refund yet: current block height is ${currentHeight}, but refund locktime is ${selectedOffer.lockTime}. Please mine more blocks first.`);
        }

        showToast(`Locating funded UTXO on ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC address...`, 'info');

        const utxo = await verifyFundingOnClient(selectedOffer, targetChain);

        showToast("Signing Refund transaction using Taproot MAST RefundLeaf...", 'info');
        
        // Reconstruct the HTLC payment details
        const recipientPubKey = Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const refundPubKey = Buffer.from(selectedOffer.initiatorPubKey, 'hex');

        const keyPair = getKeyPairForPubKey(Buffer.from(refundPubKey).toString('hex'), net);

        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          recipientPubKey,
          refundPubKey,
          selectedOffer.lockTime,
          net
        );

        // Build and sign refund transaction
        const refundFeeSats = await calculateTxFee('refund', false, targetChain);
        const tx = PureBitcoinSwap.buildHtlcRefundTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - refundFeeSats),
          ownAddress, // Refund goes back to user's safe ownAddress
          Buffer.from(selectedOffer.hashLock, 'hex'),
          recipientPubKey,
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          selectedOffer.lockTime,
          net
        );

        // Broadcast raw tx
        const settlementRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        // Update Offer State on server
        const role = selectedOffer.initiatorPubKey === publicKey ? 'initiator' : 'acceptor';
        const updateRes = await secureUpdateOffer(selectedOffer.id, {
          status: 'REFUNDED',
          initiatorSettlementTxid: settlementRes.data.txid
        }, role);

        setSelectedOffer(updateRes.data);
        showToast("HTLC successfully refunded! Your coins have been reclaimed.", "success");
      } 
      
      else {
        // Acceptor refunds the second HTLC after lockTime / 2 (T/2)
        const targetChain = isBtcBacking ? 'bip110' : 'main';
        const targetAddress = isBtcBacking ? selectedOffer.b110HtlcAddress! : selectedOffer.btcHtlcAddress!;
        const currentHeight = isBtcBacking ? nodeInfo.bip110Height : nodeInfo.mainHeight;
        const requiredLockTime = getSecondHtlcLockTime(selectedOffer, net);

        if (currentHeight < requiredLockTime) {
          throw new Error(`Cannot refund yet: current block height is ${currentHeight}, but refund locktime is ${requiredLockTime}. Please mine more blocks first.`);
        }

        showToast(`Locating funded UTXO on ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC address...`, 'info');

        const utxo = await verifyFundingOnClient(selectedOffer, targetChain);

        showToast("Signing Refund transaction using Taproot MAST RefundLeaf...", 'info');
        
        // Reconstruct second HTLC payment details
        const secondHtlcRecipient = Buffer.from(selectedOffer.initiatorPubKey, 'hex');
        const secondHtlcRefund = Buffer.from(selectedOffer.acceptorPubKey!, 'hex');

        const keyPair = getKeyPairForPubKey(Buffer.from(secondHtlcRefund).toString('hex'), net);

        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          secondHtlcRefund,
          requiredLockTime,
          net
        );

        // Build and sign refund transaction
        const refundFeeSats = await calculateTxFee('refund', false, targetChain);
        const tx = PureBitcoinSwap.buildHtlcRefundTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - refundFeeSats),
          ownAddress, // Refund goes back to user's safe ownAddress
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          requiredLockTime,
          net
        );

        // Broadcast raw tx
        const settlementRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        // Update Offer State on server
        const role = selectedOffer.initiatorPubKey === publicKey ? 'initiator' : 'acceptor';
        const updateRes = await secureUpdateOffer(selectedOffer.id, {
          status: 'REFUNDED',
          acceptorSettlementTxid: settlementRes.data.txid
        }, role);

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

  // Helper to derive keys and addresses for a given index deterministically
  const deriveKeysForIndex = (masterPriv: string, index: number, network: bitcoin.Network) => {
    const childKeyPair = deriveKeyPairForIndex(masterPriv, index, network);
    const childPublicKey = Buffer.from(childKeyPair.publicKey).toString('hex');
    const childPrivateKey = Buffer.from(childKeyPair.privateKey!).toString('hex');
    const splitPayment = PureBitcoinSwap.createSplitPayment(Buffer.from(childKeyPair.publicKey), network);
    const ownPayment = bitcoin.payments.p2tr({
      internalPubkey: PureBitcoinSwap.getXOnlyPubKey(Buffer.from(childKeyPair.publicKey)),
      network
    });
    return {
      privateKey: childPrivateKey,
      publicKey: childPublicKey,
      splitAddress: splitPayment.payment.address!,
      ownAddress: ownPayment.address!
    };
  };

  // Find derived keypair in history by public key hex, or return the active keypair as fallback
  const getKeyPairForPubKey = (pubKeyHex: string, network: bitcoin.Network): any => {
    for (let i = 0; i <= maxIndex; i++) {
      const kp = deriveKeyPairForIndex(masterPrivateKey, i, network);
      if (Buffer.from(kp.publicKey).toString('hex') === pubKeyHex) {
        return kp;
      }
    }
    // Fallback to active private key
    return ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network });
  };

  const getRecommendedFeeRate = async (chain: 'main' | 'bip110'): Promise<number> => {
    if (networkMode === 'regtest') return 15;

    const res = await axios.get(`${API_BASE}/fees/recommended?chain=${chain}`, { timeout: 5000 });
    const rate = Number(res.data.halfHourFee || res.data.hourFee);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Explorer returned an invalid fee rate for ${chain}`);
    }
    return rate;
  };

  const getCoordinatorFees = async (): Promise<CoordinatorFees> => {
    const res = await axios.get(`${API_BASE}/fees/coordinator`, { timeout: 5000 });
    const makerFeePercent = String(res.data?.makerFeePercent ?? '');
    const takerFeePercent = String(res.data?.takerFeePercent ?? '');
    const receiveAddress = String(res.data?.receiveAddress ?? '');
    for (const [name, value] of [['maker', makerFeePercent], ['taker', takerFeePercent]]) {
      if (!/^(?:\d+)(?:\.\d+)?$/.test(value) || Number(value) > 100) {
        throw new Error(`Server returned an invalid ${name} coordinator fee`);
      }
    }
    if ((Number(makerFeePercent) > 0 || Number(takerFeePercent) > 0) && !receiveAddress) {
      throw new Error('Server coordinator fee configuration has no receive address');
    }
    return { makerFeePercent, takerFeePercent, receiveAddress };
  };

  const coordinatorFeeSats = (amountSats: number, percent: string): bigint => {
    const [whole, fraction = ''] = percent.split('.');
    const scale = 10n ** BigInt(fraction.length);
    const numerator = BigInt(whole) * scale + BigInt(fraction || '0');
    const denominator = 100n * scale;
    const product = BigInt(amountSats) * numerator;
    return (product + denominator - 1n) / denominator;
  };

  // Dynamically calculate transaction fee in Satoshis depending on active network mode
  const calculateTxFee = async (
    txType: 'split-script' | 'split-keypath' | 'funding' | 'claim' | 'refund' | 'withdraw',
    hasChange: boolean = false,
    chain: 'main' | 'bip110' = 'main'
  ): Promise<number> => {
    if (networkMode === 'regtest') {
      // For regtest, we continue with standard hardcoded values for simplicity and reliability in local environments
      if (txType === 'funding') return 5000;
      if (txType === 'claim') return 2000;
      if (txType === 'refund') return 2000;
      if (txType === 'withdraw') return 5000;
      return 2000; // split-script / split-keypath
    }

    // Mainnet Mode: Fetch feerate from the chain-specific backend proxy.
    const mempoolRate = await getRecommendedFeeRate(chain);
    const safetyMargin = Math.min(5, mempoolRate);
    const finalRate = mempoolRate + safetyMargin;

    let vBytes = 150;
    switch (txType) {
      case 'split-script':
        vBytes = 130;
        break;
      case 'split-keypath':
        vBytes = 115;
        break;
      case 'funding':
        vBytes = hasChange ? 160 : 115;
        break;
      case 'claim':
        vBytes = 155;
        break;
      case 'refund':
        vBytes = 140;
        break;
      case 'withdraw':
        vBytes = hasChange ? 180 : 130;
        break;
    }

    const feeSats = Math.ceil(vBytes * finalRate);
    console.log(`[FEE-CALC] Mainnet Feerate for ${chain.toUpperCase()}: ${finalRate} sats/vB (including safety margin). TxType: ${txType}, size: ${vBytes} vB. Fee: ${feeSats} sats.`);
    return feeSats;
  };

  const createFundingFeeEstimator = async (chain: 'main' | 'bip110', coordinatorOutput = false): Promise<FundingFeeEstimator> => {
    if (networkMode === 'regtest') {
      return (inputCount: number) => 5000 + Math.max(0, inputCount - 1) * 1000;
    }

    const mempoolRate = await getRecommendedFeeRate(chain);
    const finalRate = mempoolRate + Math.min(5, mempoolRate);
    return (inputCount: number, hasChange: boolean) => {
      const baseVbytes = (hasChange ? 160 : 115) + (coordinatorOutput ? 43 : 0);
      const additionalInputVbytes = Math.max(0, inputCount - 1) * 68;
      return Math.ceil((baseVbytes + additionalInputVbytes) * finalRate);
    };
  };

  const buildFundingInputs = (
    selectedUtxos: UTXO[],
    chain: 'main' | 'bip110',
    network: bitcoin.Network
  ) => selectedUtxos.map(utxo => {
    const utxoIndex = utxo.index !== undefined ? utxo.index : activeIndex;
    const keyPair = deriveKeyPairForIndex(masterPrivateKey, utxoIndex, network);
    const pubKey = Buffer.from(keyPair.publicKey);
    const contractAddressUtxos = chain === 'main' ? mainUtxos : bip110Utxos;
    const isContractAddress = contractAddressUtxos.some(
      candidate => candidate.txid === utxo.txid && candidate.vout === utxo.vout
    );

    if (isContractAddress) {
      const splitPayment = PureBitcoinSwap.createSplitPayment(pubKey, network);
      return {
        txid: utxo.txid,
        vout: utxo.vout,
        amount: BigInt(utxo.amount),
        keyPair,
        merkleRoot: splitPayment.leafHash,
        paymentOutput: splitPayment.payment.output!
      };
    }

    const keypathPayment = bitcoin.payments.p2tr({
      internalPubkey: PureBitcoinSwap.getXOnlyPubKey(pubKey),
      network
    });
    return {
      txid: utxo.txid,
      vout: utxo.vout,
      amount: BigInt(utxo.amount),
      keyPair,
      merkleRoot: Buffer.alloc(0),
      paymentOutput: keypathPayment.output!
    };
  });

  // Helper to derive a completely new, unused change address by incrementing maxIndex (HD privacy)
  const getNewChangeAddress = (network: bitcoin.Network): string => {
    const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';
    const nextMaxIndex = maxIndex + 1;
    
    // Update index state
    setMaxIndex(nextMaxIndex);
    localStorage.setItem(`${keyPrefix}_max_index`, String(nextMaxIndex));
    
    const childKeys = deriveKeysForIndex(masterPrivateKey, nextMaxIndex, network);
    console.log(`[CHANGE-DERIVATION] Generated fresh change address at index #${nextMaxIndex + 1}: ${childKeys.ownAddress}`);
    return childKeys.ownAddress;
  };

  // Web Audio API Synthesizer: pleasant two-tone platform chime (D5 to A5 notes)
  const playNotificationChime = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5 note
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5 note
      
      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
      
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.45);
    } catch (err) {
      console.warn("Web Audio API chime blocked by browser autoplay policy:", err);
    }
  };

  // Triggers HTML5 System Desktop Notifications and plays the chime
  const sendSystemNotification = (title: string, body: string) => {
    playNotificationChime();
    
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body,
          tag: 'bip110-swap-portal'
        });
      } catch (e) {
        console.error("System notification failed to spawn:", e);
      }
    }
  };

  // Request HTML5 Notifications permission on startup
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            console.log("Desktop notifications permission granted.");
          }
        });
      }
    }
  }, []);

  // Monitor offersList changes and dispatch real-time notifications
  useEffect(() => {
    if (!offersList || offersList.length === 0) {
      prevOffersRef.current = offersList || [];
      return;
    }

    const prevOffers = prevOffersRef.current;
    if (prevOffers && prevOffers.length > 0 && publicKey) {
      // 1. Detect New Offers published by counterparties
      offersList.forEach(o => {
        const wasPresent = prevOffers.some(p => p.id === o.id);
        const isNotOurs = o.initiatorPubKey !== publicKey;
        
        if (!wasPresent && isNotOurs) {
          sendSystemNotification(
            "New Swap Offer Open",
            `Marketplace: #${o.id} is selling ${(o.initiatorB110Amount / 100000000).toFixed(4)} B110 for ${(o.acceptorBtcAmount / 100000000).toFixed(4)} BTC.`
          );
        }
      });

      // 2. Detect Existing Offers status transitions or field updates
      offersList.forEach(o => {
        const prev = prevOffers.find(p => p.id === o.id);
        if (prev) {
          const isParticipant = o.initiatorPubKey === publicKey || o.acceptorPubKey === publicKey;
          const isWeInitiator = o.initiatorPubKey === publicKey;

          if (isParticipant) {
            // Status updated
            if (o.status !== prev.status) {
              let title = `Swap #${o.id} Progressed`;
              let text = `Status updated to ${o.status}`;
              
              if (o.status === 'ACCEPTED') {
                title = "Swap Offer Accepted!";
                text = `A counterparty has accepted your Swap #${o.id}. Proceed to fund HTLC.`;
              } else if (o.status === 'FUNDED_INITIATOR') {
                title = "Initiator Escrow Locked";
                text = `The Initiator has locked coins for Swap #${o.id}. Verify and fund your escrow now.`;
              } else if (o.status === 'FUNDED_ACCEPTOR') {
                title = "Acceptor Escrow Locked";
                text = `The Acceptor has locked coins for Swap #${o.id}. You can now claim yours!`;
              } else if (o.status === 'CLAIMED') {
                title = "Swap Settled Successfully!";
                text = `All contract escrow claims are complete for Swap #${o.id}.`;
              } else if (o.status === 'REFUNDED') {
                title = "Swap Aborted & Refunded";
                text = `Escrow timelocks expired and coins were reclaimed for Swap #${o.id}.`;
              }

              sendSystemNotification(title, text);
            }
            
            // Preimage revealed
            else if (o.preimage !== prev.preimage && o.preimage && !isWeInitiator) {
              sendSystemNotification(
                "Preimage Revealed!",
                `The Initiator has claimed BTC, revealing preimage "${o.preimage}". Claim your B110 coins now!`
              );
            }

            // Acceptor claimed B110
            else if (o.acceptorClaimed !== prev.acceptorClaimed && o.acceptorClaimed && isWeInitiator) {
              sendSystemNotification(
                "Swap Completed!",
                `The Acceptor has extracted the preimage and successfully claimed their B110 coins.`
              );
            }
          }
        }
      });
    }

    // Keep history ref updated
    prevOffersRef.current = offersList;
  }, [offersList, publicKey]);

  // Load saved master key and active/max index pointers from LocalStorage on mount or networkMode change
  useEffect(() => {
    setHasBalanceSnapshot(false);
    setBalanceSyncStatus('loading');
    balanceRetryAfterRef.current = 0;
    const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';
    const net = getNetwork();

    let masterPriv = sessionStorage.getItem(`${keyPrefix}_master_privkey`);
    let activeIdx = parseInt(localStorage.getItem(`${keyPrefix}_active_index`) || '0', 10);
    let maxIdx = parseInt(localStorage.getItem(`${keyPrefix}_max_index`) || '0', 10);

    if (!masterPriv) {
      // Migrate pre-existing non-master private key to master if exists, or generate a fresh one
      const oldPriv = localStorage.getItem(`${keyPrefix}_master_privkey`) || localStorage.getItem(`${keyPrefix}_bip110_privkey`);
      if (oldPriv) {
        masterPriv = oldPriv;
      } else {
        const pair = ECPair.makeRandom();
        masterPriv = Buffer.from(pair.privateKey!).toString('hex');
      }
      activeIdx = 0;
      maxIdx = 0;
      sessionStorage.setItem(`${keyPrefix}_master_privkey`, masterPriv);
      localStorage.setItem(`${keyPrefix}_active_index`, '0');
      localStorage.setItem(`${keyPrefix}_max_index`, '0');
    }
    // Remove legacy persistent plaintext secrets after one-time migration.
    localStorage.removeItem(`${keyPrefix}_master_privkey`);
    localStorage.removeItem(`${keyPrefix}_bip110_privkey`);

    setMasterPrivateKey(masterPriv);
    setActiveIndex(activeIdx);
    setMaxIndex(maxIdx);

    // Retrieve recovery downloaded status for this networkMode
    const isDownloaded = localStorage.getItem(`${keyPrefix}_recovery_downloaded`) === 'true';
    setRecoveryDownloaded(isDownloaded);

    // Derive active states for this activeIndex
    const activeKeys = deriveKeysForIndex(masterPriv, activeIdx, net);
    setPrivateKey(activeKeys.privateKey);
    setPublicKey(activeKeys.publicKey);
    setSplitAddress(activeKeys.splitAddress);
    setOwnAddress(activeKeys.ownAddress);

    fetchNodeInfo();
  }, [networkMode]);

  // Fetch offers immediately whenever pagination/sorting or networkMode changes
  useEffect(() => {
    fetchOffers();
  }, [networkMode, offersPage, offersLimit, offersOrderBy, offersOrderDir]);

  // Sync balances and UTXOs when splitAddress, ownAddress or activeTab/networkMode changes
  useEffect(() => {
    if (splitAddress && ownAddress) {
      fetchBalances();
    }
  }, [splitAddress, ownAddress, activeTab, networkMode, masterPrivateKey, maxIndex]);

  // Poll node info, marketplace offers, and wallet balances/UTXOs every 10 seconds for active, real-time updates
  useEffect(() => {
    const interval = setInterval(() => {
      fetchNodeInfo();
      fetchOffers();
      if (splitAddress && ownAddress) {
        fetchBalances();
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [networkMode, splitAddress, ownAddress, masterPrivateKey, maxIndex, offersPage, offersLimit, offersOrderBy, offersOrderDir]);

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

  const handleDownloadRecoveryFile = async () => {
    try {
      const password = window.prompt('Choose a strong password to encrypt this recovery file:');
      if (!password || password.length < 12) throw new Error('Recovery password must be at least 12 characters.');
      const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';
      const recoveryData = {
        app: 'bip110-splittoooor',
        networkMode,
        masterPrivateKey,
        maxIndex,
        backupDate: new Date().toISOString(),
        instructions: "Upload this file to the BIP110 Splittoooor application to instantly restore your Master Private Key and derived addresses."
      };

      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const material = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      const key = await window.crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(recoveryData)));
      const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      const jsonStr = JSON.stringify({ app: 'bip110-splittoooor-encrypted', version: 1, kdf: 'PBKDF2-SHA256', iterations: 310000, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) }, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `bip110-splittoooor-recovery-${networkMode}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      // Set downloaded state to true and save to local storage
      localStorage.setItem(`${keyPrefix}_recovery_downloaded`, 'true');
      setRecoveryDownloaded(true);

      showToast('Recovery file downloaded successfully! Wallet splitting features unlocked.', 'success');
    } catch (err: any) {
      showToast('Error generating recovery file: ' + err.message, 'error');
    }
  };

  const handleUploadRecoveryFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;
        let data = JSON.parse(text);
        if (data.app === 'bip110-splittoooor-encrypted') {
          const password = window.prompt('Enter the recovery-file password:');
          if (!password) throw new Error('A password is required.');
          const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
          const material = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
          const key = await window.crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromBase64(data.salt), iterations: data.iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
          const plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(data.iv) }, key, fromBase64(data.ciphertext));
          data = JSON.parse(new TextDecoder().decode(plaintext));
        }

        if (data.app !== 'bip110-splittoooor' || !data.masterPrivateKey) {
          showToast('Invalid recovery file format. Please upload a valid BIP110 Splittoooor recovery file.', 'error');
          return;
        }

        const confirmed = window.confirm(
          `Are you sure you want to restore this wallet?\n\nThis will overwrite your current Master Private Key (${masterPrivateKey.substring(0, 10)}...) and derived addresses with the ones from the backup.\n\nMake sure you have backed up any current keys first!`
        );
        if (!confirmed) return;

        const net = getNetwork();
        const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';

        // Update local state and localStorage
        const masterPriv = data.masterPrivateKey;
        const maxIdx = typeof data.maxIndex === 'number' ? data.maxIndex : 0;
        const activeIdx = 0; // reset active index to first derived address

        setMasterPrivateKey(masterPriv);
        setHasBalanceSnapshot(false);
        setBalanceSyncStatus('loading');
        balanceRetryAfterRef.current = 0;
        setActiveIndex(activeIdx);
        setMaxIndex(maxIdx);

        sessionStorage.setItem(`${keyPrefix}_master_privkey`, masterPriv);
        localStorage.setItem(`${keyPrefix}_active_index`, String(activeIdx));
        localStorage.setItem(`${keyPrefix}_max_index`, String(maxIdx));

        // Mark recovery as downloaded since they uploaded their recovery backup
        localStorage.setItem(`${keyPrefix}_recovery_downloaded`, 'true');
        setRecoveryDownloaded(true);

        // Derive active states
        const activeKeys = deriveKeysForIndex(masterPriv, activeIdx, net);
        setPrivateKey(activeKeys.privateKey);
        setPublicKey(activeKeys.publicKey);
        setSplitAddress(activeKeys.splitAddress);
        setOwnAddress(activeKeys.ownAddress);

        showToast('Wallet successfully restored from backup file! Switched to derived Address #1.', 'success');
      } catch (err: any) {
        showToast('Error parsing recovery file: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    // Reset file input value
    event.target.value = '';
  };

  const generateNewWallet = async () => {
    setLoadingKeys(true);
    try {
      const net = getNetwork();
      const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';

      // Increment maxIndex to derive the next address deterministically!
      const newMaxIndex = maxIndex + 1;
      
      const activeKeys = deriveKeysForIndex(masterPrivateKey, newMaxIndex, net);

      setPrivateKey(activeKeys.privateKey);
      setPublicKey(activeKeys.publicKey);
      setSplitAddress(activeKeys.splitAddress);
      setOwnAddress(activeKeys.ownAddress);
      setActiveIndex(newMaxIndex);
      setMaxIndex(newMaxIndex);

      localStorage.setItem(`${keyPrefix}_active_index`, String(newMaxIndex));
      localStorage.setItem(`${keyPrefix}_max_index`, String(newMaxIndex));

      sessionStorage.setItem(`${keyPrefix}_bip110_privkey`, activeKeys.privateKey);
      localStorage.setItem(`${keyPrefix}_bip110_pubkey`, activeKeys.publicKey);
      localStorage.setItem(`${keyPrefix}_bip110_address`, activeKeys.splitAddress);
      
      showToast(`Derived and switched to new P2TR Address #${newMaxIndex + 1} entirely from your master key.`, 'success');
    } catch (err: any) {
      showToast('Error generating keys: ' + err.message, 'error');
    } finally {
      setLoadingKeys(false);
    }
  };

  const loadWalletFromHistory = (index: number) => {
    const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';
    const net = getNetwork();
    
    if (index < 0 || index > maxIndex) return;

    const activeKeys = deriveKeysForIndex(masterPrivateKey, index, net);

    setPrivateKey(activeKeys.privateKey);
    setPublicKey(activeKeys.publicKey);
    setSplitAddress(activeKeys.splitAddress);
    setOwnAddress(activeKeys.ownAddress);
    setActiveIndex(index);

    localStorage.setItem(`${keyPrefix}_active_index`, String(index));

    sessionStorage.setItem(`${keyPrefix}_bip110_privkey`, activeKeys.privateKey);
    localStorage.setItem(`${keyPrefix}_bip110_pubkey`, activeKeys.publicKey);
    localStorage.setItem(`${keyPrefix}_bip110_address`, activeKeys.splitAddress);

    showToast(`Switched active P2TR address to Address #${index + 1}`, 'success');
  };

  const fetchNodeInfo = async () => {
    try {
      const res = await axios.get(`${API_BASE}/node/info`);
      setNodeInfo({ mainHeight: res.data.mainHeight, bip110Height: res.data.bip110Height, errors: res.data.errors });
    } catch (err: any) {
      setNodeInfo({ mainHeight: 0, bip110Height: 0 });
      console.error(err);
    }
  };

  const fetchOffers = async () => {
    try {
      // 1. Fetch Marketplace Offers (others' offers)
      const excludeParam = publicKey ? `&excludePubKey=${publicKey}` : '';
      const marketplaceRes = await axios.get(
        `${API_BASE}/offers?networkMode=${networkMode}${excludeParam}&page=${offersPage}&limit=${offersLimit}&orderBy=${offersOrderBy}&orderDir=${offersOrderDir}`
      );
      setMarketplaceOffers(marketplaceRes.data.offers);
      setOffersTotal(marketplaceRes.data.total);
      setOffersTotalPages(marketplaceRes.data.totalPages);

      if (publicKey) {
        // 2. Fetch My Created Offers
        const createdRes = await axios.get(
          `${API_BASE}/offers?networkMode=${networkMode}&initiatorPubKey=${publicKey}&limit=100`
        );
        setMyCreatedOffers(createdRes.data.offers);

        // 3. Fetch My Accepted Offers
        const acceptedRes = await axios.get(
          `${API_BASE}/offers?networkMode=${networkMode}&acceptorPubKey=${publicKey}&limit=100`
        );
        setMyAcceptedOffers(acceptedRes.data.offers);
      } else {
        setMyCreatedOffers([]);
        setMyAcceptedOffers([]);
      }
    } catch (err: any) {
      console.error(err);
    }
  };

  const fetchBalances = async () => {
    if (!masterPrivateKey) return;
    if (balanceFetchInFlightRef.current) {
      balanceRefreshQueuedRef.current = true;
      return;
    }
    if (Date.now() < balanceRetryAfterRef.current) {
      setBalanceSyncStatus('rate-limited');
      return;
    }

    balanceFetchInFlightRef.current = true;
    setBalanceSyncStatus('loading');
    try {
      const net = getNetwork();
      let aggregatedMainUtxos: any[] = [];
      let aggregatedBip110Utxos: any[] = [];
      let aggregatedOwnMainUtxos: any[] = [];
      let aggregatedOwnBip110Utxos: any[] = [];

      // Async transaction handlers may call this function from a render that predates
      // a freshly derived change address. The persisted index is updated synchronously,
      // so use whichever scan boundary is newest.
      const keyPrefix = networkMode === 'mainnet' ? 'mainnet' : 'regtest';
      const persistedMaxIndex = Number(localStorage.getItem(`${keyPrefix}_max_index`) ?? maxIndex);
      const scanMaxIndex = Number.isSafeInteger(persistedMaxIndex) && persistedMaxIndex >= 0
        ? Math.max(maxIndex, persistedMaxIndex)
        : maxIndex;

      // Query unspents for ALL derived addresses from index 0 to maxIndex
      for (let i = 0; i <= scanMaxIndex; i++) {
        const childKeys = deriveKeysForIndex(masterPrivateKey, i, net);
        
        // 1. Fetch Contract UTXOs (Unsplit)
        const resMain = await axios.post(`${API_BASE}/wallet/utxos`, { address: childKeys.splitAddress, chain: 'main', networkMode });
        const mainWithIndex = resMain.data.utxos.map((u: any) => ({ ...u, index: i, address: childKeys.splitAddress }));
        aggregatedMainUtxos.push(...mainWithIndex);

        const resBip110 = await axios.post(`${API_BASE}/wallet/utxos`, { address: childKeys.splitAddress, chain: 'bip110', networkMode });
        const bip110WithIndex = resBip110.data.utxos.map((u: any) => ({ ...u, index: i, address: childKeys.splitAddress }));
        aggregatedBip110Utxos.push(...bip110WithIndex);

        // 2. Fetch derived keypath-address UTXOs; cross-chain presence determines classification.
        const resOwnMain = await axios.post(`${API_BASE}/wallet/utxos`, { address: childKeys.ownAddress, chain: 'main', networkMode });
        const ownMainWithIndex = resOwnMain.data.utxos.map((u: any) => ({ ...u, index: i, address: childKeys.ownAddress }));
        aggregatedOwnMainUtxos.push(...ownMainWithIndex);

        const resOwnBip110 = await axios.post(`${API_BASE}/wallet/utxos`, { address: childKeys.ownAddress, chain: 'bip110', networkMode });
        const ownBip110WithIndex = resOwnBip110.data.utxos.map((u: any) => ({ ...u, index: i, address: childKeys.ownAddress }));
        aggregatedOwnBip110Utxos.push(...ownBip110WithIndex);
      }

      setMainUtxos(aggregatedMainUtxos);
      setBip110Utxos(aggregatedBip110Utxos);
      setOwnMainUtxos(aggregatedOwnMainUtxos);
      setOwnBip110Utxos(aggregatedOwnBip110Utxos);
      const refreshedMainOutpoints = buildOutpointSet([...aggregatedMainUtxos, ...aggregatedOwnMainUtxos]);
      const refreshedBip110Outpoints = buildOutpointSet([...aggregatedBip110Utxos, ...aggregatedOwnBip110Utxos]);
      setSelectedUtxoToSplit(current => (
        current && classifyOutpoint(current, refreshedMainOutpoints, refreshedBip110Outpoints) === 'unsplit'
          ? current
          : null
      ));

      // Sum balances
      const totalMain = aggregatedMainUtxos.reduce((sum, u) => sum + u.amount, 0);
      setMainBalance(totalMain);

      const totalBip110 = aggregatedBip110Utxos.reduce((sum, u) => sum + u.amount, 0);
      setBip110Balance(totalBip110);

      const totalOwnMain = aggregatedOwnMainUtxos.reduce((sum, u) => sum + u.amount, 0);
      setOwnMainBalance(totalOwnMain);

      const totalOwnBip110 = aggregatedOwnBip110Utxos.reduce((sum, u) => sum + u.amount, 0);
      setOwnBip110Balance(totalOwnBip110);

      balanceRetryAfterRef.current = 0;
      setHasBalanceSnapshot(true);
      setBalanceSyncStatus('ready');

      fetchNodeInfo();
    } catch (err: any) {
      // Publish only complete cross-chain snapshots. A failed refresh must not turn
      // a known wallet into an alarming zero balance or empty UTXO set.
      if (err.response?.status === 429) {
        const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
        const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader
          : 10;
        balanceRetryAfterRef.current = Date.now() + retryAfterSeconds * 1000;
        setBalanceSyncStatus('rate-limited');
      } else {
        setBalanceSyncStatus('error');
      }
      console.error("Error fetching multi-address balances:", err);
    } finally {
      balanceFetchInFlightRef.current = false;
      if (balanceRefreshQueuedRef.current) {
        balanceRefreshQueuedRef.current = false;
        window.setTimeout(() => fetchBalances(), 0);
      }
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
      showToast(
        chain === 'main'
          ? `Mined ${blocks} block(s) on Bitcoin Core`
          : `Mined ${blocks} block(s) on Core first, then ${blocks} on BIP110-Chain`,
        'success'
      );
      await fetchBalances();
    } catch (err: any) {
      showToast(`Mining failed: ${err.message}`, 'error');
    }
  };

  const executeBilateralSplit = async () => {
    if (!recoveryDownloaded) {
      showToast('Safety lock: You must download your recovery backup file first!', 'error');
      return;
    }
    if (!selectedUtxoToSplit) {
      showToast('Please select an unsplit UTXO to split!', 'error');
      return;
    }
    if (!isUtxoUnsplit(selectedUtxoToSplit)) {
      setSelectedUtxoToSplit(null);
      showToast('This UTXO exists on only one chain and is already split.', 'error');
      return;
    }
    if (!ownAddress) {
      showToast('No split destination address computed.', 'error');
      return;
    }

    setSplittingBilateral(true);
    setBilateralSplitResult(null);

    const net = getNetwork();
    const utxoIndex = (selectedUtxoToSplit as any).index !== undefined ? (selectedUtxoToSplit as any).index : activeIndex;
    const utxoKeys = deriveKeysForIndex(masterPrivateKey, utxoIndex, net);
    const ownerKeyPair = deriveKeyPairForIndex(masterPrivateKey, utxoIndex, net);
    const pubKey = Buffer.from(ownerKeyPair.publicKey);
    const splitPayment = PureBitcoinSwap.createSplitPayment(pubKey, net);

    const feeSats = await calculateTxFee('split-script', false, 'main');
    const inputSats = BigInt(selectedUtxoToSplit.amount);
    const fee = BigInt(feeSats);
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
        utxoKeys.ownAddress, // Split goes to that child's own address!
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

  const executeWithdrawal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWithdrawUtxoKey) {
      showToast("Please select a UTXO to withdraw from.", "error");
      return;
    }
    if (!withdrawDestAddress) {
      showToast("Please enter a destination address.", "error");
      return;
    }

    setWithdrawing(true);
    try {
      const [selectedChain, txid, voutStr] = selectedWithdrawUtxoKey.split('|');
      const vout = Number(voutStr);
      const isMainChain = selectedChain === 'main';
      const chainUtxos = isMainChain ? allMainUtxos : allBip110Utxos;
      const contractUtxos = isMainChain ? mainUtxos : bip110Utxos;
      const utxo = chainUtxos.find(u => u.txid === txid && u.vout === vout);
      const isSplitAddress = contractUtxos.some(u => u.txid === txid && u.vout === vout);

      if (!utxo) {
        throw new Error("Could not find the selected UTXO.");
      }

      const inputSats = BigInt(utxo.amount);
      const net = getNetwork();
      const utxoIndex = (utxo as any).index !== undefined ? (utxo as any).index : activeIndex;
      const ownerKeyPair = deriveKeyPairForIndex(masterPrivateKey, utxoIndex, net);
      const childKeys = deriveKeysForIndex(masterPrivateKey, utxoIndex, net);

      let withdrawSats = Number(withdrawAmountSats);
      const initialEstimateHasChange = inputSats > BigInt(withdrawSats || 0) + 5000n;
      const targetChain = isMainChain ? 'main' : 'bip110';
      const initialFeeSats = await calculateTxFee('withdraw', initialEstimateHasChange, targetChain);

      if (!withdrawSats || withdrawSats <= 0) {
        // Default to withdraw max (minus calculated dynamic fee)
        withdrawSats = Number(inputSats) - initialFeeSats;
      }

      if (withdrawSats > Number(inputSats) - initialFeeSats) {
        throw new Error(`Withdraw amount cannot exceed ${((Number(inputSats) - initialFeeSats) / 100000000).toFixed(4)} (input size minus fee).`);
      }

      const finalHasChange = inputSats > BigInt(withdrawSats) + BigInt(initialFeeSats);
      const finalFeeSats = await calculateTxFee('withdraw', finalHasChange, targetChain);
      const changeAddress = finalHasChange ? getNewChangeAddress(net) : undefined;

      showToast(`Signing withdrawal from Address #${utxoIndex + 1}...`, "info");

      const tx = PureBitcoinSwap.buildWithdrawalTx(
        ownerKeyPair,
        utxo.txid,
        utxo.vout,
        inputSats,
        BigInt(withdrawSats),
        withdrawDestAddress,
        isSplitAddress,
        isMainChain,
        changeAddress,
        BigInt(finalFeeSats),
        net
      );

      const broadcastRes = await axios.post(`${API_BASE}/tx/broadcast`, {
        hex: tx.toHex(),
        chain: targetChain,
        networkMode
      });

      showToast(`Withdrawal successfully broadcasted on ${isMainChain ? 'Bitcoin Core' : 'BIP110-Chain'}! TxID: ${broadcastRes.data.txid}`, 'success');
      
      // Clear fields
      setWithdrawDestAddress('');
      setSelectedWithdrawUtxoKey('');
      setWithdrawAmountSats('');
      
      await fetchBalances();
    } catch (err: any) {
      showToast('Withdrawal failed: ' + err.message, 'error');
    } finally {
      setWithdrawing(false);
    }
  };

  const handleDeleteOffer = async (o: Offer) => {
    const confirmed = window.confirm(
      o.status === 'ACCEPTED'
        ? `Abort Swap #${o.id}? Neither participant has locked funds, so the swap will be permanently removed.`
        : `Are you sure you want to delete and remove your Swap Offer #${o.id}?`
    );
    if (!confirmed) return;

    try {
      const msg = `delete-offer:${o.id}`;
      const msgHash = bitcoin.crypto.sha256(Buffer.from(msg));
      
      const pair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'));
      const sig = pair.sign(msgHash);
      const signature = Buffer.from(sig).toString('hex');

      const res = await axios.post(`${API_BASE}/offers/${o.id}/delete`, { signature });
      showToast(res.data.message || 'Offer deleted successfully.', 'success');
      
      if (selectedOffer?.id === o.id) {
        setSelectedOffer(null);
      }
      
      await fetchOffers();
    } catch (err: any) {
      const errMsg = err.response?.data?.error || err.message;
      showToast(`Failed to delete offer: ${errMsg}`, 'error');
    }
  };

  const handleWalkbackAcceptance = async (o: Offer) => {
    const confirmed = window.confirm(`Abort Swap #${o.id}? Neither party has locked funds and the offer will reset to OPEN.`);
    if (!confirmed) return;

    try {
      const msg = `walkback-offer:${o.id}`;
      const msgHash = bitcoin.crypto.sha256(Buffer.from(msg));
      
      const pair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'));
      const sig = pair.sign(msgHash);
      const signature = Buffer.from(sig).toString('hex');

      const res = await axios.post(`${API_BASE}/offers/${o.id}/walkback`, { signature });
      showToast(res.data.message || 'Acceptance walked back successfully.', 'success');
      
      if (selectedOffer?.id === o.id) {
        setSelectedOffer({
          ...selectedOffer,
          status: res.data.status,
          acceptorPubKey: res.data.status === 'OPEN' ? undefined : selectedOffer.acceptorPubKey
        });
      }

      await fetchOffers();
    } catch (err: any) {
      const errMsg = err.response?.data?.error || err.message;
      showToast(`Failed to walk back acceptance: ${errMsg}`, 'error');
    }
  };

  const secureUpdateOffer = async (offerId: string, fields: Partial<Offer>, signerRole: 'initiator' | 'acceptor') => {
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

    const msg = `update-offer:${offerId}:${canonicalStringify(fields)}`;
    const msgHash = bitcoin.crypto.sha256(Buffer.from(msg));
    
    const pair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'));
    const sig = pair.sign(msgHash);
    const signature = Buffer.from(sig).toString('hex');

    const res = await axios.post(`${API_BASE}/offers/${offerId}/update`, {
      fields,
      signer: signerRole,
      signature
    });
    return res;
  };

  const handleCreateOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishing(true);
    try {
      const coordinatorFees = await getCoordinatorFees();
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
      if (!Number.isSafeInteger(sellAmount) || sellAmount <= 0) {
        throw new Error("Please enter a valid whole-number sell amount in sats.");
      }

      const fundingCandidates = getSplitUtxosForChain(backingChain!);
      const coordinatorFee = coordinatorFeeSats(sellAmount, coordinatorFees.makerFeePercent);
      const estimateFundingFee = await createFundingFeeEstimator(backingChain!, coordinatorFee > 0n);
      const fundingSelection = selectFundingUtxos(
        fundingCandidates,
        BigInt(sellAmount) + coordinatorFee,
        estimateFundingFee,
        utxo
      );
      if (!fundingSelection) {
        const totalAvailable = fundingCandidates.reduce((sum, candidate) => sum + candidate.amount, 0);
        const minimumFee = estimateFundingFee(Math.max(1, fundingCandidates.length), false);
        const maximumFundable = Math.max(0, totalAvailable - minimumFee - Number(coordinatorFee));
        throw new Error(
          `Insufficient ${backingChain === 'main' ? 'BTC' : 'B110'} split balance for this offer plus fees. ` +
          `Maximum fundable amount is approximately ${maximumFundable.toLocaleString()} sats.`
        );
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

      const baseHeight = backingChain === 'main' ? nodeInfo.mainHeight : nodeInfo.bip110Height;
      const secondBaseHeight = backingChain === 'main' ? nodeInfo.bip110Height : nodeInfo.mainHeight;
      if (!baseHeight || baseHeight <= 0) {
        throw new Error(`Cannot determine current block height for ${backingChain === 'main' ? 'Bitcoin' : 'BIP110'} chain. Please wait for node info to sync.`);
      }
      if (!secondBaseHeight || secondBaseHeight <= 0) throw new Error('Cannot determine the counter-chain height.');
      const duration = Number(newOfferLocktime);
      if (!Number.isSafeInteger(duration) || duration < 2) throw new Error('Lock duration must be at least two blocks.');
      const absoluteLockTime = baseHeight + duration;
      const secondLockTime = secondBaseHeight + Math.floor(duration / 2);

      const res = await axios.post(`${API_BASE}/offers`, {
        initiatorPubKey: publicKey,
        initiatorB110Amount: Number(newOfferB110),
        acceptorBtcAmount: Number(newOfferBtc),
        hashLock: hashLockHex,
        lockTime: absoluteLockTime,
        secondLockTime,
        networkMode,
        backingTxid,
        backingVout,
        backingChain
      });

      // Save preimage locally associated with Offer ID so we can claim later
      sessionStorage.setItem(`preimage_${res.data.id}`, preimageHex);

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
    try {
      const coordinatorFees = await getCoordinatorFees();
      const targetChain: 'main' | 'bip110' = offer.backingChain === 'main' ? 'bip110' : 'main';
      const targetAmount = targetChain === 'main' ? offer.acceptorBtcAmount : offer.initiatorB110Amount;
      const coordinatorFee = coordinatorFeeSats(targetAmount, coordinatorFees.takerFeePercent);
      const estimateFundingFee = await createFundingFeeEstimator(targetChain, coordinatorFee > 0n);
      const fundingSelection = selectFundingUtxos(
        getSplitUtxosForChain(targetChain),
        BigInt(targetAmount) + coordinatorFee,
        estimateFundingFee
      );
      if (!fundingSelection) {
        throw new Error(`insufficient split ${targetChain === 'main' ? 'BTC' : 'BIP110'} balance for the contract, coordinator fee, and network fee`);
      }
      const acceptMessage = `accept-offer:${offer.id}:${publicKey}`;
      const acceptPair = ECPair.fromPrivateKey(Buffer.from(privateKey, 'hex'));
      const signature = Buffer.from(acceptPair.sign(bitcoin.crypto.sha256(Buffer.from(acceptMessage)))).toString('hex');
      const res = await axios.post(`${API_BASE}/offers/${offer.id}/accept`, {
        acceptorPubKey: publicKey,
        signature
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
        const coordinatorFees = await getCoordinatorFees();
        const coordinatorFee = coordinatorFeeSats(targetAmount, coordinatorFees.makerFeePercent);

        showToast(`Building ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC contract locally...`, 'info');
        
        // 1. Generate HTLC outputs locally
        const recipientPubKey = Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const refundPubKey = Buffer.from(selectedOffer.initiatorPubKey, 'hex');

        const htlc = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          recipientPubKey,
          refundPubKey,
          selectedOffer.lockTime,
          net
        );

        // 2. Select enough of the initiator's split UTXOs to cover the contract and fee.
        // The outpoint chosen when publishing remains the preferred/identifying input,
        // but it is not required to fund the whole contract by itself.
        const fundingCandidates = getSplitUtxosForChain(targetChain);
        const preferredUtxo = fundingCandidates.find(
          u => u.txid === selectedOffer.backingTxid && u.vout === selectedOffer.backingVout
        );

        if (!preferredUtxo) {
          throw new Error(`The split UTXO backing this offer is no longer available on ${targetChain === 'main' ? 'Bitcoin' : 'BIP110-Chain'}.`);
        }

        const targetSats = BigInt(targetAmount);
        const estimateFundingFee = await createFundingFeeEstimator(targetChain, coordinatorFee > 0n);
        const fundingSelection = selectFundingUtxos(
          fundingCandidates,
          targetSats + coordinatorFee,
          estimateFundingFee,
          preferredUtxo
        );

        if (!fundingSelection) {
          const totalAvailable = fundingCandidates.reduce((sum, candidate) => sum + candidate.amount, 0);
          throw new Error(
            `Insufficient split balance on ${targetChain === 'main' ? 'Bitcoin' : 'BIP110-Chain'} to cover the ` +
            `${(Number(targetSats) / 100000000).toFixed(8)} contract plus fees. ` +
            `Available across ${fundingCandidates.length} UTXO${fundingCandidates.length === 1 ? '' : 's'}: ${(totalAvailable / 100000000).toFixed(8)}.`
          );
        }

        const changeAddress = fundingSelection.hasChange ? getNewChangeAddress(net) : undefined;
        const inputsData = buildFundingInputs(fundingSelection.utxos, targetChain, net);

        // 3. Build & sign the multi-input funding transaction locally.
        const tx = PureBitcoinSwap.buildMultiInputHtlcFundingTx(
          inputsData,
          targetSats,
          htlc.address!,
          changeAddress,
          fundingSelection.feeSats,
          net,
          coordinatorFees.receiveAddress,
          coordinatorFee
        );
        const htlcVout = assertConstructedFundingOutput(tx, htlc.address!, targetSats);

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
          updateParams.btcHtlcVout = htlcVout;
        } else {
          updateParams.b110HtlcAddress = htlc.address!;
          updateParams.b110HtlcTxid = broadcastRes.data.txid;
          updateParams.b110HtlcVout = htlcVout;
        }

        const updateRes = await secureUpdateOffer(selectedOffer.id, updateParams, 'initiator');

        setSelectedOffer(updateRes.data);
        showToast(`${targetChain === 'main' ? 'Bitcoin' : 'BIP110'} HTLC successfully funded!`, 'success');
      } 
      
      else if (step === 3) {
        // Step 3: Fund second HTLC (Performed locally by Acceptor)
        const isBtcBacking = selectedOffer.backingChain === 'main';
        const targetChain: 'main' | 'bip110' = isBtcBacking ? 'bip110' : 'main';
        const targetAmount = isBtcBacking ? selectedOffer.initiatorB110Amount : selectedOffer.acceptorBtcAmount;
        const coordinatorFees = await getCoordinatorFees();
        const coordinatorFee = coordinatorFeeSats(targetAmount, coordinatorFees.takerFeePercent);

        // Security check first: Verify the initiator's first HTLC address matches the expected script
        const firstHtlcAddress = isBtcBacking ? selectedOffer.btcHtlcAddress! : selectedOffer.b110HtlcAddress!;
        const firstHtlcRecipient = Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const firstHtlcRefund = Buffer.from(selectedOffer.initiatorPubKey, 'hex');

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

        const firstChain: 'main' | 'bip110' = isBtcBacking ? 'main' : 'bip110';
        await verifyFundingOnClient(selectedOffer, firstChain);

        showToast(`Building ${targetChain === 'main' ? 'BTC' : 'B110'} HTLC contract locally...`, 'info');

        // 1. Generate second HTLC outputs locally
        const secondHtlcRecipient = Buffer.from(selectedOffer.initiatorPubKey, 'hex');
        const secondHtlcRefund = Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const secondHtlcLockTime = selectedOffer.secondLockTime;

        const htlc = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          secondHtlcRefund,
          secondHtlcLockTime,
          net
        );

        // 2. Select enough split outputs of the acceptor to fund the contract and fee.
        const candidates = getSplitUtxosForChain(targetChain);
        const targetSats = BigInt(targetAmount);
        const estimateFundingFee = await createFundingFeeEstimator(targetChain, coordinatorFee > 0n);
        const fundingSelection = selectFundingUtxos(candidates, targetSats + coordinatorFee, estimateFundingFee);

        if (!fundingSelection) {
          const totalAvailable = candidates.reduce((sum, candidate) => sum + candidate.amount, 0);
          throw new Error(
            `Insufficient split balance on ${targetChain === 'main' ? 'Bitcoin' : 'BIP110-Chain'} to cover the ` +
            `${(Number(targetSats) / 100000000).toFixed(8)} contract plus fees. ` +
            `Available across ${candidates.length} UTXO${candidates.length === 1 ? '' : 's'}: ${(totalAvailable / 100000000).toFixed(8)}.`
          );
        }

        const changeAddress = fundingSelection.hasChange ? getNewChangeAddress(net) : undefined;

        // 3. Build & sign funding transaction locally with multiple inputs!
        const inputsData = buildFundingInputs(fundingSelection.utxos, targetChain, net);

        const tx = PureBitcoinSwap.buildMultiInputHtlcFundingTx(
          inputsData,
          targetSats,
          htlc.address!,
          changeAddress,
          fundingSelection.feeSats,
          net,
          coordinatorFees.receiveAddress,
          coordinatorFee
        );
        const htlcVout = assertConstructedFundingOutput(tx, htlc.address!, targetSats);

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
          updateParams.btcHtlcVout = htlcVout;
        } else {
          updateParams.b110HtlcAddress = htlc.address!;
          updateParams.b110HtlcTxid = broadcastRes.data.txid;
          updateParams.b110HtlcVout = htlcVout;
        }

        const updateRes = await secureUpdateOffer(selectedOffer.id, updateParams, 'acceptor');

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
        const secondHtlcRecipient = Buffer.from(selectedOffer.initiatorPubKey, 'hex');
        const secondHtlcRefund = Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const secondHtlcLockTime = getSecondHtlcLockTime(selectedOffer, net);

        const isSecondHtlcValid = PureBitcoinSwap.verifyTaprootHtlcAddress(
          targetAddress,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          secondHtlcRefund,
          secondHtlcLockTime,
          net
        );

        if (!isSecondHtlcValid) {
          throw new Error(`CRITICAL SECURITY WARNING: The acceptor's ${targetChain === 'main' ? 'BTC' : 'BIP110'} HTLC address is INVALID or has been tampered with!`);
        }

        showToast(`Signing ${targetChain === 'main' ? 'BTC' : 'B110'} Claim transaction with local preimage...`, 'info');

        const utxo = await verifyFundingOnClient(selectedOffer, targetChain);

        // Verification of the amount funded inside the HTLC
        const requiredAmount = isBtcBacking ? selectedOffer.initiatorB110Amount : selectedOffer.acceptorBtcAmount;
        if (BigInt(utxo.amount) < BigInt(requiredAmount - 5000)) {
          throw new Error(`CRITICAL SECURITY WARNING: The acceptor funded the HTLC with only ${(utxo.amount / 100000000).toFixed(4)} ${targetChain === 'main' ? 'BTC' : 'B110'}, but the agreed amount was ${(requiredAmount / 100000000).toFixed(4)}! Do NOT release the preimage!`);
        }

        // Retrieve local preimage securely stored
        const savedPreimage = sessionStorage.getItem(`preimage_${selectedOffer.id}`);
        if (!savedPreimage) throw new Error("Cryptographic preimage not found in secure local storage.");

        // Build and sign claim transaction locally!
        const keyPair = getKeyPairForPubKey(selectedOffer.initiatorPubKey, net);
        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          secondHtlcRecipient,
          secondHtlcRefund,
          secondHtlcLockTime,
          net
        );

        const feeSats = await calculateTxFee('claim', false, targetChain);
        const tx = PureBitcoinSwap.buildHtlcClaimTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - feeSats), 
          ownAddress, // Claim destination is user's own address!
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(savedPreimage, 'hex'), 
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          secondHtlcRefund,
          secondHtlcLockTime,
          net
        );

        // Broadcast raw tx
        const settlementRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        // Update Offer State on server
        const updateRes = await secureUpdateOffer(selectedOffer.id, {
          preimage: savedPreimage,
          status: 'CLAIMED',
          initiatorSettlementTxid: settlementRes.data.txid
        }, 'initiator');

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
        const firstHtlcRecipient = Buffer.from(selectedOffer.acceptorPubKey!, 'hex');
        const firstHtlcRefund = Buffer.from(selectedOffer.initiatorPubKey, 'hex');

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

        const utxo = await verifyFundingOnClient(selectedOffer, targetChain);

        // Build and sign claim transaction locally!
        const keyPair = getKeyPairForPubKey(Buffer.from(firstHtlcRecipient).toString('hex'), net);
        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          Buffer.from(selectedOffer.hashLock, 'hex'),
          firstHtlcRecipient,
          firstHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        const claimFeeSats = await calculateTxFee('claim', false, targetChain);
        const tx = PureBitcoinSwap.buildHtlcClaimTx(
          keyPair,
          utxo.txid,
          utxo.vout,
          BigInt(utxo.amount),
          BigInt(utxo.amount - claimFeeSats), 
          ownAddress, // Claim destination is user's own address!
          Buffer.from(selectedOffer.hashLock, 'hex'),
          Buffer.from(selectedOffer.preimage!, 'hex'), // preimage hex
          htlcPayment,
          Buffer.from(selectedOffer.initiatorPubKey, 'hex'),
          firstHtlcRefund,
          selectedOffer.lockTime,
          net
        );

        const settlementRes = await axios.post(`${API_BASE}/tx/broadcast`, {
          hex: tx.toHex(),
          chain: targetChain,
          networkMode
        });

        const updateRes = await secureUpdateOffer(selectedOffer.id, {
          status: 'CLAIMED',
          acceptorClaimed: true,
          acceptorSettlementTxid: settlementRes.data.txid
        }, 'acceptor');

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

  const blockLead = nodeInfo.mainHeight - nodeInfo.bip110Height;
  const isLockoutActive = nodeInfo.mainHeight > 0 && nodeInfo.bip110Height > 0 && blockLead > 0 && blockLead < 10;

  return (
    <div className="app-shell min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
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

      {/* Sticky Top Navigation Bar */}
      <div className="command-deck sticky top-0 z-40 w-full bg-slate-950/80 backdrop-blur-md border-b border-slate-900">
        {/* Header */}
        <header className="command-header border-b border-slate-800/85 bg-slate-900/40 py-3 md:py-0 md:h-16 flex items-center">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 w-full flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-6">
          <div className="brand-lockup flex items-center gap-3">
            <div className="brand-mark bg-gradient-to-tr from-sky-500 to-indigo-500 p-2 rounded-xl shadow-lg shadow-sky-500/10">
              <Layers className="w-6 h-6 text-white" strokeWidth={1.6} />
            </div>
            <div>
              <div className="brand-kicker">REPLAY-PROTECTED DESK</div>
              <h1 className="brand-title font-bold text-base sm:text-lg leading-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                Splittoooor
              </h1>
              <p className="brand-subtitle text-[10px] sm:text-xs text-slate-400">Atomic settlement across a consensus fork</p>
            </div>
          </div>

          {/* Network Toggle Button and Stats */}
          <div className="flex flex-wrap items-center justify-start md:justify-end gap-3 sm:gap-6">
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
                  <span className="hidden xs:inline">Simulation (Regtest)</span>
                  <span className="xs:hidden">Regtest</span>
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
                  <span className="hidden xs:inline">Production (Mainnet)</span>
                  <span className="xs:hidden">Mainnet</span>
                </button>
              </div>
            ) : (
              <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-850">
                {networkMode === 'regtest' ? (
                  <div className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 text-indigo-400 bg-slate-900/40 border border-slate-800">
                    <Flame className="w-3.5 h-3.5 animate-pulse" />
                    <span className="hidden xs:inline">SIMULATION (REGTEST MODE)</span>
                    <span className="xs:hidden">REGTEST</span>
                  </div>
                ) : (
                  <div className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 text-amber-400 bg-amber-500/10 border border-amber-500/20">
                    <Lock className="w-3.5 h-3.5" />
                    <span className="hidden xs:inline">PRODUCTION (MAINNET MODE)</span>
                    <span className="xs:hidden">MAINNET</span>
                  </div>
                )}
              </div>
            )}

            {networkMode === 'regtest' ? (
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex flex-col items-end leading-none">
                    <span className="text-[10px] sm:text-xs text-slate-400 font-medium">Core Regtest</span>
                    <span className="text-[10px] sm:text-xs font-semibold text-emerald-400 bg-emerald-950/40 border border-emerald-900/60 px-2 py-0.5 rounded-md mt-1">
                      Block #{nodeInfo.mainHeight}
                    </span>
                  </div>
                  <button
                    onClick={() => mineBlocks('main', 1)}
                    className="px-2 py-1 text-[10px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-950/30 hover:bg-emerald-900/40 border border-emerald-900/40 hover:border-emerald-500 rounded-md transition-all self-end"
                    title="Mine 1 Block on Bitcoin Core Regtest"
                  >
                    +1 Block
                  </button>
                </div>
                <div className="flex items-center gap-2.5 border-l border-slate-800 pl-3 sm:pl-4">
                  <div className="flex flex-col items-end leading-none">
                    <span className="text-[10px] sm:text-xs text-slate-400 font-medium">Knots Regtest</span>
                    <span className="text-[10px] sm:text-xs font-semibold text-sky-400 bg-sky-950/40 border border-sky-900/60 px-2 py-0.5 rounded-md mt-1">
                      Block #{nodeInfo.bip110Height}
                    </span>
                  </div>
                  <button
                    onClick={() => mineBlocks('bip110', 1)}
                    className="px-2 py-1 text-[10px] font-bold text-sky-400 hover:text-sky-300 bg-sky-950/30 hover:bg-sky-900/40 border border-sky-900/40 hover:border-sky-500 rounded-md transition-all self-end"
                    title="Mine 1 Block on BIP110 Knots Regtest"
                  >
                    +1 Block
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="flex flex-col items-end leading-none">
                  <span className="text-[10px] sm:text-xs text-slate-400 font-medium">Bitcoin</span>
                  <span
                    className={`text-[10px] sm:text-xs font-semibold px-2 py-0.5 rounded-md mt-1 border ${nodeInfo.errors?.main ? 'text-rose-400 bg-rose-950/40 border-rose-900/60' : 'text-emerald-400 bg-emerald-950/40 border-emerald-900/60'}`}
                    title={nodeInfo.errors?.main}
                  >
                    {nodeInfo.errors?.main ? 'Unavailable' : `Block #${nodeInfo.mainHeight}`}
                  </span>
                </div>
                <div className="flex flex-col items-end leading-none border-l border-slate-800 pl-3 sm:pl-4">
                  <span className="text-[10px] sm:text-xs text-slate-400 font-medium">BIP110</span>
                  <span
                    className={`text-[10px] sm:text-xs font-semibold px-2 py-0.5 rounded-md mt-1 border ${nodeInfo.errors?.bip110 ? 'text-rose-400 bg-rose-950/40 border-rose-900/60' : 'text-sky-400 bg-sky-950/40 border-sky-900/60'}`}
                    title={nodeInfo.errors?.bip110}
                  >
                    {nodeInfo.errors?.bip110 ? 'Unavailable' : `Block #${nodeInfo.bip110Height}`}
                  </span>
                </div>
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
      <nav className="workflow-nav bg-slate-950/60 overflow-x-auto scrollbar-none whitespace-nowrap" aria-label="Swap workflow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1 min-w-max sm:min-w-0">
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
                className={`workflow-tab py-4 px-6 font-medium text-sm flex items-center gap-2 border-b-2 transition-all shrink-0 ${
                  activeTab === tab.id 
                    ? 'workflow-tab--active border-indigo-500 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </nav>
    </div>

      {/* Main Content Area */}
      <main className="workspace flex-1 max-w-7xl mx-auto px-4 sm:px-6 py-8 w-full">
        {isLockoutActive ? (
          <div className="bg-slate-900/50 border border-amber-900/40 rounded-3xl p-8 md:p-12 shadow-2xl flex flex-col items-center text-center space-y-6 max-w-3xl mx-auto backdrop-blur-sm mt-8 animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-amber-950/40 border border-amber-500/50 flex items-center justify-center shadow-lg shadow-amber-500/10">
              <AlertTriangle className="w-8 h-8 text-amber-500 animate-bounce" />
            </div>
            
            <div className="space-y-2">
              <h2 className="text-xl md:text-2xl font-bold tracking-tight text-amber-300">
                Consensus Safety Lockout: Insufficient Main-Chain Work Advantage
              </h2>
              <p className="text-sm text-slate-400 max-w-xl mx-auto leading-relaxed">
                BIP110 Knots enforces a strict subset of Bitcoin Core consensus rules. Since any block produced by a BIP110 node is automatically valid on the Main-Chain, the Core chain must maintain at least a <strong className="text-amber-400">10-block lead</strong> to prevent reorg, block replay, or chain separation vulnerabilities.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 w-full max-w-md pt-4">
              <div className="bg-slate-950/80 border border-slate-900 px-4 py-3 rounded-xl">
                <span className="text-[10px] text-slate-500 uppercase block font-semibold mb-0.5">Bitcoin Core Height</span>
                <span className="text-md font-extrabold text-emerald-400 font-mono">{nodeInfo.mainHeight} blocks</span>
              </div>
              <div className="bg-slate-950/80 border border-slate-900 px-4 py-3 rounded-xl">
                <span className="text-[10px] text-slate-500 uppercase block font-semibold mb-0.5">BIP110 Knots Height</span>
                <span className="text-md font-extrabold text-sky-400 font-mono">{nodeInfo.bip110Height} blocks</span>
              </div>
              <div className="col-span-2 sm:col-span-1 bg-slate-950/80 border border-amber-950/40 px-4 py-3 rounded-xl flex flex-col justify-center">
                <span className="text-[10px] text-amber-500/80 uppercase block font-bold mb-0.5">Current Lead</span>
                <span className={`text-md font-extrabold font-mono ${nodeInfo.mainHeight - nodeInfo.bip110Height >= 10 ? 'text-emerald-400' : 'text-rose-400 animate-pulse'}`}>
                  {nodeInfo.mainHeight - nodeInfo.bip110Height} / 10
                </span>
              </div>
            </div>

            {networkMode === 'regtest' ? (
              <div className="pt-6 w-full max-w-xs">
                <button
                  onClick={() => mineBlocks('main', 10)}
                  className="w-full py-3 bg-gradient-to-r from-amber-600 to-indigo-600 hover:from-amber-500 hover:to-indigo-500 text-white font-semibold text-sm rounded-xl shadow-xl shadow-indigo-600/10 transition-all flex items-center justify-center gap-2 group"
                >
                  <Sparkles className="w-4 h-4 text-amber-300 group-hover:scale-110 transition-transform animate-pulse" />
                  Mine +10 Blocks on Bitcoin Core
                </button>
                <span className="text-[10px] text-slate-500 block mt-2.5 leading-normal">
                  Click to instantly mine 10 blocks on Core via local RPC, establishing the required work advantage and unlocking the portal.
                </span>
              </div>
            ) : (
              <div className="pt-6 bg-slate-950/40 border border-slate-800 p-4 rounded-2xl max-w-md text-xs text-slate-400 leading-relaxed">
                🛡️ <strong>Production Safety Hold:</strong> The system is waiting for the Main-Chain (Bitcoin Core) to extend its cumulative proof-of-work lead. The interface will automatically restore functionality as soon as the Main-Chain establishes a strict 10-block lead.
              </div>
            )}
          </div>
        ) : (
          <>
        
        {/* TAB 1: WALLET / DEPOSIT */}
        {activeTab === 'wallet' && (
          <div className="space-y-8">
            {/* Primary funding destination: deliberately first and visually dominant. */}
            <section className="relative overflow-hidden rounded-2xl border border-emerald-500/35 bg-slate-950 shadow-2xl shadow-emerald-950/20">
              <div className="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-emerald-300 via-sky-400 to-indigo-500" />
              <div className="p-5 sm:p-7 pl-7 sm:pl-9">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="max-w-2xl">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-300">
                        Deposit destination
                      </span>
                      <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        {networkMode === 'mainnet' ? 'Bitcoin Mainnet' : 'Regtest'} · P2TR
                      </span>
                    </div>
                    <h2 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
                      Send funds to this address
                    </h2>
                    <p className="mt-2 text-xs leading-relaxed text-slate-400 sm:text-sm">
                      This is your unified deposit address. Initial unsplit coins must arrive here before they can be separated into Bitcoin and BIP110 balances.
                    </p>
                  </div>

                  <div className="shrink-0 rounded-xl border border-sky-500/20 bg-sky-950/20 px-4 py-3 text-xs text-sky-200 lg:max-w-xs">
                    <span className="block font-bold">Same address on both fork chains</span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">Do not use the later “split destination” as your initial deposit address.</span>
                  </div>
                </div>

                <div className="mt-6 rounded-xl border border-emerald-500/25 bg-black/35 p-3 sm:flex sm:items-center sm:gap-3 sm:p-4">
                  <code className="block min-w-0 flex-1 break-all font-mono text-sm font-semibold leading-relaxed text-emerald-200 sm:text-base">
                    {splitAddress || 'Computing your deposit address…'}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(splitAddress)}
                    disabled={!splitAddress}
                    className="mt-3 inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40 sm:mt-0 sm:w-auto"
                  >
                    <Copy className="h-4 w-4" />
                    Copy deposit address
                  </button>
                </div>
              </div>
            </section>

            {/* Keypair Card */}
            <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <h3 className="text-md font-semibold text-slate-200 mb-2 flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-indigo-400" />
                  Your Cryptographic Keypair
                </h3>
                <p className="text-xs text-slate-400 mb-6">
                  {networkMode === 'mainnet' 
                    ? '🔒 Kept securely inside your browser sandbox.' 
                    : 'Regtest-ready keys generated entirely offline.'}
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

                <div className="mt-6 flex flex-col gap-4">
                  <button
                    onClick={generateNewWallet}
                    disabled={loadingKeys}
                    className="w-full sm:w-auto px-4 py-2 text-xs font-semibold rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white transition-all self-start"
                  >
                    Generate New Deposit Address
                  </button>

                  {maxIndex > 0 && (
                    <div className="mt-2 pt-4 border-t border-slate-800/80">
                      <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">Switch Deposit Address</label>
                      <select
                        value={activeIndex}
                        onChange={(e) => loadWalletFromHistory(Number(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 font-mono"
                      >
                        {Array.from({ length: maxIndex + 1 }).map((_, index) => {
                          const net = getNetwork();
                          const childKeys = deriveKeysForIndex(masterPrivateKey, index, net);
                          return (
                            <option key={index} value={index}>
                              Address #{index + 1} ({childKeys.splitAddress.substring(0, 10)}...{childKeys.splitAddress.substring(childKeys.splitAddress.length - 8)})
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}
                </div>
              </div>

              {/* Split Address Details */}
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-slate-200 mb-1 flex items-center gap-2">
                    <Unlock className="w-4 h-4 text-sky-400" />
                    Deposit Contract Details
                  </h4>
                  <p className="text-xs text-slate-400 mb-4">
                    Technical details for the deposit address highlighted above. Scriptpath on Bitcoin, keypath on BIP110.
                  </p>

                  <div className="bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-xl flex items-center justify-between font-mono text-xs text-sky-300 mb-4">
                    <span className="truncate mr-4 font-semibold">{splitAddress || 'Computing address...'}</span>
                    <button onClick={() => copyToClipboard(splitAddress)} className="text-slate-500 hover:text-slate-300">
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="space-y-2.5 text-xs text-slate-400">
                    <div className="flex flex-col gap-1 xs:flex-row xs:justify-between border-b border-slate-900 pb-2">
                      <span className="shrink-0 font-medium">Internal Pubkey (X-Only):</span>
                      <span className="font-mono text-slate-200 truncate max-w-full sm:max-w-[200px]" title={publicKey ? publicKey.substring(2) : 'N/A'}>
                        {publicKey ? publicKey.substring(2) : 'N/A'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium">Address Prefix:</span>
                      <span className="font-semibold text-amber-500">{networkMode === 'mainnet' ? 'bc1p (Bitcoin Mainnet)' : 'bcrt1p (Regtest)'}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-800 flex flex-col sm:flex-row gap-4">
                  <div className="flex-1">
                    <span className="text-xs text-slate-400 block mb-1">Main-Chain Balance</span>
                    <span className="text-lg sm:text-xl font-bold text-emerald-400">
                      {hasBalanceSnapshot
                        ? `${((mainBalance + ownMainBalance) / 100000000).toFixed(4)} ${networkMode === 'mainnet' ? 'BTC' : 'rBTC'}`
                        : 'Loading…'}
                    </span>
                    {hasBalanceSnapshot && (
                      <span className="text-[10px] text-slate-500 block mt-0.5 font-medium leading-none">
                        {(getMainUnsplitBalance() / 100000000).toFixed(4)} Unsplit + {(getMainSplitBalance() / 100000000).toFixed(4)} Split
                      </span>
                    )}
                  </div>
                  <div className="flex-1 border-t sm:border-t-0 sm:border-l border-slate-800 pt-4 sm:pt-0 sm:pl-4">
                    <span className="text-xs text-slate-400 block mb-1">BIP110 Balance</span>
                    <span className="text-lg sm:text-xl font-bold text-sky-400">
                      {hasBalanceSnapshot
                        ? `${((bip110Balance + ownBip110Balance) / 100000000).toFixed(4)} B110`
                        : 'Loading…'}
                    </span>
                    {hasBalanceSnapshot && (
                      <span className="text-[10px] text-slate-500 block mt-0.5 font-medium leading-none">
                        {(getBip110UnsplitBalance() / 100000000).toFixed(4)} Unsplit + {(getBip110SplitBalance() / 100000000).toFixed(4)} Split
                      </span>
                    )}
                  </div>
                </div>
                {balanceSyncStatus !== 'ready' && (
                  <div className={`mt-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-semibold ${
                    balanceSyncStatus === 'error'
                      ? 'border-rose-900/50 bg-rose-950/20 text-rose-300'
                      : 'border-amber-900/50 bg-amber-950/20 text-amber-300'
                  }`} role="status" aria-live="polite">
                    <RefreshCw className={`h-3.5 w-3.5 ${balanceSyncStatus !== 'error' ? 'animate-spin' : ''}`} />
                    {balanceSyncStatus === 'rate-limited'
                      ? 'Wallet service is busy. Keeping the last confirmed balances and retrying shortly…'
                      : balanceSyncStatus === 'error'
                        ? 'Balance refresh failed. Keeping the last confirmed wallet snapshot.'
                        : 'Loading wallet balances and UTXOs…'}
                  </div>
                )}
              </div>
            </div>

            {/* HD Wallet Security, Backup & Recovery Card */}
            <CollapsibleCard 
              title="HD Wallet Backup & Restore" 
              icon={ShieldCheck} 
              defaultOpen={false}
            >
              <p className="text-xs text-slate-400 mb-4">
                Derived from a single Master Private Key. Keep it safe and backed up!
              </p>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Download Backup Section */}
                <div className="bg-slate-950/60 border border-slate-850 p-5 rounded-xl flex flex-col justify-between space-y-4">
                  <div>
                    <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Download className="w-4 h-4 text-emerald-400" />
                      1. Backup Master Seed
                    </h4>
                    <p className="text-[11px] text-slate-500 mb-4">
                      Download a secure JSON backup of your Master Seed to unlock coin-splitting and safe-refunds.
                    </p>

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block uppercase tracking-wider mb-1">Master Private Key (Seed)</label>
                      <div className="bg-slate-950 border border-slate-900 px-3 py-2 rounded-lg flex items-center justify-between font-mono text-xs text-slate-400">
                        <span className="truncate mr-4">
                          {masterPrivateKey 
                            ? (revealMasterPrivKey ? masterPrivateKey : '••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••') 
                            : 'No master key loaded'}
                        </span>
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => setRevealMasterPrivKey(!revealMasterPrivKey)} className="text-slate-600 hover:text-slate-400">
                            {revealMasterPrivKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => copyToClipboard(masterPrivateKey)} className="text-slate-600 hover:text-slate-400">
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleDownloadRecoveryFile}
                    className="w-full sm:w-auto px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs rounded-xl flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-600/10"
                  >
                    <Download className="w-4 h-4" />
                    Download Recovery Backup File
                  </button>
                </div>

                {/* Upload Restore Section */}
                <div className="bg-slate-950/60 border border-slate-850 p-5 rounded-xl flex flex-col justify-between space-y-4">
                  <div>
                    <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Upload className="w-4 h-4 text-sky-400" />
                      2. Restore Wallet
                    </h4>
                    <p className="text-[11px] text-slate-500 mb-4">
                      Upload your recovery JSON backup file to restore your Master Key and history.
                    </p>

                    {/* Hidden input element */}
                    <input
                      type="file"
                      id="recovery-upload-input"
                      accept=".json"
                      onChange={handleUploadRecoveryFile}
                      className="hidden"
                    />

                    <label
                      htmlFor="recovery-upload-input"
                      className="border border-dashed border-slate-800 bg-slate-950 hover:bg-slate-900/30 rounded-xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all text-center group"
                    >
                      <Upload className="w-6 h-6 text-slate-500 group-hover:text-sky-400 transition-colors" />
                      <span className="text-xs font-semibold text-slate-300">Choose Recovery JSON File</span>
                      <span className="text-[10px] text-slate-500">Supports .json files generated by splittoooor</span>
                    </label>
                  </div>
                </div>
              </div>
            </CollapsibleCard>

            {/* Regtest-only faucet controls. Mainnet deposits use the primary address panel above. */}
            {networkMode === 'regtest' && (
            <CollapsibleCard
              title="Regtest Faucet & Node Funder"
              icon={Coins}
              defaultOpen={true}
            >
                <>
                  <p className="text-xs text-slate-400 mb-6">
                    Fund your local regtest environment and send simulated coins to the deposit address shown at the top of this page.
                  </p>

                  <div className="space-y-6">
                    {/* Step 1: Fund Nodes */}
                    <div className="bg-slate-950 p-4 rounded-xl border border-slate-850 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="max-w-md">
                        <h4 className="text-xs font-bold text-slate-200 mb-1">Step 1: Bootstrap BIP110 Consensus & Miner Wallets</h4>
                        <p className="text-[10px] text-slate-400">Mine 450 blocks of shared history to activate BIP110 consensus on Knots and mature Coinbase miner rewards.</p>
                      </div>
                      <button
                        onClick={() => mineBlocks('main', 450)}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl shadow-md transition-all self-start sm:self-center"
                      >
                        Mine 450 blocks
                      </button>
                    </div>

                    {/* Step 2: Fund deposit address */}
                    <div className="bg-slate-950 p-4 rounded-xl border border-slate-850">
                      <h4 className="text-xs font-bold text-slate-200 mb-1">Step 2: Fund Your Deposit Address</h4>
                      <p className="text-[10px] text-slate-400 mb-4">Send simulated coins from the miner wallet to your deposit address. The faucet mines one block to confirm the deposit.</p>
                      
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
                    <span>Simulate blocks:</span>
                    <div className="flex gap-2">
                      <button onClick={() => mineBlocks('main', 1)} className="hover:text-white border border-slate-800 px-3 py-1.5 rounded-lg bg-slate-950">
                        Mine 1 block (Core)
                      </button>
                      <button onClick={() => mineBlocks('bip110', 1)} className="hover:text-white border border-slate-800 px-3 py-1.5 rounded-lg bg-slate-950">
                        Mine 1 block (Knots)
                      </button>
                    </div>
                  </div>
                </>
            </CollapsibleCard>
            )}

            {/* UTXOs Monitor */}
            <CollapsibleCard
              title="Confirmed UTXO Ledger"
              defaultOpen={true}
            >
              {balanceSyncStatus !== 'ready' && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-900/40 bg-amber-950/15 px-3 py-2.5 text-xs text-amber-300" role="status">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  {balanceSyncStatus === 'rate-limited'
                    ? 'Rate limited — retaining the last complete UTXO snapshot while we wait to retry.'
                    : hasBalanceSnapshot
                      ? 'Refreshing UTXOs; the entries below are the last complete snapshot.'
                      : 'Loading the complete cross-chain UTXO set…'}
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">Bitcoin UTXOs</h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {!hasBalanceSnapshot ? (
                      <div className="text-xs text-amber-300 py-4 text-center border border-dashed border-amber-900/40 rounded-xl">Loading Bitcoin outputs…</div>
                    ) : mainUtxos.length === 0 && ownMainUtxos.length === 0 ? (
                      <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-800 rounded-xl">No unspent outputs.</div>
                    ) : (
                      <div className="space-y-2">
                        {/* Render Main-Chain UTXOs with dynamic split check */}
                        {uniqueUtxos(allMainUtxos).map((u, i) => {
                          const isSplit = isUtxoSplit(u);
                          return (
                            <div key={`main-${i}`} className={`p-2.5 rounded-xl text-xs flex justify-between items-center ${
                              isSplit 
                                ? 'bg-slate-900/40 border border-emerald-950 shadow-sm shadow-emerald-500/5' 
                                : 'bg-slate-950 border border-slate-800/60'
                            }`}>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-slate-400 truncate w-24">{u.txid}</span>
                                {isSplit ? (
                                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                                    u.confirmations < 1 
                                      ? 'bg-amber-950/30 border-amber-800/40 text-amber-400 animate-pulse'
                                      : 'bg-emerald-950/30 border-emerald-800/40 text-emerald-400'
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
                              <span className="font-semibold text-emerald-400">{(u.amount / 100000000).toFixed(4)} BTC</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">BIP110 UTXOs</h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {!hasBalanceSnapshot ? (
                      <div className="text-xs text-amber-300 py-4 text-center border border-dashed border-amber-900/40 rounded-xl">Loading BIP110 outputs…</div>
                    ) : bip110Utxos.length === 0 && ownBip110Utxos.length === 0 ? (
                      <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-800 rounded-xl">No unspent outputs.</div>
                    ) : (
                      <div className="space-y-2">
                        {/* Render BIP110 UTXOs with dynamic split check */}
                        {uniqueUtxos(allBip110Utxos).map((u, i) => {
                          const isSplit = isUtxoSplit(u);
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
                                      : 'bg-sky-950/30 border-sky-800/40 text-sky-400'
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
            </CollapsibleCard>

            {/* Withdraw Funds Panel */}
            <CollapsibleCard
              title="Withdraw Unlocked Funds"
              icon={ExternalLink}
              defaultOpen={false}
            >
              <form onSubmit={executeWithdrawal} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">
                      Select Source UTXO to withdraw from
                    </label>
                    <select
                      value={selectedWithdrawUtxoKey}
                      onChange={async (e) => {
                        const key = e.target.value;
                        setSelectedWithdrawUtxoKey(key);
                        if (key) {
                          const [chain, txid, voutStr] = key.split('|');
                          const vout = Number(voutStr);
                          const chainUtxos = chain === 'main' ? allMainUtxos : allBip110Utxos;
                          const utxo = chainUtxos
                            .find(u => u.txid === txid && u.vout === vout);
                          if (utxo) {
                            // Default to max withdraw (minus dynamically calculated fee)
                            const targetChain = chain === 'main' ? 'main' : 'bip110';
                            const feeSats = await calculateTxFee('withdraw', false, targetChain);
                            const maxWithdraw = utxo.amount - feeSats;
                            setWithdrawAmountSats(String(maxWithdraw > 0 ? maxWithdraw : 0));
                          }
                        } else {
                          setWithdrawAmountSats('');
                        }
                      }}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                    >
                      <option value="">-- Choose a Source UTXO --</option>
                      {/* Main-chain splitAddress outputs */}
                      {mainUtxos.map(u => (
                        <option key={`${u.txid}-${u.vout}-split-main`} value={`main|${u.txid}|${u.vout}`}>
                          BTC [Contract Addr] ({(u.amount / 100000000).toFixed(4)} BTC | {u.txid.substring(0, 10)}...:{u.vout}) [Addr Index #{u.index !== undefined ? u.index + 1 : 1}]
                        </option>
                      ))}
                      {/* BIP110-chain splitAddress outputs */}
                      {bip110Utxos.map(u => (
                        <option key={`${u.txid}-${u.vout}-split-b110`} value={`bip110|${u.txid}|${u.vout}`}>
                          B110 [Contract Addr] ({(u.amount / 100000000).toFixed(4)} B110 | {u.txid.substring(0, 10)}...:{u.vout}) [Addr Index #{u.index !== undefined ? u.index + 1 : 1}]
                        </option>
                      ))}
                      {/* Main-chain ownAddress outputs */}
                      {ownMainUtxos.map(u => (
                        <option key={`${u.txid}-${u.vout}-own-main`} value={`main|${u.txid}|${u.vout}`}>
                          BTC [Own Split Addr] ({(u.amount / 100000000).toFixed(4)} BTC | {u.txid.substring(0, 10)}...:{u.vout}) [Addr Index #{u.index !== undefined ? u.index + 1 : 1}]
                        </option>
                      ))}
                      {/* BIP110-chain ownAddress outputs */}
                      {ownBip110Utxos.map(u => (
                        <option key={`${u.txid}-${u.vout}-own-b110`} value={`bip110|${u.txid}|${u.vout}`}>
                          B110 [Own Split Addr] ({(u.amount / 100000000).toFixed(4)} B110 | {u.txid.substring(0, 10)}...:{u.vout}) [Addr Index #{u.index !== undefined ? u.index + 1 : 1}]
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">
                      External Destination Address
                    </label>
                    <input
                      type="text"
                      value={withdrawDestAddress}
                      onChange={(e) => setWithdrawDestAddress(e.target.value)}
                      placeholder="e.g. bcrt1p... or bc1p..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end pt-2">
                  <div>
                    <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">
                      Withdrawal Amount (Sats)
                    </label>
                    <div className="relative">
                      <input
                        type="number"
                        min="10000"
                        value={withdrawAmountSats}
                        onChange={(e) => setWithdrawAmountSats(e.target.value)}
                        placeholder="Withdrawal amount in Satoshis"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono pr-16"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          if (selectedWithdrawUtxoKey) {
                            const [chain, txid, voutStr] = selectedWithdrawUtxoKey.split('|');
                            const vout = Number(voutStr);
                            const chainUtxos = chain === 'main' ? allMainUtxos : allBip110Utxos;
                            const utxo = chainUtxos
                              .find(u => u.txid === txid && u.vout === vout);
                            if (utxo) {
                              const targetChain = chain === 'main' ? 'main' : 'bip110';
                              const feeSats = await calculateTxFee('withdraw', false, targetChain);
                              const maxWithdraw = utxo.amount - feeSats;
                              setWithdrawAmountSats(String(maxWithdraw > 0 ? maxWithdraw : 0));
                            }
                          }
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] font-bold text-indigo-400 hover:text-indigo-300 bg-slate-900 border border-slate-800 rounded"
                      >
                        MAX
                      </button>
                    </div>
                    <span className="text-[10px] text-slate-500 mt-1 block">
                      {networkMode === 'mainnet' ? 'A dynamic transaction fee will be calculated and deducted.' : 'Standard transaction fee of 5,000 satoshis will be deducted.'}
                    </span>
                  </div>

                  <div>
                    <button
                      type="submit"
                      disabled={withdrawing || !selectedWithdrawUtxoKey || !withdrawDestAddress}
                      className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xs rounded-xl py-2.5 shadow-lg shadow-indigo-600/10 transition-all"
                    >
                      {withdrawing ? 'Broadcasting Withdrawal...' : 'Execute Withdrawal'}
                    </button>
                  </div>
                </div>
              </form>
            </CollapsibleCard>
          </div>
        )}

        {/* TAB 2: COIN SPLITTER */}
        {activeTab === 'splitter' && (
          <div className="space-y-8">
            <CollapsibleCard
              title="Bilateral Replay-Proof Coin Splitter"
              icon={Layers}
              defaultOpen={true}
            >
              <p className="text-xs text-slate-400 mb-6">
                Split your coins to protect them from replay risk and secure your balances before funding HTLCs.
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
                  
                  {/* Only outpoints currently present on both chains are eligible for splitting. */}
                  {!hasBalanceSnapshot ? (
                    <div className="text-center py-8 border border-dashed border-amber-900/40 bg-amber-950/10 rounded-xl text-xs text-amber-300 flex items-center justify-center gap-2" role="status">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Loading the cross-chain UTXO snapshot…
                    </div>
                  ) : getUnsplitUtxosForChain('main').length === 0 ? (
                    <div className="text-center py-8 border border-dashed border-slate-800 bg-slate-950/40 rounded-xl text-xs text-slate-500">
                      No unsplit outputs detected. An output must exist on both chains to be eligible.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3">
                      {getUnsplitUtxosForChain('main').map((u, idx) => {
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
                <CollapsibleCard
                  title="Already Split UTXOs (Replay-Protected)"
                  defaultOpen={false}
                  className="bg-slate-950/20 border-slate-850/60"
                >
                  <div className="space-y-2">
                    {/* Render split UTXOs on Main-Chain */}
                    {getSplitUtxosForChain('main').map((u, i) => (
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
                    {getSplitUtxosForChain('bip110').map((u, i) => (
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

                    {getSplitUtxosForChain('main').length === 0 && getSplitUtxosForChain('bip110').length === 0 && (
                      <div className="text-center py-6 border border-slate-900 bg-slate-950/20 rounded-xl text-xs text-slate-600">
                        No split UTXOs detected yet. Select an unsplit UTXO above to split!
                      </div>
                    )}
                  </div>
                </CollapsibleCard>

                {/* Single Split Spends Action Button */}
                <div className="pt-4">
                  {!recoveryDownloaded ? (
                    <div className="bg-amber-950/25 border border-amber-900/60 p-5 rounded-2xl space-y-4 max-w-2xl shadow-xl">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-amber-300">Safety Lock: Backup Required Before Splitting</h4>
                          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                            To protect your newly deposited funds on both chains against accidental loss, you must download your recovery backup file containing your Master Seed before proceeding with any coin-split operations.
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={handleDownloadRecoveryFile}
                        className="px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold rounded-xl flex items-center gap-2 transition-all shadow-lg shadow-amber-600/15"
                      >
                        <Download className="w-4 h-4" />
                        Download Recovery Backup File & Unlock
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={executeBilateralSplit}
                      disabled={splittingBilateral || !selectedUtxoToSplit}
                      className="w-full sm:w-auto px-6 py-3 font-semibold text-sm rounded-xl text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/10"
                    >
                      {splittingBilateral ? 'Executing Main-Chain Scriptpath Spend...' : 'Split Coins (Scriptpath Spend)'}
                    </button>
                  )}
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
                              Contains banned OP_IF, so BIP110-Chain will reject it, keeping your coins safely split on Knots.
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
            </CollapsibleCard>
          </div>
        )}

        {/* TAB 3: MARKETPLACE LOBBY */}
        {activeTab === 'marketplace' && (
          <div className="space-y-8">
            {/* Publish Form */}
            <CollapsibleCard
              title="Publish Swap Offer (Initiator)"
              icon={Plus}
              defaultOpen={true}
            >
              <p className="text-xs text-slate-400 mb-6">
                List a swap offer selling BIP110 for Main-Chain BTC.
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
                          setSellAmountSats('');
                          setPremiumPercent('0'); // Default to 0% (parity)
                          setNewOfferB110('');
                          setNewOfferBtc('');
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
                  {!hasBalanceSnapshot ? (
                    <p className="text-xs text-amber-300 mt-2 flex items-center gap-2" role="status">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Loading available split UTXOs…
                    </p>
                  ) : getAvailableSplitUtxos().length === 0 && (
                    <p className="text-xs text-rose-400 mt-2">
                      ⚠️ You have no split UTXOs. Please go to the **Bilateral Splitter** tab to split some coins first!
                    </p>
                  )}

                  {selectedBackingUtxoKey && (() => {
                    const utxo = getAvailableSplitUtxos().find(u => `${u.txid}-${u.vout}` === selectedBackingUtxoKey);
                    if (!utxo) return null;
                    const chainLabel = utxo.chain === 'main' ? 'BTC' : 'B110';
                    const fundingCandidates = getSplitUtxosForChain(utxo.chain);
                    const aggregateBalance = fundingCandidates.reduce((sum, candidate) => sum + candidate.amount, 0);
                    return (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
                        <div>
                          <label className="text-xs font-bold text-slate-400 block uppercase tracking-wider mb-2">
                            Sell Amount (Sats)
                          </label>
                          <input
                            type="number"
                            min="100000"
                            value={sellAmountSats}
                            onChange={(e) => handleSellAmountChange(e.target.value)}
                            placeholder={`Up to aggregate balance minus fees`}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                          />
                          <span className="text-[10px] text-slate-500 mt-1 block">
                            Aggregate split balance: <span className="font-semibold text-slate-400">{aggregateBalance.toLocaleString()} Sats</span> ({(aggregateBalance / 100000000).toFixed(4)} {chainLabel}) across {fundingCandidates.length} UTXO{fundingCandidates.length === 1 ? '' : 's'}. Fees must also fit within this balance.
                          </span>
                          <span className="text-[10px] text-slate-600 mt-1 block">
                            The selected outpoint anchors the offer; additional split UTXOs are added automatically when funding it.
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
            </CollapsibleCard>

            {/* PUBLIC MARKETPLACE LOBBY */}
            <CollapsibleCard
              title={`Public Marketplace Lobby (${networkMode === 'mainnet' ? 'Mainnet' : 'Regtest'})`}
              icon={TrendingUp}
              defaultOpen={true}
            >
              <p className="text-xs text-slate-400 mb-6">
                Accept swap offers published by other counterparties.
              </p>

              {/* Sorting and Page Size Controls */}
              <div className="flex flex-col sm:flex-row gap-4 mb-6 justify-between items-start sm:items-center text-xs">
                <div className="flex flex-wrap gap-3 items-center">
                  <span className="text-slate-400 font-medium">Sort By:</span>
                  <select
                    value={offersOrderBy}
                    onChange={(e) => {
                      setOffersOrderBy(e.target.value as any);
                      setOffersPage(1); // Reset to page 1 on sort change
                    }}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-slate-300 focus:outline-none focus:border-slate-700 font-medium"
                  >
                    <option value="createdAt">Date Created</option>
                    <option value="premium">Premium Size</option>
                    <option value="amount">Amount Size</option>
                  </select>

                  <select
                    value={offersOrderDir}
                    onChange={(e) => {
                      setOffersOrderDir(e.target.value as any);
                      setOffersPage(1); // Reset to page 1 on direction change
                    }}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-slate-300 focus:outline-none focus:border-slate-700 font-medium"
                  >
                    <option value="desc">Descending</option>
                    <option value="asc">Ascending</option>
                  </select>

                  <span className="text-slate-400 font-medium ml-2">Show:</span>
                  <select
                    value={offersLimit}
                    onChange={(e) => {
                      setOffersLimit(Number(e.target.value));
                      setOffersPage(1); // Reset to page 1 on limit change
                    }}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-slate-300 focus:outline-none focus:border-slate-700 font-medium"
                  >
                    <option value={5}>5 per page</option>
                    <option value={10}>10 per page</option>
                    <option value={20}>20 per page</option>
                    <option value={50}>50 per page</option>
                  </select>
                </div>

                <div className="text-slate-400 font-medium">
                  Total found: <span className="text-slate-200 font-bold">{offersTotal}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {marketplaceOffers.length === 0 ? (
                  <div className="col-span-2 text-center py-12 text-slate-500 border border-dashed border-slate-800 rounded-2xl bg-slate-950/20 text-xs">
                    No other sellers' offers found in the orderbook.
                  </div>
                ) : (
                  marketplaceOffers.map((o) => {
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
                                {formatLockTimeDisplay(o.lockTime, false, o.backingChain || 'main')}
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

              {/* Pagination Controls */}
              {offersTotalPages > 1 && (
                <div className="flex justify-center items-center gap-4 mt-8 pt-6 border-t border-slate-900 text-xs">
                  <button
                    disabled={offersPage === 1}
                    onClick={() => setOffersPage(prev => Math.max(prev - 1, 1))}
                    className="px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-900 transition-all font-semibold"
                  >
                    Previous
                  </button>
                  <span className="text-slate-400 font-semibold">
                    Page <span className="text-slate-200">{offersPage}</span> of <span className="text-slate-200">{offersTotalPages}</span>
                  </span>
                  <button
                    disabled={offersPage === offersTotalPages}
                    onClick={() => setOffersPage(prev => Math.min(prev + 1, offersTotalPages))}
                    className="px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-900 transition-all font-semibold"
                  >
                    Next
                  </button>
                </div>
              )}
            </CollapsibleCard>
          </div>
        )}

        {/* TAB 4: MY SWAPS & OPEN OFFERS */}
        {activeTab === 'my-offers' && (
          <div className="space-y-8">
            {/* Published Swaps (You are Initiator) */}
            <CollapsibleCard
              title="My Swaps & Open Offers (You are Initiator)"
              icon={User}
              defaultOpen={true}
            >
              <p className="text-xs text-slate-400 mb-6">
                Monitor and manage swap offers you published.
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
                            {o.isPending ? 'PENDING' : o.status === 'OPEN' ? 'OPEN' : o.status}
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
                              {formatLockTimeDisplay(o.lockTime, false, o.backingChain || 'main')}
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

                      <div className="mt-5 flex flex-col sm:flex-row gap-3">
                        <button
                          onClick={() => {
                            setSelectedOffer(o);
                            setActiveTab('wizard');
                          }}
                          className="flex-1 py-2.5 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg shadow-indigo-600/10 flex items-center justify-center gap-1.5"
                        >
                          <Activity className="w-4 h-4" />
                          Open Swap Wizard
                        </button>
                        
                        {(o.status === 'OPEN' || o.status === 'ACCEPTED') && (
                          <button
                            onClick={() => handleDeleteOffer(o)}
                            className="px-4 py-2.5 text-xs font-semibold rounded-xl bg-rose-950/40 hover:bg-rose-900/60 border border-rose-900/40 text-rose-300 transition-all flex items-center justify-center gap-1"
                            title={o.status === 'ACCEPTED' ? 'Abort before locking your funds' : 'Cancel and permanently delete this offer'}
                          >
                            {o.status === 'ACCEPTED' ? 'Abort Swap' : 'Delete'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CollapsibleCard>

            {/* Accepted Swaps (You are Acceptor) */}
            <CollapsibleCard
              title="Swaps I Have Accepted (You are Acceptor)"
              icon={UserCheck}
              defaultOpen={true}
            >
              <p className="text-xs text-slate-400 mb-6">
                Monitor swaps you accepted. You may abort at any point before you lock your own funds.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {offersList.filter(o => o.acceptorPubKey === publicKey).length === 0 ? (
                  <div className="col-span-2 text-center py-12 text-slate-500 border border-dashed border-slate-800 rounded-2xl bg-slate-950/20 text-xs">
                    You haven't accepted any swaps yet. Browse the **Marketplace Lobby** to find open offers!
                  </div>
                ) : (
                  offersList.filter(o => o.acceptorPubKey === publicKey).map((o) => (
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
                            o.status === 'ACCEPTED' ? 'bg-indigo-950/40 border-indigo-900/60 text-indigo-400 animate-pulse' :
                            'bg-emerald-950/40 border-emerald-900/60 text-emerald-400'
                          }`}>
                            {o.isPending ? 'PENDING' : o.status}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-4 mb-4 text-xs">
                          <div>
                            <span className="text-slate-400 block font-medium">You Receive</span>
                            <span className="font-semibold text-sky-400">
                              {o.backingChain === 'main' ? `${(o.acceptorBtcAmount / 100000000).toFixed(4)} BTC` : `${(o.initiatorB110Amount / 100000000).toFixed(4)} B110`}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block font-medium">You Spend</span>
                            <span className="font-semibold text-emerald-400">
                              {o.backingChain === 'main' ? `${(o.initiatorB110Amount / 100000000).toFixed(4)} B110` : `${(o.acceptorBtcAmount / 100000000).toFixed(4)} BTC`}
                            </span>
                          </div>
                        </div>

                         <div className="text-[10px] space-y-1.5 border-t border-slate-900 pt-3">
                          <div className="flex justify-between">
                            <span className="text-slate-500 font-medium">Refund Locktime (T/2):</span>
                            <span className="font-semibold text-amber-500">
                              {formatLockTimeDisplay(o.secondLockTime, false, o.backingChain === 'main' ? 'bip110' : 'main')}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-500 font-medium">Escrow Status:</span>
                            <span className={`font-semibold ${(o.backingChain === 'main' ? o.btcHtlcTxid : o.b110HtlcTxid) ? 'text-emerald-400' : 'text-amber-500 animate-pulse'}`}>
                              {(o.backingChain === 'main' ? o.btcHtlcTxid : o.b110HtlcTxid) ? '✔️ Initiator Escrow Funded' : '⏳ Waiting for Initiator to lock funds'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-col sm:flex-row gap-3">
                        <button
                          onClick={() => {
                            setSelectedOffer(o);
                            setActiveTab('wizard');
                          }}
                          className="flex-1 py-2.5 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg shadow-indigo-600/10 flex items-center justify-center gap-1.5"
                        >
                          <Activity className="w-4 h-4" />
                          Open Swap Wizard
                        </button>
                        
                        {o.status === 'ACCEPTED' && (
                          <button
                            onClick={() => handleWalkbackAcceptance(o)}
                            className="px-4 py-2.5 text-xs font-semibold rounded-xl bg-amber-950/40 hover:bg-amber-900/60 border border-amber-900/40 text-amber-400 transition-all flex items-center justify-center gap-1"
                            title="Abort before locking your funds"
                          >
                            Abort Swap
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CollapsibleCard>
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
                      Construct and sign Taproot MAST transactions securely in your browser.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full sm:w-auto">
                    <div className="bg-slate-950 border border-slate-850 px-4 py-2.5 rounded-xl text-center">
                      <span className="text-[10px] text-slate-500 uppercase block font-semibold">Sell Volume</span>
                      <span className="text-sm font-bold text-sky-400">{(selectedOffer.initiatorB110Amount / 100000000).toFixed(4)} B110</span>
                    </div>
                    <div className="bg-slate-950 border border-slate-850 px-4 py-2.5 rounded-xl text-center">
                      <span className="text-[10px] text-slate-500 uppercase block font-semibold">Buy Volume</span>
                      <span className="text-sm font-bold text-emerald-400">{(selectedOffer.acceptorBtcAmount / 100000000).toFixed(4)} BTC</span>
                    </div>
                    <div className="bg-slate-950 border border-slate-850 px-4 py-2.5 rounded-xl text-center">
                      <span className="text-[10px] text-slate-500 uppercase block font-semibold">Refund Height (T / T/2)</span>
                      <span className="text-sm font-bold text-amber-500">
                        #{selectedOffer.lockTime} / #{selectedOffer.secondLockTime}
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

                {/* Either participant may abort only while neither party has locked funds. */}
                {(() => {
                  const isInitiator = selectedOffer.initiatorPubKey === publicKey;
                  const isAcceptor = selectedOffer.acceptorPubKey === publicKey;
                  const canInitiatorAbort = isInitiator && (selectedOffer.status === 'OPEN' || selectedOffer.status === 'ACCEPTED');
                  const canAcceptorAbort = isAcceptor && selectedOffer.status === 'ACCEPTED';
                  if (!canInitiatorAbort && !canAcceptorAbort) return null;

                  return (
                    <div className="bg-rose-950/15 border border-rose-900/40 p-4 rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                      <div>
                        <h4 className="text-xs font-bold text-rose-300">Abort Before Locking Funds</h4>
                        <p className="text-[10px] text-slate-400 mt-1 leading-normal">
                          Your funds are still unlocked. Aborting now does not require an on-chain refund.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => canInitiatorAbort ? handleDeleteOffer(selectedOffer) : handleWalkbackAcceptance(selectedOffer)}
                        className="px-4 py-2.5 text-xs font-semibold rounded-xl bg-rose-950/50 hover:bg-rose-900/60 border border-rose-900/50 text-rose-300 transition-all whitespace-nowrap"
                      >
                        Abort Swap
                      </button>
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
                <CollapsibleCard
                  title="Wizard Actions Dashboard"
                  icon={Activity}
                  defaultOpen={true}
                >
                  <div className="space-y-6 mt-2">
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
                        <span className={`text-xs font-semibold px-2 py-1 rounded border ${getMainSplitBalance() > 0 ? 'bg-emerald-950/40 border-emerald-900/60 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-500'}`}>
                          {getMainSplitBalance() > 0 ? 'BTC Split Ready' : 'BTC Split Pending'}
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
                      const isUtxoUnconfirmed = utxo && utxo.confirmations < 1;

                      if (isInitiator) {
                        return (
                          <div className="bg-slate-950 border border-slate-850 p-5 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            <div>
                              <span className="text-[10px] text-slate-500 block uppercase tracking-wider font-bold">Pending Action (Initiator)</span>
                              <h4 className="text-xs font-bold text-slate-200">Lock {isBtcBacking ? 'Bitcoin' : 'BIP110'} Coins into HTLC Contract</h4>
                              {utxo && (
                                <p className="text-[10px] text-slate-400 font-mono mt-2 bg-slate-900 border border-slate-850 p-2.5 rounded-lg leading-normal">
                                  <span className="block font-semibold text-slate-300 mb-1">Preferred Backing Input:</span>
                                  TxID: {utxo.txid.substring(0, 12)}...{utxo.txid.substring(52)}:{utxo.vout}<br />
                                  Amount: {(utxo.amount / 100000000).toFixed(4)} {isBtcBacking ? 'BTC' : 'B110'}<br />
                                  Address: {utxo.address || 'Split contract / ownAddress'}<br />
                                  <span className="text-slate-500">Additional split UTXOs are selected automatically when required.</span>
                                </p>
                              )}
                              {isUtxoUnconfirmed && (
                                <p className="text-[10px] text-amber-500 font-semibold mt-2.5 bg-amber-950/20 border border-amber-900/40 p-2.5 rounded-lg leading-normal">
                                  ⚠️ Your split transaction is still unconfirmed (0 confirmations). Please wait or mine a block to confirm it before locking your coins!
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => runWizardStep(2)}
                              disabled={isUtxoUnconfirmed}
                              className={`px-4 py-2 text-white font-semibold text-xs rounded-xl shadow-md transition-all self-end md:self-center disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${bgClass}`}
                            >
                              {isUtxoUnconfirmed ? 'Awaiting Split Confirmation...' : `Lock & Fund ${isBtcBacking ? 'BTC' : 'B110'} HTLC`}
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
                      const isInitiatorPending = selectedOffer.isPending;
                      const isUtxoUnconfirmed = utxo && utxo.confirmations < 1;
                      const cannotProceed = isInitiatorPending || isUtxoUnconfirmed;

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
                              {isInitiatorPending && (
                                <p className="text-[10px] text-amber-500 font-semibold mt-2.5 bg-amber-950/20 border border-amber-900/40 p-2.5 rounded-lg leading-normal">
                                  ⚠️ Initiator's HTLC escrow transaction is still unconfirmed (0 confirmations). To prevent transaction replacement/cancellation, please wait until their transaction is mined in a block!
                                </p>
                              )}
                              {!isInitiatorPending && isUtxoUnconfirmed && (
                                <p className="text-[10px] text-amber-500 font-semibold mt-2.5 bg-amber-950/20 border border-amber-900/40 p-2.5 rounded-lg leading-normal">
                                  ⚠️ Your split transaction is still unconfirmed (0 confirmations). Please wait or mine a block to confirm it first.
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => runWizardStep(3)}
                              disabled={cannotProceed}
                              className={`px-4 py-2 text-white font-semibold text-xs rounded-xl shadow-md transition-all self-end md:self-center disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${bgClass}`}
                            >
                              {isInitiatorPending ? 'Awaiting Initiator\'s Escrow...' : isUtxoUnconfirmed ? 'Awaiting Split Confirmation...' : `Lock & Fund ${isBtcBacking ? 'B110' : 'BTC'} HTLC`}
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
                      const isAcceptorPending = selectedOffer.isPending;

                      if (isInitiator) {
                        return (
                          <div className="bg-slate-950 border border-slate-850 p-5 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            <div>
                              <span className="text-[10px] text-slate-500 block uppercase tracking-wider font-bold">Pending Action (Initiator)</span>
                              <h4 className="text-xs font-bold text-slate-200">Claim {isBtcBacking ? 'B110' : 'Bitcoin'} Coins from Escrow</h4>
                              <p className="text-[10px] text-slate-400 leading-normal mt-1">
                                Collect your funds from the {isBtcBacking ? 'BIP110-Chain' : 'Main-Chain'} HTLC escrow contract. This action will automatically write the secret preimage to the public blockchain, enabling the Acceptor to claim their coins.
                              </p>
                              {isAcceptorPending && (
                                <p className="text-[10px] text-amber-500 font-semibold mt-2.5 bg-amber-950/20 border border-amber-900/40 p-2.5 rounded-lg leading-normal">
                                  ⚠️ Acceptor's HTLC escrow transaction is still unconfirmed (0 confirmations). To ensure absolute transaction safety, you can only claim once their transaction is mined in a block!
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => runWizardStep(4)}
                              disabled={isAcceptorPending}
                              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xs rounded-xl shadow-md transition-all self-end md:self-center whitespace-nowrap"
                            >
                              {isAcceptorPending ? 'Awaiting Confirmation...' : `Claim ${isBtcBacking ? 'B110' : 'BTC'} (Reveal Secret)`}
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
                      const isAcceptor = selectedOffer.acceptorPubKey === publicKey;
                      const isBtcBacking = selectedOffer.backingChain === 'main';
                      const hasFundedHtlc = isInitiator
                        || (isAcceptor && selectedOffer.status === 'FUNDED_ACCEPTOR');

                      if (!hasFundedHtlc) return null;

                      const targetLocktime = isInitiator 
                        ? selectedOffer.lockTime 
                        : getSecondHtlcLockTime(selectedOffer, getNetwork());

                      const targetChain = isInitiator
                        ? (isBtcBacking ? 'main' : 'bip110')
                        : (isBtcBacking ? 'bip110' : 'main');

                      const currentHeight = targetChain === 'main' 
                        ? nodeInfo.mainHeight 
                        : nodeInfo.bip110Height;

                      const isExpired = currentHeight >= targetLocktime;

                      return (
                        <CollapsibleCard
                          title="Safety Refund Panel"
                          icon={AlertTriangle}
                          defaultOpen={false}
                          className="mt-4"
                        >
                          <div className="space-y-3 mt-2">
                            <p className="text-[10px] text-slate-400 leading-normal">
                              If the counterparty disappears or fails to fulfill their step, you can safely reclaim your locked funds from the HTLC after block height expiration.
                            </p>
                            <div className="flex justify-between items-center bg-slate-950/40 p-2.5 rounded-lg border border-slate-900">
                              <span className="text-[10px] font-bold text-slate-400">Lock Status:</span>
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

                            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center pt-2 gap-4 border-t border-slate-800/80 mt-2">
                              <span className="text-[10px] text-slate-500 font-medium leading-normal">
                                {isExpired 
                                  ? '✔️ Refund window is OPEN.' 
                                  : `⏳ Refund opens in ${targetLocktime - currentHeight} blocks (~${(((targetLocktime - currentHeight) * 10) / 60).toFixed(1)} hrs).`}
                              </span>
                              <div className="flex flex-wrap sm:flex-nowrap gap-2 w-full sm:w-auto justify-end">
                                {networkMode === 'regtest' && !isExpired && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const blocksNeeded = targetLocktime - currentHeight;
                                      mineBlocks(targetChain, blocksNeeded);
                                    }}
                                    className="px-3 py-2 bg-indigo-600/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 hover:border-indigo-500/40 font-semibold text-xs rounded-xl transition-all whitespace-nowrap"
                                    title={`Fast-forward by mining ${targetLocktime - currentHeight} blocks`}
                                  >
                                    ⚡ Fast-Forward {targetLocktime - currentHeight} Blocks
                                  </button>
                                )}
                                <button
                                  onClick={executeRefund}
                                  disabled={!isExpired}
                                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xs rounded-xl shadow-md transition-all whitespace-nowrap"
                                >
                                  Reclaim Locked Funds
                                </button>
                              </div>
                            </div>
                          </div>
                        </CollapsibleCard>
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
                </CollapsibleCard>
              </div>
            )}
          </div>
        )}
          </>
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
