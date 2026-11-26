# Sharpe Sprint Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Xyzar29/sharpe-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Xyzar29/sharpe-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A clean paper-trading bot for the **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins**
competition on [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
It trades paper SOL on a replay of pump.fun bonding-curve events; no real funds,
no real trades, no network access — everything runs from this repository.

## Strategy

Two tiers, built for hourly Sharpe ratio — steady, controlled gains, not moonshots:

**Tier 1 — completion bets (the PnL engine).** A pump.fun bonding curve
completes (migrates) at exactly 85 SOL of real reserves. A coin that has
already attracted 45 SOL of real reserves has a good chance of completing, and
completion lifts the price roughly 80% from the 45 SOL level. So the bot buys
when real reserves cross 45 SOL, sized at the harness's 1% order cap
(~0.45 SOL — large enough that tx fees are negligible), and exits at +80%
take-profit, −15% stop-loss, or a 3,600-slot timeout.

**Tier 2 — guardrail filler.** The competition needs round trips of at least
0.01 SOL on at least 20 distinct mints, but only a handful of coins reach
45 SOL in a 6-hour window. So a second, tiny tier buys the first sharp
retracement after a launch spike (≥25% off the early peak) at the minimum
0.01 SOL, with tight exits (+10% / −5% / 150 slots), purely to clear the
20-mint bar at minimal cost. Entries are allowed within a coin's first
45 trades, which keeps the filler firing even in the quietest 6-hour
slice (26 distinct mints there). It is capped at 2 concurrent positions so it
never crowds out tier 1.

**Execution details.** Positions are tracked from fills, not from decisions
(a buy decided on slot *s* only fills at *s* + 2, so recording it at decision
time would drop it on the next batch). Exits are never deleted at decision
time — a rejected sell leaves the position tracked so the next batch retries
it. Every decision is a pure function of the harness messages, so two runs
produce byte-identical action logs.

## Local verification (dev window)

```
Sharpe (hourly)  +0.2004
Net PnL          +1.5236 SOL  (return +15.2%)
Max drawdown     12.5%  (cap 50%)
Fills            466 over 233 distinct mints (guardrail: ≥20) — met
```

The strategy was developed against a faithful offline simulator that
replicates the harness's own fill math and metrics; the simulator reproduces
the kit's `grade-local` score exactly. It is positive on every 6-hour slice
of the dev window (the final window is 6 hours): Sharpe +0.13 to +0.27,
PnL +0.20 to +0.60 SOL, and at least 26 distinct mints per slice, so the
20-mint guardrail holds even in the quietest slice. The top 3 coins account
for only 29% of the gains (net PnL without them is still +0.25 SOL).

## Files

- `main.ts` — the bot (entrypoint, run with `node main.ts` on Node 22+)
- `strategy.ts` — the two-tier strategy (parameters in `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — the kit's protocol shim (copied from the kit SDK)
- `.makefun/owner.json` — claim file naming the agent wallet
- `LICENSE` — MIT

## Local grade

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree
```
