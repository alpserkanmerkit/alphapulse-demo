export interface QuantModelGovernance {
    horizon: 'short-term' | 'medium-term' | 'long-term';
    modelFamily: string;
    inputWindow: string;
    assumptions: string[];
    limitations: string[];
    providerPolicy: string;
    validationStatus: 'heuristic_baseline' | 'engine_reported';
}

const GOVERNANCE_BY_HORIZON: Record<QuantModelGovernance['horizon'], QuantModelGovernance> = {
    'short-term': {
        horizon: 'short-term',
        modelFamily: 'Monte Carlo GBM / VaR / Kelly',
        inputWindow: 'Recent market history from the quant data bridge when available.',
        assumptions: ['Returns are approximated from observed price history.', 'Kelly sizing uses annualized excess return over the supplied risk-free rate.', 'Volatility is treated as a decision-support estimate, not a guarantee.'],
        limitations: ['Not broker-grade real-time data.', 'Fallback output is heuristic and must not be treated as a validated model run.'],
        providerPolicy: 'YahooFinance/yfinance bridge is acceptable for decision support with explicit freshness and fallback labeling.',
        validationStatus: 'engine_reported',
    },
    'medium-term': {
        horizon: 'medium-term',
        modelFamily: 'ARIMAX / GARCH / regime heuristic',
        inputWindow: 'Medium-window market history plus optional sentiment score.',
        assumptions: ['Historical volatility and sentiment are proxies for medium-term risk.', 'Regime labels are explanatory diagnostics.'],
        limitations: ['Model fit can degrade in sparse or discontinuous market data.', 'No production backtest ledger is attached yet.'],
        providerPolicy: 'YahooFinance/yfinance bridge is treated as a provider adapter, not a permanent SLA boundary.',
        validationStatus: 'engine_reported',
    },
    'long-term': {
        horizon: 'long-term',
        modelFamily: 'DCF / Fama-French proxy premium',
        inputWindow: 'Long-horizon valuation assumptions plus available market context.',
        assumptions: ['Risk-free rate and factor premium are scenario inputs.', 'Target bands are valuation support, not advice.'],
        limitations: ['DCF assumptions are sensitive to terminal inputs.', 'Factor premium is a proxy until a durable validation fixture exists.'],
        providerPolicy: 'Inputs must remain labeled as live, fallback, or simulated in downstream responses.',
        validationStatus: 'engine_reported',
    },
};

export function getQuantModelGovernance(
    horizon: QuantModelGovernance['horizon'],
    isFallback: boolean
): QuantModelGovernance {
    return {
        ...GOVERNANCE_BY_HORIZON[horizon],
        validationStatus: isFallback ? 'heuristic_baseline' : GOVERNANCE_BY_HORIZON[horizon].validationStatus,
    };
}
