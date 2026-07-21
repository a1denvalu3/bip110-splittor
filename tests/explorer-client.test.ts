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
                return { data: { confirmed: true, block_height: 840_000 } };
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

    it('accepts an explorer base URL that already ends in /api', async () => {
        const requests: string[] = [];
        const http = {
            get: async (url: string) => {
                requests.push(url);
                return { data: 840_000 };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example/api/', http);

        expect(client.baseUrl).to.equal('https://explorer.example');
        expect(await client.getTipHeight()).to.equal(840_000);
        expect(requests).to.deep.equal(['https://explorer.example/api/blocks/tip/height']);
    });

    it('maps and validates Esplora UTXO responses', async () => {
        const requests: string[] = [];
        const http = {
            get: async (url: string) => {
                requests.push(url);
                return { data: [{
                    txid: 'cd'.repeat(32),
                    vout: 2,
                    value: 42_000,
                    status: { confirmed: true, block_height: 839_999 }
                }] };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        expect(await client.getAddressUtxos('bc1ptest')).to.deep.equal([{
            txid: 'cd'.repeat(32),
            vout: 2,
            amount: 42_000,
            confirmations: 1
        }]);
        expect(requests).to.deep.equal([
            'https://explorer.example/api/address/bc1ptest/utxo'
        ]);
    });

    it('fetches raw transaction hex from the Esplora transaction endpoint', async () => {
        const requests: string[] = [];
        const txid = 'ab'.repeat(32);
        const rawTransaction = '02000000000100';
        const http = {
            get: async (url: string) => {
                requests.push(url);
                return { data: rawTransaction };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http, 4321);

        expect(await client.getRawTransaction(txid)).to.equal(rawTransaction);
        expect(requests).to.deep.equal([`https://explorer.example/api/tx/${txid}/hex`]);
    });

    it('rejects malformed raw transaction responses', async () => {
        const http = {
            get: async () => ({ data: 'not transaction hex' }),
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        try {
            await client.getRawTransaction('ab'.repeat(32));
            expect.fail('Expected malformed transaction hex to fail');
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerRequestError);
            expect((error as Error).message).to.contain('invalid raw transaction hex');
        }
    });

    it('posts raw transaction hex as text/plain and validates the returned txid', async () => {
        const requests: Array<{ url: string; body: string; config: any }> = [];
        const expectedTxid = 'ef'.repeat(32);
        const http = {
            get: async () => ({ data: {} }),
            post: async (url: string, body: string, config: any) => {
                requests.push({ url, body, config });
                return { data: ` ${expectedTxid}\n` };
            }
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http, 4321);

        expect(await client.broadcastTransaction('02000000')).to.equal(expectedTxid);
        expect(requests).to.deep.equal([{
            url: 'https://explorer.example/api/tx',
            body: '02000000',
            config: { timeout: 4321, headers: { 'Content-Type': 'text/plain' } }
        }]);

        http.post = async () => ({ data: 'not-a-64-character-txid' });
        try {
            await client.broadcastTransaction('02000000');
            expect.fail('Expected a malformed txid response to fail');
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerRequestError);
            expect((error as Error).message).to.contain('invalid transaction id');
        }
    });

    it('uses the tip-height endpoint and accepts genesis height zero', async () => {
        const requests: string[] = [];
        const http = {
            get: async (url: string) => {
                requests.push(url);
                return { data: '0' };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        expect(await client.getTipHeight()).to.equal(0);
        expect(requests).to.deep.equal(['https://explorer.example/api/blocks/tip/height']);

        http.get = async () => ({ data: -1 });
        try {
            await client.getTipHeight();
            expect.fail('Expected a negative height to fail');
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerRequestError);
            expect((error as Error).message).to.contain('invalid chain height');
        }
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
        const requests: string[] = [];
        const http = {
            get: async (url: string) => {
                requests.push(url);
                return {
                    data: {
                        fastestFee: 8.25,
                        halfHourFee: 5.5,
                        hourFee: 3.75,
                        economyFee: 2.1,
                        minimumFee: 1.01
                    }
                };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        expect(await client.getRecommendedFees()).to.include({
            halfHourFee: 5.5,
            minimumFee: 1.01
        });
        expect(requests).to.deep.equal([
            'https://explorer.example/api/v1/fees/recommended'
        ]);
    });

    it('falls back to Esplora fee estimates and maps confirmation targets', async () => {
        const requests: string[] = [];
        const http = {
            get: async (url: string) => {
                requests.push(url);
                if (url.endsWith('/v1/fees/recommended')) {
                    throw {
                        message: 'Request failed with status code 404',
                        response: { status: 404, data: 'not found' }
                    };
                }
                return {
                    data: {
                        '1': 9.5,
                        '3': 7.25,
                        '6': 4.5,
                        '144': 2.25,
                        '1008': 1.1
                    }
                };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        expect(await client.getRecommendedFees()).to.deep.equal({
            fastestFee: 9.5,
            halfHourFee: 7.25,
            hourFee: 4.5,
            economyFee: 2.25,
            minimumFee: 1.1
        });
        expect(requests).to.deep.equal([
            'https://explorer.example/api/v1/fees/recommended',
            'https://explorer.example/api/fee-estimates'
        ]);
    });

    it('reports both fee endpoint failures', async () => {
        const http = {
            get: async (url: string) => {
                if (url.endsWith('/v1/fees/recommended')) {
                    throw new Error('mempool endpoint unavailable');
                }
                return { data: { '1': 5 } };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        try {
            await client.getRecommendedFees();
            expect.fail('Expected both fee endpoints to fail');
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerRequestError);
            expect((error as Error).message).to.contain('Mempool endpoint failed: mempool endpoint unavailable');
            expect((error as Error).message).to.contain('Esplora endpoint failed: Explorer returned an invalid 3-block fee estimate');
        }
    });

    it('propagates HTTP status and text response details through ExplorerRequestError', async () => {
        const http = {
            get: async () => {
                throw {
                    message: 'Request failed with status code 429',
                    response: { status: 429, data: 'rate limit exceeded' }
                };
            },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        try {
            await client.getTipHeight();
            expect.fail('Expected HTTP failure');
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerRequestError);
            expect((error as ExplorerRequestError).status).to.equal(429);
            expect((error as ExplorerRequestError).operation).to.equal('Chain-tip lookup');
            expect((error as Error).message).to.equal(
                'Chain-tip lookup failed (HTTP 429): rate limit exceeded'
            );
        }
    });

    it('propagates network errors without inventing an HTTP status', async () => {
        const http = {
            get: async () => { throw new Error('socket hang up'); },
            post: async () => ({ data: '' })
        } as any;
        const client = new MempoolExplorerClient('https://explorer.example', http);

        try {
            await client.getTipHeight();
            expect.fail('Expected network failure');
        } catch (error) {
            expect(error).to.be.instanceOf(ExplorerRequestError);
            expect((error as ExplorerRequestError).status).to.equal(undefined);
            expect((error as Error).message).to.equal('Chain-tip lookup failed: socket hang up');
        }
    });

    it('requires HTTPS for non-local production explorers', () => {
        expect(() => new MempoolExplorerClient('http://explorer.example')).to.throw(
            'must use HTTPS'
        );
        expect(() => new MempoolExplorerClient('http://localhost:3006')).not.to.throw();
    });
});
