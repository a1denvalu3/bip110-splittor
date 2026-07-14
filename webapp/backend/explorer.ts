import axios, { AxiosError, AxiosInstance } from 'axios';

export type ExplorerChain = 'main' | 'bip110';

export interface ExplorerUtxo {
    txid: string;
    vout: number;
    amount: number;
    confirmations: number;
}

export interface RecommendedFees {
    fastestFee: number;
    halfHourFee: number;
    hourFee: number;
    economyFee: number;
    minimumFee: number;
}

type HttpClient = Pick<AxiosInstance, 'get' | 'post'>;

export class ExplorerRequestError extends Error {
    readonly operation: string;
    readonly status?: number;

    constructor(operation: string, cause: unknown) {
        const axiosError = cause as AxiosError;
        const status = axiosError.response?.status;
        const responseMessage = typeof axiosError.response?.data === 'string'
            ? axiosError.response.data
            : undefined;
        const detail = responseMessage || axiosError.message || String(cause);
        super(`${operation} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
        this.name = 'ExplorerRequestError';
        this.operation = operation;
        this.status = status;
    }
}

export class MempoolExplorerClient {
    readonly baseUrl: string;
    private readonly http: HttpClient;
    private readonly timeoutMs: number;

    constructor(baseUrl: string, http: HttpClient = axios, timeoutMs = 5000) {
        const normalizedUrl = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/, '');
        if (!normalizedUrl) throw new Error('Explorer base URL is required');

        let parsed: URL;
        try {
            parsed = new URL(normalizedUrl);
        } catch {
            throw new Error(`Invalid explorer base URL: ${baseUrl}`);
        }
        if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
            throw new Error('Explorer base URL must use HTTPS outside localhost');
        }

        this.baseUrl = normalizedUrl;
        this.http = http;
        this.timeoutMs = timeoutMs;
    }

    private api(path: string): string {
        return `${this.baseUrl}/api${path}`;
    }

    async getTransactionConfirmations(txid: string): Promise<number> {
        try {
            const response = await this.http.get(this.api(`/tx/${encodeURIComponent(txid)}/status`), {
                timeout: this.timeoutMs
            });
            if (typeof response.data?.confirmed !== 'boolean') {
                throw new Error('Explorer returned an invalid transaction-status response');
            }
            return response.data.confirmed ? 1 : 0;
        } catch (error) {
            if (error instanceof ExplorerRequestError) throw error;
            throw new ExplorerRequestError('Transaction status lookup', error);
        }
    }

    async getAddressUtxos(address: string): Promise<ExplorerUtxo[]> {
        try {
            const response = await this.http.get(this.api(`/address/${encodeURIComponent(address)}/utxo`), {
                timeout: this.timeoutMs
            });
            if (!Array.isArray(response.data)) {
                throw new Error('Explorer returned an invalid UTXO response');
            }
            return response.data.map((utxo: any) => {
                if (
                    typeof utxo?.txid !== 'string' ||
                    !Number.isInteger(utxo?.vout) ||
                    !Number.isSafeInteger(utxo?.value) ||
                    typeof utxo?.status?.confirmed !== 'boolean'
                ) {
                    throw new Error('Explorer returned a malformed UTXO');
                }
                return {
                    txid: utxo.txid,
                    vout: utxo.vout,
                    amount: utxo.value,
                    confirmations: utxo.status.confirmed ? 1 : 0
                };
            });
        } catch (error) {
            if (error instanceof ExplorerRequestError) throw error;
            throw new ExplorerRequestError('Address UTXO lookup', error);
        }
    }

    async broadcastTransaction(hex: string): Promise<string> {
        try {
            const response = await this.http.post(this.api('/tx'), hex, {
                timeout: this.timeoutMs,
                headers: { 'Content-Type': 'text/plain' }
            });
            if (typeof response.data !== 'string' || !/^[0-9a-f]{64}$/i.test(response.data.trim())) {
                throw new Error('Explorer returned an invalid transaction id');
            }
            return response.data.trim();
        } catch (error) {
            if (error instanceof ExplorerRequestError) throw error;
            throw new ExplorerRequestError('Transaction broadcast', error);
        }
    }

    async getTipHeight(): Promise<number> {
        try {
            const response = await this.http.get(this.api('/blocks/tip/height'), {
                timeout: this.timeoutMs
            });
            const height = Number(response.data);
            if (!Number.isSafeInteger(height) || height < 0) {
                throw new Error('Explorer returned an invalid chain height');
            }
            return height;
        } catch (error) {
            if (error instanceof ExplorerRequestError) throw error;
            throw new ExplorerRequestError('Chain-tip lookup', error);
        }
    }

    async getRecommendedFees(): Promise<RecommendedFees> {
        try {
            const response = await this.http.get(this.api('/v1/fees/recommended'), {
                timeout: this.timeoutMs
            });
            const keys: (keyof RecommendedFees)[] = [
                'fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee'
            ];
            const fees = {} as RecommendedFees;
            for (const key of keys) {
                const value = Number(response.data?.[key]);
                if (!Number.isFinite(value) || value <= 0) {
                    throw new Error(`Explorer returned an invalid ${key}`);
                }
                fees[key] = value;
            }
            return fees;
        } catch (error) {
            if (error instanceof ExplorerRequestError) throw error;
            throw new ExplorerRequestError('Recommended-fee lookup', error);
        }
    }

    async assertHealthy(name: string): Promise<void> {
        await Promise.all([this.getTipHeight(), this.getRecommendedFees()]);
        console.log(`[BOOT] ${name} explorer health check passed: ${this.baseUrl}`);
    }
}
