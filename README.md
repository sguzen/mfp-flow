# mfp·flow

**Live footprint, session volume profile and real aggressor delta for every [MyFundedPerps](https://myfundedperpetuals.com) market**, built on MFP's public market-data stream. No API key, no backend, no account needed. Open the page and read the auction.

### Three surfaces

| | | |
| - | - | - |
| **Web app** | [**sguzen.github.io/mfp-flow**](https://sguzen.github.io/mfp-flow/) | Footprint, Profiles and TPO on any MFP market. Nothing to install. |
| **Chrome extension** | [**download the latest release**](https://github.com/sguzen/mfp-flow/releases/latest) | The same chart beside the MFP terminal, plus your account's entry, stop, target, liquidation and both breach lines. Read-only. |
| **MCP server** | `npm run mcp:build` | Lets Claude or any MCP client ask about auction structure: naked POCs, value migration, initial balance, failed auctions. |

![BTC 5m footprint with session profile](docs/screenshots/btc-5m-dark.png)

## Three views

| Footprint | Profiles | TPO |
| - | - | - |
| Bid × ask per price row with real aggressor delta | Each day's volume profile inside its own time span, plus a composite | Market Profile letters per 30m period, exact from candle highs and lows |

![BTC, 10 days of session profiles with a 10-day composite](docs/screenshots/btc-profiles.png)

![NAS100 TPO](docs/screenshots/nas100-tpo.png)

## What you get

- **Footprint.** Each bar shows aggressive sells (hit bid) × aggressive buys (lift ask) per price row, from MFP's `trades` stream with the aggressor side, plus diagonal imbalances, stacked imbalances, and the bar POC. Intervals are 1m / 5m / 15m / 30m, and the row size is selectable per market.
- **Session volume profile.** POC, a 70% value area (expanded two rows at a time from the POC), and a developing POC line. The session can be the UTC day (crypto) or a CME-style 18:00 ET day (indices, metals); DST is handled.
- **Prior-session context.** Prior POC, VAH, VAL, high and low, plus naked POCs from earlier sessions.
- **Previous days (Profiles view).** Every session's volume profile is drawn in its own time span with VA shading and POC/VAH/VAL labels. History depth is 3, 5 or 10 days.
- **Composite profile.** The right-hand profile can merge the last N days, and the composite VAH/VAL/POC lines are drawn across the chart.
- **TPO (Market Profile).** 30-minute letters A–X then a–x, TPO POC and value area, an initial-balance bracket, range extension, single prints, tails (excess) and poor highs/lows. TPO is time at price, so it is **exact** for every past session; it doesn't depend on recorded trades.
- **Sessions table.** POC, VAH/VAL and value migration (higher / lower / overlapping / inside / outside) for every loaded day.
- **Delta.** Per-bar delta and session CVD from real aggressor flow only. Estimated delta is optional and labelled as such.
- **Auction context markers:** failed auctions vs prior value or extremes (including whether delta backed the break), poor highs and lows, single prints, low-volume nodes, and price-vs-CVD divergence. These describe structure. **They are context, not trade signals.**
- **Every MFP market,** including NAS100 (`xyz:XYZ100`), Gold, S&P 500, stocks and FX on Hyperliquid, and the full Binance perp list. Deep links work: `#XYZ100`, `#BTCUSDT`, `#hyperliquid|xyz:GOLD`.
- Dark and light themes, a local/UTC/New York clock, pan and zoom, a crosshair with per-cell breakdown, and a layout that works on mobile.

![NAS100 session profiles, light theme](docs/screenshots/nas100-profiles-light.png)

## Real vs estimated (read this)

The trade stream is **live-only**. That shapes what you see:

| Data | Source | Shown as |
| - | - | - |
| Bars since you opened the page | recorded trades with the aggressor side | solid cells, real delta |
| Older bars, ~3 days back | 1-minute candles, volume spread evenly over each candle's range | hatched cells, `~` values, delta "n/a" |

Hyperliquid keeps only about 5,000 one-minute candles (~3.5 days), so for HL markets (NAS100, Gold, S&P 500…) older sessions are filled from **30-minute candles**. That's exact for TPO and 30m bars, and an approximation for volume profiles; the panel shows where the switch happens.

Recorded trades are kept in your browser (IndexedDB), so reopening the page keeps your real-delta history. The live recorder reconciles exactly with the venue's 1m candle volume (see `npm run smoke`). Value areas built mostly from candle history are approximations of the true profile.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (value area, TPO, composite, bucketing, footprint, sessions, auction context, links, MCP shaping)
npm run smoke      # 20 s against the live stream: trade counts, dedupe, trade-vs-candle reconciliation, POC/VA
npm run build      # static site in dist/, deployable to any static host (relative paths)
npm run markets    # refresh the bundled market list
npm run mcp:smoke  # build the MCP server and exercise every tool against live data
npm run ext:build  # the browser extension, into dist-ext/ (load unpacked in Chrome)
```

## Ask it questions: the MCP server

The same analytics are exposed over [MCP](https://modelcontextprotocol.io), so Claude Code, Claude Desktop or any MCP client can ask about auction structure on any MFP market. It needs no API key and it is **read-only** — nothing in this project places, modifies or cancels an order.

```bash
npm install && npm run mcp:build
claude mcp add mfp-flow -- node "$PWD/dist-mcp/mfp-flow-mcp.js"
```

Once published to npm this becomes `claude mcp add mfp-flow -- npx -y mfp-flow-mcp`. Then `/mcp` lists the server and four tools:

| Tool | Answers |
| - | - |
| `list_markets(query?)` | which markets exist, with aliases like NAS100 |
| `get_session_profiles(market, days, row?, session?)` | per-session POC, value area, high/low, volume, real share, value migration |
| `get_tpo(market, days, row?, session?)` | TPO POC and value area, initial balance, range extension, single prints, tails, poor highs/lows |
| `get_levels(market, days, session?)` | last price, location vs value, prior levels, naked POCs with distance, composite value, failed auctions |

Try:

- *"Where are NAS100's naked POCs and is value migrating higher this week?"*
- *"Did BTC's initial balance extend today, and did it leave a poor high?"*
- *"Compare where gold is trading against its last five days of value areas."*

Every response carries a `data_quality` block saying what is exact and what is inferred: TPO is exact for any past session, volume is exact but its buy/sell split is only real for the share recorded live, and aggressor delta exists only from the moment the server started. Prices come back as decimal strings at the market's tick, and a short `summary` line is included so an agent can quote one sentence without re-deriving anything. The numbers match the web app for the same settings.

## The browser extension: your account's risk on the chart

A Manifest V3 extension puts the same chart beside the MyFundedPerps terminal,
and — if you give it a **Read Only** API key — draws your own account's levels on it.

**To try it without building anything**, download `mfp-flow-extension.zip` from the
[latest release](https://github.com/sguzen/mfp-flow/releases/latest) and unzip it. Then open
`chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the
unzipped `mfp-flow-extension` folder. Chrome will note that it is an unpacked extension —
expected, since this is not on the Chrome Web Store. The release zip is built by CI from
the tagged source rather than uploaded from a laptop.

**A key is optional.** The chart works with no account at all; a **Read Only** key is only
needed for the account overlay, and a `fp_test_…` key reaches sandbox accounts only, which
is the one to test with.

To build it yourself instead:

```bash
npm install && npm run ext:build     # builds dist-ext/
# chrome://extensions -> Developer mode -> Load unpacked -> select dist-ext/
npm run ext:zip                      # mfp-flow-extension.zip, same layout as the release
```

![The panel inside the MFP terminal, with the account's own levels on the chart](docs/screenshots/extension-overlay.png)

On a `/trade/...` page a **mfp·flow** button opens a resizable panel. It follows the
terminal's market as you switch instruments, mapping the terminal's tickers onto the
stream's (the terminal says XAU where the stream says GOLD, and some of its TradFi
names only exist as Binance perps). If a market has no stream equivalent, the panel
says so and lets you pick one rather than quietly charting something else.

With a key saved, for the market on screen it draws:

- each open position's **entry**, its **stop** and **target** (from working reduce-only
  stop/take orders), and its **liquidation** price;
- two **breach lines** — the price at which this market's move alone would take equity
  to the daily-loss floor and to the max-drawdown floor, exit commission included.

and a strip showing equity, both rooms in dollars and as a share of the allowance, and
the time to the New York daily reset.

### What it will not do

- **It is read-only.** There is no order placement, modification or cancellation code
  anywhere in it. The built bundle contains no non-GET request at all — only
  `GET /v1/positions?status=open` and `GET /v1/orders?status=working`.
- **The key never leaves the background service worker.** It is held in
  `chrome.storage.local` (never `sync`, which would copy it to every signed-in browser),
  it is never handed to the page, the content script or the panel, and no message can
  read it back out. Use a **Read Only** key; a `fp_test_…` key reaches sandbox accounts only.
- **The content script reads the URL and nothing else** about the page.

### What the breach lines are not

They are an estimate for a chart line, not a guarantee. A stop triggers on last price
but fills at a fresh one, funding and swap accrue separately, and your other positions
move too. The maths is in `src/risk/breach.ts` with hand-computed tests; floors are
inclusive, positions on one market are netted first, and a long that cannot reach its
floor even at zero is reported as unreachable rather than drawn at a nonsense price.

The line is where **equity touches the floor** — `mark ± room/size` — which is what MFP
itself breaches on. It was checked against the terminal: on a 1035.11 SOL short at a
mark of 120.772 with $3,968 of daily room, MFP showed a Loss Limit of $124.61 and this
gives $124.6055. Closing a position at that price costs commission, so a real exit
lands a little short of the floor — about $0.037 on that position. That cushion is
reported by `exitCost()` rather than folded into the line, so the line keeps meaning
the same thing the platform's does.

## Open interest and liquidations

- **Open interest.** MFP's stream carries live OI, so it is sampled per minute for every
  market and shown as a ΔOI pane (**Display → Lower pane**): change per bar as signed bars,
  the level as a line. Each session's net change gets the standard four-way reading —
  new longs, short covering, new shorts, long liquidation — with a 0.1% dead zone so a
  move too small to mean anything reads "flat". **Context, not signals.**
- **OI history** exists only for Binance-provider markets, where Binance publishes it
  (CORS-open, so the page reads it directly). One request returns 500 rows, so the
  resolution is chosen to cover the window: 15m for 3–5 days, 30m for 10. It is coarser
  than the bars and is labelled as such. Hyperliquid markets get live OI only and say so;
  their only published figure duplicates what MFP already streams.
- **Liquidations** are Binance-only too (`@forceOrder`), drawn as bubbles at the fill
  price with area proportional to notional — a liquidated long is a forced sell, so it
  takes the sell colour. Binance samples that feed to **one event per second per symbol**,
  so it shows that liquidations happened, not how many; the panel says so. Other venues
  publish none, and the app says *"no public liquidation feed for this venue"* rather
  than inventing one.

A bar with no OI observation is **blank, not zero** — a zero bar would claim "observed,
unchanged" where the truth is "not observed". The same rule holds in the sessions table,
the tooltip and the MCP responses, which return `null` rather than `0`.

## Optional: the 24/7 recorder

The trade stream is live-only, so the browser can only show real aggressor delta from the
moment you opened the page. A machine that stays on can record continuously, and the app
merges those minutes as **real** instead of estimating them from candles.

```bash
MFP_MARKETS="binance|BTCUSDT,hyperliquid|xyz:XYZ100" npm run recorder
# -> http://127.0.0.1:8787  (/minutes, /health)
```

Then paste that URL into **Display -> Recorder URL** in the app. Minutes it has are merged
in as real before the candle fallback; where both the browser and the recorder saw the same
minute, the one with more trades wins.

| Env var | Default | |
| - | - | - |
| `MFP_MARKETS` | BTCUSDT + XYZ100 | comma-separated market ids |
| `MFP_PORT` / `MFP_HOST` | `8787` / `127.0.0.1` | loopback by default |
| `MFP_DB` | `recorder.db` | SQLite file (`node:sqlite`, no native build) |
| `MFP_RETENTION_DAYS` | `14` | older minutes are pruned |

It runs the same `MarketFeed` the browser runs, with SQLite behind the app's own
`Persistence` interface, so there is no second implementation of the footprint, the
tradeId dedupe or the coverage tracking. It is read-only and keyless (public market data
only), which is why `/minutes` serves open CORS.

**Hosting is yours to arrange.** An always-on desktop or a small VPS both work. If you
expose it beyond loopback, put it behind something that terminates TLS, and note that
`/minutes` is readable by anyone who can reach it -- it carries no account data, only
public trades. Nothing is hosted on your behalf.

## Where the data comes from

Everything on the chart is MFP's, with two deliberate exceptions that MFP does not publish.

| Host | What it provides | Whose data |
| - | - | - |
| `wss://api-stream.myfundedperpetuals.com` | trades, 1m candles, marketStats (mark, funding, **live open interest**) | MyFundedPerps |
| `https://developers.myfundedperpetuals.com` | the market list (`/v1/markets`) | MyFundedPerps |
| `https://fapi.binance.com` | **open-interest history** | Binance, called directly |
| `wss://fstream.binance.com` | **forced liquidations** | Binance, called directly |

MFP's stream carries live OI but keeps no history, and carries no liquidation data at all.
Those two gaps are the only reason the page talks to Binance, and it only does so for
**Binance-provider markets** — the ones whose book MFP mirrors from Binance. Hyperliquid
markets (NAS100, Gold, S&P 500) never trigger a Binance request; they show live OI only and
say so, and show no liquidation UI at all.

Note that a market id like `binance|BTCUSDT` is **MFP's own identifier**, naming which venue
MFP mirrors. Seeing it in a link does not mean a request went to Binance.

If you would rather the page spoke only to MFP, turn off **Liquidation bubbles** in Display
and leave the lower pane on CVD — the ΔOI pane still works from MFP's live OI, just without
backfilled history.

The extension additionally calls `developers.` or `sandbox.myfundedperpetuals.com` for your
account, and only when you have given it a key.

## How it uses MFP

- `wss://api-stream.myfundedperpetuals.com/v1/market-data`. One multiplexed connection carries `trades`, `marketStats` (mark, OI, funding) and live `candles`. It also uses `candles.history` paging for backfill, reconnects with backoff and jitter, resubscribes, replaces itself on `draining`, and backfills gaps after reconnects.
- `GET /v1/markets` for the market list. Its CORS policy only allows MFP's docs origin, so the app ships a snapshot (`npm run markets`) and uses the live list when the browser can read it.

## Not affiliated with MyFundedPerps

Analysis tool only. Nothing here is a signal or a recommendation, and nothing here claims an edge.
