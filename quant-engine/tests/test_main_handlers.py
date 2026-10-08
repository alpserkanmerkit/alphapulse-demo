"""main.py: FastAPI handler functions are tested by calling them directly (small, no network).

The routing/validation layer (TestClient) needs httpx; since it is not in requirements.txt,
that test is skipped when httpx is missing.
"""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

QUANT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUANT_ROOT))

from fastapi import HTTPException  # noqa: E402

import main  # noqa: E402


class BuildForecastResponseTests(unittest.TestCase):
    def test_error_payload_raises_value_error(self):
        with self.assertRaisesRegex(ValueError, "boom"):
            main.build_forecast_response("h", "fam", {"error": "boom"}, "win")

    def test_success_envelope_maps_result_fields(self):
        result = {"input_observations": 7, "model_assumptions": ["a"], "risk_free_rate": 0.05}
        response = main.build_forecast_response("3-6 months", "fam", result, "win")

        self.assertEqual(response["status"], "success")
        self.assertEqual(response["horizon"], "3-6 months")
        self.assertIs(response["data"], result)
        self.assertEqual(response["metadata"]["dataQuality"]["observations"], 7)
        governance = response["metadata"]["modelGovernance"]
        self.assertEqual(governance["modelFamily"], "fam")
        self.assertEqual(governance["inputWindow"], "win")
        self.assertEqual(governance["assumptions"], ["a"])
        self.assertEqual(governance["riskFreeRate"], 0.05)

    def test_missing_optional_result_fields_use_safe_defaults(self):
        response = main.build_forecast_response("h", "fam", {}, "win")
        self.assertEqual(response["metadata"]["dataQuality"]["observations"], 0)
        self.assertEqual(response["metadata"]["modelGovernance"]["assumptions"], [])
        self.assertIsNone(response["metadata"]["modelGovernance"]["riskFreeRate"])


class RequestModelTests(unittest.TestCase):
    def test_analyze_request_defaults(self):
        request = main.AnalyzeRequest(ticker="AAPL")
        self.assertEqual(request.sentiment_score, 0.5)
        self.assertEqual(request.risk_free_rate, 0.04)
        self.assertIsNone(request.current_price)

    def test_history_request_default_range(self):
        self.assertEqual(main.HistoryRequest(symbols=["A"]).range, "24M")


class HealthTests(unittest.TestCase):
    def test_health_payload(self):
        self.assertEqual(main.health(), {"status": "ok", "service": "quant-engine"})


class MarketQuotesTests(unittest.TestCase):
    def test_symbols_are_stripped_uppercased_deduplicated_and_blanks_dropped(self):
        with patch("main.fetch_yfinance_quote", side_effect=lambda symbol: {"symbol": symbol}) as fetch:
            response = main.market_quotes(main.QuoteRequest(symbols=[" aapl", "AAPL", "", "  ", "msft"]))

        self.assertEqual([call.args[0] for call in fetch.call_args_list], ["AAPL", "MSFT"])
        self.assertEqual(response["quotes"], [{"symbol": "AAPL"}, {"symbol": "MSFT"}])
        self.assertEqual(response["errors"], {})
        self.assertEqual(response["status"], "success")

    def test_per_symbol_failure_is_reported_without_failing_the_batch(self):
        def fake(symbol):
            if symbol == "BAD":
                raise ValueError("no data")
            return {"symbol": symbol}

        with patch("main.fetch_yfinance_quote", side_effect=fake):
            response = main.market_quotes(main.QuoteRequest(symbols=["ok", "bad"]))

        self.assertEqual(response["quotes"], [{"symbol": "OK"}])
        self.assertEqual(response["errors"], {"BAD": "no data"})

    def test_at_most_thirty_symbols_are_fetched(self):
        symbols = [f"S{index}" for index in range(45)]
        with patch("main.fetch_yfinance_quote", side_effect=lambda symbol: {"symbol": symbol}) as fetch:
            response = main.market_quotes(main.QuoteRequest(symbols=symbols))
        self.assertEqual(fetch.call_count, 30)
        self.assertEqual(len(response["quotes"]), 30)


class MarketHistoryTests(unittest.TestCase):
    def test_unknown_range_is_rejected_with_400_before_any_fetch(self):
        with patch("main.fetch_yfinance_history") as fetch:
            with self.assertRaises(HTTPException) as caught:
                main.market_history(main.HistoryRequest(symbols=["AAPL"], range="5Y"))
        self.assertEqual(caught.exception.status_code, 400)
        fetch.assert_not_called()

    def test_range_is_uppercased_and_none_falls_back_to_24m(self):
        with patch("main.fetch_yfinance_history", return_value=[]) as fetch:
            lower = main.market_history(main.HistoryRequest(symbols=["a"], range="6m"))
            default = main.market_history(main.HistoryRequest(symbols=["a"], range=None))
        self.assertEqual(lower["range"], "6M")
        self.assertEqual(default["range"], "24M")
        self.assertEqual(fetch.call_args_list[0].args, ("A", "6M"))

    def test_failed_symbol_gets_empty_history_and_error_entry(self):
        def fake(symbol, range_label):
            if symbol == "BAD":
                raise RuntimeError("down")
            return [{"close": 1.0}]

        with patch("main.fetch_yfinance_history", side_effect=fake):
            response = main.market_history(main.HistoryRequest(symbols=["ok", "bad", "OK"], range="3M"))

        self.assertEqual(response["history"], {"OK": [{"close": 1.0}], "BAD": []})
        self.assertEqual(response["errors"], {"BAD": "down"})

    def test_at_most_thirty_symbols_are_fetched(self):
        with patch("main.fetch_yfinance_history", return_value=[]) as fetch:
            main.market_history(main.HistoryRequest(symbols=[f"S{index}" for index in range(40)]))
        self.assertEqual(fetch.call_count, 30)


class ForecastEndpointTests(unittest.TestCase):
    def test_short_term_calls_monte_carlo_with_90_days_and_risk_free_rate(self):
        with patch("main.run_monte_carlo", return_value={"input_observations": 3}) as model:
            response = main.forecast_short_term(main.AnalyzeRequest(ticker="AAPL", risk_free_rate=0.07))
        model.assert_called_once_with("AAPL", days=90, risk_free_rate=0.07)
        self.assertEqual(response["horizon"], "3-6 months")
        self.assertEqual(response["metadata"]["dataQuality"]["observations"], 3)

    def test_medium_term_passes_sentiment_and_180_days(self):
        with patch("main.run_arimax_garch", return_value={}) as model:
            response = main.forecast_medium_term(main.AnalyzeRequest(ticker="AAPL", sentiment_score=0.9))
        model.assert_called_once_with("AAPL", 0.9, days=180)
        self.assertEqual(response["horizon"], "6-12 months")

    def test_long_term_passes_risk_free_rate(self):
        with patch("main.run_dcf_fama_french", return_value={}) as model:
            response = main.forecast_long_term(main.AnalyzeRequest(ticker="AAPL", risk_free_rate=0.03))
        model.assert_called_once_with("AAPL", rfr=0.03)
        self.assertEqual(response["horizon"], "12-36 months")

    def test_model_failures_become_http_500_with_message(self):
        cases = [
            ("main.run_monte_carlo", main.forecast_short_term),
            ("main.run_arimax_garch", main.forecast_medium_term),
            ("main.run_dcf_fama_french", main.forecast_long_term),
        ]
        for target, endpoint in cases:
            with self.subTest(endpoint=endpoint.__name__), patch(target, side_effect=ValueError("model failed")):
                with self.assertRaises(HTTPException) as caught:
                    endpoint(main.AnalyzeRequest(ticker="AAPL"))
                self.assertEqual(caught.exception.status_code, 500)
                self.assertEqual(caught.exception.detail, "model failed")

    def test_engine_error_payload_is_surfaced_as_http_500(self):
        with patch("main.run_monte_carlo", return_value={"error": "engine said no"}):
            with self.assertRaises(HTTPException) as caught:
                main.forecast_short_term(main.AnalyzeRequest(ticker="AAPL"))
        self.assertEqual(caught.exception.detail, "engine said no")


@unittest.skipUnless(importlib.util.find_spec("httpx"), "starlette TestClient requires httpx (not in requirements.txt)")
class RoutingTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient

        try:
            self.client = TestClient(main.app)
        except TypeError as error:  # httpx>=0.28 + starlette 0.36 (fastapi==0.110.0) incompatible
            self.skipTest(f"TestClient could not be created: {error}")

    def test_health_route(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["service"], "quant-engine")

    def test_history_route_maps_handler_400(self):
        response = self.client.post("/api/market/history", json={"symbols": ["AAPL"], "range": "9Y"})
        self.assertEqual(response.status_code, 400)

    def test_request_validation_rejects_missing_ticker_with_422(self):
        response = self.client.post("/api/forecast/short-term", json={})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
