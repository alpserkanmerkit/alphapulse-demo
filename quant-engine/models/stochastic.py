import numpy as np
import pandas as pd

from market_data import load_close_series


def _close_series_from_prices(prices):
    series = pd.Series(prices, dtype="float64").dropna()
    if series.empty or len(series) < 3:
        raise ValueError("At least 3 price observations are required")
    return series

def run_monte_carlo(ticker: str, days: int = 90, simulations: int = 1000, price_series=None, seed=None, risk_free_rate: float = 0.04):
    # Fetch 1 year of daily returns to calculate mu and sigma unless a fixture
    # series is supplied by deterministic tests.
    if price_series is None:
        prices = load_close_series(ticker, "12M")
    else:
        prices = _close_series_from_prices(price_series)

    returns = prices.pct_change().dropna()
    mu = returns.mean()
    sigma = returns.std()
    if not np.isfinite(mu) or not np.isfinite(sigma) or sigma <= 0:
        raise ValueError(f"Insufficient volatility data for {ticker}")

    last_price = float(prices.iloc[-1])
    rng = np.random.default_rng(seed)

    # GBM Formula: S_t = S_{t-1} * exp((mu - 0.5 * sigma^2) + sigma * Z)
    simulated_paths = np.zeros((days, simulations))
    simulated_paths[0] = last_price

    for t in range(1, days):
        Z = rng.standard_normal(simulations)
        simulated_paths[t] = simulated_paths[t-1] * np.exp((mu - 0.5 * sigma**2) + sigma * Z)

    ending_prices = simulated_paths[-1]
    var_95 = np.percentile(ending_prices, 5)
    expected_return = (np.mean(ending_prices) - last_price) / last_price
    annualized_expected_return = expected_return * (252 / max(days, 1))
    excess_return = annualized_expected_return - risk_free_rate
    kelly_fraction = excess_return / (sigma**2 * 252) if sigma > 0 else 0
    kelly_fraction = max(0.0, min(1.0, kelly_fraction))

    return {
        "current_price": round(last_price, 2),
        "median_target": round(float(np.median(ending_prices)), 2),
        "upper_target_10pct": round(float(np.percentile(ending_prices, 90)), 2),
        "lower_target_10pct": round(float(np.percentile(ending_prices, 10)), 2),
        "var_95": round(float(var_95), 2),
        "recommended_kelly_bet": round(float(kelly_fraction), 4),
        "annualized_expected_return": round(float(annualized_expected_return), 4),
        "risk_free_rate": round(float(risk_free_rate), 4),
        "path_trajectories": simulated_paths[:, :5].tolist(),
        "input_observations": int(len(prices)),
        "model_assumptions": [
            "Daily returns are modeled with a GBM approximation.",
            "Kelly sizing uses annualized excess return over the supplied risk-free rate.",
            "Output is decision support only and not an execution instruction.",
        ],
    }
