#!/usr/bin/env node
/** chatgpt-scraper "best crm for startups" --web-search */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { TokenMissing, askOne, token, write } from "./scrape.js";

const USAGE = `usage: chatgpt-scraper PROMPT [PROMPT ...] [--country CC] [--web-search] [--out PATH]

  PROMPT         what you would type into ChatGPT, quoted
  --country CC   two-letter country ChatGPT answers from, default US
  --web-search   ask ChatGPT to search the web before answering
  --out PATH     output file, default chatgpt.json`;

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const CLEAR_LINE = "\r\x1b[2K";

/** Seconds as h:mm:ss, the shape a reader can read at a glance. */
function clock(seconds) {
  const mm = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${Math.floor(seconds / 3600)}:${mm}:${ss}`;
}

/**
 * A spinner and a running clock, so minutes of waiting look alive.
 * Outside a terminal it prints one plain line instead, because a log wants a
 * line, not an animation.
 */
function waiting(label) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`asking  ${label}...\n`);
    return () => {};
  }
  const started = Date.now();
  let frame = 0;
  const tick = () => {
    const spin = FRAMES[frame++ % FRAMES.length];
    process.stdout.write(`${CLEAR_LINE}${spin} ${label} ${clock(Math.floor((Date.now() - started) / 1000))}`);
  };
  tick();
  const timer = setInterval(tick, 100);
  timer.unref();
  return () => {
    clearInterval(timer);
    process.stdout.write(CLEAR_LINE); // leave the line clean for the result
  };
}

function countryCode(value) {
  if (!/^[A-Za-z]{2}$/.test(value)) {
    throw new Error(`${JSON.stringify(value)} is not a two-letter country code, like US`);
  }
  return value.toUpperCase();
}

export async function main(argv = process.argv.slice(2)) {
  let prompts;
  let country;
  let webSearch;
  let out;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        country: { type: "string" },
        "web-search": { type: "boolean" },
        out: { type: "string" },
      },
      allowPositionals: true,
    });
    prompts = positionals;
    country = values.country === undefined ? "US" : countryCode(values.country);
    webSearch = values["web-search"] ? true : undefined;
    out = values.out ?? "chatgpt.json";
    if (!prompts.length) throw new Error("give at least one prompt");
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  process.stdout.write(
    `Asking ChatGPT ${prompts.length} prompt(s) from ${country}${webSearch ? ", with web search" : ""}\n` +
      "Usually one to five minutes each. Billed per answer, 5,000 free credits a month.\n",
  );
  try {
    token(); // fail before the first wait, not after it
  } catch (error) {
    if (!(error instanceof TokenMissing)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const outcomes = [];
  for (const prompt of prompts) {
    const label = prompt.length <= 50 ? prompt : `${prompt.slice(0, 47)}...`;
    const done = waiting(JSON.stringify(label));
    const outcome = await askOne(prompt, { country, web_search: webSearch });
    done();
    process.stdout.write(`${outcome.line()}\n`);
    outcomes.push(outcome);
  }

  await write(outcomes, out, country);
  const answered = outcomes.filter((outcome) => outcome.ok).length;
  // the path as typed, not resolved: the reader knows where they ran it
  process.stdout.write(`\nSaved ${answered} answers as JSON to ${out}\n`);
  return outcomes.every((outcome) => outcome.ok) ? 0 : 1;
}

/**
 * Is this file the program being run?
 *
 * Comparing `import.meta.url` to `file://${argv[1]}` is wrong twice over. A
 * path with a space encodes to %20 on one side only, and `npm install -g`
 * puts a symlink on PATH, so argv[1] is the link while import.meta.url is the
 * file it points at. Either mismatch makes the installed command exit 0 and
 * do nothing at all.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
