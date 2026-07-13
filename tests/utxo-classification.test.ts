import { expect } from 'chai';
import {
    buildOutpointSet,
    classifyOutpoint
} from '../src/lib/utxoClassification';

describe('Cross-chain UTXO classification', () => {
    const shared = { txid: 'aa'.repeat(32), vout: 1 };

    it('classifies an outpoint as unsplit only when it exists on both chains', () => {
        const main = buildOutpointSet([shared]);
        const bip110 = buildOutpointSet([{ ...shared }]);

        expect(classifyOutpoint(shared, main, bip110)).to.equal('unsplit');
    });

    it('classifies a main-chain-only outpoint as split', () => {
        expect(classifyOutpoint(
            shared,
            buildOutpointSet([shared]),
            buildOutpointSet([])
        )).to.equal('split');
    });

    it('classifies a BIP110-only outpoint as split', () => {
        expect(classifyOutpoint(
            shared,
            buildOutpointSet([]),
            buildOutpointSet([shared])
        )).to.equal('split');
    });

    it('matches the complete outpoint, including vout', () => {
        expect(classifyOutpoint(
            shared,
            buildOutpointSet([shared]),
            buildOutpointSet([{ txid: shared.txid, vout: 2 }])
        )).to.equal('split');
    });
});
