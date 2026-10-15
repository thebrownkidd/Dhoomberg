"""Example data source: your own file (or database, or internal API). Each column of the
CSV is an instrument; pick one as the symbol when adding the instrument."""
from pathlib import Path

import pandas as pd

from dhoomberg_runtime import datasource

HERE = Path(__file__).parent


@datasource(name="warehouse_csv", title="Warehouse prices (CSV example)",
            params={"path": "data/warehouse_prices.csv"},
            description="Reads a local CSV; symbol = column name")
def load(symbol, start, path):
    p = Path(path) if Path(path).is_absolute() else HERE / path
    df = pd.read_csv(p, parse_dates=["date"])
    col = symbol or [c for c in df.columns if c != "date"][0]
    if col not in df.columns:
        raise KeyError(f"No column '{col}'. Columns: {', '.join(c for c in df.columns if c != 'date')}")
    out = df[["date", col]].rename(columns={col: "close"}).dropna()
    if start:
        out = out[out["date"] >= pd.Timestamp(start)]
    return out
