"""Regenerates tests/fixtures/talib.json: reference indicator values from TA-Lib.

    pip install TA-Lib numpy
    python tests/fixtures/gen_talib.py
"""
import json
from pathlib import Path

import numpy as np
import talib

rng = np.random.default_rng(20261013)
n = 600
closes = 100 * np.exp(np.cumsum(rng.normal(0.0002, 0.015, n)))
closes = np.round(closes, 4)


def lst(a):
    return [None if np.isnan(v) else float(v) for v in a]


upper, mid, lower = talib.BBANDS(closes, timeperiod=20, nbdevup=2, nbdevdn=2, matype=0)
macd, signal, hist = talib.MACD(closes, fastperiod=12, slowperiod=26, signalperiod=9)

out = {
    "closes": closes.tolist(),
    "sma20": lst(talib.SMA(closes, 20)),
    "ema20": lst(talib.EMA(closes, 20)),
    "wma20": lst(talib.WMA(closes, 20)),
    "bb_upper": lst(upper), "bb_mid": lst(mid), "bb_lower": lst(lower),
    "rsi14": lst(talib.RSI(closes, 14)),
    "macd": lst(macd), "macd_signal": lst(signal), "macd_hist": lst(hist),
    "roc10": lst(talib.ROC(closes, 10)),
    "talib_version": talib.__version__,
}
Path(__file__).with_name("talib.json").write_text(json.dumps(out))
print(f"wrote {len(closes)} bars with TA-Lib {talib.__version__}")
