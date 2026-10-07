"""fetch_futures_context never raises - it's a "fail gracefully to
unavailable" piece, not core to the pipeline. Mocks requests.get so these
don't depend on the network."""

import pytest

import config
from src.context.futures import fetch_futures_context

FAKE_TICKERS_RESPONSE = {
    "result": "success",
    "tickers": [
        {
            "symbol": "PF_XBTUSD",
            "markPrice": 83778.43,
            "openInterest": 2161.664,
            "vol24h": 3997.9196,
            "fundingRate": 0.5987021631921114,  # NOT a percentage - see src/context/futures.py
            "fundingRatePrediction": -1.138189603516875,
            "relativeFundingRate": 7.094779166667e-06,
            "relativeFundingRatePrediction": -1.35828875e-05,
        },
        {
            "symbol": "PF_ETHUSD",
            "markPrice": 2613.42,
            "openInterest": 29839.833,
            "vol24h": 44539.686,
            "relativeFundingRate": 6.415491666667e-06,
            "relativeFundingRatePrediction": -1.3228891666667e-05,
        },
    ],
}


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


def test_successful_fetch_converts_relative_rate_to_percent(monkeypatch):
    monkeypatch.setattr("src.context.futures.requests.get", lambda *a, **k: FakeResponse(FAKE_TICKERS_RESPONSE))

    result = fetch_futures_context("btc")

    assert result["symbol"] == "PF_XBTUSD"
    assert result["mark_price"] == pytest.approx(83778.43)
    assert result["open_interest"] == pytest.approx(2161.664)
    # relativeFundingRate 7.094779166667e-06 -> 0.0007094...%, NOT the raw
    # fundingRate field (0.5987), which would be a nonsensical ~60%.
    assert result["funding_rate_hourly_pct"] == pytest.approx(0.0007094779166667)
    assert result["funding_rate_prediction_hourly_pct"] == pytest.approx(-0.00135828875)


def test_eth_symbol_resolves_correctly(monkeypatch):
    monkeypatch.setattr("src.context.futures.requests.get", lambda *a, **k: FakeResponse(FAKE_TICKERS_RESPONSE))

    result = fetch_futures_context("eth")

    assert result["symbol"] == "PF_ETHUSD"
    assert result["open_interest"] == pytest.approx(29839.833)


def test_unknown_asset_returns_none_without_a_request(monkeypatch):
    def fail_if_called(*a, **k):
        raise AssertionError("should not have made a request for an unknown asset")

    monkeypatch.setattr("src.context.futures.requests.get", fail_if_called)
    assert fetch_futures_context("doge") is None


def test_symbol_missing_from_response_returns_none_after_retries(monkeypatch):
    empty_response = {"result": "success", "tickers": []}
    monkeypatch.setattr("src.context.futures.requests.get", lambda *a, **k: FakeResponse(empty_response))
    monkeypatch.setattr("src.context.futures.time.sleep", lambda *a: None)

    assert fetch_futures_context("btc") is None


def test_http_error_retries_then_returns_none(monkeypatch):
    calls = []

    def flaky_get(*a, **k):
        calls.append(1)
        return FakeResponse({}, status_code=500)

    monkeypatch.setattr("src.context.futures.requests.get", flaky_get)
    monkeypatch.setattr("src.context.futures.time.sleep", lambda *a: None)

    assert fetch_futures_context("btc") is None
    assert len(calls) == config.FETCH_RETRIES


def test_retry_then_succeed(monkeypatch):
    calls = []

    def flaky_then_ok(*a, **k):
        calls.append(1)
        if len(calls) < 2:
            return FakeResponse({}, status_code=500)
        return FakeResponse(FAKE_TICKERS_RESPONSE)

    monkeypatch.setattr("src.context.futures.requests.get", flaky_then_ok)
    monkeypatch.setattr("src.context.futures.time.sleep", lambda *a: None)

    result = fetch_futures_context("btc")
    assert result is not None
    assert result["symbol"] == "PF_XBTUSD"
    assert len(calls) == 2
