// Delve E2E test — free, real LLM call through Google Gemini's
// OpenAI-compatible endpoint.
//
// This exercises the SAME request/parse shape the app's OpenAI-compatible
// client uses (llm.js -> OpenAIClient): POST chat/completions with
// `Authorization: Bearer <key>` and a `messages` array, then read
// `choices[0].message.content`. Because it runs in Node (no browser), there is
// no CORS involved — it proves the request/parse logic works against a real
// model.
//
// Run:  GEMINI_API_KEY=... node tests/e2e.mjs
// Get a free key at https://aistudio.google.com
//
// Exits 0 on PASS, non-zero on FAIL. Prints SKIP (and exits 0) if no key is set.

const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = "gemini-2.0-flash";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.log(
    "SKIP: GEMINI_API_KEY not set. Get a free key at https://aistudio.google.com and re-run:\n" +
      "  GEMINI_API_KEY=... node tests/e2e.mjs"
  );
  process.exit(0);
}

function fail(reason) {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

try {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      // Keep tokens tiny so this costs ~nothing on the free tier.
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      max_tokens: 20,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    fail(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    fail(`response was not valid JSON: ${e.message}`);
  }

  // Same access path the app uses for streamed/non-streamed completions.
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    fail(`no non-empty text in response: ${JSON.stringify(json).slice(0, 400)}`);
  }

  console.log(`Model replied: ${content.trim()}`);
  console.log("PASS");
  process.exit(0);
} catch (e) {
  fail(e.message || String(e));
}
