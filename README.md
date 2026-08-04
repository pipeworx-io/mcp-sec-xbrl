# mcp-sec-xbrl

SEC XBRL MCP — wraps SEC EDGAR XBRL API (data.sec.gov)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `get_company_facts` | List all XBRL taxonomies and concept tags filed by a company (CIK required). Returns entity name, taxonomy names (us-gaap, dei, etc.), concept count per taxonomy, and a sample of up to 20 tag names each. Use get_company_concept or get_company_financials to retrieve actual numeric values for a specific tag. |
| `get_company_concept` | Get a specific financial metric for a company across all filings. Use this to track revenue, net income, or any XBRL tag over time. Example: get_company_concept(cik: "320193", taxonomy: "us-gaap", tag: "Revenue"). |
| `search_filings` | Search recent SEC filings for a company by CIK. Optionally filter by filing type (10-K, 10-Q, 8-K, etc.). Returns filing dates, types, and accession numbers. |
| `get_company_financials` | High-level summary of a public US company's annual (10-K) financials: revenue, net income, total assets, cash, EPS, etc. Returns clean numerical values with the XBRL tag used and the period-end date. By default returns the most recent fiscal year; pass `fiscal_year_end` to get a specific year (e.g. "2024-12-31" for Tesla FY2024 or just "2024" to auto-match the year). Prefer this over get_company_facts/get_company_concept for any single-company financial snapshot question. Pass a CIK (e.g. "320193") or a ticker (e.g. "AAPL"; auto-resolves to CIK). |

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Sec Xbrl data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
