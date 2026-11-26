// Sharpe Sprint Bot — entrypoint.
//
// Speaks agent-fun/replay/v2 on stdin/stdout through the kit's protocol shim.
// The strategy lives in strategy.ts; this file only wires it up. Run with
// `node main.ts` on Node 22+ (the grader runs `node /bot/main.ts`).

import { runBot } from "./vendor/makefun-bot.ts";
import { createStrategy, DEFAULT_PARAMS } from "./strategy.ts";

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state) {
    console.error(
      `done: batches=${state.seq + 1} cash=${state.cash} positions=${state.positions.size} buys=${strategy.stats.buys} sells=${strategy.stats.sells}`,
    );
  },
});
