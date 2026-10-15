"""Dhoomberg plugin SDK.

Drop a .py file into plugins/ and decorate functions:

    from dhoomberg_runtime import indicator, model, datasource, signal

    @indicator(name="kalman", title="Kalman trend", params={"q": 0.01}, pane="overlay")
    def kalman(series, q):          # pandas Series of closes indexed by date
        ...                         # return a Series / list / dict of Series

    @model(name="garch_drift", title="GARCH drift", params={"window": 250})
    def garch(series, horizon, window):
        ...                         # return `horizon` future prices

    @datasource(name="my_csv", title="My warehouse feed", params={"path": "data.csv"})
    def load(symbol, start, path):
        ...                         # return a DataFrame with date + close (or a Series indexed by date)

    @signal(name="breakout", title="20-day breakout", params={"n": 20})
    def breakout(series, n):
        ...                         # return a 0/1 Series; usable in rules like any indicator

The server discovers plugins at start-up and whenever a file in plugins/ changes.
"""

REGISTRY = {}


def _register(kind, fn, name, title, params, description, **extra):
    pid = name or fn.__name__
    if pid in REGISTRY:
        raise ValueError(f"Duplicate plugin name '{pid}' ({REGISTRY[pid]['file']} and {fn.__code__.co_filename})")
    REGISTRY[pid] = {
        "fn": fn,
        "file": fn.__code__.co_filename,
        "manifest": {
            "name": pid,
            "kind": kind,
            "title": title or pid.replace("_", " ").title(),
            "params": dict(params or {}),
            "description": description or (fn.__doc__ or "").strip().split("\n")[0],
            **extra,
        },
    }
    return fn


def indicator(name=None, title=None, params=None, pane="sub", outputs=None, levels=None, description=""):
    def deco(fn):
        return _register("indicator", fn, name, title, params, description, pane=pane, outputs=list(outputs or ["value"]), levels=list(levels or []))
    return deco


def signal(name=None, title=None, params=None, description=""):
    def deco(fn):
        return _register("indicator", fn, name, title, params, description, pane="sub", outputs=["value"], levels=[0.5], signal=True)
    return deco


def model(name=None, title=None, params=None, description=""):
    def deco(fn):
        return _register("model", fn, name, title, params, description)
    return deco


def datasource(name=None, title=None, params=None, description=""):
    def deco(fn):
        return _register("datasource", fn, name, title, params, description)
    return deco
