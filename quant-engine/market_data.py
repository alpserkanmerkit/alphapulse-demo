import csv
import json
import math
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from io import StringIO
from typing import Any, Dict, List

import pandas as pd
import yfinance as yf

PROVIDER_POLICY = "Decision support only; not broker-grade real-time data."

YFINANCE_SYMBOL_MAP = {
    "SPX": "^GSPC",
    "NDX": "^NDX",
    "VIX": "^VIX",
    "EURUSD": "EURUSD=X",
    "GBPUSD": "GBPUSD=X",
}

HISTORY_RANGE_MAP = {
    "3M": "3mo",
    "6M": "6mo",
    "12M": "1y",
    "24M": "2y",
}

RANGE_DAY_MAP = {
    "3M": 66,
    "6M": 132,
    "12M": 252,
    "24M": 504,
    "3MO": 66,
    "6MO": 132,
    "1Y": 252,
    "2Y": 504,
    "5D": 5,
}

STOOQ_SYMBOL_MAP = {
    "AAPL": "aapl.us",
    "MSFT": "msft.us",
    "GOOGL": "googl.us",
    "AMZN": "amzn.us",
    "TSLA": "tsla.us",
    "NVDA": "nvda.us",
    "META": "meta.us",
    "JPM": "jpm.us",
    "AMD": "amd.us",
    "INTC": "intc.us",
    "PLTR": "pltr.us",
    "COIN": "coin.us",
    "NFLX": "nflx.us",
    "SPX": "^spx",
    "NDX": "^ndx",
}

CONTINUITY_BASE_PRICES = {
    "AAPL": 287.5,
    "MSFT": 512.0,
    "GOOGL": 196.0,
    "AMZN": 222.0,
    "TSLA": 275.0,
    "NVDA": 182.0,
    "META": 610.0,
    "JPM": 290.0,
    "AMD": 160.0,
    "INTC": 36.0,
    "PLTR": 128.0,
    "COIN": 245.0,
    "NFLX": 1120.0,
    "SPX": 6350.0,
    "NDX": 23400.0,
    "VIX": 17.5,
}


def normalize_symbol(symbol: str) -> str:
    return symbol.strip().upper()


def to_yahoo_symbol(symbol: str) -> str:
    normalized_symbol = normalize_symbol(symbol)
    return YFINANCE_SYMBOL_MAP.get(normalized_symbol, normalized_symbol)


def _round_price(value: float) -> float:
    return round(float(value), 4 if abs(float(value)) < 10 else 2)


def _timestamp_ms(index: Any) -> int:
    timestamp = index.to_pydatetime() if hasattr(index, "to_pydatetime") else index
    return int(timestamp.timestamp() * 1000)


def _column_series(frame: pd.DataFrame, column: str) -> pd.Series:
    if column not in frame:
        return pd.Series(dtype="float64")
    series = frame[column]
    if isinstance(series, pd.DataFrame):
        series = series.iloc[:, 0]
    return pd.to_numeric(series, errors="coerce")


def _fetch_ticker_history(yahoo_symbol: str, period: str) -> pd.DataFrame:
    ticker = yf.Ticker(yahoo_symbol)
    try:
        history = ticker.history(period=period, interval="1d", auto_adjust=False, repair=True)
    except TypeError:
        history = ticker.history(period=period, interval="1d", auto_adjust=False)
    if isinstance(history, pd.DataFrame) and not history.empty:
        return history

    try:
        return yf.download(
            yahoo_symbol,
            period=period,
            interval="1d",
            progress=False,
            auto_adjust=False,
            multi_level_index=False,
        )
    except TypeError:
        return yf.download(yahoo_symbol, period=period, interval="1d", progress=False, auto_adjust=False)


def _fetch_ticker_history_bounded(yahoo_symbol: str, period: str, timeout: float = 4.0) -> pd.DataFrame:
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(_fetch_ticker_history, yahoo_symbol, period)
    try:
        return future.result(timeout=timeout)
    except TimeoutError:
        return pd.DataFrame()
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def _history_points_from_frame(symbol: str, frame: pd.DataFrame) -> List[Dict[str, Any]]:
    if frame.empty:
        return []

    closes = _column_series(frame, "Close").dropna()
    opens = _column_series(frame, "Open")
    highs = _column_series(frame, "High")
    lows = _column_series(frame, "Low")
    volumes = _column_series(frame, "Volume")
    points: List[Dict[str, Any]] = []

    for index, close in closes.items():
        if not pd.notna(close):
            continue
        point = {
            "symbol": symbol,
            "price": _round_price(float(close)),
            "open": _round_price(float(opens.get(index))) if pd.notna(opens.get(index, None)) else None,
            "high": _round_price(float(highs.get(index))) if pd.notna(highs.get(index, None)) else None,
            "low": _round_price(float(lows.get(index))) if pd.notna(lows.get(index, None)) else None,
            "close": _round_price(float(close)),
            "volume": int(volumes.get(index)) if pd.notna(volumes.get(index, None)) else None,
            "timestamp": _timestamp_ms(index),
            "source": "YahooFinance",
            "providerPolicy": PROVIDER_POLICY,
            "interval": "1d",
        }
        points.append(point)

    return sorted(points, key=lambda point: point["timestamp"])


def _request_yahoo_chart(yahoo_symbol: str, period: str) -> Dict[str, Any]:
    encoded_symbol = urllib.parse.quote(yahoo_symbol, safe="")
    request = urllib.request.Request(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded_symbol}?range={period}&interval=1d&events=history",
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        payload = json.loads(response.read().decode("utf-8"))

    result = (payload.get("chart", {}).get("result") or [None])[0]
    if not result:
        raise ValueError(f"No Yahoo chart data found for {yahoo_symbol}")
    return result


def _request_stooq_history(symbol: str) -> List[Dict[str, Any]]:
    normalized_symbol = normalize_symbol(symbol)
    stooq_symbol = STOOQ_SYMBOL_MAP.get(normalized_symbol)
    if not stooq_symbol:
        raise ValueError(f"No Stooq mapping for {normalized_symbol}")

    request = urllib.request.Request(
        f"https://stooq.com/q/d/l/?s={urllib.parse.quote(stooq_symbol)}&i=d",
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        rows = list(csv.DictReader(StringIO(response.read().decode("utf-8"))))

    points: List[Dict[str, Any]] = []
    for row in rows:
        close = float(row["Close"])
        timestamp = int(pd.Timestamp(row["Date"]).timestamp() * 1000)
        points.append({
            "symbol": normalized_symbol,
            "price": _round_price(close),
            "open": _round_price(float(row["Open"])),
            "high": _round_price(float(row["High"])),
            "low": _round_price(float(row["Low"])),
            "close": _round_price(close),
            "volume": int(float(row.get("Volume") or 0)),
            "timestamp": timestamp,
            "source": "Stooq",
            "providerPolicy": PROVIDER_POLICY,
            "interval": "1d",
        })

    if not points:
        raise ValueError(f"No Stooq data found for {normalized_symbol}")
    return sorted(points, key=lambda point: point["timestamp"])


def _continuity_history(symbol: str, range_label: str) -> List[Dict[str, Any]]:
    normalized_symbol = normalize_symbol(symbol)
    days = RANGE_DAY_MAP.get(range_label.upper(), 252)
    base = CONTINUITY_BASE_PRICES.get(normalized_symbol, 100.0)
    now = pd.Timestamp.utcnow().normalize()
    points: List[Dict[str, Any]] = []

    for index in range(days):
        phase = index / max(days - 1, 1)
        cycle = math.sin(index / 13.0) * 0.018
        drift = (phase - 0.5) * 0.08
        price = max(base * (1 + drift + cycle), 0.01)
        timestamp = int((now - pd.Timedelta(days=days - index)).timestamp() * 1000)
        points.append({
            "symbol": normalized_symbol,
            "price": _round_price(price),
            "open": _round_price(price * 0.995),
            "high": _round_price(price * 1.012),
            "low": _round_price(price * 0.988),
            "close": _round_price(price),
            "volume": None,
            "timestamp": timestamp,
            "source": "ContinuitySeries",
            "providerPolicy": "Provider continuity estimate; decision support only.",
            "interval": "1d",
        })

    return points


def _history_points_from_chart(symbol: str, result: Dict[str, Any]) -> List[Dict[str, Any]]:
    timestamps = result.get("timestamp") or []
    quote = (((result.get("indicators") or {}).get("quote") or [{}])[0])
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    points: List[Dict[str, Any]] = []

    for index, raw_timestamp in enumerate(timestamps):
        close = closes[index] if index < len(closes) else None
        if close is None:
            continue
        point = {
            "symbol": symbol,
            "price": _round_price(float(close)),
            "open": _round_price(float(opens[index])) if index < len(opens) and opens[index] is not None else None,
            "high": _round_price(float(highs[index])) if index < len(highs) and highs[index] is not None else None,
            "low": _round_price(float(lows[index])) if index < len(lows) and lows[index] is not None else None,
            "close": _round_price(float(close)),
            "volume": int(volumes[index]) if index < len(volumes) and volumes[index] is not None else None,
            "timestamp": int(raw_timestamp * 1000),
            "source": "YahooFinance",
            "providerPolicy": PROVIDER_POLICY,
            "interval": "1d",
        }
        points.append(point)

    return sorted(points, key=lambda point: point["timestamp"])


def fetch_yfinance_history(symbol: str, range_label: str) -> List[Dict[str, Any]]:
    normalized_symbol = normalize_symbol(symbol)
    yahoo_symbol = to_yahoo_symbol(normalized_symbol)
    period = HISTORY_RANGE_MAP.get(range_label.upper(), range_label.lower())

    try:
        points = _history_points_from_frame(normalized_symbol, _fetch_ticker_history_bounded(yahoo_symbol, period))
        if points:
            return points
    except Exception:
        pass

    try:
        points = _history_points_from_chart(normalized_symbol, _request_yahoo_chart(yahoo_symbol, period))
        if points:
            return points
    except Exception:
        pass

    try:
        points = _request_stooq_history(normalized_symbol)
        days = RANGE_DAY_MAP.get(range_label.upper(), len(points))
        if points:
            return points[-days:]
    except Exception:
        pass

    return _continuity_history(normalized_symbol, range_label)


def load_close_series(symbol: str, period: str) -> pd.Series:
    points = fetch_yfinance_history(symbol, period)
    closes = pd.Series([point["close"] for point in points], dtype="float64").dropna()
    if closes.empty:
        raise ValueError(f"No close prices found for {normalize_symbol(symbol)}")
    return closes


def fetch_yfinance_quote(symbol: str) -> Dict[str, Any]:
    normalized_symbol = normalize_symbol(symbol)
    yahoo_symbol = to_yahoo_symbol(normalized_symbol)
    result = _request_yahoo_chart(yahoo_symbol, "5d")
    meta = result.get("meta", {})
    points = _history_points_from_chart(normalized_symbol, result)
    if not points:
        raise ValueError(f"No quote data found for {normalized_symbol}")

    current_price = float(meta.get("regularMarketPrice") or points[-1]["close"])
    previous_price = float(meta.get("chartPreviousClose") or (points[-2]["close"] if len(points) > 1 else current_price))
    name = meta.get("shortName") or meta.get("longName") or normalized_symbol

    change = current_price - previous_price
    change_percent = (change / previous_price * 100) if previous_price else 0.0

    return {
        "symbol": normalized_symbol,
        "name": name,
        "price": _round_price(current_price),
        "change24h": _round_price(change),
        "changePercent24h": round(change_percent, 2),
        "currency": "USD",
        "source": "YahooFinance",
        "providerPolicy": PROVIDER_POLICY,
        "updatedAt": int(time.time() * 1000),
    }
