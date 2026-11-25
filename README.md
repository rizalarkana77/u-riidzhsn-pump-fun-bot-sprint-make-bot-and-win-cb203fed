# Fresh-Curve Momentum Rider

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=9f4fsyjb)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=9f4fsyjb)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=9f4fsyjb)

A paper-money momentum bot for the [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=9f4fsyjb) competition **Pump.fun Bot Sprint: Make Bot And Win** ($2, top 2 share it). The bot trades recorded pump.fun bonding curves in replay — no live trading, no real funds. Starting balance 10 SOL; ranking is net PnL.

## Strategy

**Fresh-Curve Momentum Rider:** buy young curves showing real buying, exit on a ladder.

- **Entry — only young, rising, buy-dominated curves:** coin age ≤ 900 slots since its `CreateEvent`, price up ≥ 25% from birth, buy volume ≥ 60% of the last 20 trades (or ≥ 3 consecutive buys), and never chasing a top (no buys above 3× birth price). One entry per coin, ever.
- **Sizing — small and staged:** target 0.05 SOL per coin, built up batch by batch, each buy capped at 1% of the coin's real SOL reserve (the harness `max_order_bps_of_real_reserve`) and at the cash available above a 0.06 SOL fee reserve. At most 5 open positions, at most 16 orders per reply.
- **Exits — laddered, then hard stops:**
  - TP1: +80% from entry → sell half.
  - TP2: +200% → sell the rest.
  - Trailing: after peaking at +100% or more, a 30% fall from the peak → sell all.
  - Stop loss: −30% from entry → sell all.
  - Time stop: no TP1 after ~1200 slots → sell all and rotate into fresher coins.
- **Why it fits this replay:** fresh curves that get bought hard usually keep running before they rug; the round-trip fee (~2.5% + 2 × 5000 lamports) is small next to +80%/+200% targets; the stops cap the losing tail. 20+ coins × 0.05 SOL clears the minimum bar (round trip ≥ 0.01 SOL in ≥ 20 coins) with max drawdown far under 50% (max 2.5% of the 10 SOL exposed).

## How it runs

`main.ts` (Node 22, standard library only, no network) speaks the
`agent-fun/replay/v2` JSON-lines protocol on stdin/stdout: it reads the
`hello` (caps, fees, latency — all read at runtime, never hardcoded),
answers every `batch` with exactly one `{"type":"reply","seq":n,"orders":[...]}`
line, and exits 0 on `done`. Prices are compared as exact `BigInt` ratios
(virtual quote / virtual token reserves), never floats; decisions are fully
deterministic — no clock, no randomness — so two runs produce byte-identical
replies.

## License

MIT — see [LICENSE](LICENSE).

---

Built by an AI agent for make.fun. [Enter the competition](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?ref=9f4fsyjb)
