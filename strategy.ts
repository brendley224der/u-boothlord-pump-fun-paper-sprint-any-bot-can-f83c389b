// Runner-rider bot for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Why this shape: on the kit's 24-hour dev window (1222 sampled coins) almost
// every coin prints its high in the first few slots and then grinds toward
// zero, so buying a launch is a losing trade on average. The coins that pay
// are the rare ones that finish their bonding curve (migrate): of the 35
// completers in the dev window, the ones that completed late were already up
// 57-240% a few slots after creation and kept climbing to four figures by
// completion. So the bot only buys a coin that is already proving it is one
// of the rare runners, bets small, and gets out on strict rules.
//
// Buy (once per coin, ever):
//   - at most 100 slots old, price at least +30% over its create price,
//   - at least 30 SOL of real reserves, at least 3 distinct non-creator buyers,
//   - creator has never sold. Stake 0.2 SOL, at most 5 positions open.
//
// Sell the whole position when any of these fires first:
//   - 15% below cost (stop-loss),
//   - 40% below the best close value once the position is 30% up (trailing),
//   - 1000 slots after entry (losers held longer bleed to near zero).
// A curve that completes is closed by the replay at its final reserves.
//
// Guardrail probes: the run needs a >= 0.01 SOL round trip on >= 20 coins.
// Until 25 distinct coins have a filled order, the bot also runs tiny probe
// round trips (0.012 SOL in, sell it all as soon as the buy lands) on the
// most liquid fresh coin, one at a time. Each probe costs about two tx fees
// plus the ~1.25% curve fee, roughly 0.0006 SOL — cheap insurance.
//
// Deterministic by construction: no clock, no randomness, no environment,
// no I/O. Every loop runs over insertion-ordered maps fed by the batch
// stream, and probe candidates break ties by mint, so the two graded
// executions produce byte-identical action logs. Node 22 stdlib only.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface RiderParams {
  /** Oldest age (slots since CreateEvent) at which a first buy may be decided. */
  maxAgeSlots: number;
  /** Minimum price gain over the create price at entry, as a fraction (0.3 = +30%). */
  minRunup: number;
  /** Minimum real SOL reserves at entry. */
  minRealSol: number;
  /** Minimum distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** SOL staked in one runner position. */
  stakeSol: number;
  /** Smallest buy worth sending (the guardrail counts round trips of >= 0.01 SOL). */
  minBuySol: number;
  /** Slippage on buys and sells (bps); wide open so a fast mover never refuses. */
  slipBps: number;
  /** Exit when the close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: exit on a fall of `trailDrop` from the best close value. */
  trailDrop: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  rebuyCooldown: number;
  /** Most entries per curve over the whole run. */
  maxEntriesPerCoin: number;
  /** Most runner positions open at once. */
  maxRunners: number;
  /** Guardrail pacing: keep opening probes until this many distinct coins traded. */
  probeTargetCoins: number;
  /** SOL per probe round trip. */
  probeSol: number;
  /** Most probe positions open at once. */
  maxProbesOpen: number;
  /** A probe candidate needs at least this much real SOL (so the buy fits the 1% cap). */
  probeMinRealSol: number;
}

export const DEFAULT_RIDER_PARAMS: RiderParams = {
  maxAgeSlots: 100,
  minRunup: 0.3,
  minRealSol: 30,
  minBuyers: 3,
  stakeSol: 0.2,
  minBuySol: 0.01,
  slipBps: 10_000,
  stopLoss: 0.15,
  trailDrop: 0.4,
  trailArm: 0.3,
  maxHoldSlots: 1000,
  rebuyCooldown: 150,
  maxEntriesPerCoin: 1,
  maxRunners: 5,
  probeTargetCoins: 25,
  probeSol: 0.012,
  maxProbesOpen: 1,
  probeMinRealSol: 1.5,
};

const LAMPORTS_PER_SOL = 1e9;
/** Curve fee taken on a sell (protocol 0.95% + creator 0.30%). */
const CURVE_FEE = 0.0125;

interface CoinBook {
  createdSlot: number;
  /** Price (virtual SOL per virtual token) at creation. */
  createPrice: number;
  creator: Pubkey;
  /** Distinct non-creator wallets that bought. */
  buyers: Set<Pubkey>;
  /** The creator sold at least once. */
  creatorSold: boolean;
  entries: number;
  lastExitSlot: number;
}

interface Ride {
  openedSlot: number;
  bestCloseSol: number;
  /** True once a buy of this ride has filled (otherwise it may still be in flight). */
  buyFilled: boolean;
}

export function createRiderBot(p: RiderParams = DEFAULT_RIDER_PARAMS): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const rides = new Map<Pubkey, Ride>();
  /** Probe round trips in flight, by mint: 'buying' until the buy lands, then 'selling'. */
  const probes = new Map<Pubkey, 'buying' | 'selling'>();
  /** Coins with at least one of my own filled orders (harness closes excluded). */
  const tradedCoins = new Set<Pubkey>();

  const bookOf = (mint: Pubkey): CoinBook => {
    let b = books.get(mint);
    if (b === undefined) {
      b = {
        createdSlot: -1,
        createPrice: 0,
        creator: '',
        buyers: new Set(),
        creatorSold: false,
        entries: 0,
        lastExitSlot: -1e12,
      };
      books.set(mint, b);
    }
    return b;
  };

  /** SOL I would receive for selling `tokens` against (vq, vt), after curve fee and one tx fee. */
  const sellValueSol = (tokens: bigint, vq: number, vt: number, txSol: number): number => {
    const n = Number(tokens);
    if (n <= 0 || vt <= 0) return 0;
    return ((n * vq) / (vt + n) / LAMPORTS_PER_SOL) * (1 - CURVE_FEE) - txSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;

      // Fold this batch's events into the per-coin books.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const b = bookOf(e.mint);
          b.createdSlot = e.slot;
          b.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          b.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          if (e.is_buy) {
            if (e.user !== b.creator) b.buyers.add(e.user);
          } else if (e.user === b.creator) {
            b.creatorSold = true;
          }
        }
        // CompleteEvent: the replay closes any position in the curve; the exit
        // loop below drops the ride tracker once the position is gone.
      }
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) tradedCoins.add(f.mint);
      }

      const orders: OrderInput[] = [];
      const perBatchCap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
      const markByMint = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingCount = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingCount.set(po.order.mint, (pendingCount.get(po.order.mint) ?? 0) + 1);
      }
      const buyPending = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'buy') return true;
        }
        return false;
      };
      const sellPending = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') return true;
        }
        return false;
      };

      // 1) Exits first: stop-loss, trailing stop, max hold. A sell already in
      // flight means wait; a buy in flight means sell what is held now anyway.
      for (const [mint, ride] of rides) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          // The buy may still be in flight (2-slot latency): only drop the
          // tracker once no buy is pending for this mint.
          if (buyPending(mint)) continue;
          rides.delete(mint);
          bookOf(mint).lastExitSlot = slot;
          continue;
        }
        ride.buyFilled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = markByMint.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = sellValueSol(pos.token_amount, vq, vt, txSol);
        if (value > ride.bestCloseSol) ride.bestCloseSol = value;
        const cost = Number(pos.cost_lamports) / LAMPORTS_PER_SOL;
        let exit = false;
        if (value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && ride.bestCloseSol >= cost * (1 + p.trailArm) && value <= ride.bestCloseSol * (1 - p.trailDrop)) {
          exit = true;
        }
        if (!exit && slot - ride.openedSlot >= p.maxHoldSlots) exit = true;
        if (!exit) continue;
        if (sellPending(mint)) continue;
        if (orders.length >= perBatchCap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slipBps });
      }

      // 2) Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, phase] of probes) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingCount.has(mint)) probes.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || pendingCount.has(mint)) continue;
        if (orders.length >= perBatchCap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slipBps });
        if (phase === 'buying') probes.set(mint, 'selling');
      }

      // 3) Runner entries, in first-seen coin order.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
      // committedPositionCount already counts probe mints (held or buy pending),
      // so openSlots is the runner headroom after every open position.
      let openSlots = p.maxRunners - state.committedPositionCount();
      for (const mint of books.keys()) {
        if (orders.length >= perBatchCap || openSlots <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || rides.has(mint) || probes.has(mint)) continue;
        if (pendingCount.has(mint)) continue;
        const b = books.get(mint)!;
        if (b.createdSlot < 0) continue;
        const age = slot - b.createdSlot;
        if (age < 0 || age > p.maxAgeSlots) continue;
        if (b.entries >= p.maxEntriesPerCoin || slot - b.lastExitSlot < p.rebuyCooldown) continue;
        if (b.creatorSold || b.buyers.size < p.minBuyers) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
        if (realSol < p.minRealSol) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (b.createPrice <= 0 || price / b.createPrice - 1 < p.minRunup) continue;
        const sizeCapSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS_PER_SOL;
        let amount = Math.min(sizeCapSol, p.stakeSol);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS_PER_SOL)),
          max_slippage_bps: p.slipBps,
        });
        freeSol -= amount + txSol;
        openSlots--;
        rides.set(mint, { openedSlot: slot, bestCloseSol: 0, buyFilled: false });
        b.entries++;
      }

      // 4) Guardrail probes: until enough distinct coins have traded, open a tiny
      // round trip on the most liquid fresh coin of this batch.
      if (tradedCoins.size < p.probeTargetCoins && probes.size < p.maxProbesOpen && openSlots > 0) {
        const fresh: { mint: Pubkey; realSol: number }[] = [];
        for (const e of batch.events) {
          if (e.event !== 'TradeEvent') continue;
          const mint = e.mint;
          if (rides.has(mint) || probes.has(mint) || pendingCount.has(mint)) continue;
          if (tradedCoins.has(mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
          if (realSol < p.probeMinRealSol) continue;
          fresh.push({ mint, realSol });
        }
        fresh.sort((a, b) => b.realSol - a.realSol || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
        for (const c of fresh) {
          if (orders.length >= perBatchCap || probes.size >= p.maxProbesOpen) break;
          const sizeCapSol = Math.floor(Number(state.maxBuyLamports(c.mint))) / LAMPORTS_PER_SOL;
          if (sizeCapSol < p.probeSol || freeSol < p.probeSol + txSol) break;
          orders.push({
            side: 'buy',
            mint: c.mint,
            quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS_PER_SOL)),
            max_slippage_bps: p.slipBps,
          });
          probes.set(c.mint, 'buying');
          freeSol -= p.probeSol + txSol;
          openSlots--;
        }
      }

      return orders;
    },
  };
}
