import json

import pandas as pd

from src.session_reactions.cli import _is_fresh, _load_json


def test_freshness_guard_skips_recent_artifacts_and_rejects_old_or_invalid(tmp_path):
    fresh = tmp_path / "fresh.json"
    payload = {"generated_at_utc": pd.Timestamp.now(tz="UTC").isoformat(), "events": []}
    fresh.write_text(json.dumps(payload))
    assert _is_fresh(str(fresh), 20) is True
    assert _load_json(str(fresh)) == payload

    old = tmp_path / "old.json"
    old.write_text(json.dumps({"generated_at_utc": "2020-01-01T00:00:00Z"}))
    assert _is_fresh(str(old), 20) is False

    invalid = tmp_path / "invalid.json"
    invalid.write_text("not json")
    assert _is_fresh(str(invalid), 20) is False
    assert _load_json(str(invalid)) is None
    assert _is_fresh(str(tmp_path / "missing.json"), 20) is False
