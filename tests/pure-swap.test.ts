import { expect } from 'chai';
import { PureBitcoinSwap } from '../src/lib/PureBitcoinSwap';
import * as bitcoin from 'bitcoinjs-lib';

describe('Pure Bitcoinjs-Lib Optimized Swap Tests', () => {
    // Generate roles
    const initiator = PureBitcoinSwap.generateKeyPair();
    const acceptor = PureBitcoinSwap.generateKeyPair();

    // Convert Uint8Array to Buffer for standard bitcoinjs-lib compatibility
    const initiatorPubKey = Buffer.from(initiator.publicKey);
    const acceptorPubKey = Buffer.from(acceptor.publicKey);

    // Swap parameters
    const preimage = 'highly-optimized-bip110-swap-secret';
    const hashLock = PureBitcoinSwap.computeHashLock(preimage);

    // Timelocks
    const lockTime = 2000; // Block height

    it('1. Split Script should compile to the exact opcode gating sequence', () => {
        const splitScript = PureBitcoinSwap.createSplitScript(initiatorPubKey);
        const decompiled = bitcoin.script.decompile(splitScript);

        expect(decompiled).to.not.be.null;
        const opcodes = decompiled!;

        expect(opcodes[0]).to.equal(bitcoin.opcodes.OP_IF);
        expect(opcodes[1]).to.equal(bitcoin.opcodes.OP_RETURN);
        expect(opcodes[2]).to.equal(bitcoin.opcodes.OP_ELSE);
        
        // Public key is at index 3
        expect(Buffer.isBuffer(opcodes[3])).to.be.true;
        expect((opcodes[3] as Buffer).length).to.equal(32); // Must be X-only (32 bytes)
        expect((opcodes[3] as Buffer).toString('hex')).to.equal(PureBitcoinSwap.getXOnlyPubKey(initiatorPubKey).toString('hex'));

        expect(opcodes[4]).to.equal(bitcoin.opcodes.OP_CHECKSIG);
        expect(opcodes[5]).to.equal(bitcoin.opcodes.OP_ENDIF);
    });

    it('2. Claim Script should be exactly 69 bytes with zero conditional opcodes', () => {
        const claimScript = PureBitcoinSwap.createHtlcClaimScript(hashLock, acceptorPubKey);
        expect(claimScript.length).to.equal(69); // 33-byte hashLock push + 33-byte recipientPubKey push + 3 single-byte opcodes = 69 bytes!

        const decompiled = bitcoin.script.decompile(claimScript)!;
        expect(decompiled[0]).to.equal(bitcoin.opcodes.OP_SHA256);
        expect((decompiled[1] as Buffer).toString('hex')).to.equal(hashLock.toString('hex'));
        expect(decompiled[2]).to.equal(bitcoin.opcodes.OP_EQUALVERIFY);
        expect((decompiled[3] as Buffer).toString('hex')).to.equal(PureBitcoinSwap.getXOnlyPubKey(acceptorPubKey).toString('hex'));
        expect(decompiled[4]).to.equal(bitcoin.opcodes.OP_CHECKSIG);

        // Verify no conditional opcodes exist in the leaf
        const hasConditional = decompiled.some(op => 
            op === bitcoin.opcodes.OP_IF || 
            op === bitcoin.opcodes.OP_ELSE || 
            op === bitcoin.opcodes.OP_ENDIF
        );
        expect(hasConditional).to.be.false;
    });

    it('3. Refund Script should be exactly 39 bytes with zero conditional opcodes', () => {
        const refundScript = PureBitcoinSwap.createHtlcRefundScript(initiatorPubKey, lockTime);
        expect(refundScript.length).to.equal(39); // 2 + 1 + 1 + 1 + 32 + 1 + 1 = 39 bytes!

        const decompiled = bitcoin.script.decompile(refundScript)!;
        expect((decompiled[0] as Buffer).toString('hex')).to.equal(Buffer.from(bitcoin.script.number.encode(lockTime)).toString('hex'));
        expect(decompiled[1]).to.equal(bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY);
        expect(decompiled[2]).to.equal(bitcoin.opcodes.OP_DROP);
        expect((decompiled[3] as Buffer).toString('hex')).to.equal(PureBitcoinSwap.getXOnlyPubKey(initiatorPubKey).toString('hex'));
        expect(decompiled[4]).to.equal(bitcoin.opcodes.OP_CHECKSIG);

        // Verify no conditional opcodes exist in the leaf
        const hasConditional = decompiled.some(op => 
            op === bitcoin.opcodes.OP_IF || 
            op === bitcoin.opcodes.OP_ELSE || 
            op === bitcoin.opcodes.OP_ENDIF
        );
        expect(hasConditional).to.be.false;
    });

    it('4. Taproot HTLC Address Generation should be completely deterministic', () => {
        // Aggregate/Musig2 mock internal public key (combinatorial)
        const mockInternalPubKey = Buffer.from(
            '0250863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352', 
            'hex'
        );

        const htlcPayment1 = PureBitcoinSwap.createTaprootHtlc(
            mockInternalPubKey,
            hashLock,
            acceptorPubKey,
            initiatorPubKey,
            lockTime
        );

        const htlcPayment2 = PureBitcoinSwap.createTaprootHtlc(
            mockInternalPubKey,
            hashLock,
            acceptorPubKey,
            initiatorPubKey,
            lockTime
        );

        // Addresses must be absolutely identical and valid testnet p2tr addresses starting with "tb1p"
        expect(htlcPayment1.address).to.equal(htlcPayment2.address);
        expect(htlcPayment1.address!.startsWith('tb1p')).to.be.true;
    });
});
