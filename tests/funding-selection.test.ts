import { expect } from 'chai';
import { selectFundingUtxos } from '../src/lib/fundingSelection';

describe('Multi-input funding selection', () => {
    const fee = (inputs: number, hasChange: boolean) => 100 + inputs * 50 + (hasChange ? 40 : 0);
    const utxo = (id: string, amount: number) => ({ txid: id.repeat(64), vout: 0, amount });

    it('adds inputs until the contract amount and fee are covered', () => {
        const result = selectFundingUtxos(
            [utxo('a', 600), utxo('b', 600)],
            1_000n,
            fee
        );

        expect(result?.utxos).to.have.length(2);
        expect(result?.feeSats).to.equal(200n);
        expect(result?.totalInputSats).to.equal(1_200n);
    });

    it('returns null when aggregate balance cannot cover fees', () => {
        expect(selectFundingUtxos([utxo('a', 1_000)], 1_000n, fee)).to.equal(null);
    });

    it('uses the selected backing outpoint first and then adds the largest inputs', () => {
        const preferred = utxo('a', 300);
        const result = selectFundingUtxos(
            [utxo('b', 800), preferred, utxo('c', 500)],
            1_000n,
            fee,
            preferred
        );

        expect(result?.utxos.map(item => item.txid[0])).to.deep.equal(['a', 'b', 'c']);
    });

    it('creates change only when the remainder also covers the change output fee and dust', () => {
        const noChange = selectFundingUtxos([utxo('a', 1_200)], 1_000n, fee);
        const withChange = selectFundingUtxos([utxo('b', 2_000)], 1_000n, fee);

        expect(noChange?.hasChange).to.equal(false);
        expect(withChange?.hasChange).to.equal(true);
    });
});
