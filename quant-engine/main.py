from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from market_data import HISTORY_RANGE_MAP, fetch_yfinance_history, fetch_yfinance_quote
from models.econometrics import run_arimax_garch
from models.stochastic import run_monte_carlo
from models.value import run_dcf_fama_french

app = FastAPI(title="AlphaPulse Quant Engine", version="1.0.0")

class AnalyzeRequest(BaseModel):
    ticker: str
    sentiment_score: Optional[float] = 0.5
    current_price: Optional[float] = None
    risk_free_rate: Optional[float] = 0.04

class QuoteRequest(BaseModel):
    symbols: List[str]

class HistoryRequest(BaseModel):
    symbols: List[str]
    range: Optional[str] = "24M"

def build_forecast_response(horizon: str, model_family: str, result: Dict[str, Any], input_window: str) -> Dict[str, Any]:
    if result.get("error"):
        raise ValueError(str(result["error"]))

    return {
        "status": "success",
        "horizon": horizon,
        "data": result,
        "metadata": {
            "provider": "YahooFinance/yfinance",
            "providerPolicy": "Decision support only; not broker-grade real-time data.",
            "mode": "live",
            "dataQuality": {
                "status": "ready",
                "observations": result.get("input_observations", 0),
            },
            "modelGovernance": {
                "modelFamily": model_family,
                "inputWindow": input_window,
                "assumptions": result.get("model_assumptions", []),
                "riskFreeRate": result.get("risk_free_rate"),
                "validationStatus": "engine_reported",
            },
        },
    }

@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "service": "quant-engine"}

@app.post("/api/market/quotes")
def market_quotes(req: QuoteRequest) -> Dict[str, Any]:
    """
    Live quote bridge for the Node backend. Uses the existing yfinance dependency
    and reports per-symbol failures without failing the whole batch.
    """
    symbols = []
    seen = set()
    for symbol in req.symbols:
        normalized = symbol.strip().upper()
        if normalized and normalized not in seen:
            seen.add(normalized)
            symbols.append(normalized)

    quotes = []
    errors = {}
    for symbol in symbols[:30]:
        try:
            quotes.append(fetch_yfinance_quote(symbol))
        except Exception as e:
            errors[symbol] = str(e)

    return {"status": "success", "quotes": quotes, "errors": errors}

@app.post("/api/market/history")
def market_history(req: HistoryRequest) -> Dict[str, Any]:
    """
    Daily historical close bridge for the Node backend. Supports portfolio chart
    ranges without requiring another Node-side market data dependency.
    """
    range_label = (req.range or "24M").upper()
    if range_label not in HISTORY_RANGE_MAP:
        raise HTTPException(status_code=400, detail="range must be one of 3M, 6M, 12M, 24M")

    symbols = []
    seen = set()
    for symbol in req.symbols:
        normalized = symbol.strip().upper()
        if normalized and normalized not in seen:
            seen.add(normalized)
            symbols.append(normalized)

    history = {}
    errors = {}
    for symbol in symbols[:30]:
        try:
            history[symbol] = fetch_yfinance_history(symbol, range_label)
        except Exception as e:
            history[symbol] = []
            errors[symbol] = str(e)

    return {"status": "success", "range": range_label, "history": history, "errors": errors}

@app.post("/api/forecast/short-term")
def forecast_short_term(req: AnalyzeRequest) -> Dict[str, Any]:
    """
    3-6 Months: Monte Carlo GBM + VaR + Kelly Criterion
    """
    try:
        result = run_monte_carlo(req.ticker, days=90, risk_free_rate=req.risk_free_rate or 0.04)
        return build_forecast_response("3-6 months", "Monte Carlo GBM / VaR / Kelly", result, "1 year daily closes")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/forecast/medium-term")
def forecast_medium_term(req: AnalyzeRequest) -> Dict[str, Any]:
    """
    6-12 Months: ARIMAX + GARCH + Markov Regimes
    """
    try:
        result = run_arimax_garch(req.ticker, req.sentiment_score, days=180)
        return build_forecast_response("6-12 months", "ARIMAX / GARCH / regime heuristic", result, "2 years daily closes")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/forecast/long-term")
def forecast_long_term(req: AnalyzeRequest) -> Dict[str, Any]:
    """
    12-36 Months: DCF + Fama French 5-Factor
    """
    try:
        result = run_dcf_fama_french(req.ticker, rfr=req.risk_free_rate)
        return build_forecast_response("12-36 months", "DCF / Fama-French proxy premium", result, "Latest company fundamentals plus recent price")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
