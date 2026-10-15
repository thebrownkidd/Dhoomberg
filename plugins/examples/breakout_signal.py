"""Example signal: 1 when the close makes a new N-bar high, else 0. Use it in a rule as
"py:breakout > 0.5", or plot it under the chart."""
from dhoomberg_runtime import signal


@signal(name="breakout", title="N-bar breakout", params={"n": 20},
        description="1 on a close above the prior N-bar high")
def breakout(series, n):
    prior_high = series.shift(1).rolling(int(n)).max()
    return (series > prior_high).astype(float).where(prior_high.notna())
