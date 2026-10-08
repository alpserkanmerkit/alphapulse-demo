from concurrent.futures import ThreadPoolExecutor, TimeoutError

import yfinance as yf

from market_data import load_close_series

FUNDAMENTAL_TIMEOUT_SECONDS = 4

def _safe_latest_price(ticker: str, price_fixture=None) -> float:
    if price_fixture:
        return float(price_fixture[-1])
    return float(load_close_series(ticker, "5d").iloc[-1])

def _load_info_bounded(ticker: str):
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(lambda: yf.Ticker(ticker).info or {})
    closed = False
    try:
        return future.result(timeout=FUNDAMENTAL_TIMEOUT_SECONDS), None
    except TimeoutError:
        executor.shutdown(wait=False, cancel_futures=True)
        closed = True
        return {}, f"Fundamental provider timed out after {FUNDAMENTAL_TIMEOUT_SECONDS}s; used price-only proxy valuation."
    except Exception as error:
        executor.shutdown(wait=False, cancel_futures=True)
        closed = True
        return {}, f"Fundamental provider unavailable; used price-only proxy valuation ({error})."
    finally:
        if not closed:
            executor.shutdown(wait=False, cancel_futures=True)

def run_dcf_fama_french(ticker: str, rfr: float = 0.04, info_fixture=None, price_fixture=None):
    """
    Automated DCF & proxy Fama-French 5 factor evaluation for a 36-month horizon.
    """
    info_warning = None
    if info_fixture is None:
        info, info_warning = _load_info_bounded(ticker)
    else:
        info = info_fixture

    current_price = info.get("currentPrice") or info.get("regularMarketPrice") or 0.0
    shares = info.get("sharesOutstanding") or 0.0

    if current_price == 0.0:
        current_price = _safe_latest_price(ticker, price_fixture)

    if current_price <= 0:
        raise ValueError(f"Could not retrieve price for {ticker}")

    fcf = info.get("freeCashflow")
    if not fcf or shares == 0:
        projected_value = current_price * ((1 + 0.10)**3)
        result = {
            "current_price": round(current_price, 2),
            "dcf_intrinsic_value": round(projected_value, 2),
            "fama_french_premium": 0.0,
            "target_12_36_months": round(projected_value, 2),
            "upper_band": round(projected_value * 1.05, 2),
            "lower_band": round(projected_value * 0.95, 2),
            "warning": "Insufficient financial data for deep DCF. Using proxy growth.",
            "input_observations": 1,
            "risk_free_rate": round(float(rfr), 4),
            "wacc": None,
            "terminal_growth": None,
            "model_assumptions": [
                "Insufficient fundamentals triggered proxy growth.",
                "Proxy output is decision support only and should not be treated as a validated valuation.",
            ],
        }
        if info_warning:
            result["warning"] = info_warning
            result["model_assumptions"].append("Provider continuity safeguards were applied before producing the proxy valuation.")
        return result

    growth_rate = info.get("revenueGrowth") or 0.08
    beta = info.get("beta") or 1.0
    erp = 0.055
    wacc = rfr + (beta * erp)
    terminal_growth = max(0.01, min(rfr - 0.01, 0.03))

    projected_fcf = [fcf * ((1 + growth_rate) ** i) for i in range(1, 4)]
    tv = (projected_fcf[-1] * (1 + terminal_growth)) / (wacc - terminal_growth)
    pv_fcf = sum(cf / ((1 + wacc) ** (i + 1)) for i, cf in enumerate(projected_fcf))
    pv_tv = tv / ((1 + wacc) ** 3)

    enterprise_value = pv_fcf + pv_tv
    total_cash = info.get("totalCash", 0)
    total_debt = info.get("totalDebt", 0)
    equity_value = enterprise_value + total_cash - total_debt
    per_share_value = equity_value / shares

    market_cap = info.get("marketCap", 0)
    pb_ratio = info.get("priceToBook", 1.0)
    roe = info.get("returnOnEquity", 0.10)
    current_ratio = info.get("currentRatio", 1.5)

    ff_premium = 0.0
    if market_cap > 0 and market_cap < 2e9:
        ff_premium += 0.02
    if pb_ratio > 0 and pb_ratio < 1.0:
        ff_premium += 0.015
    if roe is not None and roe > 0.15:
        ff_premium += 0.01
    if current_ratio is not None and current_ratio > 2.0:
        ff_premium += 0.005

    target_value = per_share_value * ((1 + ff_premium) ** 3)
    target_value = max(current_price * 0.5, min(target_value, current_price * 4.0))

    return {
        "current_price": round(current_price, 2),
        "dcf_intrinsic_value": round(per_share_value, 2),
        "fama_french_premium": round(ff_premium, 4),
        "target_12_36_months": round(target_value, 2),
        "upper_band": round(target_value * 1.05, 2),
        "lower_band": round(target_value * 0.95, 2),
        "input_observations": 1,
        "risk_free_rate": round(float(rfr), 4),
        "wacc": round(float(wacc), 4),
        "terminal_growth": round(float(terminal_growth), 4),
        "model_assumptions": [
            "WACC is estimated from supplied risk-free rate plus beta-adjusted equity risk premium.",
            "Terminal growth is bounded below the discount rate.",
            "Fama-French premium is a proxy factor adjustment, not a production validation ledger.",
        ],
    }
