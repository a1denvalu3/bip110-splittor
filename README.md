# Double-Sided Replay-Protected Atomic Swap MainChain/BIP110-Chain

A double-sided, replay-protected atomic swap protocol designed to operate safely across a hard fork using pure, hyper-optimized Taproot MAST script leaves. This implementation is based on the [Double-Sided Replay-Protected Atomic Swap across BIP110 Hard Fork Gist](https://gist.github.com/a1denvalu3/7641b514bdb3b9de1b0f87a96c19cbf4), which formalizes the exact cryptographic splitting and swap scheme implemented here. It strictly avoids conditional branching opcodes in its HTLC script leaves to fully comply with the BIP110 opcode ban, providing a robust, lightweight, and framework-free atomic swap engine using raw `bitcoinjs-lib` and `tiny-secp256k1`.

---

## Technical Overview

During a hard fork, transaction replay attacks pose a critical risk to users trading across the split networks. BIP110 introduces a hard-fork consensus rule that bans conditional branching opcodes (`OP_IF`, `OP_ELSE`, `OP_ENDIF`) inside Taproot script leaves. 

To overcome this restriction while ensuring cross-chain atomic swaps remain completely secure and replay-protected, this protocol utilizes two key design paradigms:
1. **Pure Multi-Contract MAST Leaves**: HTLC conditional logic is entirely flattened into modular, independent leaves inside a Taproot MAST tree (no `OP_IF` allowed).
2. **Bilateral Double-Sided Coin Splitting**: Prior to funding any cross-chain HTLC, both the **Initiator** and **Acceptor** split their UTXOs on each respective chain. One spend uses the `OP_IF` scriptpath (accepted on Main-Chain, rejected on BIP110-Chain) and the other uses a Schnorr Keypath spend (accepted on both, but because the input is spent via `OP_IF` on the Main-Chain, it remains unique to the BIP110-Chain).

---

## The Bilateral Coin Split & HTLC Funding Symmetry

The protocol establishes a perfect, mirror-image cryptographic locking mechanism between the two participants to ensure zero replay risk:

| Participant | Chain they are Selling on | Spend Path used to Split & Fund | HTLC Location | Chain they are Buying on | How they Claim |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Initiator ($\mathcal{I}$)** | **BIP110-Chain** | **Keypath (Schnorr)** | BIP110-Chain | **Main-Chain** | Revealed Preimage $s$ |
| **Acceptor ($\mathcal{A}$)** | **Main-Chain** | **Scriptpath (`OP_IF`)** | Main-Chain | **BIP110-Chain** | Extracted Preimage $s$ |

### Why this is Cryptographically and Economically Elegant:

1. **The Initiator ($\mathcal{I}$)**:
   * Wants to get rid of their BIP110-Chain coins in exchange for Main-Chain coins.
   * On the **BIP110-Chain**, the Initiator uses their **Keypath spend** to split their coins.
   * They then use this split UTXO to fund the **BIP110-Chain HTLC**.
   * Since the parent UTXO on the Main-Chain was already spent via the `OP_IF` scriptpath, this transaction is a double-spend and impossible to replay on the Main-Chain.

2. **The Acceptor ($\mathcal{A}$)**:
   * Wants to get rid of their Main-Chain coins in exchange for BIP110-Chain coins.
   * On the **Main-Chain**, the Acceptor uses their **`OP_IF` scriptpath spend** to split their coins.
   * They then use this split UTXO to fund the **Main-Chain HTLC**.
   * Since this split transaction's ancestry contains the banned `OP_IF` opcode, it is rejected instantly by Knots nodes, making it impossible to replay on the BIP110-Chain.

---

## Script Leaf Specifications

By eliminating sCrypt boilerplate and hand-crafting script elements, we achieve extremely compact, fee-efficient bytecode sizes:

### 1. Split Contract
* **OPCODE Structure**: `OP_IF OP_RETURN OP_ELSE <pubKey> OP_CHECKSIG OP_ENDIF`
* **Bytecode Size**: **38 bytes**

### 2. HTLC Claim Leaf
* **OPCODE Structure**: `OP_SHA256 <hashLock> OP_EQUALVERIFY <recipientPubKey> OP_CHECKSIG`
* **Bytecode Size**: **69 bytes** (100% compliant with BIP110's opcode ban; contains 0 conditional branches)

### 3. HTLC Refund Leaf
* **OPCODE Structure**: `<lockTime> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundPubKey> OP_CHECKSIG`
* **Bytecode Size**: **39 bytes** (100% compliant with BIP110's opcode ban; contains 0 conditional branches)

---

## Integration Tests & Verification

The integration suite runs against connected, native Bitcoin Core (v26.0) and Bitcoin Knots (v29.3 with BIP110 consensus enabled) containers on a local Regtest network. This setup represents a high-fidelity, real-time simulation of an active hard fork split.

### Prerequisites
Make sure Docker is running on your host machine.

### Setup and Running Nodes
1. Install dependencies:
   ```bash
   npm install
   ```
2. Spin up the containerized Bitcoin Core (RPC port 18443) and Bitcoin Knots (RPC port 18444) nodes:
   ```bash
   docker-compose up -d
   ```
   * **BIP110 Activation:** The Bitcoin Knots container automatically activates the BIP110 `reduced_data` consensus rules immediately on startup via the version bit parameter `-vbparams=reduced_data:-1:999999999999`.
   * **Dual-Node P2P Connection:** The Core and Knots nodes are automatically connected to each other over P2P at startup via an automated `addnode` initialization sequence. This establishes a fully connected block propagation topology prior to the hard fork split.

### Running Verification Tests

#### 1. Coin Split Primitive Test
Asserts that `OP_IF` scriptpath transactions executed on Bitcoin Core are correctly rejected by Bitcoin Knots (BIP110-Chain) and that Schnorr keypath spends work correctly for both parties:
```bash
npm run test:split
```

#### 2. Full Double-Sided Atomic Swap Test
Simulates the entire swap end-to-end: double-sided splitting, double-sided HTLC funding, preimage extraction, and final claims:
```bash
npm run test:swap
```

#### 3. Swap Failure & Refund Test
Verifies all failure modes under real consensus rules: rejects claims with incorrect preimages, rejects premature refund spends, and successfully executes timelock-expired refund spends using the `RefundLeaf` scriptpath:
```bash
npm run test:refund
```

---

## Running the Interactive WebApp (Regtest Simulation)

You can run the full-stack interactive atomic swap web application locally to test and simulate splits, orders, claims, and refunds via a premium web UI.

### 1. Boot up the Nodes & Backend Server
This command will spin up the docker containers (Core + Knots), wipe any previous regtest DB to start fresh from zero, and launch the Express backend on port `4000`:
```bash
npm run server
```

### 2. Start the Frontend Client
This command will start the Vite React development server:
```bash
npm run frontend
```

### 3. Open the Web Portal
Once both services are running, open your web browser and navigate to:
```
http://localhost:3000
```

* **Step-by-Step Simulation Guide**:
  1. **Tab 1: Unified Wallet & Coin Faucet**: Generate mature coinbase miner rewards and activate the BIP110 consensus split natively by clicking **"Mine 450 blocks"**. Next, deposit test coins to your derived P2TR split contract address using the **Core and Knots faucets**.
  2. **Tab 2: Bilateral Splitter**: Select your deposited unsplit UTXO. Download your master seed recovery backup file to unlock features, then click **"Split Coins (Scriptpath Spend)"** to execute a split transaction (accepted on Bitcoin Core but rejected on Knots, cleanly isolating your BIP110 coins).
  3. **Tab 3: Marketplace Lobby**: Publish a swap offer to sell your isolated BIP110 coins in exchange for Mainnet BTC, customized with custom premiums or discounts.
  4. **Tab 4: My Swaps & Offers**: Monitor your listings, delete outstanding listings, walk back acceptances, or accept your own listing as a counterparty (by generating a new active P2TR address in Tab 1!).
  5. **Tab 5: Swap Wizard**: Orchestrate the end-to-end atomic swap using the step-by-step visual workflow to fund escrows, extract revealed preimages, settle claims, or simulate expired refund scripts.

## Production Mainnet Explorer Configuration

Mainnet mode fails closed unless both explorers expose a Mempool-compatible API, including chain height, transaction status, address UTXOs, raw transaction broadcast, and recommended fees.

```bash
BITCOIN_EXPLORER_URL=https://mempool.space \
BIP110_EXPLORER_URL=https://your-bip110-mempool.example \
npm run server:mainnet
```

Coordinator fees are disabled by default. To require funding transactions from makers (initiators)
and takers (acceptors) to pay the coordinator, configure percentage values and a receive address:

```bash
MAKER_FEE_PERCENT=0.25 \
TAKER_FEE_PERCENT=0.50 \
COORDINATOR_RECEIVE_ADDR=bc1p... \
npm run server:mainnet
```

Percentages are applied to the swap amount on the chain being locked and rounded up to the next satoshi.
Outputs to the receive address are summed. `COORDINATOR_RECEIVE_ADDR` may be omitted while both fees remain
at their default `0` percent.

The frontend uses same-origin `/api` in production. Set `VITE_API_BASE_URL` at build time only when the backend is hosted on a different origin.

---

## References

* **Formalized Scheme Specification Gist**: [Double-Sided Replay-Protected Atomic Swap Gist](https://gist.github.com/a1denvalu3/7641b514bdb3b9de1b0f87a96c19cbf4)
* **Engines Used**: `bitcoinjs-lib` (v7), `tiny-secp256k1` (v2), and standard Bitcoin Regtest nodes.
