import { expect } from 'chai';
import * as bitcoin from 'bitcoinjs-lib';
import {
    assertCoordinatorFee,
    loadCoordinatorFeeConfig,
    requiredCoordinatorFee
} from '../webapp/backend/coordinatorFees';

describe('Coordinator fees', () => {
    const network = bitcoin.networks.regtest;
    const address = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 7), network }).address!;

    function transactionWithPayments(payments: bigint[]): string {
        const tx = new bitcoin.Transaction();
        tx.addInput(Buffer.alloc(32), 0);
        for (const value of payments) tx.addOutput(bitcoin.address.toOutputScript(address, network), value);
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

    it('sums coordinator outputs and rejects underpayment', () => {
        assertCoordinatorFee(transactionWithPayments([10n, 16n]), 10_001n, '0.25', address, network);
        expect(() => assertCoordinatorFee(transactionWithPayments([25n]), 10_001n, '0.25', address, network))
            .to.throw('required at least 26 sats, found 25 sats');
    });

    it('does not parse an address or transaction when the role fee is disabled', () => {
        expect(() => assertCoordinatorFee('not-a-transaction', 10_000n, '0', '', network)).not.to.throw();
    });
});
