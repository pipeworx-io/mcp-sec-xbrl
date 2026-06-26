interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * SEC XBRL MCP — wraps SEC EDGAR XBRL API (data.sec.gov)
 *
 * Free, no authentication required. User-Agent header is required by SEC.
 * Provides structured financial data from SEC filings.
 *
 * Tools:
 * - get_company_facts: get all XBRL facts for a company (financial statements)
 * - get_company_concept: get a specific financial metric across all filings
 * - search_filings: search recent SEC filings for a company
 * - get_company_financials: high-level convenience — revenue, net income, assets, etc.
 *   from the most recent 10-K, picking the right XBRL tag automatically.
 */


const BASE_URL = 'https://data.sec.gov';
const EFTS_URL = 'https://efts.sec.gov/LATEST';
const USER_AGENT = 'Pipeworx/1.0 (pipeworx.io)';

async function secGet(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    // SEC returns S3-style XML error bodies on 404 — extract <Code> / <Message>
    // so callers see "NoSuchKey: The specified key does not exist" instead of
    // 200 chars of escaped XML. Production analytics 2026-06-08: 6x
    // get_company_concept 404s, all with the same indecipherable XML envelope.
    // Same pattern we used for FMI on 2026-06-06.
    const code = /<Code>([^<]+)<\/Code>/i.exec(text)?.[1];
    const message = /<Message>([^<]+)<\/Message>/i.exec(text)?.[1];
    if (code || message) {
      const human = [code, message].filter(Boolean).join(': ');
      const hint = res.status === 404
        ? ' (CIK or concept tag not found — for company concepts try common ones like Revenues, NetIncomeLoss, Assets; verify the CIK via edgar_ticker_to_cik)'
        : '';
      throw new Error(`SEC API error (${res.status}): ${human}${hint}`);
    }
    throw new Error(`SEC API error (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

function padCik(cik: string): string {
  if (typeof cik !== 'string' || !cik.trim()) {
    throw new Error('Required argument "cik" is missing or empty. Pass a CIK like "320193" or "0000320193".');
  }
  // SEC requires 10-digit zero-padded CIK
  const cleaned = cik.replace(/^0+/, '').replace(/\D/g, '');
  return cleaned.padStart(10, '0');
}

const tools: McpToolExport['tools'] = [
  {
    name: 'get_company_facts',
    description:
      'List all XBRL taxonomies and concept tags filed by a company (CIK required). Returns entity name, taxonomy names (us-gaap, dei, etc.), concept count per taxonomy, and a sample of up to 20 tag names each. Use get_company_concept or get_company_financials to retrieve actual numeric values for a specific tag.',
    inputSchema: {
      type: 'object',
      properties: {
        cik: {
          type: 'string',
          description: 'SEC Central Index Key (e.g., "320193" for Apple, "789019" for Microsoft)',
        },
      },
      required: ['cik'],
    },
  },
  {
    name: 'get_company_concept',
    description:
      'Get a specific financial metric for a company across all filings. Use this to track revenue, net income, or any XBRL tag over time. Example: get_company_concept(cik: "320193", taxonomy: "us-gaap", tag: "Revenue").',
    inputSchema: {
      type: 'object',
      properties: {
        cik: {
          type: 'string',
          description: 'SEC Central Index Key (e.g., "320193" for Apple)',
        },
        taxonomy: {
          type: 'string',
          description: 'XBRL taxonomy: "us-gaap", "ifrs-full", "dei", or "srt"',
        },
        tag: {
          type: 'string',
          description: 'XBRL concept tag (e.g., "Revenue", "NetIncomeLoss", "Assets", "EarningsPerShareBasic")',
        },
      },
      required: ['cik', 'taxonomy', 'tag'],
    },
  },
  {
    name: 'search_filings',
    description:
      'Search recent SEC filings for a company by CIK. Optionally filter by filing type (10-K, 10-Q, 8-K, etc.). Returns filing dates, types, and accession numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        cik: {
          type: 'string',
          description: 'SEC Central Index Key (e.g., "320193" for Apple)',
        },
        type: {
          type: 'string',
          description: 'Filing type filter (e.g., "10-K", "10-Q", "8-K", "DEF 14A")',
        },
      },
      required: ['cik'],
    },
  },
  {
    name: 'get_company_financials',
    description:
      'High-level summary of a public US company\'s annual (10-K) financials: revenue, net income, total assets, cash, EPS, etc. Returns clean numerical values with the XBRL tag used and the period-end date. By default returns the most recent fiscal year; pass `fiscal_year_end` to get a specific year (e.g. "2024-12-31" for Tesla FY2024 or just "2024" to auto-match the year). Prefer this over get_company_facts/get_company_concept for any single-company financial snapshot question. Pass a CIK (e.g. "320193") or a ticker (e.g. "AAPL"; auto-resolves to CIK).',
    inputSchema: {
      type: 'object',
      properties: {
        company: {
          type: 'string',
          description: 'CIK (e.g., "320193", "0000320193") OR ticker symbol (e.g., "AAPL", "TSLA", "MSFT"). Ticker is auto-resolved to CIK via SEC EDGAR.',
        },
        fiscal_year_end: {
          type: 'string',
          description: 'Optional. Pass a 4-digit fiscal year ("2024") to get values from any 10-K period ending in that calendar year, OR a specific period-end date ("2024-12-31"). Omit to get the most recent fiscal year.',
        },
      },
      required: ['company'],
    },
  },
];

// Pulls the company identifier from any of the common alias names an LLM
// might supply. The schema names "company" or "cik" depending on the tool,
// but agents reach for "ticker", "symbol", or "company" interchangeably in
// production — the prior 21% error rate on this pack was almost entirely
// agents passing `{ticker: "AAPL"}` and getting "Required argument 'company'
// is missing" back. Resolving all aliases in dispatch makes the tools
// LLM-forgiving without breaking the documented schema.
function identifierArg(args: Record<string, unknown>): string {
  return (
    (args.cik as string | undefined) ??
    (args.company as string | undefined) ??
    (args.ticker as string | undefined) ??
    (args.symbol as string | undefined) ??
    ''
  );
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_company_facts':
      return getCompanyFacts(identifierArg(args));
    case 'get_company_concept':
      return getCompanyConcept(
        identifierArg(args),
        args.taxonomy as string,
        args.tag as string,
      );
    case 'search_filings':
      return searchFilings(identifierArg(args), args.type as string | undefined);
    case 'get_company_financials':
      return getCompanyFinancials(identifierArg(args), args.fiscal_year_end as string | undefined);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── ticker → CIK resolution ────────────────────────────────────────────
let TICKER_CACHE: Record<string, string> | null = null;

async function resolveTickerToCik(input: string): Promise<string> {
  const trimmed = input.trim();
  // Already a CIK (digits)?
  if (/^\d+$/.test(trimmed)) return padCik(trimmed);

  if (!TICKER_CACHE) {
    const data = (await secGet('https://www.sec.gov/files/company_tickers.json')) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >;
    TICKER_CACHE = {};
    for (const entry of Object.values(data)) {
      TICKER_CACHE[entry.ticker.toUpperCase()] = String(entry.cik_str);
    }
  }
  const cik = TICKER_CACHE[trimmed.toUpperCase()];
  if (!cik) throw new Error(`Could not resolve ticker "${input}" to a SEC CIK. Try passing the CIK directly.`);
  return padCik(cik);
}

// ── high-level financials ──────────────────────────────────────────────
const REVENUE_TAGS = [
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'SalesRevenueNet',
  'SalesRevenueGoodsNet',
];

interface XbrlEntry {
  val: number;
  fy: number;
  fp: string;
  end: string;
  filed: string;
  form: string;
}

interface XbrlFact {
  label: string;
  units: Record<string, XbrlEntry[]>;
}

// Sort by `end` (period end date) descending, not `fy` (filing year). A 10-K
// filed in 2025 contains comparative data for FY2023, FY2024, AND FY2025 — all
// stamped fy=2025 since fy is the filing context, not the reported period.
// `end` is the actual period-end date, which is what we want.
//
// If `targetEnd` is provided, pick the entry whose `end` matches (exact date
// or 4-digit year prefix). Otherwise return the most recent annual entry.
function pickAnnual(
  facts: Record<string, XbrlFact>,
  tag: string,
  targetEnd?: string,
): (XbrlEntry & { tag: string; label: string }) | null {
  const fact = facts[tag];
  if (!fact) return null;
  const entries = fact.units?.['USD'] ?? fact.units?.['USD/shares'] ?? fact.units?.['shares'] ?? [];
  let annual = entries.filter((e) => e.form === '10-K' && e.fp === 'FY');
  if (targetEnd) {
    // Accept either full ISO date or 4-digit year prefix
    annual = annual.filter((e) =>
      /^\d{4}$/.test(targetEnd) ? e.end?.startsWith(targetEnd) : e.end === targetEnd,
    );
  }
  annual.sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''));
  if (!annual[0]) return null;
  return { tag, label: fact.label, ...annual[0] };
}

// Pick whichever candidate tag has the most recent annual entry — companies
// change which us-gaap tag they use over time (e.g. MSFT switched from
// "Revenues" to "RevenueFromContractWithCustomerExcludingAssessedTax" after
// ASC 606), so first-match-wins returns stale data.
function bestMatch(facts: Record<string, XbrlFact>, tagCandidates: string[], targetEnd?: string) {
  let best: (XbrlEntry & { tag: string; label: string }) | null = null;
  for (const tag of tagCandidates) {
    const hit = pickAnnual(facts, tag, targetEnd);
    if (!hit) continue;
    if (!best || (hit.end ?? '') > (best.end ?? '')) best = hit;
  }
  return best;
}

async function getCompanyFinancials(company: string, fiscalYearEnd?: string) {
  if (typeof company !== 'string' || !company.trim()) {
    throw new Error('Required argument "company" is missing or empty. Pass a CIK like "320193" or a ticker like "AAPL".');
  }
  const cik = await resolveTickerToCik(company);
  const data = (await secGet(
    `${BASE_URL}/api/xbrl/companyfacts/CIK${cik}.json`,
  )) as {
    cik: number;
    entityName: string;
    facts: { 'us-gaap'?: Record<string, XbrlFact> };
  };
  const usGaap = data.facts?.['us-gaap'] ?? {};

  const revenue = bestMatch(usGaap, REVENUE_TAGS, fiscalYearEnd);

  return {
    cik: String(data.cik),
    entity_name: data.entityName,
    period_end: revenue?.end ?? null,
    fiscal_year: revenue?.fy ?? null,
    revenue,
    net_income: bestMatch(usGaap, ['NetIncomeLoss'], fiscalYearEnd),
    total_assets: bestMatch(usGaap, ['Assets'], fiscalYearEnd),
    total_liabilities: bestMatch(usGaap, ['Liabilities'], fiscalYearEnd),
    stockholders_equity: bestMatch(usGaap, ['StockholdersEquity'], fiscalYearEnd),
    cash_and_equivalents: bestMatch(usGaap, [
      'CashAndCashEquivalentsAtCarryingValue',
      'Cash',
    ], fiscalYearEnd),
    operating_income: bestMatch(usGaap, ['OperatingIncomeLoss'], fiscalYearEnd),
    gross_profit: bestMatch(usGaap, ['GrossProfit'], fiscalYearEnd),
    rnd_expense: bestMatch(usGaap, ['ResearchAndDevelopmentExpense'], fiscalYearEnd),
    eps_basic: bestMatch(usGaap, ['EarningsPerShareBasic'], fiscalYearEnd),
    eps_diluted: bestMatch(usGaap, ['EarningsPerShareDiluted'], fiscalYearEnd),
    common_shares_outstanding: bestMatch(usGaap, ['CommonStockSharesOutstanding'], fiscalYearEnd),
  };
}

async function getCompanyFacts(cik: string) {
  const paddedCik = padCik(cik);
  const data = (await secGet(
    `${BASE_URL}/api/xbrl/companyfacts/CIK${paddedCik}.json`,
  )) as {
    cik: number;
    entityName: string;
    facts: Record<
      string,
      Record<
        string,
        {
          label: string;
          description: string;
          units: Record<string, Array<{ val: number; fy: number; fp: string; end: string; filed: string }>>;
        }
      >
    >;
  };

  // Summarize the available facts rather than returning everything
  const taxonomies: Record<string, string[]> = {};
  for (const [taxonomy, concepts] of Object.entries(data.facts)) {
    taxonomies[taxonomy] = Object.keys(concepts);
  }

  return {
    cik: data.cik,
    entity_name: data.entityName,
    taxonomies: Object.entries(taxonomies).map(([name, tags]) => ({
      taxonomy: name,
      concept_count: tags.length,
      sample_tags: tags.slice(0, 20),
    })),
  };
}

async function getCompanyConcept(cik: string, taxonomy: string, tag: string) {
  const paddedCik = padCik(cik);
  const data = (await secGet(
    `${BASE_URL}/api/xbrl/companyconcept/CIK${paddedCik}/${encodeURIComponent(taxonomy)}/${encodeURIComponent(tag)}.json`,
  )) as {
    cik: number;
    entityName: string;
    tag: string;
    taxonomy: string;
    label: string;
    description: string;
    units: Record<
      string,
      Array<{
        val: number;
        fy: number;
        fp: string;
        end: string;
        start?: string;
        filed: string;
        accn: string;
        form: string;
      }>
    >;
  };

  const units: Record<string, unknown[]> = {};
  for (const [unit, entries] of Object.entries(data.units)) {
    // Return the most recent entries (last 20)
    units[unit] = entries.slice(-20).map((e) => ({
      value: e.val,
      fiscal_year: e.fy,
      fiscal_period: e.fp,
      period_end: e.end,
      filed: e.filed,
      form: e.form,
    }));
  }

  return {
    cik: data.cik,
    entity_name: data.entityName,
    tag: data.tag,
    taxonomy: data.taxonomy,
    label: data.label,
    description: data.description,
    units,
  };
}

async function searchFilings(cik: string, type?: string) {
  const paddedCik = padCik(cik);
  const data = (await secGet(
    `${BASE_URL}/submissions/CIK${paddedCik}.json`,
  )) as {
    cik: string;
    entityType: string;
    name: string;
    tickers: string[];
    exchanges: string[];
    ein: string;
    sic: string;
    sicDescription: string;
    stateOfIncorporation: string;
    filings: {
      recent: {
        accessionNumber: string[];
        filingDate: string[];
        reportDate: string[];
        form: string[];
        primaryDocument: string[];
        primaryDocDescription: string[];
      };
    };
  };

  const recent = data.filings.recent;
  let filings = recent.accessionNumber.map((accn, i) => ({
    accession_number: accn,
    filing_date: recent.filingDate[i],
    report_date: recent.reportDate[i],
    form: recent.form[i],
    document: recent.primaryDocument[i],
    description: recent.primaryDocDescription[i],
  }));

  if (type) {
    filings = filings.filter((f) =>
      f.form?.toLowerCase() === type.toLowerCase(),
    );
  }

  return {
    cik: data.cik,
    name: data.name,
    tickers: data.tickers,
    exchanges: data.exchanges,
    sic: data.sic,
    sic_description: data.sicDescription,
    state_of_incorporation: data.stateOfIncorporation,
    filing_count: filings.length,
    filings: filings.slice(0, 25),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
