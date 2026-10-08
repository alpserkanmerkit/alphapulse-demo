import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

QUANT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUANT_ROOT))

from market_data import fetch_yfinance_history, fetch_yfinance_quote
from models.econometrics import run_arimax_garch
from models.stochastic import run_monte_carlo
from models.value import run_dcf_fama_french


def fixture_prices(length=90):
    return [100 + index * 0.35 + math.sin(index / 5) for index in range(length)]


class QuantModelFixtureTests(unittest.TestCase):
    def test_history_loader_returns_ordered_ohlcv_points(self):
        frame = pd.DataFrame(
            {
                "Open": [99.0, 100.0],
                "High": [102.0, 103.0],
                "Low": [98.0, 99.0],
                "Close": [101.0, 102.0],
                "Volume": [1000, 1200],
            },
            index=pd.to_datetime(["2026-01-02", "2026-01-03"]),
        )

        with patch("market_data._fetch_ticker_history", return_value=frame):
            points = fetch_yfinance_history("aapl", "24M")

        self.assertEqual(len(points), 2)
        self.assertEqual(points[0]["symbol"], "AAPL")
        self.assertEqual(points[0]["price"], 101.0)
        self.assertEqual(points[0]["open"], 99.0)
        self.assertEqual(points[0]["volume"], 1000)
        self.assertEqual(points[0]["interval"], "1d")

    def test_history_loader_uses_chart_fallback_when_yfinance_is_empty(self):
        chart_result = {
            "timestamp": [1767225600, 1767312000],
            "indicators": {
                "quote": [{
                    "open": [99.0, 100.0],
                    "high": [102.0, 103.0],
                    "low": [98.0, 99.0],
                    "close": [101.0, 102.0],
                    "volume": [1000, 1200],
                }]
            },
        }

        with patch("market_data._fetch_ticker_history", return_value=pd.DataFrame()), patch("market_data._request_yahoo_chart", return_value=chart_result):
            points = fetch_yfinance_history("AAPL", "12M")

        self.assertEqual(len(points), 2)
        self.assertEqual(points[-1]["close"], 102.0)

    def test_history_loader_uses_continuity_series_when_providers_fail(self):
        with patch("market_data._fetch_ticker_history_bounded", return_value=pd.DataFrame()), \
             patch("market_data._request_yahoo_chart", side_effect=TimeoutError("chart timeout")), \
             patch("market_data._request_stooq_history", side_effect=TimeoutError("stooq timeout")):
            points = fetch_yfinance_history("AAPL", "3M")

        self.assertGreaterEqual(len(points), 30)
        self.assertEqual(points[-1]["symbol"], "AAPL")
        self.assertEqual(points[-1]["source"], "ContinuitySeries")

    def test_quote_loader_uses_yahoo_chart_without_quote_summary(self):
        chart_result = {
            "meta": {
                "regularMarketPrice": 106.0,
                "chartPreviousClose": 104.0,
                "shortName": "Apple Inc.",
            },
            "timestamp": [1767225600, 1767312000],
            "indicators": {
                "quote": [{
                    "open": [102.0, 104.0],
                    "high": [105.0, 107.0],
                    "low": [101.0, 103.0],
                    "close": [104.0, 105.5],
                    "volume": [1000, 1200],
                }]
            },
        }

        with patch("market_data._request_yahoo_chart", return_value=chart_result), patch("market_data.yf.Ticker") as ticker_mock:
            quote = fetch_yfinance_quote("aapl")

        ticker_mock.assert_not_called()
        self.assertEqual(quote["symbol"], "AAPL")
        self.assertEqual(quote["name"], "Apple Inc.")
        self.assertEqual(quote["price"], 106.0)
        self.assertEqual(quote["change24h"], 2.0)
        self.assertEqual(quote["changePercent24h"], 1.92)
        self.assertEqual(quote["source"], "YahooFinance")

    def test_monte_carlo_fixture_is_deterministic_and_success_shaped(self):
        result = run_monte_carlo("FIX", days=12, simulations=64, price_series=fixture_prices(), seed=42, risk_free_rate=0.04)

        again = run_monte_carlo("FIX", days=12, simulations=64, price_series=fixture_prices(), seed=42, risk_free_rate=0.04)

        self.assertNotIn("error", result)
        self.assertEqual(result["input_observations"], 90)
        self.assertGreater(result["median_target"], 0)
        self.assertEqual(len(result["path_trajectories"]), 12)
        self.assertEqual(result["risk_free_rate"], 0.04)
        self.assertIn("model_assumptions", result)
        # The test name said "deterministic" but a second run with the same seed was not compared.
        self.assertEqual(result, again)

    def test_econometrics_fixture_returns_bands_without_network(self):
        result = run_arimax_garch("FIX", sentiment_score=0.6, days=10, price_series=fixture_prices(120))

        self.assertNotIn("error", result)
        self.assertEqual(result["input_observations"], 120)
        self.assertGreater(result["upper_band"], result["lower_band"])
        self.assertEqual(len(result["forecast_path"]), 10)
        self.assertEqual(result["sentiment_score"], 0.6)
        self.assertIn("model_assumptions", result)
        # Band half-width should be a reasonable fraction of the target (is the GARCH variance scale /10000 preserved?).
        half_width = (result["upper_band"] - result["lower_band"]) / 2
        self.assertLess(half_width, result["target_6_12_months"])

    def test_value_risk_free_rate_changes_discount_rate(self):
        fixture = {
            "currentPrice": 100,
            "sharesOutstanding": 1_000_000,
            "freeCashflow": 18_000_000,
            "revenueGrowth": 0.05,
            "beta": 1.1,
            "totalCash": 2_000_000,
            "totalDebt": 1_000_000,
            "marketCap": 1_500_000_000,
            "priceToBook": 0.9,
            "returnOnEquity": 0.2,
            "currentRatio": 2.5,
        }
        low_rfr = run_dcf_fama_french("FIX", rfr=0.02, info_fixture=fixture)
        high_rfr = run_dcf_fama_french("FIX", rfr=0.06, info_fixture=fixture)

        self.assertLess(low_rfr["wacc"], high_rfr["wacc"])
        self.assertNotEqual(low_rfr["dcf_intrinsic_value"], high_rfr["dcf_intrinsic_value"])

    def test_invalid_fixture_raises_instead_of_returning_error_payload(self):
        with self.assertRaises(ValueError):
            run_monte_carlo("FIX", price_series=[100], seed=1)


if __name__ == "__main__":
    unittest.main()
