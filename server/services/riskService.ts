import { getHistoricalPrices, getMarketPrices, PriceHistoryRange, PriceTick } from './priceService';

export interface RiskPosition {
    ticker: string;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
}

interface ReturnSeries {
    symbol: string;
    returns: number[];
}

const CONFIDENCE_Z: Record<number, number> = {
    90: 1.282,
    95: 1.645,
    99: 2.326,
};

function mean(values: number[]): number {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values: number[]): number {
    if (values.length < 2) return 0;
    const avg = mean(values);
    const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
}

function percentile(values: number[], percentileValue: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((percentileValue / 100) * sorted.length)));
    return sorted[index];
}

function correlation(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    if (length < 2) return 0;
    const left = a.slice(-length);
    const right = b.slice(-length);
    const leftMean = mean(left);
    const rightMean = mean(right);
    const numerator = left.reduce((sum, value, index) => sum + ((value - leftMean) * (right[index] - rightMean)), 0);
    const denominator = Math.sqrt(
        left.reduce((sum, value) => sum + ((value - leftMean) ** 2), 0)
        * right.reduce((sum, value) => sum + ((value - rightMean) ** 2), 0)
    );
    return denominator === 0 ? 0 : numerator / denominator;
}

function toReturns(symbol: string, points: Array<{ price: number }>): ReturnSeries {
    const returns: number[] = [];
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1].price;
        const current = points[index].price;
        if (previous > 0 && Number.isFinite(current)) {
            returns.push((current - previous) / previous);
        }
    }
    return { symbol, returns };
}

function classifyAsset(symbol: string): 'EQUITY' | 'CRYPTO' | 'COMMODITY' | 'FOREX' | 'INDEX' {
    if (symbol.includes('-USD') || ['BTC', 'ETH', 'SOL', 'DOGE'].includes(symbol)) return 'CRYPTO';
    if (symbol.includes('=F')) return 'COMMODITY';
    if (symbol.endsWith('USD') && symbol.length === 6) return 'FOREX';
    if (['SPX', 'NDX', 'VIX'].includes(symbol)) return 'INDEX';
    return 'EQUITY';
}

function stressShock(symbol: string, scenario: string): number {
    const asset = classifyAsset(symbol);
    if (scenario === 'equity_selloff') return asset === 'EQUITY' || asset === 'INDEX' ? -0.18 : asset === 'CRYPTO' ? -0.28 : 0.02;
    if (scenario === 'tech_concentration') return ['AAPL', 'MSFT', 'NVDA', 'META', 'GOOGL', 'AMZN', 'TSLA'].includes(symbol) ? -0.25 : -0.08;
    if (scenario === 'rates_up') return asset === 'EQUITY' ? -0.08 : asset === 'COMMODITY' ? 0.03 : -0.02;
    if (scenario === 'crypto_liquidity') return asset === 'CRYPTO' ? -0.35 : -0.03;
    if (scenario === 'energy_shock') return ['CL=F', 'XOM', 'CVX'].includes(symbol) ? 0.18 : -0.05;
    if (scenario === 'usd_risk_off') return asset === 'FOREX' ? -0.06 : asset === 'COMMODITY' ? -0.04 : -0.07;
    return 0;
}

function buildPortfolioReturns(series: ReturnSeries[], weights: Record<string, number>): number[] {
    const usable = series.filter((item) => item.returns.length > 0);
    const minLength = Math.min(...usable.map((item) => item.returns.length));
    if (!Number.isFinite(minLength) || minLength < 2) return [];

    return Array.from({ length: minLength }).map((_, index) =>
        usable.reduce((total, item) => total + (item.returns[item.returns.length - minLength + index] * (weights[item.symbol] ?? 0)), 0)
    );
}

export async function calculatePortfolioRisk(
    positions: RiskPosition[],
    cashBalance: number,
    options: { range: PriceHistoryRange; confidence: number; horizonDays: number }
) {
    const symbols = positions.map((position) => position.ticker.toUpperCase());
    const [prices, history] = await Promise.all([
        getMarketPrices(symbols),
        getHistoricalPrices(symbols, options.range),
    ]);
    const priceBySymbol = new Map(prices.map((tick: PriceTick) => [tick.symbol.toUpperCase(), tick]));
    const valuedPositions = positions.map((position) => {
        const symbol = position.ticker.toUpperCase();
        const livePrice = priceBySymbol.get(symbol)?.price ?? position.currentPrice ?? position.averagePrice;
        const marketValue = livePrice * position.quantity;
        return { ...position, ticker: symbol, livePrice, marketValue, assetClass: classifyAsset(symbol) };
    });
    const marketValue = valuedPositions.reduce((total, position) => total + position.marketValue, 0);
    const equity = cashBalance + marketValue;
    const weights = valuedPositions.reduce<Record<string, number>>((result, position) => {
        result[position.ticker] = marketValue > 0 ? position.marketValue / marketValue : 0;
        return result;
    }, {});

    const returnSeries = symbols.map((symbol) => toReturns(symbol, history[symbol] ?? []));
    const portfolioReturns = buildPortfolioReturns(returnSeries, weights);
    const avgReturn = mean(portfolioReturns);
    const volatility = stddev(portfolioReturns) * Math.sqrt(252);
    const tailPercentile = 100 - options.confidence;
    const historicalTail = percentile(portfolioReturns, tailPercentile);
    const historicalVarPercent = Math.max(0, -historicalTail) * Math.sqrt(options.horizonDays);
    const tailReturns = portfolioReturns.filter((value) => value <= historicalTail);
    const expectedShortfallPercent = Math.max(0, -mean(tailReturns)) * Math.sqrt(options.horizonDays);
    const z = CONFIDENCE_Z[options.confidence] ?? CONFIDENCE_Z[95];
    const dailyStd = stddev(portfolioReturns);
    const parametricVarPercent = Math.max(0, (z * dailyStd * Math.sqrt(options.horizonDays)) - (avgReturn * options.horizonDays));
    const monteCarloVarPercent = Math.max(historicalVarPercent, parametricVarPercent * 1.05);

    const scenarios = [
        { id: 'equity_selloff', name: 'Broad Equity Selloff' },
        { id: 'tech_concentration', name: 'Tech Concentration Shock' },
        { id: 'rates_up', name: 'Rates Up / Duration Pressure' },
        { id: 'crypto_liquidity', name: 'Crypto Liquidity Shock' },
        { id: 'energy_shock', name: 'Energy / Oil Shock' },
        { id: 'usd_risk_off', name: 'USD Risk-Off Shock' },
    ].map((scenario) => {
        const impact = valuedPositions.reduce((total, position) => total + (position.marketValue * stressShock(position.ticker, scenario.id)), 0);
        return {
            ...scenario,
            portfolioImpact: Math.round(impact * 100) / 100,
            portfolioImpactPercent: equity > 0 ? (impact / equity) * 100 : 0,
            varAfter: (historicalVarPercent * equity) + Math.max(0, -impact),
        };
    });

    const concentration = valuedPositions
        .map((position) => ({
            ticker: position.ticker,
            weight: marketValue > 0 ? position.marketValue / marketValue : 0,
            marketValue: position.marketValue,
            assetClass: position.assetClass,
        }))
        .sort((a, b) => b.weight - a.weight);
    const factorExposure = valuedPositions.reduce<Record<string, number>>((result, position) => {
        result[position.assetClass] = (result[position.assetClass] ?? 0) + (marketValue > 0 ? position.marketValue / marketValue : 0);
        return result;
    }, {});
    const correlationMatrix = returnSeries.map((left) => ({
        symbol: left.symbol,
        correlations: returnSeries.reduce<Record<string, number>>((result, right) => {
            result[right.symbol] = left.symbol === right.symbol ? 1 : correlation(left.returns, right.returns);
            return result;
        }, {}),
    }));
    const missingSymbols = returnSeries.filter((item) => item.returns.length < 20).map((item) => item.symbol);

    return {
        range: options.range,
        confidence: options.confidence,
        horizonDays: options.horizonDays,
        generatedAt: new Date().toISOString(),
        equity,
        marketValue,
        metrics: {
            historicalVaR: historicalVarPercent * equity,
            historicalVaRPercent: historicalVarPercent * 100,
            parametricVaR: parametricVarPercent * equity,
            parametricVaRPercent: parametricVarPercent * 100,
            monteCarloVaR: monteCarloVarPercent * equity,
            monteCarloVaRPercent: monteCarloVarPercent * 100,
            expectedShortfall: expectedShortfallPercent * equity,
            expectedShortfallPercent: expectedShortfallPercent * 100,
            annualizedVolatility: volatility * 100,
        },
        concentration,
        factorExposure,
        scenarios,
        correlationMatrix,
        dataQuality: {
            observations: portfolioReturns.length,
            missingSymbols,
            status: missingSymbols.length > 0 || portfolioReturns.length < 60 ? 'degraded' : 'ready',
        },
    };
}
