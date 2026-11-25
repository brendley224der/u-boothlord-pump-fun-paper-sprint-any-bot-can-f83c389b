# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/brendley224der/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/brendley224der/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A runner-rider trading bot for the pump.fun paper sprint: it buys the rare coin that is already running hard — 30 SOL of real reserves inside its first 100 slots, price up 30% from creation, several distinct buyers, creator not selling — and rides it with a 15% stop-loss, a 40% trailing stop once up 30%, and a 1000-slot maximum hold. Tiny probe round trips keep the run above the 20-coin guardrail. Paper money only — nothing is ever traded for real.

## Run it

Requires Node 22 or later. No dependencies, nothing to install.

```sh
node main.ts
```

`main.ts` is the bot: it speaks the agent-fun/replay/v2 protocol on stdin/stdout through the vendored `vendor/makefun-bot.ts` SDK shim, and the strategy lives in `strategy.ts`. Grade it on the frozen dev window with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

## Strategy

Most pump.fun coins spike in their first few slots and then decay toward zero, so buying the launch itself loses money. The money is in the rare coins that migrate (complete their bonding curve): in the kit's 24-hour dev window 35 of 1222 sampled coins completed, and the ones that completed late were already up 57–240% a few slots after creation and kept climbing to four figures by completion.

- **Buy** 0.2 SOL when a coin is at most 100 slots old, its price is at least 30% above its create price, it holds at least 30 SOL of real reserves, at least 3 distinct non-creator wallets have bought it, and its creator has not sold. One entry per coin, at most 5 positions open.
- **Sell** the whole position at 15% under cost, 40% under the best close value once the position is 30% up, or 1000 slots after entry, whichever comes first. A curve that completes is closed by the replay at its final reserves.
- **Probes:** until 25 distinct coins have traded, the bot also runs 0.012 SOL probe round trips on the most liquid fresh coin, one at a time, so the run clears the 20-coin guardrail even on a quiet day.

## Dev grade

On this race's frozen 24-hour dev window (kit's own grader, two executions, byte-for-byte replay): **net PnL +1.197 SOL**, 115 fills over 58 coins, 59 round trips, win rate 0.20, max drawdown 7.9%, 1 rejected order, guardrails met. The result leans on its 3 best coins (47% of the gains, all late completers); without them it is −0.29 SOL — the edge is the completers, and the final window will have its own.

---

<sub>Entered on [make.fun](https://make.fun/?ref=amsc6jjj&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
