# Delve

A multi-agent deep-research engine that runs entirely in your browser. Ask a
question; Delve decomposes it into sub-questions, runs parallel web searches,
reads the results, has a critic agent adversarially check every claim against
its sources, and streams back a structured, cited report.

There is no backend. You bring your own API keys (one LLM key, one web-search
key), they live in your browser's `localStorage`, and every request goes
directly from the page to the provider you chose. Open your network tab and
you'll see exactly that — no Delve server in the middle, because there isn't one.

**Live:** https://vansh4195.github.io/delve/

## What it does

Most "ask an AI" tools make one model call and hand you the answer. Delve is a
genuine multi-step pipeline with distinct agent roles, and it shows each step
working live in an agent-trace panel so you can watch the research happen.

1. **Planner** — decomposes your question into N focused sub-questions, each with
   a precise search query (one model call, returned as structured JSON via tool use).
2. **Search agents** — every sub-question's query is searched in parallel against
   your web-search provider. Results are de-duplicated and numbered as sources.
3. **Analyst agents** — for each sub-question, an agent reads its sources and
   extracts only the claims those sources actually support, with citation numbers.
4. **Critic** — an adversarial verification pass. The critic re-reads the source
   corpus and rules on each drafted claim: supported, partially supported,
   unsupported, or conflicting. This is the step that separates a research tool
   from a confident-sounding guess.
5. **Writer** — streams a Markdown report that answers your question using only
   the verified evidence, with inline `[n]` citations linking to the source list,
   and an explicit caveats section for weak or conflicting findings.

## Architecture

```
question
   │
   ▼
[ Planner ]  ──tool-use JSON──▶  sub-questions + search queries
   │
   ▼  (parallel)
[ Search 1 ] [ Search 2 ] … [ Search N ]  ──▶  numbered, de-duplicated sources
   │
   ▼  (parallel)
[ Analyst 1 ] [ Analyst 2 ] … ──▶  cited claims per sub-question
   │
   ▼
[ Critic ]  ──tool-use JSON──▶  verdict per claim (supported / unsupported / …)
   │
   ▼
[ Writer ]  ──streaming──▶  cited Markdown report  +  source list
```

The whole thing is plain ES modules — no build step, no framework, no bundler.
That keeps the trust story simple (the code you read is the code that runs) and
makes GitHub Pages hosting trivial.

| File | Responsibility |
|------|----------------|
| `index.html` / `styles.css` | UI shell, settings modal, two-panel layout |
| `app.js` | Wiring: key storage, the live trace panel, streaming report render |
| `engine.js` | The multi-agent orchestration (the pipeline above) |
| `llm.js` | LLM clients — Anthropic and OpenAI, both browser-direct with SSE streaming and tool use |
| `search.js` | Web-search clients — Tavily and Brave |
| `markdown.js` | A small, dependency-free Markdown→HTML renderer (escapes input, turns `[n]` into citation anchors) |

## Bring your own keys

Delve needs two keys. Click **Keys & Settings** in the top bar to add them.

### LLM (pick one)

- **Anthropic** — get a key at [console.anthropic.com](https://console.anthropic.com).
  Default model `claude-opus-4-8`. Anthropic exposes a CORS path for direct
  browser calls, which Delve opts into with the
  `anthropic-dangerous-direct-browser-access` header. The key is sent only to
  `api.anthropic.com`.
- **OpenAI** — get a key at [platform.openai.com](https://platform.openai.com).
  Default model `gpt-4o`. Sent only to `api.openai.com`.

You can override the model in settings; leave it blank to use the default.

### Web search (pick one)

- **Tavily** — [tavily.com](https://tavily.com). Has a usable free tier and
  returns extracted page text, which Delve's analyst agents read directly.
- **Brave Search API** — [search.brave.com/api](https://search.brave.com/api).
  Returns titles and descriptions, used as the readable extract.

### Where keys go

Keys are saved in `localStorage` under a single key (`delve.settings.v1`) and
are read back only to populate the request headers/body for the provider you
selected. They are never transmitted anywhere except the provider's own API
endpoint. "Clear stored keys" wipes them. Nothing is logged or proxied.

## Run it locally

It's static files, but ES modules need to be served over HTTP (not `file://`):

```bash
git clone https://github.com/Vansh4195/delve.git
cd delve
python3 -m http.server 8080
# open http://localhost:8080
```

Any static server works (`npx serve`, etc.).

## Deploy

Hosted on GitHub Pages from the repository root. Any push to `main` publishes.
To host your own copy: fork, enable Pages (Settings → Pages → deploy from
`main` / root), and it's live at `https://<you>.github.io/delve/`.

## Notes & limits

- **CORS:** Tavily, Brave, OpenAI, and Anthropic's browser path all allow
  direct browser requests. A web-search provider without CORS, or a corporate
  proxy that strips headers, won't work — that's the tradeoff of having no backend.
- **Reading depth:** Delve reads the extracted text the search provider returns
  rather than fetching and parsing each page itself (arbitrary cross-origin page
  fetches are blocked in the browser). Tavily's advanced extraction gives the
  analyst agents the most to work with.
- **Cost:** every run is several model calls (plan + one analyst per
  sub-question + critic + writer). The "fast / balanced / thorough" selector
  controls how many. You pay your provider directly.

## License

MIT — see [LICENSE](LICENSE).
