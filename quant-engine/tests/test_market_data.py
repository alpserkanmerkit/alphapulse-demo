"""Small tests for the pure/semi-pure functions in market_data.py.

No network, disk or sleep: urllib/yfinance/ThreadPoolExecutor are mocked. Timestamps
are tz-aware so the result does not depend on the machine's time zone.
"""
import json
import sys
import unittest
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd

QUANT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUANT_ROOT))

import market_data  # noqa: E402


class _InlineExecutor:
    """Replaces ThreadPoolExecutor: runs the work on the same thread (no thread/sleep)."""

    timeout_error = False

    def __init__(self, max_workers=1):
        pass

    def submit(self, fn, *args):
        executor = self

        class _Future:
            def result(self, timeout=None):
                if executor.timeout_error:
                    raise FutureTimeoutError()
                return fn(*args)

        return _Future()

    def shutdown(self, wait=True, cancel_futures=False):
        pass


class _TimeoutExecutor(_InlineExecutor):
    timeout_error = True


def _urlopen_returning(body: bytes):
    response = MagicMock()
    response.read.return_value = body
    response.__enter__.return_value = response
    response.__exit__.return_value = False
    return MagicMock(return_value=response)


class SymbolAndRoundingTests(unittest.TestCase):
    def test_symbol_mapping_normalizes_and_maps_indices(self):
        self.assertEqual(market_data.normalize_symbol("  aapl "), "AAPL")
        self.assertEqual(market_data.to_yahoo_symbol(" spx "), "^GSPC")
        self.assertEqual(market_data.to_yahoo_symbol("eurusd"), "EURUSD=X")
        self.assertEqual(market_data.to_yahoo_symbol("msft"), "MSFT")

    def test_round_price_uses_four_decimals_below_ten_and_two_above(self):
        self.assertEqual(market_data._round_price(5.123456), 5.1235)
        self.assertEqual(market_data._round_price(123.456), 123.46)
        self.assertEqual(market_data._round_price(-5.123456), -5.1235)

    def test_timestamp_ms_accepts_pandas_and_plain_datetime(self):
        stamp = pd.Timestamp("2026-01-02", tz="UTC")
        self.assertEqual(market_data._timestamp_ms(stamp), 1767312000000)
        self.assertEqual(market_data._timestamp_ms(stamp.to_pydatetime()), 1767312000000)


class ColumnSeriesTests(unittest.TestCase):
    def test_missing_column_returns_empty_float_series(self):
        result = market_data._column_series(pd.DataFrame({"Close": [1.0]}), "Volume")
        self.assertTrue(result.empty)
        self.assertEqual(str(result.dtype), "float64")

    def test_duplicate_columns_use_first_and_strings_become_nan(self):
        frame = pd.DataFrame([[1.0, 9.0], ["bad", 8.0]], columns=["Close", "Close"])
        result = market_data._column_series(frame, "Close")
        self.assertEqual(result.iloc[0], 1.0)
        self.assertTrue(np.isnan(result.iloc[1]))


class HistoryPointsFromFrameTests(unittest.TestCase):
    def test_empty_frame_gives_no_points(self):
        self.assertEqual(market_data._history_points_from_frame("AAPL", pd.DataFrame()), [])

    def test_nan_close_is_skipped_missing_fields_become_none_and_points_are_sorted(self):
        frame = pd.DataFrame(
            {
                "Open": [None, 10.0, 11.0],
                "Close": [12.0, float("nan"), 11.5],
                "Volume": [float("nan"), 5.0, 7.0],
            },
            index=pd.to_datetime(["2026-01-03", "2026-01-02", "2026-01-01"], utc=True),
        )
        points = market_data._history_points_from_frame("AAPL", frame)

        self.assertEqual([point["close"] for point in points], [11.5, 12.0])
        self.assertEqual([point["timestamp"] for point in points], sorted(point["timestamp"] for point in points))
        self.assertEqual(points[1]["open"], None)
        self.assertEqual(points[1]["volume"], None)
        self.assertEqual(points[0]["volume"], 7)
        self.assertEqual(points[0]["high"], None)


class HistoryPointsFromChartTests(unittest.TestCase):
    def test_points_are_sorted_and_none_close_is_skipped(self):
        result = {
            "timestamp": [1767312000, 1767225600, 1767398400],
            "indicators": {"quote": [{"open": [2.0], "high": [], "low": [], "close": [102.0, 101.0, None], "volume": [None, 1000]}]},
        }
        points = market_data._history_points_from_chart("AAPL", result)

        self.assertEqual([point["close"] for point in points], [101.0, 102.0])
        self.assertEqual(points[0]["timestamp"], 1767225600000)
        self.assertEqual(points[0]["volume"], 1000)
        self.assertEqual(points[1]["volume"], None)
        self.assertEqual(points[1]["open"], 2.0)
        self.assertEqual(points[0]["open"], None)
        self.assertEqual(points[0]["high"], None)

    def test_missing_indicators_give_no_points(self):
        self.assertEqual(market_data._history_points_from_chart("AAPL", {}), [])
        self.assertEqual(market_data._history_points_from_chart("AAPL", {"timestamp": [1767225600]}), [])


class YahooChartRequestTests(unittest.TestCase):
    def test_returns_first_result_and_percent_encodes_the_symbol(self):
        body = json.dumps({"chart": {"result": [{"meta": {"x": 1}}]}}).encode()
        opener = _urlopen_returning(body)
        with patch("market_data.urllib.request.urlopen", opener):
            result = market_data._request_yahoo_chart("^GSPC", "5d")

        self.assertEqual(result, {"meta": {"x": 1}})
        request = opener.call_args.args[0]
        self.assertIn("/chart/%5EGSPC?range=5d", request.full_url)

    def test_empty_result_raises_value_error(self):
        for payload in ({"chart": {"result": None}}, {"chart": {"result": []}}, {}):
            with self.subTest(payload=payload), patch("market_data.urllib.request.urlopen", _urlopen_returning(json.dumps(payload).encode())):
                with self.assertRaises(ValueError):
                    market_data._request_yahoo_chart("AAPL", "5d")


class StooqRequestTests(unittest.TestCase):
    CSV = (
        "Date,Open,High,Low,Close,Volume\n"
        "2026-01-03,11,13,10,12.5,200\n"
        "2026-01-02,10,12,9,11.5,\n"
    )

    def test_unmapped_symbol_raises_before_any_request(self):
        opener = MagicMock()
        with patch("market_data.urllib.request.urlopen", opener):
            with self.assertRaises(ValueError):
                market_data._request_stooq_history("ZZZZ")
        opener.assert_not_called()

    def test_csv_rows_are_parsed_and_sorted_ascending(self):
        with patch("market_data.urllib.request.urlopen", _urlopen_returning(self.CSV.encode())):
            points = market_data._request_stooq_history("aapl")

        self.assertEqual([point["close"] for point in points], [11.5, 12.5])
        self.assertEqual(points[0]["timestamp"], 1767312000000)
        self.assertEqual(points[0]["volume"], 0)
        self.assertEqual(points[1]["volume"], 200)
        self.assertEqual({point["source"] for point in points}, {"Stooq"})
        self.assertEqual(points[0]["symbol"], "AAPL")

    def test_header_only_csv_raises_value_error(self):
        with patch("market_data.urllib.request.urlopen", _urlopen_returning(b"Date,Open,High,Low,Close,Volume\n")):
            with self.assertRaises(ValueError):
                market_data._request_stooq_history("AAPL")


class ContinuityHistoryTests(unittest.TestCase):
    def test_length_follows_range_label_with_252_default(self):
        self.assertEqual(len(market_data._continuity_history("AAPL", "3M")), 66)
        self.assertEqual(len(market_data._continuity_history("AAPL", "5d")), 5)
        self.assertEqual(len(market_data._continuity_history("AAPL", "weird")), 252)

    def test_uses_known_base_price_else_100_and_timestamps_increase(self):
        known = market_data._continuity_history("AAPL", "3M")
        unknown = market_data._continuity_history("ZZZZ", "3M")

        timestamps = [point["timestamp"] for point in known]
        self.assertEqual(timestamps, sorted(set(timestamps)))
        # drift +-4% and cycle +-1.8% => price stays within ~6% of the base price
        self.assertTrue(all(abs(point["close"] / 287.5 - 1) < 0.07 for point in known))
        self.assertTrue(all(abs(point["close"] / 100.0 - 1) < 0.07 for point in unknown))
        self.assertEqual({point["source"] for point in known}, {"ContinuitySeries"})
        self.assertTrue(all(point["low"] < point["close"] < point["high"] for point in known))

    def test_price_is_floored_at_one_cent(self):
        with patch.dict(market_data.CONTINUITY_BASE_PRICES, {"TINY": 0.0}):
            points = market_data._continuity_history("tiny", "5d")
        self.assertTrue(all(point["close"] == 0.01 for point in points))


class FetchTickerHistoryTests(unittest.TestCase):
    NON_EMPTY = pd.DataFrame({"Close": [1.0]})

    def test_returns_ticker_history_when_not_empty(self):
        ticker = MagicMock()
        ticker.history.return_value = self.NON_EMPTY
        with patch("market_data.yf.Ticker", return_value=ticker), patch("market_data.yf.download") as download:
            frame = market_data._fetch_ticker_history("AAPL", "1y")
        self.assertIs(frame, self.NON_EMPTY)
        download.assert_not_called()

    def test_type_error_on_repair_flag_retries_without_it(self):
        ticker = MagicMock()
        ticker.history.side_effect = [TypeError("repair"), self.NON_EMPTY]
        with patch("market_data.yf.Ticker", return_value=ticker):
            frame = market_data._fetch_ticker_history("AAPL", "1y")
        self.assertIs(frame, self.NON_EMPTY)
        self.assertNotIn("repair", ticker.history.call_args_list[1].kwargs)

    def test_empty_history_falls_back_to_download_and_then_to_legacy_signature(self):
        ticker = MagicMock()
        ticker.history.return_value = pd.DataFrame()
        with patch("market_data.yf.Ticker", return_value=ticker), patch("market_data.yf.download", return_value=self.NON_EMPTY) as download:
            self.assertIs(market_data._fetch_ticker_history("AAPL", "1y"), self.NON_EMPTY)
        self.assertEqual(download.call_args.kwargs["multi_level_index"], False)

        with patch("market_data.yf.Ticker", return_value=ticker), patch("market_data.yf.download", side_effect=[TypeError("old"), self.NON_EMPTY]) as download:
            self.assertIs(market_data._fetch_ticker_history("AAPL", "1y"), self.NON_EMPTY)
        self.assertEqual(download.call_count, 2)
        self.assertNotIn("multi_level_index", download.call_args_list[1].kwargs)


class FetchTickerHistoryBoundedTests(unittest.TestCase):
    def test_timeout_returns_empty_frame(self):
        with patch("market_data.ThreadPoolExecutor", _TimeoutExecutor), patch("market_data._fetch_ticker_history") as inner:
            frame = market_data._fetch_ticker_history_bounded("AAPL", "1y")
        self.assertTrue(frame.empty)
        inner.assert_not_called()

    def test_result_is_passed_through_when_in_time(self):
        expected = pd.DataFrame({"Close": [1.0]})
        with patch("market_data.ThreadPoolExecutor", _InlineExecutor), patch("market_data._fetch_ticker_history", return_value=expected) as inner:
            frame = market_data._fetch_ticker_history_bounded("AAPL", "1y")
        self.assertIs(frame, expected)
        inner.assert_called_once_with("AAPL", "1y")


class FetchHistoryFallbackChainTests(unittest.TestCase):
    CHART = {
        "timestamp": [1767225600],
        "indicators": {"quote": [{"close": [101.0]}]},
    }

    def _stooq_points(self, count):
        return [{"symbol": "AAPL", "close": float(i), "timestamp": i, "source": "Stooq"} for i in range(count)]

    def test_period_is_mapped_from_range_label_and_symbol_from_alias(self):
        with patch("market_data._fetch_ticker_history_bounded", return_value=pd.DataFrame()) as bounded, \
             patch("market_data._request_yahoo_chart", return_value=self.CHART):
            market_data.fetch_yfinance_history("spx", "3m")
        bounded.assert_called_once_with("^GSPC", "3mo")

    def test_unknown_range_label_is_passed_lowercased(self):
        with patch("market_data._fetch_ticker_history_bounded", return_value=pd.DataFrame()) as bounded, \
             patch("market_data._request_yahoo_chart", return_value=self.CHART):
            market_data.fetch_yfinance_history("AAPL", "5D")
        bounded.assert_called_once_with("AAPL", "5d")

    def test_exception_in_primary_provider_falls_through_to_chart(self):
        with patch("market_data._fetch_ticker_history_bounded", side_effect=RuntimeError("boom")), \
             patch("market_data._request_yahoo_chart", return_value=self.CHART):
            points = market_data.fetch_yfinance_history("AAPL", "12M")
        self.assertEqual(points[0]["close"], 101.0)

    def test_chart_without_usable_points_falls_through_to_stooq_and_trims_to_range(self):
        empty_chart = {"timestamp": [], "indicators": {"quote": [{}]}}
        with patch("market_data._fetch_ticker_history_bounded", return_value=pd.DataFrame()), \
             patch("market_data._request_yahoo_chart", return_value=empty_chart), \
             patch("market_data._request_stooq_history", return_value=self._stooq_points(100)):
            points = market_data.fetch_yfinance_history("AAPL", "3M")
        self.assertEqual(len(points), 66)
        self.assertEqual(points[-1]["close"], 99.0)
        self.assertEqual(points[0]["close"], 34.0)

    def test_empty_stooq_result_falls_through_to_continuity(self):
        with patch("market_data._fetch_ticker_history_bounded", return_value=pd.DataFrame()), \
             patch("market_data._request_yahoo_chart", side_effect=ValueError("none")), \
             patch("market_data._request_stooq_history", return_value=[]):
            points = market_data.fetch_yfinance_history("AAPL", "3M")
        self.assertEqual(points[0]["source"], "ContinuitySeries")


class LoadCloseSeriesTests(unittest.TestCase):
    def test_returns_float_series_of_closes(self):
        with patch("market_data.fetch_yfinance_history", return_value=[{"close": 1.5}, {"close": 2.5}]) as fetch:
            series = market_data.load_close_series("aapl", "12M")
        fetch.assert_called_once_with("aapl", "12M")
        self.assertEqual(series.tolist(), [1.5, 2.5])
        self.assertEqual(str(series.dtype), "float64")

    def test_no_points_raises_with_normalized_symbol(self):
        with patch("market_data.fetch_yfinance_history", return_value=[]):
            with self.assertRaisesRegex(ValueError, "AAPL"):
                market_data.load_close_series(" aapl ", "12M")


class QuoteEdgeTests(unittest.TestCase):
    def test_no_chart_points_raises_value_error(self):
        with patch("market_data._request_yahoo_chart", return_value={"meta": {}, "timestamp": []}):
            with self.assertRaises(ValueError):
                market_data.fetch_yfinance_quote("AAPL")

    def test_without_meta_price_uses_last_two_closes_and_symbol_as_name(self):
        chart = {"meta": {}, "timestamp": [1767225600, 1767312000], "indicators": {"quote": [{"close": [100.0, 110.0]}]}}
        with patch("market_data._request_yahoo_chart", return_value=chart):
            quote = market_data.fetch_yfinance_quote("aapl")
        self.assertEqual(quote["price"], 110.0)
        self.assertEqual(quote["change24h"], 10.0)
        self.assertEqual(quote["changePercent24h"], 10.0)
        self.assertEqual(quote["name"], "AAPL")

    def test_single_point_has_zero_change(self):
        chart = {"meta": {}, "timestamp": [1767225600], "indicators": {"quote": [{"close": [100.0]}]}}
        with patch("market_data._request_yahoo_chart", return_value=chart):
            quote = market_data.fetch_yfinance_quote("AAPL")
        self.assertEqual(quote["change24h"], 0.0)
        self.assertEqual(quote["changePercent24h"], 0.0)

    def test_long_name_is_used_when_short_name_missing(self):
        chart = {"meta": {"regularMarketPrice": 5.0, "chartPreviousClose": 4.0, "longName": "Long Co"}, "timestamp": [1], "indicators": {"quote": [{"close": [5.0]}]}}
        with patch("market_data._request_yahoo_chart", return_value=chart):
            self.assertEqual(market_data.fetch_yfinance_quote("X")["name"], "Long Co")


if __name__ == "__main__":
    unittest.main()
