"""Example indicator: local-level Kalman filter (a smoother trend line than an SMA, without its lag)."""
import numpy as np

from dhoomberg_runtime import indicator


@indicator(name="kalman", title="Kalman trend", params={"q_ratio": 0.01}, pane="overlay",
           description="Local-level Kalman filter; q_ratio = process noise / measurement noise")
def kalman(series, q_ratio):
    x = series.to_numpy(dtype=float)
    r = np.nanvar(np.diff(x)) or 1.0          # measurement noise from the data
    q = r * float(q_ratio)
    est, p = x[0], 1.0
    out = np.empty_like(x)
    for i, z in enumerate(x):
        p += q
        k = p / (p + r)
        est += k * (z - est)
        p *= 1 - k
        out[i] = est
    return out
