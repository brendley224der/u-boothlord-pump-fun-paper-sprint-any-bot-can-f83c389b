// Runner-rider bot for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Buys the rare pump.fun coin that is already running hard — 30 SOL of real
// reserves inside its first 100 slots, price up 30% from creation, several
// distinct buyers, creator not selling — and rides it with a 15% stop-loss,
// a 40% trailing stop once up 30%, and a 1000-slot maximum hold. Tiny probe
// round trips keep the run above the 20-coin guardrail. See strategy.ts for
// the full reasoning and the dev-window numbers. Node 22 stdlib only.

import { runBot } from './vendor/makefun-bot.ts';
import { createRiderBot, DEFAULT_RIDER_PARAMS } from './strategy.ts';

await runBot(createRiderBot(DEFAULT_RIDER_PARAMS));
