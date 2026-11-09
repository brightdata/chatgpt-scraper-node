/** These run without a token. The API is a stub. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { ApiError, CHATGPT, TokenMissing, ask, askOne, run, scrape, token, transport, write } from "../src/scrape.js";
import { main } from "../src/cli.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const real = { ...transport };
const savedToken = process.env.BRIGHTDATA_API_TOKEN;
const PROMPT = "Best CRM software for small businesses";

let temp;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "gptscraper-"));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.BRIGHTDATA_API_TOKEN = "test";
  transport.sleep = async () => {};
});
afterEach(() => {
  Object.assign(transport, real);
  if (savedToken === undefined) delete process.env.BRIGHTDATA_API_TOKEN;
  else process.env.BRIGHTDATA_API_TOKEN = savedToken;
});

/** Answers trigger, progress and snapshot the way the live API does. */
function fakeApi({ rows = [], states = ["ready"], refuse } = {}) {
  const calls = [];
  const queue = [...states];
  transport.fetch = async (url, init) => {
    const path = url.slice("https://api.brightdata.com/datasets/v3".length);
    calls.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (refuse) return reply(refuse.status, refuse.body);
    if (path.startsWith("/trigger")) return reply(200, { snapshot_id: "sd_test" });
    if (path.startsWith("/progress/")) return reply(200, { status: queue.length > 1 ? queue.shift() : queue[0] });
    if (path.startsWith("/snapshot/")) return reply(200, rows);
    throw new Error(path);
  };
  return {
    calls,
    trigger() {
      const { path, body } = calls[0];
      return { query: Object.fromEntries(new URLSearchParams(path.split("?")[1])), body };
    },
  };
}

describe("what is sent", () => {
  test("a prompt is sent to ChatGPT with its country and nothing unset", async () => {
    const api = fakeApi();
    await ask(PROMPT, { country: "us" });
    const { query, body } = api.trigger();
    assert.deepEqual(query, { dataset_id: CHATGPT, include_errors: "true" });
    assert.deepEqual(body, [{ url: "https://chatgpt.com/", prompt: PROMPT, country: "US" }]);
  });

  test("every option goes in as the API names it", async () => {
    const api = fakeApi();
    await ask([PROMPT, "Name three sourdough recipes"], {
      country: "GB",
      web_search: true,
      require_sources: true,
      additional_prompt: "Which is easiest?",
      index: 7,
    });
    const extra = { country: "GB", web_search: true, require_sources: true, additional_prompt: "Which is easiest?", index: 7 };
    assert.deepEqual(api.trigger().body, [
      { url: "https://chatgpt.com/", prompt: PROMPT, ...extra },
      { url: "https://chatgpt.com/", prompt: "Name three sourdough recipes", ...extra },
    ]);
  });

  test("web_search false is sent, not dropped", async () => {
    const api = fakeApi();
    await ask(PROMPT, { web_search: false });
    assert.equal(api.trigger().body[0].web_search, false);
  });
});

describe("the job", () => {
  test("run polls until the snapshot is ready", async () => {
    const api = fakeApi({ rows: [{ answer_text: "HubSpot" }], states: ["running", "running", "ready"] });
    assert.deepEqual(await run(CHATGPT, [{ prompt: "x" }]), [{ answer_text: "HubSpot" }]);
    assert.equal(api.calls.filter((c) => c.path === "/progress/sd_test").length, 3);
  });

  test("a dropped poll does not lose the job", async () => {
    fakeApi({ rows: [{ answer_text: "HubSpot" }] });
    const answer = transport.fetch;
    let dropped = 0;
    transport.fetch = async (url, init) => {
      if (url.includes("/progress/") && !dropped++) throw new TypeError("fetch failed");
      return answer(url, init);
    };
    assert.deepEqual(await run(CHATGPT, [{ prompt: "x" }]), [{ answer_text: "HubSpot" }]);
    assert.ok(dropped >= 2);
  });

  test("a failed snapshot is an error", async () => {
    fakeApi({ states: ["failed"] });
    await assert.rejects(run(CHATGPT, [{ prompt: "x" }]), /sd_test failed/);
  });

  test("a job that never finishes times out", async () => {
    fakeApi({ states: ["running"] });
    await assert.rejects(run(CHATGPT, [{ prompt: "x" }], { timeoutMs: -1 }), /timeout/);
  });

  test("an HTTP error names the status and the reason", async () => {
    fakeApi({ refuse: { status: 400, body: { errors: [["prompt", "This value is required"]] } } });
    await assert.rejects(ask(""), (error) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /HTTP 400.*prompt/);
      return true;
    });
  });
});

describe("the token", () => {
  test("comes from the environment, then the CLI login", async () => {
    delete process.env.BRIGHTDATA_API_TOKEN;
    transport.credentialsPath = () => join(temp, "missing.json");
    assert.throws(() => token(), TokenMissing);

    const credentials = join(temp, "credentials.json");
    await writeFile(credentials, JSON.stringify({ api_key: "from-login" }));
    transport.credentialsPath = () => credentials;
    assert.equal(token(), "from-login");

    process.env.BRIGHTDATA_API_TOKEN = "from-env";
    assert.equal(token(), "from-env");
  });
});

describe("what the API answers", () => {
  test("an answer reports its length and citations", async () => {
    fakeApi({ rows: [{ answer_text: "x".repeat(1234), citations: [{}, {}, {}] }] });
    const outcome = await askOne(PROMPT);
    assert.ok(outcome.ok);
    assert.equal(outcome.line(), `got     ${JSON.stringify(PROMPT)}: 1,234 characters, 3 citations`);
  });

  test("an error row fails the prompt, and a long prompt is shortened", async () => {
    const longPrompt = "Compare every CRM on the market by price, features and support quality";
    fakeApi({ rows: [{ error: "Crawler error: something", error_code: "crawl_error" }] });
    const outcome = await askOne(longPrompt);
    assert.ok(!outcome.ok);
    assert.equal(outcome.line(), `failed  ${JSON.stringify(`${longPrompt.slice(0, 47)}...`)}: Crawler error: something`);
  });

  test("one bad prompt does not end the run", async () => {
    let n = 0;
    transport.fetch = async () => {
      n += 1;
      if (n === 1) throw new RangeError("boom");
      const body = n === 2 ? { snapshot_id: "s" } : n === 3 ? { status: "ready" } : [{ answer_text: "hello" }];
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const [first, second] = await scrape(["boom", "hello"]);
    assert.equal(first.error, "RangeError: boom");
    assert.ok(second.ok);
    assert.deepEqual(second.answer, { answer_text: "hello" });
  });

  test("a run writes what it found", async () => {
    fakeApi({ rows: [{ answer_text: "HubSpot", citations: [] }] });
    const outcomes = await scrape([PROMPT], { country: "gb" });
    const document = JSON.parse(await readFile(await write(outcomes, join(temp, "out.json"), "gb"), "utf8"));
    assert.equal(document.country, "GB");
    assert.deepEqual(document.prompts, [{ prompt: PROMPT, answer: { answer_text: "HubSpot", citations: [] } }]);
    assert.ok(document.generated_at);
  });
});

describe("the command", () => {
  test("the exit code says whether every prompt worked", async () => {
    fakeApi({ rows: [{ answer_text: "x" }] });
    assert.equal(await main([PROMPT, "--out", join(temp, "ok.json")]), 0);
    fakeApi({ rows: [{ error: "boom" }] });
    assert.equal(await main([PROMPT, "--out", join(temp, "bad.json")]), 1);
  });

  test("country and web search reach the request", async () => {
    const api = fakeApi({ rows: [{ answer_text: "x" }] });
    await main([PROMPT, "--country", "de", "--web-search", "--out", join(temp, "o.json")]);
    assert.deepEqual(api.trigger().body, [{ url: "https://chatgpt.com/", prompt: PROMPT, country: "DE", web_search: true }]);
  });

  test("a bad country or no prompt is refused before any request", async () => {
    const api = fakeApi();
    assert.equal(await main(["x", "--country", "USA"]), 2);
    assert.equal(await main([]), 2);
    assert.equal(api.calls.length, 0);
  });

  test("a missing token is a message, not a stack trace, and the header comes first", async () => {
    const env = { ...process.env, HOME: temp, APPDATA: temp };
    delete env.BRIGHTDATA_API_TOKEN;
    const done = await exec(process.execPath, [join(ROOT, "src", "cli.js"), PROMPT], { env }).catch((e) => e);
    assert.equal(done.code, 2);
    assert.match(done.stderr, /export BRIGHTDATA_API_TOKEN/);
    assert.match(done.stderr, /bdata login/);
    assert.doesNotMatch(done.stderr, /at .*\.js:\d+/);
    assert.match(done.stdout, /^Asking ChatGPT 1 prompt\(s\) from US/);
  });
});

describe("the README", () => {
  test("the excerpt is the start of the example file", async () => {
    const sample = await readFile(join(ROOT, "examples", "sample_output.json"), "utf8");
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    // each line cut at 160 characters: answer_html alone is a 1.4 MB line
    const lines = sample.split("\n").slice(0, 20).map((l) => (l.length <= 160 ? l : `${l.slice(0, 160)}...`));
    assert.ok(readme.includes(lines.join("\n")), "README excerpt drifted from the file");
    assert.ok(readme.includes("](examples/sample_output.json)"));
  });

  test("every in-page link has its heading", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const anchors = new Set(
      [...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").replaceAll(" ", "-")),
    );
    for (const [, anchor] of readme.matchAll(/\]\(#([^)]+)\)/g)) {
      assert.ok(anchors.has(anchor), `#${anchor} points at no heading`);
    }
  });
});
