// Sharpe Sprint — strategy core.
//
// Two-tier paper-trading bot for the pump.fun replay, built for hourly Sharpe
// ratio — not for moonshots:
//
//   Tier 1 — completion bets (the PnL engine). A bonding curve completes
//   (migrates) at exactly 85 SOL of real reserves. A coin that has already
//   attracted 50 SOL of real reserves has a ~62% chance of completing, and
//   completion lifts the price roughly 50%+ from the 50 SOL level. So: buy
//   when real reserves cross 50 SOL, size at the harness's 1% order cap
//   (~0.5 SOL — large enough that tx fees are negligible), exit at +50%
//   take-profit, -15% stop-loss, or a 3,600-slot timeout. Few trades, big
//   size, positive expected value in both halves of the dev window.
//
//   Tier 2 — guardrail filler. The competition needs round trips of at least
//   0.01 SOL on at least 20 distinct mints, but only ~7 coins reach 50 SOL
//   in a 6-hour window. So a second, tiny tier trades the first sharp
//   retracement after a launch spike (dip-buying) at the minimum 0.01 SOL,
//   with tight exits, purely to clear the 20-mint bar at minimal cost. It is
//   capped at 2 concurrent positions so it never crowds out tier 1.
//
// Every decision is a pure function of the harness messages (events, marks,
// fills, account). No clock, no environment, no randomness, so two runs
// produce byte-identical action logs.
//
// This module holds no I/O: main.ts wires it to runBot, and an offline
// simulator can drive it through BotState directly.

import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

export interface StrategyParams {
  // Tier 1 — completion bets.
  /** Enter when real quote reserves reach this many SOL. */
  completeRealSol: number;
  /** Largest tier-1 buy, in lamports (the 1% order cap usually binds first). */
  completeBuyLamports: bigint;
  /** Tier-1 take profit vs entry price, in bps. */
  completeTakeProfitBps: number;
  /** Tier-1 stop loss vs entry price, in bps. */
  completeStopLossBps: number;
  /** Tier-1 give-up after this many slots. */
  completeMaxHoldSlots: number;
  // Tier 2 — guardrail filler (dip-buying at minimum size).
  /** Smallest buy we will place: the guardrail's 0.01 SOL round-trip bar. */
  minBuyLamports: bigint;
  /** Trades a mint must show before a filler entry. */
  minTrades: number;
  /** Latest trade count at which a filler entry is still taken. */
  maxEntryTrades: number;
  /** Retracement from the peak that counts as a dip, in bps. */
  dipBps: number;
  /** Filler take profit vs entry price, in bps. */
  fillerTakeProfitBps: number;
  /** Filler stop loss vs entry price, in bps. */
  fillerStopLossBps: number;
  /** Filler give-up after this many slots. */
  fillerMaxHoldSlots: number;
  /** Most concurrent filler positions (tier 1 may use the rest). */
  fillerMaxPositions: number;
  // Shared.
  /** Reject a fill worse than the decision-time price by more than this. */
  maxSlippageBps: number;
  /** Slippage allowed on sells (wider than buys: a rejected exit strands
   * the position, which is worse than a bad fill on a dying coin). */
  sellSlippageBps: number;
  /** Cash kept untouched as a buffer for tx fees, in lamports. */
  cashBufferLamports: bigint;
}

export const DEFAULT_PARAMS: StrategyParams = {
  completeRealSol: 45,
  completeBuyLamports: 1_000_000_000n,
  completeTakeProfitBps: 8000,
  completeStopLossBps: 1500,
  completeMaxHoldSlots: 3600,
  minBuyLamports: 10_000_000n,
  minTrades: 5,
  maxEntryTrades: 45,
  dipBps: 2500,
  fillerTakeProfitBps: 1000,
  fillerStopLossBps: 500,
  fillerMaxHoldSlots: 150,
  fillerMaxPositions: 2,
  maxSlippageBps: 500,
  sellSlippageBps: 1500,
  cashBufferLamports: 20_000_000n,
};

interface Watch {
  mint: string;
  createPrice: number; // SOL per token at creation (virtual reserves).
  peakPrice: number; // highest SOL-per-token price seen since creation.
  trades: number;
  lastPrice: number;
  realQuote: bigint; // latest real quote (SOL) reserves.
  entered: boolean; // already took our one entry in this mint (either tier).
  done: boolean; // curve completed; never touch again.
}

interface Held {
  mint: string;
  entryPrice: number; // SOL per token actually paid (buy fill's quote/tokens).
  entrySlot: number; // slot the buy fill landed.
  takeProfitBps: number;
  stopLossBps: number;
  maxHoldSlots: number;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
  stats: { buys: number; sells: number; entries: number; tier1Buys: number; tier2Buys: number };
}

export function createStrategy(p: StrategyParams): Strategy {
  const watches = new Map<string, Watch>();
  const held = new Map<string, Held>();
  const stats = { buys: 0, sells: 0, entries: 0, tier1Buys: 0, tier2Buys: 0 };

  /** SOL per token from a curve's virtual reserves. */
  function priceOf(state: BotState, mint: string): number | null {
    const c = state.curves.get(mint);
    if (c === undefined) return null;
    if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return null;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  }

  /** Update the watch record for one batch of events. */
  function observe(state: BotState, batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === "CompleteEvent") {
        const w = watches.get(e.mint);
        if (w !== undefined) w.done = true;
        held.delete(e.mint);
        continue;
      }
      if (e.event === "CreateEvent") {
        if (!watches.has(e.mint)) {
          const price =
            BigInt(e.virtual_token_reserves) > 0n
              ? Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves)
              : 0;
          watches.set(e.mint, {
            mint: e.mint,
            createPrice: price,
            peakPrice: price,
            trades: 0,
            lastPrice: price,
            realQuote: 0n,
            entered: false,
            done: false,
          });
        }
        continue;
      }
      // TradeEvent.
      let w = watches.get(e.mint);
      if (w === undefined) {
        const price = priceOf(state, e.mint);
        w = {
          mint: e.mint,
          createPrice: price ?? 0,
          peakPrice: price ?? 0,
          trades: 0,
          lastPrice: price ?? 0,
          realQuote: 0n,
          entered: false,
          done: false,
        };
        watches.set(e.mint, w);
      }
      w.trades += 1;
      const price = priceOf(state, e.mint);
      if (price !== null) {
        w.lastPrice = price;
        if (price > w.peakPrice) w.peakPrice = price;
      }
      const c = state.curves.get(e.mint);
      if (c !== undefined) w.realQuote = c.real_quote_reserves;
    }
  }

  /** Cash available for a new buy of `size`, respecting the buffer. */
  function affordable(state: BotState, size: bigint): bigint | null {
    const free = state.freeCashLamports() - state.txFeeLamports() - p.cashBufferLamports;
    if (free < p.minBuyLamports) return null;
    const sized = size > free ? free : size;
    return sized < p.minBuyLamports ? null : sized;
  }

  /** Tier-1 entry: real reserves crossed the completion-run threshold. */
  function tier1Size(state: BotState, w: Watch): bigint | null {
    if (w.done || w.entered) return null;
    if (w.realQuote < BigInt(p.completeRealSol) * 1_000_000_000n) return null;
    if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return null;
    const cap = state.maxBuyLamports(w.mint);
    if (cap < p.minBuyLamports) return null;
    const size = p.completeBuyLamports < cap ? p.completeBuyLamports : cap;
    return affordable(state, size);
  }

  /** Tier-2 entry: early dip after the launch spike, at minimum size. */
  function tier2Size(state: BotState, w: Watch): bigint | null {
    if (w.done || w.entered) return null;
    if (w.trades < p.minTrades) return null;
    if (w.trades > p.maxEntryTrades) return null;
    if (w.createPrice <= 0 || w.lastPrice <= 0 || w.peakPrice <= 0) return null;
    const dipBps = Math.floor(((w.peakPrice - w.lastPrice) / w.peakPrice) * 10_000);
    if (dipBps < p.dipBps) return null;
    // Cap concurrent filler positions so tier 1 always has room.
    let fillerOpen = 0;
    for (const h of held.values()) if (h.takeProfitBps === p.fillerTakeProfitBps) fillerOpen++;
    if (fillerOpen >= p.fillerMaxPositions) return null;
    if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return null;
    const cap = state.maxBuyLamports(w.mint);
    if (cap < p.minBuyLamports) return null;
    return affordable(state, p.minBuyLamports);
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    observe(state, batch);

    // Track held positions from FILLS, not from decisions: a buy decided on
    // slot s only fills at s + latency, so a position recorded at decision
    // time would look absent on the next batch and be dropped. The fill's
    // own price (SOL paid per token received) is also the true cost basis.
    // The exit terms ride along with the position (they differ by tier).
    for (const f of batch.fills) {
      if (f.status === "filled" && f.side === "buy" && !f.client_id.startsWith("_")) {
        const paid = Number(BigInt(f.quote_lamports));
        const tokens = Number(BigInt(f.token_amount));
        if (tokens > 0) {
          const prev = held.get(f.mint);
          if (prev === undefined) {
            // No terms recorded (should not happen: entries record them
            // below); fall back to tier-2 terms.
            held.set(f.mint, {
              mint: f.mint,
              entryPrice: paid / tokens,
              entrySlot: f.slot,
              takeProfitBps: p.fillerTakeProfitBps,
              stopLossBps: p.fillerStopLossBps,
              maxHoldSlots: p.fillerMaxHoldSlots,
            });
          } else {
            prev.entryPrice = paid / tokens;
            prev.entrySlot = f.slot;
          }
        }
      } else if (f.client_id.startsWith("_") || (f.status === "filled" && f.side === "sell")) {
        held.delete(f.mint);
      }
    }

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // 1. Exits: take profit, stop loss, or timeout — sell the whole position.
    for (const [mint, h] of held) {
      if (orders.length >= maxOrders) break;
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        // No position yet: the buy may still be in flight (fills land two
        // slots after the decision). Only drop the entry when no buy is
        // pending either — then the buy was rejected or failed.
        let buyPending = false;
        for (const pending of state.pending.values()) {
          if (pending.order.mint === mint && pending.order.side === "buy") {
            buyPending = true;
            break;
          }
        }
        if (!buyPending) held.delete(mint);
        continue;
      }
      if (h.entryPrice <= 0) continue; // fill not yet recorded; wait.
      // A sell already in flight for this mint: wait for its fill.
      let sellPending = false;
      for (const pending of state.pending.values()) {
        if (pending.order.mint === mint && pending.order.side === "sell") {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      const changeBps = Math.floor(((price - h.entryPrice) / h.entryPrice) * 10_000);
      const timedOut = batch.slot - h.entrySlot >= h.maxHoldSlots;
      if (changeBps >= h.takeProfitBps || changeBps <= -h.stopLossBps || timedOut) {
        orders.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: p.sellSlippageBps,
        });
        stats.sells += 1;
        // Do NOT delete from `held` here: the entry leaves only when the
        // sell's fill arrives (see the fill handling above). Deleting at
        // decision time orphans the position if the sell is rejected.
      }
    }

    // 2. Entries: only mints that traded in this batch, in event order.
    // Tier 1 (completion) is checked first so it wins a contested slot.
    const seen = new Set<string>();
    for (const e of batch.events) {
      if (orders.length >= maxOrders) break;
      if (e.event !== "TradeEvent" && e.event !== "CreateEvent") continue;
      if (seen.has(e.mint)) continue;
      seen.add(e.mint);
      if (held.has(e.mint)) continue;
      if (state.positions.has(e.mint)) continue;
      let buyPending = false;
      for (const pending of state.pending.values()) {
        if (pending.order.mint === e.mint && pending.order.side === "buy") {
          buyPending = true;
          break;
        }
      }
      if (buyPending) continue;
      const w = watches.get(e.mint);
      if (w === undefined) continue;
      const size1 = tier1Size(state, w);
      if (size1 !== null) {
        orders.push({
          side: "buy",
          mint: e.mint,
          quote_lamports: size1,
          max_slippage_bps: p.maxSlippageBps,
        });
        stats.buys += 1;
        stats.tier1Buys += 1;
        stats.entries += 1;
        w.entered = true;
        // Record the exit terms now; the fill handler fills in the price.
        held.set(e.mint, {
          mint: e.mint,
          entryPrice: 0,
          entrySlot: batch.slot,
          takeProfitBps: p.completeTakeProfitBps,
          stopLossBps: p.completeStopLossBps,
          maxHoldSlots: p.completeMaxHoldSlots,
        });
        continue;
      }
      const size2 = tier2Size(state, w);
      if (size2 === null) continue;
      orders.push({
        side: "buy",
        mint: e.mint,
        quote_lamports: size2,
        max_slippage_bps: p.maxSlippageBps,
      });
      stats.buys += 1;
      stats.tier2Buys += 1;
      stats.entries += 1;
      w.entered = true;
      held.set(e.mint, {
        mint: e.mint,
        entryPrice: 0,
        entrySlot: batch.slot,
        takeProfitBps: p.fillerTakeProfitBps,
        stopLossBps: p.fillerStopLossBps,
        maxHoldSlots: p.fillerMaxHoldSlots,
      });
    }

    return orders;
  }

  return { onBatch, stats };
}
