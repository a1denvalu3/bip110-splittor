import { createHash } from 'crypto';
import { createClient } from 'redis';
import { logInfo, logWarn } from './logger';

const REDIS_URL = process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379';
const CACHE_PREFIX = process.env.CACHE_PREFIX?.trim() || 'bip110-splittoooor:v1';

const client = createClient({
    url: REDIS_URL,
    socket: { connectTimeout: 1000, reconnectStrategy: false }
});
const inFlight = new Map<string, Promise<unknown>>();
let connectPromise: Promise<boolean> | undefined;
let loggedConnectionFailure = false;

client.on('error', (error: Error) => {
    if (!loggedConnectionFailure) {
        loggedConnectionFailure = true;
        logWarn('cache.redis_error', { error: error.message });
    }
});

async function ensureConnected(): Promise<boolean> {
    if (client.isReady) return true;
    if (!connectPromise) {
        connectPromise = client.connect()
            .then(() => {
                loggedConnectionFailure = false;
                logInfo('cache.redis_connected', { url: REDIS_URL.replace(/:\/\/[^@]+@/, '://***@') });
                return true;
            })
            .catch((error: Error) => {
                if (!loggedConnectionFailure) logWarn('cache.redis_unavailable', { error: error.message });
                loggedConnectionFailure = true;
                return false;
            })
            .finally(() => { connectPromise = undefined; });
    }
    return connectPromise;
}

export function explorerCacheKey(operation: string, identity: unknown): string {
    const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    return `${CACHE_PREFIX}:explorer:${operation}:${digest}`;
}

export async function cachedExplorerRead<T>(
    operation: string,
    identity: unknown,
    ttlSeconds: number,
    loader: () => Promise<T>
): Promise<T> {
    const key = explorerCacheKey(operation, identity);
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const request = (async () => {
        const connected = await ensureConnected();
        if (connected) {
            try {
                const cached = await client.get(key);
                if (cached !== null) return JSON.parse(cached) as T;
            } catch (error: any) {
                logWarn('cache.read_failed', { operation, error: error.message });
            }
        }

        const value = await loader();
        if (connected) {
            try {
                await client.setEx(key, ttlSeconds, JSON.stringify(value));
            } catch (error: any) {
                logWarn('cache.write_failed', { operation, error: error.message });
            }
        }
        return value;
    })();

    inFlight.set(key, request);
    try {
        return await request;
    } finally {
        inFlight.delete(key);
    }
}

export async function closeCache(): Promise<void> {
    if (client.isOpen) await client.quit();
}
