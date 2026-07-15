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

    it('5. Taproot HTLC Verification Primitives should correctly validate matching and mismatching parameters', () => {
        const mockInternalPubKey = Buffer.from(
            '0250863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352', 
            'hex'
        );

        const htlcPayment = PureBitcoinSwap.createTaprootHtlc(
            mockInternalPubKey,
            hashLock,
            acceptorPubKey,
            initiatorPubKey,
            lockTime
        );

        const address = htlcPayment.address!;
        const output = htlcPayment.output!;

        // 1. Check with correct parameters
        const isAddressValid = PureBitcoinSwap.verifyTaprootHtlcAddress(
            address,
            mockInternalPubKey,
            hashLock,
            acceptorPubKey,
            initiatorPubKey,
            lockTime
        );
        expect(isAddressValid).to.be.true;

        const isOutputValid = PureBitcoinSwap.verifyTaprootHtlcOutput(
            Buffer.from(output),
            mockInternalPubKey,
            hashLock,
            acceptorPubKey,
            initiatorPubKey,
            lockTime
        );
        expect(isOutputValid).to.be.true;

        // 2. Check with wrong internal public key
        const wrongInternalKey = Buffer.from(PureBitcoinSwap.generateKeyPair().publicKey);
        const badAddressCheck1 = PureBitcoinSwap.verifyTaprootHtlcAddress(
            address,
            wrongInternalKey,
            hashLock,
            acceptorPubKey,
            initiatorPubKey,
            lockTime
        );
        expect(badAddressCheck1).to.be.false;

        // 3. Check with wrong recipient pubkey
        const wrongRecipient = Buffer.from(PureBitcoinSwap.generateKeyPair().publicKey);
        const badAddressCheck2 = PureBitcoinSwap.verifyTaprootHtlcAddress(
            address,
            mockInternalPubKey,
            hashLock,
            wrongRecipient,
            initiatorPubKey,
            lockTime
        );
        expect(badAddressCheck2).to.be.false;

        // 4. Check with wrong lockTime
        const badAddressCheck3 = PureBitcoinSwap.verifyTaprootHtlcAddress(
            address,
            mockInternalPubKey,
            hashLock,
            acceptorPubKey,
            initiatorPubKey,
            lockTime + 1
        );
        expect(badAddressCheck3).to.be.false;
    });

    it('6. Multi-input Taproot HTLC Funding should build a valid transaction with multiple signed inputs', () => {
        const recipientKeyPair = PureBitcoinSwap.generateKeyPair();
        const recipientPubKey = Buffer.from(recipientKeyPair.publicKey);

        const payment = bitcoin.payments.p2tr({
            internalPubkey: PureBitcoinSwap.getXOnlyPubKey(recipientPubKey),
            network: bitcoin.networks.regtest
        });

        const htlcAddr = payment.address!;
        const changeAddr = payment.address!;

        const input1 = {
            txid: '1111111111111111111111111111111111111111111111111111111111111111',
            vout: 0,
            amount: 100000n,
            keyPair: recipientKeyPair,
            merkleRoot: Buffer.alloc(0),
            paymentOutput: payment.output!
        };

        const input2 = {
            txid: '2222222222222222222222222222222222222222222222222222222222222222',
            vout: 1,
            amount: 150000n,
            keyPair: recipientKeyPair,
            merkleRoot: Buffer.alloc(0),
            paymentOutput: payment.output!
        };

        const tx = PureBitcoinSwap.buildMultiInputHtlcFundingTx(
            [input1, input2],
            180000n,
            htlcAddr,
            changeAddr,
            10000n
        );

        expect(tx).to.be.an.instanceOf(bitcoin.Transaction);
        expect(tx.ins.length).to.equal(2);
        expect(tx.outs.length).to.equal(2);
        
        expect(tx.outs[0].value).to.equal(180000n);
        expect(tx.outs[1].value).to.equal(60000n);

        expect(tx.ins[0].witness).to.not.be.undefined;
        expect(tx.ins[0].witness!.length).to.equal(1);
        expect(tx.ins[1].witness).to.not.be.undefined;
        expect(tx.ins[1].witness!.length).to.equal(1);
    });

    it('7. HTLC funding can include a coordinator payment without reducing the contract output', () => {
        const recipientKeyPair = PureBitcoinSwap.generateKeyPair();
        const recipientPubKey = Buffer.from(recipientKeyPair.publicKey);
        const payment = bitcoin.payments.p2tr({
            internalPubkey: PureBitcoinSwap.getXOnlyPubKey(recipientPubKey),
            network: bitcoin.networks.regtest
        });
        const coordinator = bitcoin.payments.p2wpkh({
            hash: Buffer.alloc(20, 3),
            network: bitcoin.networks.regtest
        }).address!;
        const input = {
            txid: '33'.repeat(32), vout: 0, amount: 200000n,
            keyPair: recipientKeyPair, merkleRoot: Buffer.alloc(0), paymentOutput: payment.output!
        };
        const tx = PureBitcoinSwap.buildMultiInputHtlcFundingTx(
            [input], 180000n, payment.address!, payment.address!, 10000n,
            bitcoin.networks.regtest, coordinator, 2500n
        );
        expect(tx.outs.map(output => output.value)).to.deep.equal([180000n, 2500n, 7500n]);
        expect(Buffer.from(tx.outs[1].script).equals(bitcoin.address.toOutputScript(coordinator, bitcoin.networks.regtest))).to.equal(true);
    });
});
