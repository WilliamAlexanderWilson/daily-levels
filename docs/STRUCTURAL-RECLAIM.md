# Structural reclaim detector

Method version: `structural-reclaim-pivot-cluster-v1`

## Why this exists

The previously fixed `$82,800` BTC reclaim was not a round-number guess. On
Kraken, the completed May 6, 2026 Daily candle printed a high of `$82,790.90`.
Mathieu later described that May range high as the boundary below which his
higher-timeframe bias remained lower. The UI rounded the source level to
`$82.8k`, but did not preserve the calculation that made the level important.

This detector makes that observable reason reproducible. It does not attempt
to reproduce discretionary chart drawing and it does not create a trade
signal.

## Frozen calculation

On each daily levels run, using completed Kraken BTC/USD Daily candles only:

1. Keep the most recent 540 calendar days.
2. Confirm pivot highs with five lower-high candles on both sides.
3. For every pivot high, collect other confirmed pivot highs within 2%.
4. Reject clusters with fewer than three pivots or less than 30 days between
   their first and last tests.
5. Rank the remaining clusters by pivot count, distinct calendar months,
   lifespan, then most recent test.
6. Use the highest exact high inside the winning cluster as the structural
   reclaim. Round to the nearest `$100` for display only.
7. Label the cluster `established` only with at least four pivots, three
   distinct months, and a 90-day lifespan; otherwise label it `developing`.
8. Describe acceptance with a transparent proxy: two consecutive completed
   Daily closes above or below the exact boundary. Mixed closes mean
   `testing`.

The exact price, originating candle, all cluster tests, method inputs,
acceptance closes, source, quality, and method version are written into
`site/data/btc_levels.json`. Daily history snapshots retain prior outputs, so
a changed boundary remains auditable.

## Interpretation boundary

- A detected boundary is repeat-tested market structure, not a prediction.
- `accepted-above`, `accepted-below`, and `testing` describe completed closes;
  they do not mean buy, sell, long, or short.
- The two-close rule is this project's objective proxy. The source videos use
  the discretionary word “acceptance” but do not define an exact candle count.
- The dated `$60k–$80k` macro framework and `$72k–$77k` support zone remain
  separately sourced. This detector updates the structural reclaim only; it
  does not silently pretend to derive the complete discretionary framework.
- Material changes to the detector require a new method version and fresh
  tests. Historical results must not be used to tune the same version after
  publication.

## Change audit and alerts

`structural_reclaim_audit` compares the new established boundary with the
latest published BTC snapshot, including an earlier forced run on the same
day. It records the first established level without alerting, carries the
original `current_since` timestamp while the boundary is unchanged, and
appends a versioned event only when a different **established** pivot cluster
wins the frozen ranking rule. Developing candidates and acceptance-state
changes do not create boundary-change alerts. The last established boundary
is retained through a developing or unavailable interval so the next
established calculation is still compared with the correct baseline.

The browser reuses the existing opt-in alert control. A changed boundary gets
one deduplicated in-page alert and, when permission is granted and the tab is
hidden, one browser notification. The audit stores at most the eight most
recent structural changes in the published snapshot.
