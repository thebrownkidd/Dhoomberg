"""Example forecast model: the Theta method (M3 competition winner), on log prices.

Shows up in the chart's Model dropdown and is evaluated against the naive forecast
out-of-sample like every other model.
"""
import numpy as np

from dhoomberg_runtime import model


@model(name="theta", title="Theta method", params={"alpha": 0.5},
       description="SES on log prices plus half the linear trend")
def theta(series, horizon, alpha):
    y = np.log(series.to_numpy(dtype=float))
    n = len(y)
    t = np.arange(n)
    slope = np.polyfit(t, y, 1)[0]
    level = y[0]
    for v in y[1:]:
        level = alpha * v + (1 - alpha) * level
    steps = np.arange(1, horizon + 1)
    drift = 0.5 * slope * (steps + (1 - (1 - alpha) ** n) / alpha - 1)
    return np.exp(level + drift)
