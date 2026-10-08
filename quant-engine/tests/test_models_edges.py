"""Edge/invariant tests for models/*. No network, fixed seed, fixture series.

Numeric "golden" values are computed by hand (steps are in the comments); they do not
re-implement the code's own formula.
"""
import math
import sys
import unittest
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd

QUANT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUANT_ROOT))

from models import econometrics, stochastic, value  # noqa: E402


def zigzag_prices(steps=60, up=0.03, down=-0.028, start=100.0):
    prices = [start]
    for step in range(steps):
        prices.append(prices[-1] * (1 + (up if step % 2 == 0 else down)))
    return prices


def smooth_prices(length=90):
    return [100 + index * 0.35 + math.sin(index / 5) for index in range(length)]


class MonteCarloInvariantTests(unittest.TestCase):
    def run_mc(self, **overrides):
        kwargs = dict(days=20, simulations=200, price_series=zigzag_prices(), seed=3, risk_free_rate=0.04)
        kwargs.update(overrides)
        return stochastic.run_monte_carlo("FIX", **kwargs)

    def test_same_seed_same_result_different_seed_different_paths(self):
        self.assertEqual(self.run_mc(), self.run_mc())
        self.assertNotEqual(self.run_mc()["path_trajectories"], self.run_mc(seed=4)["path_trajectories"])

    def test_percentiles_are_ordered_and_first_path_row_is_last_price(self):
        result = self.run_mc()
        self.assertLessEqual(result["var_95"], result["lower_target_10pct"])
        self.assertLessEqual(result["lower_target_10pct"], result["median_target"])
        self.assertLessEqual(result["median_target"], result["upper_target_10pct"])
        self.assertEqual(len(result["path_trajectories"]), 20)
        self.assertEqual(len(result["path_trajectories"][0]), 5)
        for first_row_price in result["path_trajectories"][0]:
            self.assertAlmostEqual(first_row_price, result["current_price"], delta=0.005)

    def test_single_day_horizon_collapses_to_last_price(self):
        result = self.run_mc(days=1)
        last = round(zigzag_prices()[-1], 2)
        for key in ("median_target", "var_95", "lower_target_10pct", "upper_target_10pct"):
            self.assertEqual(result[key], last)
        self.assertEqual(result["annualized_expected_return"], 0.0)

    def test_kelly_difference_equals_rate_difference_over_annualized_variance(self):
        # Kelly = (annualized_return - rfr) / (sigma^2 * 252), linear while within range.
        sigma = pd.Series(zigzag_prices()).pct_change().std()
        low = self.run_mc(risk_free_rate=0.15)
        high = self.run_mc(risk_free_rate=0.20)

        self.assertTrue(0.0 < high["recommended_kelly_bet"] < low["recommended_kelly_bet"] < 1.0)
        expected_gap = (0.20 - 0.15) / (sigma**2 * 252)
        self.assertAlmostEqual(low["recommended_kelly_bet"] - high["recommended_kelly_bet"], expected_gap, delta=2e-3)

    def test_kelly_is_clamped_to_zero_and_one(self):
        self.assertEqual(self.run_mc(risk_free_rate=1.0)["recommended_kelly_bet"], 0.0)
        self.assertEqual(self.run_mc(risk_free_rate=0.0)["recommended_kelly_bet"], 1.0)

    def test_flat_series_raises_insufficient_volatility(self):
        with self.assertRaisesRegex(ValueError, "volatility"):
            stochastic.run_monte_carlo("FIX", price_series=[100.0] * 10, seed=1)

    def test_nan_prices_are_dropped_before_counting_observations(self):
        result = self.run_mc(price_series=[float("nan")] + zigzag_prices(5), days=3)
        self.assertEqual(result["input_observations"], 6)

    def test_two_observations_are_rejected_three_are_enough(self):
        with self.assertRaisesRegex(ValueError, "At least 3"):
            stochastic.run_monte_carlo("FIX", price_series=[100.0, 101.0], seed=1)
        self.assertEqual(self.run_mc(price_series=[100.0, 103.0, 100.0], days=2)["input_observations"], 3)

    def test_without_fixture_prices_are_loaded_for_twelve_months(self):
        with patch("models.stochastic.load_close_series", return_value=pd.Series(zigzag_prices())) as loader:
            stochastic.run_monte_carlo("AAPL", days=3, simulations=10, seed=1)
        loader.assert_called_once_with("AAPL", "12M")


class EconometricsEdgeTests(unittest.TestCase):
    def failing_models(self):
        """Forces ARIMA and GARCH fits to fail => fast, deterministic fallback paths."""
        return patch("models.econometrics.ARIMA", side_effect=RuntimeError("arima")), patch(
            "models.econometrics.arch_model", side_effect=RuntimeError("garch")
        )

    def test_fewer_than_thirty_observations_raise(self):
        with self.assertRaisesRegex(ValueError, "At least 30"):
            econometrics.run_arimax_garch("FIX", price_series=smooth_prices(29))
        # NaNs are not counted
        with self.assertRaisesRegex(ValueError, "At least 30"):
            econometrics.run_arimax_garch("FIX", price_series=[float("nan")] * 40)

    def test_exactly_thirty_observations_are_accepted(self):
        arima, garch = self.failing_models()
        with arima, garch:
            result = econometrics.run_arimax_garch("FIX", days=3, price_series=smooth_prices(30))
        self.assertEqual(result["input_observations"], 30)

    def test_both_model_failures_use_rolling_fallbacks_and_report_warnings(self):
        prices = smooth_prices(90)
        arima, garch = self.failing_models()
        with arima, garch:
            result = econometrics.run_arimax_garch("FIX", sentiment_score=0.5, days=10, price_series=prices)

        returns = pd.Series(prices).pct_change().dropna()
        drift = returns.tail(60).mean()
        expected_target = prices[-1] * (1 + drift) ** 10
        expected_vol = max(returns.tail(60).std(), 0.005)
        expected_impact = expected_vol * math.sqrt(252) * expected_target

        self.assertAlmostEqual(result["target_6_12_months"], expected_target, delta=0.006)
        self.assertAlmostEqual(result["upper_band"], expected_target + expected_impact, delta=0.01)
        self.assertAlmostEqual(result["lower_band"], expected_target - expected_impact, delta=0.01)
        self.assertIn("ARIMAX fit unavailable", result["warning"])
        self.assertIn("GARCH fit unavailable", result["warning"])
        self.assertEqual(len(result["model_assumptions"]), 4)
        self.assertEqual(len(result["forecast_path"]), 10)

    def test_clean_run_has_no_warning_key(self):
        arima = MagicMock()
        arima.return_value.fit.return_value.forecast.return_value = np.full(5, 200.0)
        with patch("models.econometrics.ARIMA", arima), patch("models.econometrics.arch_model", side_effect=RuntimeError("garch")):
            degraded = econometrics.run_arimax_garch("FIX", days=5, price_series=smooth_prices(60))
        self.assertNotIn("ARIMAX", degraded["warning"])
        self.assertIn("GARCH fit unavailable", degraded["warning"])

    def test_sentiment_shifts_target_by_ten_percent_of_deviation_from_neutral(self):
        arima = MagicMock()
        arima.return_value.fit.return_value.forecast.return_value = np.full(5, 200.0)
        with patch("models.econometrics.ARIMA", arima), patch("models.econometrics.arch_model", side_effect=RuntimeError("g")):
            neutral = econometrics.run_arimax_garch("FIX", sentiment_score=0.5, days=5, price_series=smooth_prices(60))
            bullish = econometrics.run_arimax_garch("FIX", sentiment_score=0.7, days=5, price_series=smooth_prices(60))
        # 200 * (1 + (0.7 - 0.5) * 0.1) = 204
        self.assertEqual(neutral["target_6_12_months"], 200.0)
        self.assertEqual(bullish["target_6_12_months"], 204.0)
        self.assertEqual(bullish["sentiment_score"], 0.7)
        self.assertEqual(len(bullish["forecast_path"]), 5)

    def test_regime_label_flags_recent_volatility_burst(self):
        arima, garch = self.failing_models()
        calm = zigzag_prices(100, up=0.001, down=-0.001)
        stressed = zigzag_prices(80, up=0.001, down=-0.001)
        for step in range(20):
            stressed.append(stressed[-1] * (1.08 if step % 2 == 0 else 0.92))
        with arima, garch:
            self.assertEqual(econometrics.run_arimax_garch("FIX", days=3, price_series=calm)["market_regime"], "Stable/Low Volatility")
            self.assertEqual(econometrics.run_arimax_garch("FIX", days=3, price_series=stressed)["market_regime"], "Crisis/High Volatility")

    def test_without_fixture_prices_are_loaded_for_24_months(self):
        arima, garch = self.failing_models()
        with arima, garch, patch("models.econometrics.load_close_series", return_value=pd.Series(smooth_prices(40))) as loader:
            econometrics.run_arimax_garch("AAPL", days=3)
        loader.assert_called_once_with("AAPL", "24M")

    def test_single_price_from_provider_raises_insufficient_return_data(self):
        with patch("models.econometrics.load_close_series", return_value=pd.Series([100.0])):
            with self.assertRaisesRegex(ValueError, "Insufficient return data"):
                econometrics.run_arimax_garch("AAPL")


class ValueModelTests(unittest.TestCase):
    BASE = {
        "currentPrice": 100,
        "sharesOutstanding": 10,
        "freeCashflow": 100,
        "revenueGrowth": 0.05,
        "beta": 1.0,
        "totalCash": 50,
        "totalDebt": 20,
        "marketCap": 5e9,
        "priceToBook": 2.0,
        "returnOnEquity": 0.10,
        "currentRatio": 1.5,
    }

    def test_golden_dcf_value_hand_computed(self):
        # wacc = 0.04 + 1.0 * 0.055 = 0.095 ; terminal_growth = max(0.01, min(0.03, 0.03)) = 0.03
        # FCF1..3 = 105, 110.25, 115.7625 ; TV = 115.7625 * 1.03 / (0.095 - 0.03) = 1834.39
        # PV(FCF) = 105/1.095 + 110.25/1.095^2 + 115.7625/1.095^3 = 275.98 ; PV(TV) = 1834.39/1.095^3 = 1397.20
        # EV = 1673.18 ; equity = EV + 50 - 20 = 1703.18 ; per share (10 shares) = 170.32
        result = value.run_dcf_fama_french("FIX", rfr=0.04, info_fixture=dict(self.BASE))

        self.assertEqual(result["wacc"], 0.095)
        self.assertEqual(result["terminal_growth"], 0.03)
        self.assertEqual(result["dcf_intrinsic_value"], 170.32)
        self.assertEqual(result["fama_french_premium"], 0.0)
        self.assertEqual(result["target_12_36_months"], 170.32)
        self.assertAlmostEqual(result["upper_band"], 170.32 * 1.05, delta=0.01)
        self.assertAlmostEqual(result["lower_band"], 170.32 * 0.95, delta=0.01)
        self.assertEqual(result["current_price"], 100)

    def test_each_factor_premium_adds_its_own_increment(self):
        cases = [
            ("marketCap", 1e9, 0.02),
            ("priceToBook", 0.9, 0.015),
            ("returnOnEquity", 0.2, 0.01),
            ("currentRatio", 2.5, 0.005),
        ]
        for key, new_value, premium in cases:
            with self.subTest(key=key):
                info = dict(self.BASE, **{key: new_value})
                self.assertEqual(value.run_dcf_fama_french("FIX", info_fixture=info)["fama_french_premium"], premium)

    def test_factor_thresholds_are_strict(self):
        info = dict(self.BASE, marketCap=2e9, priceToBook=1.0, returnOnEquity=0.15, currentRatio=2.0)
        self.assertEqual(value.run_dcf_fama_french("FIX", info_fixture=info)["fama_french_premium"], 0.0)

    def test_all_premiums_stack_to_five_percent(self):
        info = dict(self.BASE, marketCap=1e9, priceToBook=0.9, returnOnEquity=0.2, currentRatio=2.5)
        self.assertEqual(value.run_dcf_fama_french("FIX", info_fixture=info)["fama_french_premium"], 0.05)

    def test_target_is_capped_at_four_times_and_floored_at_half_the_price(self):
        high = value.run_dcf_fama_french("FIX", info_fixture=dict(self.BASE, freeCashflow=1e9))
        low = value.run_dcf_fama_french("FIX", info_fixture=dict(self.BASE, freeCashflow=1e-3))
        self.assertEqual(high["target_12_36_months"], 400.0)
        self.assertEqual(low["target_12_36_months"], 50.0)
        # The DCF value is not clamped; only the target is clamped.
        self.assertGreater(high["dcf_intrinsic_value"], 400.0)

    def test_missing_cashflow_or_shares_uses_proxy_growth(self):
        for key in ("freeCashflow", "sharesOutstanding"):
            with self.subTest(missing=key):
                result = value.run_dcf_fama_french("FIX", rfr=0.05, info_fixture=dict(self.BASE, **{key: 0}))
                self.assertEqual(result["target_12_36_months"], 133.1)  # 100 * 1.1^3
                self.assertAlmostEqual(result["upper_band"], 133.1 * 1.05, delta=0.01)
                self.assertAlmostEqual(result["lower_band"], 133.1 * 0.95, delta=0.01)
                self.assertIsNone(result["wacc"])
                self.assertEqual(result["risk_free_rate"], 0.05)
                self.assertIn("Insufficient financial data", result["warning"])

    def test_provider_warning_replaces_proxy_warning_and_adds_assumption(self):
        with patch("models.value._load_info_bounded", return_value=({}, "provider down")):
            result = value.run_dcf_fama_french("FIX", price_fixture=[90.0, 100.0])
        self.assertEqual(result["current_price"], 100.0)
        self.assertEqual(result["warning"], "provider down")
        self.assertEqual(len(result["model_assumptions"]), 3)

    def test_regular_market_price_is_used_when_current_price_missing(self):
        info = {"regularMarketPrice": 80.0}
        self.assertEqual(value.run_dcf_fama_french("FIX", info_fixture=info)["current_price"], 80.0)

    def test_non_positive_price_raises(self):
        with self.assertRaisesRegex(ValueError, "Could not retrieve price"):
            value.run_dcf_fama_french("FIX", info_fixture={}, price_fixture=[0.0])

    def test_latest_price_uses_fixture_else_five_day_close_series(self):
        self.assertEqual(value._safe_latest_price("FIX", [1.0, 2.5]), 2.5)
        with patch("models.value.load_close_series", return_value=pd.Series([7.0, 8.0])) as loader:
            self.assertEqual(value._safe_latest_price("AAPL"), 8.0)
        loader.assert_called_once_with("AAPL", "5d")


class _FakeExecutor:
    """Replaces ThreadPoolExecutor; result() behavior is set from outside."""

    outcome = None

    def __init__(self, max_workers=1):
        pass

    def submit(self, fn):
        outcome = type(self).outcome

        class _Future:
            def result(self, timeout=None):
                if isinstance(outcome, BaseException):
                    raise outcome
                return fn()

        return _Future()

    def shutdown(self, wait=True, cancel_futures=False):
        pass


class LoadInfoBoundedTests(unittest.TestCase):
    def setUp(self):
        _FakeExecutor.outcome = None

    def test_returns_info_dict_without_warning(self):
        ticker = MagicMock()
        ticker.info = {"currentPrice": 5}
        with patch("models.value.ThreadPoolExecutor", _FakeExecutor), patch("models.value.yf.Ticker", return_value=ticker):
            self.assertEqual(value._load_info_bounded("AAPL"), ({"currentPrice": 5}, None))

    def test_none_info_becomes_empty_dict(self):
        ticker = MagicMock()
        ticker.info = None
        with patch("models.value.ThreadPoolExecutor", _FakeExecutor), patch("models.value.yf.Ticker", return_value=ticker):
            self.assertEqual(value._load_info_bounded("AAPL"), ({}, None))

    def test_timeout_returns_empty_info_and_timeout_warning(self):
        _FakeExecutor.outcome = FutureTimeoutError()
        with patch("models.value.ThreadPoolExecutor", _FakeExecutor):
            info, warning = value._load_info_bounded("AAPL")
        self.assertEqual(info, {})
        self.assertIn("timed out after 4s", warning)

    def test_provider_exception_returns_unavailable_warning_with_cause(self):
        _FakeExecutor.outcome = RuntimeError("401 crumb")
        with patch("models.value.ThreadPoolExecutor", _FakeExecutor):
            info, warning = value._load_info_bounded("AAPL")
        self.assertEqual(info, {})
        self.assertIn("unavailable", warning)
        self.assertIn("401 crumb", warning)


if __name__ == "__main__":
    unittest.main()
