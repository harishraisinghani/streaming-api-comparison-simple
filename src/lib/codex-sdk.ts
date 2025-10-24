import { Codex } from "@codex-data/sdk";

const apiKey = process.env.CODEX_API_KEY;
if (!apiKey) {
  throw new Error("Missing CODEX_API_KEY in environment. Add it to .env");
}

export const sdk = new Codex(apiKey);
