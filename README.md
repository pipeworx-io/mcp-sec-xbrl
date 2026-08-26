# mcp-sec-xbrl

SEC XBRL MCP — wraps SEC EDGAR XBRL API (data.sec.gov)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `get_company_facts` | List all XBRL taxonomies and concept tags filed by a company (CIK required). Returns entity name, taxonomy names (us-gaap, dei, etc.), concept count per taxonomy, and a sample of up to 20 tag names each. Use get_company_concept or get_company_financials to retrieve actual numeric values for a specific tag. |
| `get_company_concept` | Get a specific financial metric for a company across all filings. Use this to track revenue, net income, or any XBRL tag over time. Example: get_company_concept(cik: "320193", taxonomy: "us-gaap", tag: "Revenue"). |
| `search_filings` | Search recent SEC filings for a company by CIK. Optionally filter by filing type (10-K, 10-Q, 8-K, etc.). Returns filing dates, types, and accession numbers. |
| `get_company_financials` | High-level summary of a public US company's annual (10-K) financials: revenue, net income, total assets, cash, EPS, etc. Returns clean numerical values with the XBRL tag used and the period-end date. By default returns the most recent fiscal year; pass `fiscal_year_end` to get a specific year (e.g. "2024-12-31" for Tesla FY2024 or just "2024" to auto-match the year). Prefer this over get_company_facts/get_company_concept for any single-company financial snapshot question. Pass a CIK (e.g. "320193") or a ticker (e.g. "AAPL"; auto-resolves to CIK). |
| `get_liquidity_runway` | Estimate a company’s mechanical liquidity runway from its latest SEC-tagged cash/current investments and trailing-twelve-month operating cash flow. This is a screening calculation—not management guidance—and excludes future financing, commitments, restricted access, working-capital timing, and forecast changes. |
| `get_dilution_profile` | Summarize SEC-tagged common shares outstanding, approximate year-over-year share change, and reported equity issuance proceeds. Share-count dates need not equal quarter end, tags vary by filer, and this is not a fully diluted capitalization table. |
| `get_rnd_burn_profile` | Calculate trailing-twelve-month SEC-tagged R&D expense and operating cash flow using annual plus current YTD minus prior-year comparable YTD. Returns the periods used and null when a defensible bridge cannot be built. |
| `get_capital_markets_filings` | List recent SEC capital-markets filings for a company — shelf and IPO registrations (S-1, S-3, S-3ASR and the F- equivalents), 424 prospectuses, free-writing prospectuses, effectiveness notices and post-effective amendments. Answers "has this company filed a shelf", "what has it registered recently" and "is there an active ATM programme on file". A registration or prospectus filing is an event, so it does not prove securities were sold or quantify remaining shelf or ATM capacity, and an empty result covers only the years requested — a company may hold an effective shelf filed before that window. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sec-xbrl": {
      "url": "https://gateway.pipeworx.io/sec-xbrl/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sec-xbrl/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sec Xbrl data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
