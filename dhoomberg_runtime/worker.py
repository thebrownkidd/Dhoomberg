"""JSON-RPC worker: one JSON object per line on stdin, one reply per line on stdout.

Plugin code may print freely: sys.stdout is redirected to stderr so it cannot corrupt
the protocol stream.
"""
import hashlib
import importlib.util
import json
import math
import sys
import traceback
from pathlib import Path

import dhoomberg_runtime as sdk

PROTO = sys.stdout
sys.stdout = sys.stderr

try:
    import numpy as np
    import pandas as pd
except ImportError as e:  # surfaced to the UI through the 'list' reply
    np = pd = None
    IMPORT_ERROR = f"{e}. Run: pip install -r requirements.txt"
else:
    IMPORT_ERROR = None

LOAD_ERRORS = {}


def clean(v):
    """JSON-safe floats (NaN/inf -> null)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def load_plugins(root: Path):
    sdk.REGISTRY.clear()
    LOAD_ERRORS.clear()
    if not root.exists():
        return
    for path in sorted(root.rglob("*.py")):
        if path.name.startswith("_") or "__pycache__" in path.parts:
            continue
        mod_name = "dhoomberg_plugin_" + hashlib.md5(str(path).encode()).hexdigest()[:10]
        try:
            spec = importlib.util.spec_from_file_location(mod_name, path)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[mod_name] = mod
            spec.loader.exec_module(mod)
        except Exception:
            LOAD_ERRORS[str(path.relative_to(root))] = traceback.format_exc(limit=3)


def to_series(dates, closes):
    return pd.Series([clean(c) for c in closes], index=pd.to_datetime(dates), dtype=float)


def as_list(out, n):
    if isinstance(out, pd.DataFrame):
        out = out.iloc[:, 0]
    if isinstance(out, pd.Series):
        out = out.to_numpy()
    arr = [clean(v) for v in list(out)]
    if len(arr) != n:
        raise ValueError(f"returned {len(arr)} values, expected {n} (one per input bar)")
    return arr


def call_indicator(entry, a):
    s = to_series(a["dates"], a["closes"])
    params = {**entry["manifest"]["params"], **a.get("params", {})}
    if a.get("other") is not None:
        params["other"] = to_series(a["dates"], a["other"])
    out = entry["fn"](s, **params)
    n = len(s)
    if isinstance(out, pd.DataFrame):
        return {c: as_list(out[c], n) for c in out.columns}
    if isinstance(out, dict):
        return {k: as_list(v, n) for k, v in out.items()}
    return {"value": as_list(out, n)}


def call_model(entry, a):
    s = to_series(a["dates"], a["closes"])
    params = {**entry["manifest"]["params"], **a.get("params", {})}
    out = entry["fn"](s, int(a["horizon"]), **params)
    if isinstance(out, (pd.Series, pd.DataFrame)):
        out = out.to_numpy().ravel()
    vals = [clean(v) for v in list(out)][: int(a["horizon"])]
    if len(vals) < int(a["horizon"]) or any(v is None for v in vals):
        raise ValueError(f"model must return {a['horizon']} finite numbers")
    return vals


def call_datasource(entry, a):
    params = {**entry["manifest"]["params"], **a.get("params", {})}
    out = entry["fn"](a.get("symbol", ""), a.get("start"), **params)
    if isinstance(out, pd.Series):
        out = out.rename("close").to_frame()
        out["date"] = out.index
    if not isinstance(out, pd.DataFrame):
        out = pd.DataFrame(out)
    if "date" not in out.columns:
        out = out.reset_index().rename(columns={out.index.name or "index": "date"})
    cols = [c for c in ("open", "high", "low", "close", "volume") if c in out.columns]
    if "close" not in cols:
        raise ValueError("datasource must return a 'close' column")
    bars = []
    for _, r in out.iterrows():
        d = pd.to_datetime(r["date"])
        bar = {"date": d.strftime("%Y-%m-%d")}
        for c in cols:
            bar[c] = clean(r[c])
        if bar["close"] is not None:
            bars.append(bar)
    bars.sort(key=lambda b: b["date"])
    return bars


def handle(req, root):
    m = req.get("method")
    if m == "ping":
        return "pong"
    if m in ("list", "reload"):
        if m == "reload" or not sdk.REGISTRY:
            load_plugins(root)
        return {
            "plugins": [e["manifest"] | {"file": str(Path(e["file"]).name)} for e in sdk.REGISTRY.values()],
            "errors": LOAD_ERRORS,
            "importError": IMPORT_ERROR,
        }
    if IMPORT_ERROR:
        raise RuntimeError(IMPORT_ERROR)
    if m == "call":
        p = req["params"]
        entry = sdk.REGISTRY.get(p["plugin"])
        if not entry:
            raise KeyError(f"No Python plugin named '{p['plugin']}'")
        kind = entry["manifest"]["kind"]
        if kind == "indicator":
            return call_indicator(entry, p["args"])
        if kind == "model":
            return call_model(entry, p["args"])
        if kind == "datasource":
            return call_datasource(entry, p["args"])
    raise ValueError(f"Unknown method {m}")


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "plugins").resolve()
    if IMPORT_ERROR is None:
        load_plugins(root)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            out = json.dumps({"id": req.get("id"), "result": handle(req, root)}, allow_nan=False)
        except Exception as e:
            out = json.dumps({"id": req.get("id"), "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc(limit=4)})
        PROTO.write(out + "\n")
        PROTO.flush()


if __name__ == "__main__":
    main()
