import { Redis } from 'ioredis';
import { recordCacheAccess, recordCacheFallbackWrite } from '../observability/runtimeMetrics';

type CacheState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CacheDiagnostics {
    backend: 'redis' | 'memory';
    durable: boolean;
    state: CacheState;
    fallbackEntries: number;
    redisConfigured: boolean;
}

export class CacheManager {
    private redis: Redis | null = null;
    private state: CacheState = 'OPEN';
    private failureCount = 0;
    private lastFailureTime = 0;
    private fallbackMap = new Map<string, { value: string; expiresAt: number }>();
    private readonly failureThreshold = 5;
    private readonly recoveryTimeoutMs = 30000;

    constructor() {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
            return;
        }

        this.state = 'CLOSED';
        this.redis = new Redis(redisUrl, {
            retryStrategy: (times) => (times > 3 ? null : Math.min(times * 50, 2000)),
            maxRetriesPerRequest: 1,
        });

        this.redis.on('error', () => this.handleRedisError());
        this.redis.on('connect', () => this.onSuccess());
    }

    async get(key: string): Promise<string | null> {
        this.checkRecovery();
        if (this.state === 'OPEN' || !this.redis) {
            const value = this.getFromMemory(key);
            recordCacheAccess(Boolean(value));
            return value;
        }

        try {
            const result = await this.redis.get(key);
            if (result) this.onSuccess();
            const fallback = result ?? this.getFromMemory(key);
            recordCacheAccess(Boolean(fallback));
            return fallback;
        } catch {
            this.handleRedisError();
            const value = this.getFromMemory(key);
            recordCacheAccess(Boolean(value));
            return value;
        }
    }

    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
        this.checkRecovery();
        this.setToMemory(key, value, ttlSeconds);
        recordCacheFallbackWrite();

        if (this.state === 'OPEN' || !this.redis) {
            return;
        }

        try {
            await this.redis.setex(key, ttlSeconds, value);
            this.onSuccess();
        } catch {
            this.handleRedisError();
        }
    }

    diagnostics(): CacheDiagnostics {
        return {
            backend: this.redis ? 'redis' : 'memory',
            durable: Boolean(this.redis && this.state !== 'OPEN'),
            state: this.state,
            fallbackEntries: this.fallbackMap.size,
            redisConfigured: Boolean(process.env.REDIS_URL),
        };
    }

    private handleRedisError() {
        if (this.state === 'CLOSED') {
            this.failureCount++;
            if (this.failureCount >= this.failureThreshold) {
                this.state = 'OPEN';
                this.lastFailureTime = Date.now();
                console.warn('[CacheManager] Redis circuit opened. Falling back to memory cache.');
            }
        }
    }

    private onSuccess() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }

    private checkRecovery() {
        if (this.state === 'OPEN' && this.redis && Date.now() - this.lastFailureTime > this.recoveryTimeoutMs) {
            this.state = 'HALF_OPEN';
        }
    }

    private getFromMemory(key: string): string | null {
        const item = this.fallbackMap.get(key);
        if (!item) return null;
        if (Date.now() > item.expiresAt) {
            this.fallbackMap.delete(key);
            return null;
        }
        return item.value;
    }

    private setToMemory(key: string, value: string, ttlSeconds: number) {
        this.fallbackMap.set(key, {
            value,
            expiresAt: Date.now() + ttlSeconds * 1000,
        });
    }
}

export const cacheManager = new CacheManager();
