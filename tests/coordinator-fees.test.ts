import { expect } from 'chai';
import * as bitcoin from 'bitcoinjs-lib';
import {
    assertCoordinatorFee,
    coordinatorOutputValue,
    loadCoordinatorFeeConfig,
    requiredCoordinatorFee
} from '../webapp/backend/coordinatorFees';

describe('Coordinator fees', () => {
    const network = bitcoin.networks.regtest;
    const address = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 7), network }).address!;
    const otherAddress = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 8), network }).address!;

    function transactionWithPayments(payments: Array<bigint | { address: string; value: bigint }>): string {
        const tx = new bitcoin.Transaction();
        tx.addInput(Buffer.alloc(32), 0);
        for (const payment of payments) {
            const destination = typeof payment === 'bigint' ? address : payment.address;
            const value = typeof payment === 'bigint' ? payment : payment.value;
            tx.addOutput(bitcoin.address.toOutputScript(destination, network), value);
        }
        return tx.toHex();
    }

    it('defaults both role fees to zero without requiring an address', () => {
        expect(loadCoordinatorFeeConfig({} as NodeJS.ProcessEnv)).to.deep.equal({
            makerFeePercent: '0', takerFeePercent: '0', receiveAddress: ''
        });
    });

    it('requires an address for non-zero fees and rejects invalid percentages', () => {
        expect(() => loadCoordinatorFeeConfig({ MAKER_FEE_PERCENT: '0.1' } as NodeJS.ProcessEnv))
            .to.throw('COORDINATOR_RECEIVE_ADDR');
        expect(() => loadCoordinatorFeeConfig({ TAKER_FEE_PERCENT: '101', COORDINATOR_RECEIVE_ADDR: address } as NodeJS.ProcessEnv))
            .to.throw('between 0 and 100');
    });

    it('calculates decimal percentages exactly and rounds up to a satoshi', () => {
        expect(requiredCoordinatorFee(10_001n, '0.25')).to.equal(26n);
        expect(requiredCoordinatorFee(100_000n, '1')).to.equal(1_000n);
    });

    it('accepts an output paying exactly the required fee', () => {
        assertCoordinatorFee(transactionWithPayments([26n]), 10_001n, '0.25', address, network);
    });

    it('accepts overpayment', () => {
        assertCoordinatorFee(transactionWithPayments([27n]), 10_001n, '0.25', address, network);
    });

    it('sums multiple outputs to the coordinator address', () => {
        const rawTransaction = transactionWithPayments([10n, 16n]);
        expect(coordinatorOutputValue(rawTransaction, address, network)).to.equal(26n);
        assertCoordinatorFee(rawTransaction, 10_001n, '0.25', address, network);
    });

    it('rejects an underpaid coordinator output', () => {
        expect(() => assertCoordinatorFee(transactionWithPayments([25n]), 10_001n, '0.25', address, network))
            .to.throw('required at least 26 sats, found 25 sats');
    });

    it('rejects a transaction with no coordinator output', () => {
        const rawTransaction = transactionWithPayments([{ address: otherAddress, value: 1_000n }]);
        expect(() => assertCoordinatorFee(rawTransaction, 10_000n, '1', address, network))
            .to.throw('required at least 100 sats, found 0 sats');
    });

    it('does not count outputs sent to a different address', () => {
        const rawTransaction = transactionWithPayments([
            { address: otherAddress, value: 100n },
            { address, value: 99n }
        ]);
        expect(coordinatorOutputValue(rawTransaction, address, network)).to.equal(99n);
        expect(() => assertCoordinatorFee(rawTransaction, 10_000n, '1', address, network))
            .to.throw('required at least 100 sats, found 99 sats');
    });

    it('does not parse an address or transaction when the role fee is disabled', () => {
        expect(() => assertCoordinatorFee('not-a-transaction', 10_000n, '0', '', network)).not.to.throw();
    });
});
