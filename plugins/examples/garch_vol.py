"""Example indicator: GARCH(1,1) conditional volatility, fitted by grid-search maximum likelihood."""
import numpy as np

from dhoomberg_runtime import indicator


def _filter(r, omega, alpha, beta):
    s2 = np.empty_like(r)
    s2[0] = np.var(r)
    for t in range(1, len(r)):
        s2[t] = omega + alpha * r[t - 1] ** 2 + beta * s2[t - 1]
    return s2


@indicator(name="garch_vol", title="GARCH(1,1) vol", params={"periods_per_year": 252}, pane="sub",
           description="Annualised conditional volatility (%) from a GARCH(1,1) fit")
def garch_vol(series, periods_per_year):
    r = np.diff(np.log(series.to_numpy(dtype=float)))
    r = r - r.mean()
    var = r.var()
    best, best_ll = None, -np.inf
    for alpha in (0.02, 0.05, 0.08, 0.12, 0.18):
        for beta in (0.70, 0.80, 0.85, 0.90, 0.94, 0.97):
            if alpha + beta >= 0.999:
                continue
            omega = var * (1 - alpha - beta)        # variance targeting
            s2 = _filter(r, omega, alpha, beta)
            ll = -0.5 * np.sum(np.log(s2) + r ** 2 / s2)
            if ll > best_ll:
                best, best_ll = (omega, alpha, beta), ll
    s2 = _filter(r, *best)
    vol = np.sqrt(s2 * float(periods_per_year)) * 100
    return np.concatenate([[np.nan], vol])
