/** A ChatGPT scraper on Bright Data's Scraper API. */

export {
  ApiError,
  CHATGPT,
  CHATGPT_URL,
  Outcome,
  TokenMissing,
  ask,
  askOne,
  fetchSnapshot,
  run,
  scrape,
  split,
  status,
  token,
  trigger,
  write,
} from "./scrape.js";

export const VERSION = "0.1.0";
