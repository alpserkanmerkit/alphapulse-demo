import warnings

import numpy as np
import pandas as pd
from arch import arch_model
from statsmodels.tsa.arima.model import ARIMA

from market_data import load_close_series

warnings.filterwarnings("ignore")

def _close_series_from_prices(prices):
    series = pd.Series(prices, dtype="float64").dropna()
    if series.empty or len(series) < 30:
        raise ValueError("At least 30 price observations are required")
    return series

def run_arimax_garch(ticker: str, sentiment_score: float = 0.5, days: int = 180, price_series=None):
    # Fetch 2 years of daily data for better GARCH and regime diagnostics unless
    # a deterministic fixture series is supplied by tests.
    if price_series is None:
        prices = load_close_series(ticker, "24M")
    else:
        prices = _close_series_from_prices(price_series)

    returns = prices.pct_change().dropna()
    if returns.empty:
        raise ValueError(f"Insufficient return data for {ticker}")

    last_price = float(prices.iloc[-1])

    model_warnings = []
    try:
        # 1. ARIMAX(1,1,1) with Sentiment as an exogenous proxy.
        sentiment_array = np.full(len(prices), sentiment_score)
        arima_model = ARIMA(prices.values, order=(1,1,1), exog=sentiment_array)
        arima_fit = arima_model.fit()
        arima_forecast = arima_fit.forecast(steps=days, exog=np.full(days, sentiment_score))
    except Exception as error:
        drift = returns.tail(60).mean() + ((sentiment_score - 0.5) * 0.0008)
        arima_forecast = np.array([last_price * ((1 + drift) ** step) for step in range(1, days + 1)])
        model_warnings.append(f"ARIMAX fit unavailable; used rolling drift projection ({error}).")

    try:
        # 2. GARCH(1,1) for Volatility Forecasting.
        scaled_returns = returns.values * 100
        am = arch_model(scaled_returns, vol='Garch', p=1, q=1, rescale=False)
        res = am.fit(disp='off')

        garch_forecast = res.forecast(horizon=days)
        projected_variance = garch_forecast.variance.values[-1, :] / 10000
        projected_volatility = np.sqrt(projected_variance)
    except Exception as error:
        rolling_vol = float(returns.tail(60).std() or returns.std() or 0.015)
        projected_volatility = np.full(days, max(rolling_vol, 0.005))
        model_warnings.append(f"GARCH fit unavailable; used rolling volatility bands ({error}).")

    target_med = float(arima_forecast[-1])
    sentiment_drift = (sentiment_score - 0.5) * 0.1 * target_med
    target_med += sentiment_drift

    vol_impact = float(projected_volatility[-1] * np.sqrt(252) * target_med)

    current_vol = returns.rolling(20).std().iloc[-1]
    hist_vol = returns.std()
    regime_label = "Crisis/High Volatility" if current_vol > hist_vol * 1.5 else "Stable/Low Volatility"

    result = {
        "current_price": round(last_price, 2),
        "target_6_12_months": round(target_med, 2),
        "upper_band": round(target_med + vol_impact, 2),
        "lower_band": round(target_med - vol_impact, 2),
        "market_regime": regime_label,
        "forecast_path": [round(float(p), 2) for p in arima_forecast[:10].tolist()],
        "input_observations": int(len(prices)),
        "sentiment_score": round(float(sentiment_score), 4),
        "model_assumptions": [
            "ARIMA uses sentiment as a constant exogenous proxy for the requested horizon.",
            "GARCH volatility bands are explanatory decision-support estimates.",
            "Regime labels are heuristic diagnostics, not a certified Hidden Markov Model.",
        ],
    }
    if model_warnings:
        result["warning"] = " ".join(model_warnings)
        result["model_assumptions"].append("Model continuity safeguards were applied because a provider or model fit path degraded.")
    return result
