interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Company-name matching for SEC filer lookups.
 *
 * WHY THIS IS SHARED AND NOT PER-PACK. Two independent resolvers already drifted
 * apart and the drift was customer-visible: the facts contract fixed its name
 * matching on 2026-09-15 while sec-xbrl's `get_company_financials` kept the old
 * rule, so "Stanley Black and Decker revenue fiscal 2024" answered through one
 * path and returned "we do not have a source for that" through the other, on the
 * same question, minutes apart. One copy, imported by both, is the only thing
 * that stops the next divergence — and publish-pack.sh inlines `@pipeworx/shared`
 * into standalone pack repos, so a pack can depend on this without gaining a
 * runtime dependency.
 *
 * WHY IT IS NOT FOLDED INTO shared's generic rankMatches: that helper is run by
 * other packs over drugs, airports and tickers, where stripping words like CO
 * and LIMITED would silently change matching for callers who never asked for it.
 * This one is explicitly about companies, and callers opt in by name.
 */

/**
 * Words that appear in a registered corporate name without identifying the
 * company. Each earns its place by appearing in SEC's own `title` field or in
 * how people type the same filer; a word that only adds a synonym would be
 * applied inconsistently and quietly widen every match.
 */
const GENERIC_COMPANY_WORDS = new Set([
  'CORP', 'CORPORATION', 'INC', 'INCORPORATED', 'CO', 'COMPANY', 'COMPANIES',
  'LTD', 'LIMITED', 'LLC', 'LP', 'PLC', 'SA', 'NV', 'AG', 'THE',
]);

/**
 * A company name reduced to the part that identifies the company: ampersands
 * spelled out, punctuation dropped, generic corporate words removed.
 *
 * "WHIRLPOOL CORP" and "Whirlpool Corporation" both become "WHIRLPOOL".
 * "STANLEY BLACK & DECKER, INC." and "Stanley Black and Decker" both become
 * "STANLEY BLACK AND DECKER".
 *
 * The two failures this exists for are worth naming, because neither is a typo
 * and both look like the caller's fault:
 *  - SEC files Masco as "MASCO CORP", so the query "Masco Corporation" is
 *    LONGER than the title and is therefore not even a prefix of it. Every
 *    prefix/substring rule fails on a correctly-spelled full company name.
 *  - SEC writes "&"; people type "and".
 */
function companyNameKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[.,'`’/()\-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !GENERIC_COMPANY_WORDS.has(w))
    .join(' ')
    .trim();
}

/** One row of SEC's company_tickers.json, reduced to what matching needs. */
interface FilerNameRow {
  cik: string;
  /** SEC's `title`, as filed. */
  title: string;
}

/**
 * Pick the filer a name refers to, or null.
 *
 * Pass 1 matches the filed name as written (exact, then prefix, then substring,
 * shortest title first so "NVIDIA CORP" beats "NVIDIA MELLANOX ..."). Pass 2
 * retries on the identifying part, and runs ONLY when pass 1 found nothing —
 * so a name that already matches as filed keeps the more precise answer.
 *
 * NOTE ON DUPLICATE ROWS, because the obvious defensive code here would be dead.
 * SEC's ticker map is one row per SECURITY, so a filer with preferred shares or
 * multiple classes appears several times under the same CIK and title —
 * Whirlpool as WHR and WHR-PA, Alphabet as GOOGL and GOOG. Collapsing by CIK
 * before choosing changes NOTHING here, because this function returns a single
 * winner and duplicates of one filer all carry that filer's CIK. I wrote the
 * collapse, then removed it when a mutation test could not make it fail — an
 * unexercised guard reads as protection and provides none.
 *
 * A caller that reports how MANY filers matched, or declares ambiguity, DOES
 * need to collapse first, or one company with two share classes looks like two
 * companies. That is a property of the caller, not of this matcher.
 */
function matchFilerByName(
  input: string,
  rows: readonly FilerNameRow[],
): { cik: string; title: string } | null {
  const shortestTitleFirst = (a: FilerNameRow, b: FilerNameRow) => a.title.length - b.title.length;

  const pickFrom = (q: string, keyOf: (row: FilerNameRow) => string): FilerNameRow | null => {
    if (q.length < 2) return null;
    const exact: FilerNameRow[] = [];
    const prefix: FilerNameRow[] = [];
    const contains: FilerNameRow[] = [];
    for (const row of rows) {
      const title = keyOf(row);
      if (title === q) exact.push(row);
      else if (title.startsWith(`${q} `)) prefix.push(row);
      else if (title.includes(q)) contains.push(row);
    }
    for (const bucket of [exact, prefix, contains]) {
      if (bucket.length === 0) continue;
      return [...bucket].sort(shortestTitleFirst)[0] ?? null;
    }
    return null;
  };

  const asFiled = pickFrom(normaliseFiledName(input), (r) => normaliseFiledName(r.title));
  if (asFiled) return { cik: asFiled.cik, title: asFiled.title };

  const byKey = pickFrom(companyNameKey(input), (r) => companyNameKey(r.title));
  return byKey ? { cik: byKey.cik, title: byKey.title } : null;
}

/** Upper-cased, punctuation-stripped, whitespace-collapsed — the name as filed,
 *  with nothing removed. Pass 1 compares on this so an exact filed name wins
 *  before any corporate word is dropped. */
function normaliseFiledName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 &]/g, ' ').replace(/\s+/g, ' ').trim();
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'SEC Xbrl');
}


const BASE_URL = 'https://data.sec.gov';
const EFTS_URL = 'https://efts.sec.gov/LATEST';
// SEC's fair-access policy 403s a User-Agent without a contact. The edgar pack's
// working UA includes the email; a bare "pipeworx.io" was getting SEC 403s
// (get_company_financials failed on real traffic, e.g. NVIDIA financials).
const USER_AGENT = 'Pipeworx/1.0 (support@pipeworx.io)';

async function secGet<T = unknown>(url: string): Promise<T> {
  const res = await pwFetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 10_000);
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
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > 15_000_000) throw new Error('SEC API response exceeded size limit');
  const text = await res.text();
  if (new TextEncoder().encode(text).length > 15_000_000) throw new Error('SEC API response exceeded size limit');
  return JSON.parse(text) as T;
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
  {
    name: 'get_liquidity_runway',
    description: 'Estimate a company’s mechanical liquidity runway from its latest SEC-tagged cash/current investments and trailing-twelve-month operating cash flow. This is a screening calculation—not management guidance—and excludes future financing, commitments, restricted access, working-capital timing, and forecast changes.',
    inputSchema: { type: 'object', properties: { company: { type: 'string', description: 'Ticker, company name, or CIK.' } }, required: ['company'] },
  },
  {
    name: 'get_dilution_profile',
    description: 'Summarize SEC-tagged common shares outstanding, approximate year-over-year share change, and reported equity issuance proceeds. Share-count dates need not equal quarter end, tags vary by filer, and this is not a fully diluted capitalization table.',
    inputSchema: { type: 'object', properties: { company: { type: 'string', description: 'Ticker, company name, or CIK.' } }, required: ['company'] },
  },
  {
    name: 'get_rnd_burn_profile',
    description: 'Calculate trailing-twelve-month SEC-tagged R&D expense and operating cash flow using annual plus current YTD minus prior-year comparable YTD. Returns the periods used and null when a defensible bridge cannot be built.',
    inputSchema: { type: 'object', properties: { company: { type: 'string', description: 'Ticker, company name, or CIK.' } }, required: ['company'] },
  },
  {
    name: 'get_capital_markets_filings',
    description: 'List recent SEC capital-markets filings for a company — shelf and IPO registrations (S-1, S-3, S-3ASR and the F- equivalents), 424 prospectuses, free-writing prospectuses, effectiveness notices and post-effective amendments. Answers "has this company filed a shelf", "what has it registered recently" and "is there an active ATM programme on file". A registration or prospectus filing is an event, so it does not prove securities were sold or quantify remaining shelf or ATM capacity, and an empty result covers only the years requested — a company may hold an effective shelf filed before that window.',
    inputSchema: { type: 'object', properties: {
      company: { type: 'string', description: 'Ticker, company name, or CIK.' },
      years: { type: 'number', description: 'Look-back, 1–10 years (default 3).' }, limit: { type: 'number', description: '1–100 (default 25).' },
    }, required: ['company'] },
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
    case 'get_liquidity_runway':
      return getLiquidityRunway(identifierArg(args));
    case 'get_dilution_profile':
      return getDilutionProfile(identifierArg(args));
    case 'get_rnd_burn_profile':
      return getRndBurnProfile(identifierArg(args));
    case 'get_capital_markets_filings':
      return getCapitalMarketsFilings(identifierArg(args), args.years, args.limit);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * The refusal shown when `company` names nothing in SEC's registrant list.
 * Exported so the test pins the TEXT CALLERS ACTUALLY SEE — a test that
 * reconstructs the sentence locally passes happily while the real message
 * drifts, which is the failure this whole pack keeps running into.
 */
export function unresolvedCompanyMessage(input: string): string {
  return (
    `Could not resolve "${input}" to a SEC CIK. Searched SEC's registrant list by CIK, then ticker, then company name; none matched. ` +
    `This tool answers only for filers in that list, so if "${input}" is a private or non-US company, or an identifier of some other kind ` +
    `(a document, dataset, accession or database id), no ticker or CIK form of it will resolve here and retrying it will fail the same way. ` +
    `If you have the company's name, search for the filer by name first; if the value is not a company at all, this is the wrong tool for it.`
  );
}

// ── ticker/name → CIK resolution ───────────────────────────────────────
let TICKER_CACHE: Record<string, string> | null = null;
let NAME_ENTRIES: Array<{ cik: string; title: string }> | null = null;


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
    NAME_ENTRIES = [];
    for (const entry of Object.values(data)) {
      TICKER_CACHE[entry.ticker.toUpperCase()] = String(entry.cik_str);
      // Store the title AS FILED. The shared matcher normalises per pass —
      // pre-normalising here would destroy the '&' that pass 2 depends on.
      NAME_ENTRIES.push({ cik: String(entry.cik_str), title: entry.title });
    }
  }
  const cik = TICKER_CACHE[trimmed.toUpperCase()];
  if (cik) return padCik(cik);

  // Name fallback: the router often passes a company NAME ("NVIDIA") not a
  // ticker.
  //
  // This used to match only the name AS FILED, and that failed on correctly
  // spelled full company names. Measured live 2026-09-15: "MASCO" resolved but
  // "Masco Corporation" did NOT, because SEC files it as "MASCO CORP" — the
  // query is LONGER than the title, so it is not even a prefix of it. Same for
  // "Whirlpool Corporation" (filed "WHIRLPOOL CORP") and "Stanley Black and
  // Decker" (filed "STANLEY BLACK & DECKER, INC.", where SEC writes & and
  // people type and). Those are the names a router hands over, so the tool
  // refused the exact inputs it exists to serve.
  //
  // fixed once, in the facts contract's own resolver, and the sec-xbrl resolver
  // did not get that fix — so the same question answered through one path and
  // returned "we do not have a source for that" through the other, minutes
  // apart. A single shared implementation is what stops the next divergence.
  if (NAME_ENTRIES) {
    const hit = matchFilerByName(trimmed, NAME_ENTRIES);
    if (hit) return padCik(hit.cik);
  }
  // The old text was "Pass the ticker or CIK directly", which presumes the
  // caller HAS a filer and merely formatted it wrong. Measured 2026-09-14: this
  // tool is called directly (not through our router) with values that are not
  // companies at all -- JSON, PMID, DOI, TCGA, WDQS, OGRN -- ~70 customer
  // failures in 30 days, spread across many callers, several of them repeating
  // the same dead value 3-5 times. Telling an agent holding a PubMed id to
  // "pass the ticker directly" is what buys those retries: it names the
  // argument SHAPE as the problem when the argument's SUBJECT is.
  //
  // Deliberately NOT a denylist of the observed tokens. The next caller arrives
  // with a different acronym, and enumerating an open class is the mistake this
  // pack's sibling rule in the router just had removed (fleet #1984). Instead
  // say what was searched, and say plainly that a non-registrant will not
  // resolve in ANY form -- which is true of every value, listed or not.
  //
  // Accuracy note, checked live rather than assumed: do NOT claim funds or ETFs
  // are unsupported. SPY resolves fine (it is an SEC registrant); it fails later
  // with a 404 for absent company facts. QQQ does not resolve. The honest line
  // is about what the registrant list contains, not about asset class.
  throw new Error(unresolvedCompanyMessage(input));
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
  start?: string;
  filed: string;
  form: string;
  accn?: string;
}

interface XbrlFact {
  label: string;
  units: Record<string, XbrlEntry[]>;
}

type CompanyFactsData = { cik: number; entityName: string; facts: Record<string, Record<string, XbrlFact>> };

async function companyFactsData(company: string) {
  if (!company?.trim()) throw new Error('company is required');
  const cik = await resolveTickerToCik(company);
  const data = await secGet<CompanyFactsData>(`${BASE_URL}/api/xbrl/companyfacts/CIK${cik}.json`);
  return { cik, data };
}

function factEntries(facts: Record<string, XbrlFact>, tags: string[], units = ['USD']) {
  for (const tag of tags) {
    const fact = facts[tag];
    if (!fact) continue;
    for (const unit of units) {
      const rows = fact.units?.[unit];
      if (rows?.length) return { tag, label: fact.label, rows };
    }
  }
  return null;
}

function latestByPeriod(rows: XbrlEntry[]) {
  const periods = new Map<string, XbrlEntry>();
  for (const row of rows.filter((entry) => ['10-Q', '10-K'].includes(entry.form))) {
    const key = `${row.start ?? ''}|${row.end}`;
    const prior = periods.get(key);
    if (!prior || row.filed > prior.filed) periods.set(key, row);
  }
  return [...periods.values()];
}

function latestInstant(facts: Record<string, XbrlFact>, tags: string[], units = ['USD']) {
  const found = factEntries(facts, tags, units);
  if (!found) return null;
  const row = [...latestByPeriod(found.rows)].sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0];
  return row ? { ...row, tag: found.tag, label: found.label } : null;
}

function ttmValue(facts: Record<string, XbrlFact>, tags: string[]) {
  const found = factEntries(facts, tags);
  if (!found) return null;
  const rows = latestByPeriod(found.rows).filter((row) => row.start && row.end);
  // For a shared period end prefer the longest duration (earliest start):
  // 10-Q filings often contain both the standalone quarter and YTD fact.
  const latest = [...rows].sort((a, b) => b.end.localeCompare(a.end) || a.start!.localeCompare(b.start!))[0];
  if (!latest) return null;
  const days = (Date.parse(latest.end) - Date.parse(latest.start!)) / 86_400_000;
  if (days >= 330) return { value: latest.val, tag: found.tag, method: 'latest_annual', periods: { annual: latest } };
  const annual = [...rows].filter((row) => row.form === '10-K' && row.end < latest.end)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  const priorStart = `${Number(latest.start!.slice(0, 4)) - 1}${latest.start!.slice(4)}`;
  const priorEnd = `${Number(latest.end.slice(0, 4)) - 1}${latest.end.slice(4)}`;
  const priorYtd = rows.find((row) => row.start === priorStart && row.end === priorEnd);
  if (!annual || !priorYtd) return null;
  return { value: annual.val + latest.val - priorYtd.val, tag: found.tag, method: 'annual_plus_current_ytd_minus_prior_ytd',
    periods: { annual, current_ytd: latest, prior_ytd: priorYtd } };
}

const CASH_TAGS = ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'];
const COMBINED_LIQUIDITY_TAGS = ['CashAndShortTermInvestments'];
const INVESTMENT_TAGS = ['AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'MarketableSecuritiesCurrent', 'ShortTermInvestments'];
const CFO_TAGS = ['NetCashProvidedByUsedInOperatingActivities'];

async function getLiquidityRunway(company: string) {
  const { cik, data } = await companyFactsData(company);
  const gaap = data.facts['us-gaap'] ?? {};
  const combined = latestInstant(gaap, COMBINED_LIQUIDITY_TAGS);
  const cash = latestInstant(gaap, CASH_TAGS);
  const investments = latestInstant(gaap, INVESTMENT_TAGS);
  const sameDateInvestments = cash && investments?.end === cash.end ? investments : null;
  const liquidity = combined?.val ?? ((cash?.val ?? 0) + (sameDateInvestments?.val ?? 0));
  const cashFlow = ttmValue(gaap, CFO_TAGS);
  const burn = cashFlow && cashFlow.value < 0 ? -cashFlow.value : null;
  return { cik, entity_name: data.entityName, liquidity_period_end: combined?.end ?? cash?.end ?? null,
    reported_liquidity: liquidity || null, liquidity_components: combined ? [combined] : [cash, sameDateInvestments].filter(Boolean),
    trailing_twelve_month_operating_cash_flow: cashFlow, mechanical_runway_months: burn && liquidity > 0 ? liquidity / burn * 12 : null,
    scope_note: 'Mechanical runway divides latest tagged cash/current investments by trailing operating cash burn. It is not management guidance and excludes future financing, restricted access, commitments, working-capital timing, debt terms, investment liquidity, and changes in spending or revenue.' };
}

async function getRndBurnProfile(company: string) {
  const { cik, data } = await companyFactsData(company);
  const gaap = data.facts['us-gaap'] ?? {};
  return { cik, entity_name: data.entityName,
    trailing_twelve_month_rnd_expense: ttmValue(gaap, ['ResearchAndDevelopmentExpense']),
    trailing_twelve_month_operating_cash_flow: ttmValue(gaap, CFO_TAGS),
    trailing_twelve_month_net_income_loss: ttmValue(gaap, ['NetIncomeLoss']),
    scope_note: 'TTM values use the latest annual fact plus current YTD minus prior-year comparable YTD when needed. XBRL tag selection and company-specific classifications can differ; these are reported accounting figures, not forecasts.' };
}

async function getDilutionProfile(company: string) {
  const { cik, data } = await companyFactsData(company);
  const gaap = data.facts['us-gaap'] ?? {};
  const dei = data.facts.dei ?? {};
  const shareFact = factEntries(dei, ['EntityCommonStockSharesOutstanding'], ['shares']) ?? factEntries(gaap, ['CommonStockSharesOutstanding'], ['shares']);
  const shares = shareFact ? latestByPeriod(shareFact.rows).sort((a, b) => b.end.localeCompare(a.end)) : [];
  const latest = shares[0] ?? null;
  const priorTarget = latest ? Date.parse(latest.end) - 365 * 86_400_000 : 0;
  const prior = latest ? [...shares].slice(1).sort((a, b) =>
    Math.abs(Date.parse(a.end) - priorTarget) - Math.abs(Date.parse(b.end) - priorTarget))[0] ?? null : null;
  const rawProceeds = ttmValue(gaap, ['ProceedsFromIssuanceOfCommonStock', 'ProceedsFromStockOptionsExercised',
    'ProceedsFromIssuanceOfSharesUnderIncentiveAndShareBasedCompensationPlansIncludingStockOptions']);
  const proceedsEnd = rawProceeds?.periods.current_ytd?.end ?? rawProceeds?.periods.annual?.end;
  const proceeds = latest && proceedsEnd && Date.parse(latest.end) - Date.parse(proceedsEnd) <= 450 * 86_400_000 ? rawProceeds : null;
  return { cik, entity_name: data.entityName, latest_shares_outstanding: latest,
    comparison_shares_outstanding: prior, approximate_share_change_pct: latest && prior && prior.val !== 0 ? (latest.val / prior.val - 1) * 100 : null,
    trailing_twelve_month_reported_equity_proceeds: proceeds,
    scope_note: 'Shares-outstanding facts are reported on specific cover-page dates and do not include all options, warrants, convertibles, RSUs, or subsequent activity. This is not a fully diluted capitalization table; issuance tags vary by filer.' };
}

async function getCapitalMarketsFilings(company: string, yearsArg: unknown, limitArg: unknown) {
  const cik = await resolveTickerToCik(company);
  const years = Math.min(10, Math.max(1, Number(yearsArg) || 3));
  const limit = Math.min(100, Math.max(1, Number(limitArg) || 25));
  const data = await secGet<{ name: string; tickers: string[]; filings: { recent: Record<string, string[]> } }>(`${BASE_URL}/submissions/CIK${cik}.json`);
  const r = data.filings.recent;
  const cutoff = `${new Date().getUTCFullYear() - years}-${new Date().toISOString().slice(5, 10)}`;
  // The suffixed variants matter more than the bare forms for large filers: a WKSI
  // registers on S-3ASR (automatic shelf), never a plain S-3. Anchoring on `S-3$`
  // therefore reported ZERO capital-markets activity for Moderna and Vertex, whose
  // only such filings are S-3ASR, and hid 3 of 10 for Regeneron. MEF is a fee-increase
  // registration, D a dividend-reinvestment shelf, POS AM a post-effective amendment.
  const forms = /^(?:(?:S-1|S-3|F-1|F-3)(?:ASR|MEF|D)?(?:\/A)?|424[AB]\d*(?:\/A)?|FWP|EFFECT|POS ?AM)$/;
  const filings = (r.accessionNumber ?? []).map((accession, index) => ({ accession_number: accession,
    filing_date: r.filingDate?.[index] ?? null, form: r.form?.[index] ?? null, document: r.primaryDocument?.[index] ?? null,
    filing_url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${r.primaryDocument?.[index] ?? ''}` }))
    .filter((filing) => filing.filing_date && filing.filing_date >= cutoff && forms.test(filing.form ?? '')).slice(0, limit);
  return { cik, entity_name: data.name, tickers: data.tickers, years, count: filings.length, filings,
    scope_note: 'Registration statements, prospectuses, free-writing prospectuses, and effectiveness notices are filing events. They do not by themselves prove securities were sold, proceeds were received, or shelf/ATM capacity remains.' };
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
