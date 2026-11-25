// SPDX-License-Identifier: MIT
// Fresh-Curve Momentum Rider — pump.fun replay bot (agent-fun/replay/v2).
// Paper-money bot for make.fun's Pump.fun Bot Sprint: buys young bonding
// curves showing fresh momentum, exits on laddered targets / trailing stop /
// hard stop / time stop. Node 22, stdlib only. Fully deterministic: every
// decision comes from the harness input (hello.seed is the only seed and is
// never used for randomness — no Date.now(), no Math.random()).

import { createInterface } from "node:readline";

// ---------- ratio helpers (BigInt, exact) ----------
interface Ratio {
  n: bigint;
  d: bigint;
}

function cmpRatio(a: Ratio, b: Ratio): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

function scaleRatio(r: Ratio, num: bigint, den: bigint): Ratio {
  return { n: r.n * num, d: r.d * den };
}

function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v);
  return 0n;
}

function eventKind(e: Record<string, unknown>): string {
  const t = String(e.type ?? e.kind ?? "");
  if (/create/i.test(t)) return "create";
  if (/trade/i.test(t)) return "trade";
  if (/complete/i.test(t)) return "complete";
  return "";
}

// ---------- per-mint state ----------
interface EntryInfo {
  price: Ratio; // average entry price (quote lamports per token)
  slot: number; // slot the position was opened
  tp1Done: boolean;
  peak: Ratio; // highest mark price seen since entry
}

interface MintState {
  birthSlot: number;
  p0: Ratio;
  p0Set: boolean; // true once p0 came from a real mark (not the 1/1 default)
  lastPrice: Ratio;
  completed: boolean;
  closed: boolean; // any sell sent for this mint: never buy it again
  trades: { buy: boolean; sol: bigint }[];
  consecBuys: number;
  entry: EntryInfo | null;
  spentFilled: bigint; // lamports of filled buys
  pending: { clientId: string; quote: bigint; seq: number }[];
}

const TARGET_LAMPORTS = 50_000_000n; // 0.05 SOL target per mint
const CASH_RESERVE = 60_000_000n; // 0.06 SOL kept back for sell fees
const MIN_BUY = 100_000n; // dust floor per buy order
const MAX_AGE_SLOTS = 900;
const TIME_STOP_SLOTS = 1200;

const mints = new Map<string, MintState>();
let caps = {
  maxOpenPositions: 5,
  maxOrderBpsOfRealReserve: 100,
  maxOrdersPerBatch: 16,
};
let latencySlots = 2;
let buyCounter = 0;
let sellCounter = 0;

function getMint(mint: string, slot: number, price?: Ratio): MintState {
  let s = mints.get(mint);
  if (!s) {
    s = {
      birthSlot: slot,
      p0: price ?? { n: 1n, d: 1n },
      p0Set: price !== undefined,
      lastPrice: price ?? { n: 1n, d: 1n },
      completed: false,
      closed: false,
      trades: [],
      consecBuys: 0,
      entry: null,
      spentFilled: 0n,
      pending: [],
    };
    mints.set(mint, s);
  }
  return s;
}

function priceOf(mark: Record<string, unknown>): Ratio {
  return {
    n: toBig(mark.virtual_quote_reserves),
    d: toBig(mark.virtual_token_reserves),
  };
}

function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const c = (msg.caps ?? {}) as Record<string, unknown>;
      caps = {
        maxOpenPositions: Number(c.max_open_positions ?? 5),
        maxOrderBpsOfRealReserve: Number(c.max_order_bps_of_real_reserve ?? 100),
        maxOrdersPerBatch: Number(c.max_orders_per_batch ?? 16),
      };
      latencySlots = Number(msg.latency_slots ?? 2);
      return;
    }
    if (msg.type === "done") {
      process.exit(0);
    }
    if (msg.type !== "batch") return;

    const seq = Number(msg.seq ?? 0);
    const slot = Number(msg.slot ?? 0);
    const events = (msg.events ?? []) as Record<string, unknown>[];
    const marks = (msg.marks ?? []) as Record<string, unknown>[];
    const fills = (msg.fills ?? []) as Record<string, unknown>[];
    const account = (msg.account ?? {}) as Record<string, unknown>;
    const cash = toBig(account.cash_lamports);
    const positions = (account.positions ?? []) as Record<string, unknown>[];
    const held = new Map<string, bigint>();
    const heldCost = new Map<string, bigint>();
    for (const p of positions) {
      const mint = String(p.mint ?? "");
      if (!mint) continue;
      held.set(mint, toBig(p.token_amount));
      heldCost.set(mint, toBig(p.cost_lamports));
    }

    // --- events: creates / trades / completes ---
    for (const e of events) {
      const kind = eventKind(e);
      const mint = String(e.mint ?? "");
      if (!mint) continue;
      if (kind === "create") {
        const s = getMint(mint, Number(e.slot ?? slot));
        s.birthSlot = Number(e.slot ?? slot);
      } else if (kind === "trade") {
        const s = getMint(mint, slot);
        const isBuy =
          e.is_buy === true || String(e.side ?? "") === "buy";
        const sol = toBig(
          (e as Record<string, unknown>).sol_amount ??
            (e as Record<string, unknown>).quote_lamports ??
            0,
        );
        s.trades.push({ buy: isBuy, sol });
        if (s.trades.length > 20) s.trades.shift();
        s.consecBuys = isBuy ? s.consecBuys + 1 : 0;
      } else if (kind === "complete") {
        const s = getMint(mint, slot);
        s.completed = true;
      }
    }

    // --- marks: latest price per mint ---
    for (const m of marks) {
      const mint = String(m.mint ?? "");
      if (!mint) continue;
      const price = priceOf(m);
      if (price.d === 0n) continue;
      const s = getMint(mint, Number(m.slot ?? slot), price);
      if (!s.p0Set) {
        s.p0 = price;
        s.p0Set = true;
      }
      s.lastPrice = price;
      if (s.entry && cmpRatio(price, s.entry.peak) > 0) s.entry.peak = price;
      // stash real reserves on the state for buy sizing
      (s as unknown as Record<string, unknown>).realQuote = toBig(
        m.real_quote_reserves,
      );
    }

    // --- fills: reconcile spent + pending ---
    for (const f of fills) {
      const mint = String(f.mint ?? "");
      if (!mint) continue;
      const s = mints.get(mint);
      if (!s) continue;
      const isBuy = f.is_buy === true || String(f.side ?? "") === "buy";
      const clientId = String(f.client_id ?? "");
      if (isBuy) {
        s.spentFilled += toBig(f.quote_lamports);
        if (clientId) {
          const i = s.pending.findIndex((p) => p.clientId === clientId);
          if (i >= 0) s.pending.splice(i, 1);
        } else if (s.pending.length > 0) {
          s.pending.shift();
        }
      } else {
        if (clientId) {
          const i = s.pending.findIndex((p) => p.clientId === clientId);
          if (i >= 0) s.pending.splice(i, 1);
        }
      }
    }
    // expire stale pending buys (assumed filled-or-rejected after latency)
    for (const s of mints.values()) {
      s.pending = s.pending.filter((p) => seq - p.seq <= latencySlots + 1);
    }

    // --- reconcile entries from account positions (harness truth) ---
    for (const [mint, tokens] of held) {
      if (tokens <= 0n) continue;
      const s = mints.get(mint);
      if (!s || s.completed) continue;
      if (!s.entry) {
        const cost = heldCost.get(mint) ?? 0n;
        const entryPrice =
          cost > 0n
            ? { n: cost, d: tokens }
            : s.lastPrice;
        s.entry = {
          price: entryPrice,
          slot,
          tp1Done: false,
          peak: s.lastPrice,
        };
      }
    }
    for (const [mint, s] of mints) {
      if (s.entry && (held.get(mint) ?? 0n) <= 0n) s.entry = null;
    }

    const orders: Record<string, unknown>[] = [];
    const pushOrder = (o: Record<string, unknown>): void => {
      if (orders.length < caps.maxOrdersPerBatch) orders.push(o);
    };

    // --- sells first (exits outrank new buys) ---
    for (const [mint, tokens] of held) {
      if (tokens <= 0n) continue;
      const s = mints.get(mint);
      if (!s || s.completed || !s.entry) continue;
      const entry = s.entry;
      const price = s.lastPrice;
      let sellTokens = 0n;
      if (cmpRatio(price, scaleRatio(entry.price, 3n, 1n)) >= 0) {
        sellTokens = tokens; // TP2: +200% -> sell all
      } else if (
        cmpRatio(entry.peak, scaleRatio(entry.price, 2n, 1n)) >= 0 &&
        cmpRatio(price, scaleRatio(entry.peak, 7n, 10n)) <= 0
      ) {
        sellTokens = tokens; // trailing: peaked +100%, fell 30% from peak
      } else if (cmpRatio(price, scaleRatio(entry.price, 7n, 10n)) <= 0) {
        sellTokens = tokens; // stop loss: -30% from entry
      } else if (slot - entry.slot > TIME_STOP_SLOTS && !entry.tp1Done) {
        sellTokens = tokens; // time stop: no TP1 after ~1200 slots
      } else if (
        !entry.tp1Done &&
        cmpRatio(price, scaleRatio(entry.price, 9n, 5n)) >= 0
      ) {
        sellTokens = tokens / 2n; // TP1: +80% -> sell half
        if (sellTokens > 0n) entry.tp1Done = true;
      }
      if (sellTokens > 0n) {
        sellCounter += 1;
        s.closed = true; // never buy this mint again after any exit
        pushOrder({
          side: "sell",
          client_id: `s${sellCounter}`,
          mint,
          token_amount: sellTokens.toString(),
          max_slippage_bps: 300,
        });
      }
    }

    // --- buys: young, rising, buy-dominated curves not yet closed ---
    // open = held tokens, or spent/pending buys on an unclosed mint
    let openPositions = 0;
    for (const [mint, s] of mints) {
      if (s.closed) continue;
      if (
        (held.get(mint) ?? 0n) > 0n ||
        s.spentFilled > 0n ||
        s.pending.length > 0
      ) {
        openPositions += 1;
      }
    }
    for (const [mint, s] of mints) {
      if (orders.length >= caps.maxOrdersPerBatch) break;
      if (s.completed || s.closed || !s.lastPrice) continue;
      if (openPositions >= caps.maxOpenPositions) break;
      if (slot - s.birthSlot > MAX_AGE_SLOTS) continue;
      // price up >= 25% from birth, not already > 3x birth (no top-chasing)
      if (cmpRatio(s.lastPrice, scaleRatio(s.p0, 5n, 4n)) < 0) continue;
      if (cmpRatio(s.lastPrice, scaleRatio(s.p0, 3n, 1n)) >= 0) continue;
      // buy dominance: >= 60% of last-20-trade volume, or >= 3 buys in a row
      let buyVol = 0n;
      let totalVol = 0n;
      for (const t of s.trades) {
        totalVol += t.sol;
        if (t.buy) buyVol += t.sol;
      }
      const dominant =
        (totalVol > 0n && buyVol * 5n >= totalVol * 3n) ||
        s.consecBuys >= 3;
      if (!dominant) continue;
      const pendingQuote = s.pending.reduce((a, p) => a + p.quote, 0n);
      const remaining = TARGET_LAMPORTS - s.spentFilled - pendingQuote;
      if (remaining <= 0n) continue;
      const realQuote =
        ((s as unknown as Record<string, unknown>).realQuote as bigint) ?? 0n;
      const capByReserve =
        (realQuote * BigInt(caps.maxOrderBpsOfRealReserve)) / 10000n;
      const cashAvail = cash - CASH_RESERVE;
      let size = remaining;
      if (capByReserve > 0n && capByReserve < size) size = capByReserve;
      if (cashAvail < size) size = cashAvail;
      if (size < MIN_BUY) continue;
      const wasOpen =
        (held.get(mint) ?? 0n) > 0n ||
        s.spentFilled > 0n ||
        s.pending.length > 0;
      buyCounter += 1;
      const clientId = `b${buyCounter}`;
      s.pending.push({ clientId, quote: size, seq });
      if (!wasOpen) openPositions += 1;
      pushOrder({
        side: "buy",
        client_id: clientId,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: 300,
      });
    }

    process.stdout.write(
      JSON.stringify({ type: "reply", seq, orders }) + "\n",
    );
  });
}

main();
