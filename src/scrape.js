/**
 * ChatGPT answers, citations and sources on the Bright Data Scraper API, with fetch.
 *
 *     prompt -> trigger -> poll progress -> fetch snapshot -> ChatGPT's answer
 *
 * No dependencies. The JavaScript SDK, `@brightdata/sdk` 1.2.0, wraps this
 * scraper but its input type has no `require_sources`, so this module talks to
 * the API over HTTP and passes every input the scraper accepts. Every call is an
 * asynchronous job: trigger it, poll until the snapshot is ready, download it.
 * On 2026-11-09 an answer took 65 to 282 seconds.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const API = "https://api.brightdata.com/datasets/v3";

/** The one ChatGPT scraper: a prompt in, ChatGPT's answer out, with its citations. */
export const CHATGPT = "gd_m7aof0k82r803d5bjm";

/** Every prompt is sent to this URL. The scraper requires it as an input. */
export const CHATGPT_URL = "https://chatgpt.com/";

/** The slowest answer on 2026-11-09 took 282 seconds; the wait outlasts that comfortably. */
export const TIMEOUT_MS = 900_000;

export const NO_TOKEN = [
  "API token required but not found.",
  "  export BRIGHTDATA_API_TOKEN=YOUR_API_KEY   token: https://brightdata.com/cp/setting/users",
  "  or run once: npx -p @brightdata/cli bdata login",
].join("\n");

/** The API refused a request, or a job ended without a snapshot. */
export class ApiError extends Error {
  name = "ApiError";
}

/** No token in the environment and no Bright Data CLI login. */
export class TokenMissing extends ApiError {
  name = "TokenMissing";
  constructor() {
    super(NO_TOKEN);
  }
}

/**
 * The network and the clock, behind one indirection.
 *
 * ES module exports are read-only bindings, so a test cannot replace an
 * imported function. Going through this object lets the offline tests stand
 * in for the API and skip the waits.
 */
export const transport = {
  fetch: (...args) => globalThis.fetch(...args),
  pollMs: 10_000,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  credentialsPath: () => {
    if (process.platform === "win32") {
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "brightdata-cli", "credentials.json");
    }
    const base = process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config");
    return join(base, "brightdata-cli", "credentials.json");
  },
};

/** BRIGHTDATA_API_TOKEN, else the Bright Data CLI login. Never a key in code. */
export function token() {
  const found = (process.env.BRIGHTDATA_API_TOKEN ?? "").trim();
  if (found) return found;
  try {
    const key = JSON.parse(readFileSync(transport.credentialsPath(), "utf8")).api_key;
    if (key) return key;
  } catch {
    // no login file, or not JSON: same as no login
  }
  throw new TokenMissing();
}

async function call(path, body) {
  const response = await transport.fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(`HTTP ${response.status}: ${text.trim().slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Start a job and return its snapshot id. Error rows are always asked for. */
export async function trigger(datasetId, inputs, { discoverBy, limitPerInput } = {}) {
  const query = new URLSearchParams({ dataset_id: datasetId, include_errors: "true" });
  if (discoverBy) {
    query.set("type", "discover_new");
    query.set("discover_by", discoverBy);
  }
  if (limitPerInput !== undefined) query.set("limit_per_input", String(limitPerInput));
  return (await call(`/trigger?${query}`, inputs)).snapshot_id;
}

/** running, ready or failed. */
export async function status(snapshotId) {
  return (await call(`/progress/${snapshotId}`)).status;
}

/** The rows of a ready snapshot. Snapshots stay downloadable for 30 days. */
export async function fetchSnapshot(snapshotId) {
  const data = await call(`/snapshot/${snapshotId}?format=json`);
  return (Array.isArray(data) ? data : [data]).filter((row) => row && typeof row === "object");
}

/**
 * status(), except that a dropped connection is not the end of a paid job.
 *
 * A poll is safe to repeat, and one "fetch failed" five minutes into a job
 * lost it on 2026-10-24. An HTTP error still rejects.
 */
async function poll(snapshotId) {
  try {
    return await status(snapshotId);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return "running";
  }
}

/** Trigger, wait, fetch. Rows the API could not collect carry an `error` key. */
export async function run(datasetId, inputs, { discoverBy, limitPerInput, timeoutMs = TIMEOUT_MS } = {}) {
  const snapshotId = await trigger(datasetId, inputs, { discoverBy, limitPerInput });
  const deadline = Date.now() + timeoutMs;
  let state;
  while (!["ready", "failed"].includes((state = await poll(snapshotId)))) {
    if (Date.now() > deadline) {
      throw new ApiError(`timeout: snapshot ${snapshotId} not ready after ${Math.round(timeoutMs / 1000)}s`);
    }
    await transport.sleep(transport.pollMs);
  }
  if (state === "failed") throw new ApiError(`snapshot ${snapshotId} failed`);
  return fetchSnapshot(snapshotId);
}

const many = (value) => (Array.isArray(value) ? value : [value]);

/** Only the fields that were actually set. */
function given(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

/**
 * ChatGPT's answer to each prompt, one record per prompt, one job for the array.
 *
 * `web_search` asks ChatGPT to search the web, `require_sources` asks for
 * cited sources, and `additional_prompt` is a follow-up asked in the same
 * chat. Other options go into each input as the API names them, such as `index`.
 */
export function ask(prompts, { country = "US", ...options } = {}) {
  const extra = given({ country: country ? country.toUpperCase() : undefined, ...options });
  return run(CHATGPT, many(prompts).map((prompt) => ({ url: CHATGPT_URL, prompt, ...extra })));
}

/** Records, and the error messages of the rows that are not records. */
export function split(rows) {
  return {
    records: rows.filter((row) => !row.error),
    errors: rows.filter((row) => row.error).map((row) => String(row.error)),
  };
}

const shorten = (text) => (text.length <= 50 ? text : `${text.slice(0, 47)}...`);

/** What happened to one prompt. */
export class Outcome {
  constructor({ prompt, answer = null, error = null }) {
    this.prompt = prompt;
    this.answer = answer;
    this.error = error;
  }

  get ok() {
    return this.error === null;
  }

  /** One line a reader can understand without having read the source. */
  line() {
    const label = JSON.stringify(shorten(this.prompt));
    if (!this.ok) return `failed  ${label}: ${this.error}`;
    const chars = (this.answer.answer_text ?? "").length.toLocaleString("en-US");
    const cited = (this.answer.citations ?? []).length;
    return `got     ${label}: ${chars} characters, ${cited} citations`;
  }
}

/**
 * Ask one prompt. Never rejects for a bad prompt: a failure becomes an
 * Outcome. A missing token is the exception, because it fails every prompt the
 * same way.
 */
export async function askOne(prompt, { country = "US", web_search } = {}) {
  const outcome = new Outcome({ prompt });
  let rows;
  try {
    rows = await ask(prompt, { country, web_search });
  } catch (error) {
    if (error instanceof TokenMissing) throw error;
    // one bad prompt must not end the run
    outcome.error = error instanceof ApiError ? error.message : `${error?.name ?? "Error"}: ${error?.message ?? error}`;
    return outcome;
  }
  const { records, errors } = split(rows);
  if (records.length) outcome.answer = records[0];
  else outcome.error = [...new Set(errors)].join("; ") || "no answer and no error row";
  return outcome;
}

/** Ask every prompt and return one Outcome each, in order. */
export async function scrape(prompts, { country = "US", web_search } = {}) {
  const outcomes = [];
  for (const prompt of prompts) outcomes.push(await askOne(prompt, { country, web_search }));
  return outcomes;
}

/** Write one JSON file: when it ran, and ChatGPT's answer per prompt. */
export async function write(outcomes, path, country = "US") {
  const document = {
    generated_at: new Date().toISOString(),
    country: country.toUpperCase(),
    prompts: outcomes.map((o) => ({ prompt: o.prompt, answer: o.answer })),
  };
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return target;
}
