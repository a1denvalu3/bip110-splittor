import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory, ECPairAPI, ECPairInterface } from 'ecpair';
import * as crypto from 'crypto';

// Initialize Elliptic Curve library in bitcoinjs-lib for Schnorr and Taproot
bitcoin.initEccLib(ecc);
const ECPair: ECPairAPI = ECPairFactory(ecc);

export class PureBitcoinSwap {
    // Generate a random keypair for testing/development
    static generateKeyPair(): ECPairInterface {
        return ECPair.makeRandom({ network: bitcoin.networks.testnet });
    }

    // Helper to extract the 32-byte X-only public key from a compressed 33-byte public key
    static getXOnlyPubKey(pubKey: Buffer): Buffer {
        return pubKey.subarray(1, 33);
    }

    // Helper to compute standard SHA256 of a string preimage
    static computeHashLock(preimage: string): Buffer {
        return crypto.createHash('sha256').update(preimage, 'utf8').digest();
    }

    /**
     * 1. Replay-Protection Split Script (Main-Chain Spend Path)
     * OP_IF
     *   OP_RETURN
     * OP_ELSE
     *   <pubKey> OP_CHECKSIG
     * OP_ENDIF
     */
    static createSplitScript(ownerPubKey: Buffer): Buffer {
        const xOnlyKey = this.getXOnlyPubKey(ownerPubKey);
        return Buffer.from(bitcoin.script.compile([
            bitcoin.opcodes.OP_IF,
            bitcoin.opcodes.OP_RETURN,
            bitcoin.opcodes.OP_ELSE,
            xOnlyKey,
            bitcoin.opcodes.OP_CHECKSIG,
            bitcoin.opcodes.OP_ENDIF
        ]));
    }

    /**
     * 2. Claim Leaf (Success Path) - 100% BIP110 compliant, 0 conditional branching opcodes!
     * OP_SHA256 <hashLock> OP_EQUALVERIFY <recipientPubKey> OP_CHECKSIG
     */
    static createHtlcClaimScript(hashLock: Buffer, recipientPubKey: Buffer): Buffer {
        const xOnlyRecipient = this.getXOnlyPubKey(recipientPubKey);
        return Buffer.from(bitcoin.script.compile([
            bitcoin.opcodes.OP_SHA256,
            hashLock,
            bitcoin.opcodes.OP_EQUALVERIFY,
            xOnlyRecipient,
            bitcoin.opcodes.OP_CHECKSIG
        ]));
    }

    /**
     * 3. Refund Leaf (Timeout Path) - 100% BIP110 compliant, 0 conditional branching opcodes!
     * <lockTime> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundPubKey> OP_CHECKSIG
     */
    static createHtlcRefundScript(refundPubKey: Buffer, lockTime: number): Buffer {
        const xOnlyRefund = this.getXOnlyPubKey(refundPubKey);
        const locktimeBuffer = bitcoin.script.number.encode(lockTime);
        return Buffer.from(bitcoin.script.compile([
            locktimeBuffer,
            bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
            bitcoin.opcodes.OP_DROP,
            xOnlyRefund,
            bitcoin.opcodes.OP_CHECKSIG
        ]));
    }

    /**
     * 4. Build a Taproot Output committing to both MAST leaves.
     */
    static createTaprootHtlc(
        internalPubKey: Buffer, // Aggregated MuSig2 key
        hashLock: Buffer,
        recipientPubKey: Buffer,
        refundPubKey: Buffer,
        lockTime: number,
        network: bitcoin.Network = bitcoin.networks.testnet
    ): bitcoin.payments.Payment {
        const claimScript = this.createHtlcClaimScript(hashLock, recipientPubKey);
        const refundScript = this.createHtlcRefundScript(refundPubKey, lockTime);

        const claimLeaf = { output: new Uint8Array(claimScript) };
        const refundLeaf = { output: new Uint8Array(refundScript) };

        return bitcoin.payments.p2tr({
            internalPubkey: this.getXOnlyPubKey(internalPubKey),
            scriptTree: [claimLeaf, refundLeaf],
            network
        });
    }
}
