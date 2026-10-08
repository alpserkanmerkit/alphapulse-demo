export interface ProviderPolicy {
    provider: string;
    priority: number;
    freshnessSlaMs: number;
    decisionSupportOnly: boolean;
    displayLabel: string;
}

export const MARKET_DATA_PROVIDER_POLICY: Record<string, ProviderPolicy> = {
    CoinGecko: {
        provider: 'CoinGecko',
        priority: 1,
        freshnessSlaMs: 90_000,
        decisionSupportOnly: true,
        displayLabel: 'CoinGecko market data, decision support only',
    },
    YahooFinance: {
        provider: 'YahooFinance',
        priority: 2,
        freshnessSlaMs: 15 * 60_000,
        decisionSupportOnly: true,
        displayLabel: 'Yahoo/yfinance market data, not broker-grade real-time feed',
    },
    Simulated: {
        provider: 'Simulated',
        priority: 99,
        freshnessSlaMs: 0,
        decisionSupportOnly: true,
        displayLabel: 'Simulated fallback quote, display only',
    },
};

export const SYMBOL_ALIASES: Record<string, string[]> = {
    AAPL: ['APPLE', 'APPLE INC'],
    AMZN: ['AMAZON', 'AMAZON.COM'],
    AMD: ['ADVANCED MICRO DEVICES'],
    BTC: ['BITCOIN', 'BTC-USD'],
    'BTC-USD': ['BITCOIN', 'BTC'],
    ETH: ['ETHEREUM', 'ETH-USD'],
    'ETH-USD': ['ETHEREUM', 'ETH'],
    GOOGL: ['GOOGLE', 'ALPHABET'],
    META: ['META PLATFORMS', 'FACEBOOK'],
    MSFT: ['MICROSOFT'],
    NVDA: ['NVIDIA', 'NVIDIA CORP'],
    TSLA: ['TESLA'],
};

export function providerDisplayLabel(provider: string): string {
    return MARKET_DATA_PROVIDER_POLICY[provider]?.displayLabel ?? `${provider} market data, decision support only`;
}

export function providerFreshnessStatus(provider: string, updatedAt: number): 'fresh' | 'stale' | 'unknown' {
    const policy = MARKET_DATA_PROVIDER_POLICY[provider];
    if (!policy || policy.freshnessSlaMs <= 0) return 'unknown';
    return Date.now() - updatedAt <= policy.freshnessSlaMs ? 'fresh' : 'stale';
}

function normalizeText(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9.-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenPattern(value: string): RegExp {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^A-Z0-9.-])${escaped}([^A-Z0-9.-]|$)`, 'i');
}

export function restrictedSymbolCandidates(ticker: string): string[] {
    const normalized = ticker.trim().toUpperCase();
    return Array.from(new Set([normalized, ...(SYMBOL_ALIASES[normalized] ?? [])]));
}

export function findRestrictedMatches(input: { headline?: string; tickers?: string[] }, restrictedTickers: Set<string>) {
    const explicitTickers = new Set((input.tickers ?? []).map((ticker) => ticker.trim().toUpperCase()).filter(Boolean));
    const headline = normalizeText(input.headline ?? '');
    const matches: Array<{ ticker: string; matchedBy: 'ticker' | 'headline'; alias?: string }> = [];

    for (const ticker of restrictedTickers) {
        if (explicitTickers.has(ticker)) {
            matches.push({ ticker, matchedBy: 'ticker' });
            continue;
        }

        for (const candidate of restrictedSymbolCandidates(ticker)) {
            if (candidate.length < 2) continue;
            if (tokenPattern(normalizeText(candidate)).test(headline)) {
                matches.push({ ticker, matchedBy: 'headline', alias: candidate });
                break;
            }
        }
    }

    return matches;
}
