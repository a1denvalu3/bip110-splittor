# Double-Sided Replay-Protected Atomic Swap Across a Hard Fork

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

## Script Leaf Specifications (No sCrypt, Hyper-Optimized)

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

The integration suite runs against standard, unconnected Bitcoin Core and Bitcoin Knots containers using local Regtest networks to simulate a real hard fork split.

### Prerequisites
Make sure Docker is running on your host machine.

### Setup and Running Nodes
1. Install dependencies:
   ```bash
   npm install
   ```
2. Spin up the containerized Bitcoin Core (port 18443) and Bitcoin Knots (port 18444) nodes:
   ```bash
   docker-compose up -d
   ```

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

---

## References

* **Formalized Scheme Specification Gist**: [Double-Sided Replay-Protected Atomic Swap Gist](https://gist.github.com/a1denvalu3/7641b514bdb3b9de1b0f87a96c19cbf4)
* **Engines Used**: `bitcoinjs-lib` (v7), `tiny-secp256k1` (v2), and standard Bitcoin Regtest nodes.
