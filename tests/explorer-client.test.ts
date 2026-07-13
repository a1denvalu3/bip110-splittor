import { expect } from 'chai';
import {
    ExplorerRequestError,
    MempoolExplorerClient
} from '../webapp/backend/explorer';

describe('Production Mempool explorer client', () => {
    it('normalizes the base URL and uses the transaction status endpoint', async () => {
        const requests: string[] = [];
        const http = {
            get: async (url: string) => {
                requests.push(url);
                return { data: { confirmed: true } };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example///', http);

        expect(client.baseUrl).to.equal('https://explorer.example');
        expect(await client.getTransactionConfirmations('ab'.repeat(32))).to.equal(1);
        expect(requests).to.deep.equal([
            `https://explorer.example/api/tx/${'ab'.repeat(32)}/status`
        ]);
    });

    it('maps and validates Esplora UTXO responses', async () => {
        const http = {
            get: async () => ({
                data: [{
                    txid: 'cd'.repeat(32),
                    vout: 2,
                    value: 42_000,
                    status: { confirmed: false }
                }]
            }),
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        expect(await client.getAddressUtxos('bc1ptest')).to.deep.equal([{
            txid: 'cd'.repeat(32),
            vout: 2,
            amount: 42_000,
            confirmations: 0
        }]);
    });

    it('rejects malformed explorer data instead of treating it as an empty wallet', async () => {
        const http = {
            get: async () => ({ data: { unexpected: true } }),
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        try {
            await client.getAddressUtxos('bc1ptest');
            expect.fail('Expected malformed response to fail');
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerRequestError);
            expect((error as Error).message).to.contain('invalid UTXO response');
        }
    });

    it('validates the Mempool-specific recommended fee contract', async () => {
        const http = {
            get: async () => ({
                data: {
                    fastestFee: 8,
                    halfHourFee: 5,
                    hourFee: 3,
                    economyFee: 2,
                    minimumFee: 1
                }
            }),
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        expect(await client.getRecommendedFees()).to.include({
            halfHourFee: 5,
            minimumFee: 1
        });
    });

    it('requires HTTPS for non-local production explorers', () => {
        expect(() => new MempoolExplorerClient('http://explorer.example')).to.throw(
            'must use HTTPS'
        );
        expect(() => new MempoolExplorerClient('http://localhost:3006')).not.to.throw();
    });
});
