export interface QuantFallbackResponse {
    success: true;
    isFallback: true;
    confidence: 0;
    uncertainty: 'EXTREME';
    data: Record<string, unknown>;
}

const FALLBACK_BASE_PRICES: Record<string, number> = {
    AAPL: 189.5,
    TSLA: 248.2,
    NVDA: 875.3,
    MSFT: 412.1,
    AMZN: 198.5,
    META: 545,
    GOOGL: 178.7,
    JPM: 198.7,
    SPX: 5780,
    NDX: 20150,
    VIX: 18.5,
    'GC=F': 2340,
    'CL=F': 78.4,
    EURUSD: 1.092,
    GBPUSD: 1.265,
};

function hashSeed(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function seededRandom(seed: number) {
    let state = seed || 1;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function resolveBasePrice(ticker: string, currentPrice?: number): number {
    if (Number.isFinite(currentPrice) && currentPrice && currentPrice > 0) {
        return currentPrice;
    }
    return FALLBACK_BASE_PRICES[ticker.toUpperCase()] ?? 100;
}

export function generateQuantFallback(horizon: string, ticker: string, currentPrice?: number): QuantFallbackResponse {
    const normalizedTicker = ticker.toUpperCase();
    const basePrice = resolveBasePrice(normalizedTicker, currentPrice);
    const rand = seededRandom(hashSeed(`${normalizedTicker}:${horizon}:${basePrice}`));
    const generatePath = (days: number, volatility: number, drift: number) => {
        let price = basePrice;
        const path = [Number(price.toFixed(2))];
        for (let i = 1; i < days; i++) {
            const cycle = Math.sin(i / 11) * volatility * 0.18;
            const shock = (rand() - 0.5) * volatility;
            price += price * (drift + cycle + shock);
            path.push(Number(price.toFixed(2)));
        }
        return path;
    };

    let data: Record<string, unknown> = {
        ticker: normalizedTicker,
        current_price: basePrice,
        model_source: 'fallback',
        is_fallback: true,
        model_assumptions: [
            'Live quant engine was unavailable; deterministic fallback path is used for continuity.',
            'Fallback output is decision support only and must not be treated as broker-grade market data.',
        ],
    };

    if (horizon === 'short-term') {
        const path = generatePath(90, 0.018, 0.00035);
        const endPrice = path[path.length - 1];
        data = {
            ...data,
            path_trajectories: path,
            forecast_path: path,
            median_target: endPrice,
            upper_target_10pct: Number((endPrice * 1.08).toFixed(2)),
            lower_target_10pct: Number((endPrice * 0.92).toFixed(2)),
            var_95: Number((basePrice * 0.05).toFixed(2)),
            recommended_kelly_bet: 0,
        };
    } else if (horizon === 'medium-term') {
        const path = generatePath(180, 0.012, 0.00018);
        const endPrice = path[path.length - 1];
        data = {
            ...data,
            forecast_path: path,
            target_6_12_months: endPrice,
            upper_band: Number((endPrice * 1.1).toFixed(2)),
            lower_band: Number((endPrice * 0.9).toFixed(2)),
        };
    } else {
        const path = generatePath(365 * 3, 0.006, 0.00012);
        const endPrice = path[path.length - 1];
        data = {
            ...data,
            forecast_path: path,
            target_12_36_months: endPrice,
            dcf_intrinsic_value: endPrice,
            upper_band: Number((endPrice * 1.18).toFixed(2)),
            lower_band: Number((endPrice * 0.84).toFixed(2)),
            fama_french_premium: 0.06,
        };
    }

    return {
        success: true,
        isFallback: true,
        confidence: 0,
        uncertainty: 'EXTREME',
        data,
    };
}
