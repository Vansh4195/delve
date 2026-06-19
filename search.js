// Web-search clients — browser-direct (BYO key). Tavily and Brave.
// Both expose: search(query, { maxResults }) -> [{ title, url, snippet, content }]

export function makeSearch({ provider, apiKey, signal }) {
  if (provider === "tavily") return new TavilySearch({ apiKey, signal });
  if (provider === "brave") return new BraveSearch({ apiKey, signal });
  throw new Error(`Unknown search provider: ${provider}`);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// ---- Tavily -----------------------------------------------------------------
// Tavily's /search returns ranked results plus an extracted `content` field,
// which doubles as our "reader" — no separate fetch/extract step needed.

class TavilySearch {
  constructor({ apiKey, signal }) {
    this.apiKey = apiKey;
    this.signal = signal;
    this.url = "https://api.tavily.com/search";
  }

  async search(query, { maxResults = 5 } = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: this.signal,
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
        search_depth: "advanced",
        include_answer: false,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    return (json.results || []).map((r) => ({
      title: r.title || domainOf(r.url),
      url: r.url,
      domain: domainOf(r.url),
      snippet: r.content ? r.content.slice(0, 280) : "",
      content: r.raw_content || r.content || "",
      score: r.score,
    }));
  }
}

// ---- Brave ------------------------------------------------------------------
// Brave returns titles + descriptions (no full page text), so the snippet is
// also used as the readable extract. Lighter but still citeable.

class BraveSearch {
  constructor({ apiKey, signal }) {
    this.apiKey = apiKey;
    this.signal = signal;
    this.url = "https://api.search.brave.com/res/v1/web/search";
  }

  async search(query, { maxResults = 5 } = {}) {
    const params = new URLSearchParams({ q: query, count: String(maxResults) });
    const res = await fetch(`${this.url}?${params}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-subscription-token": this.apiKey,
      },
      signal: this.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Brave HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const web = json.web?.results || [];
    return web.map((r) => ({
      title: r.title || domainOf(r.url),
      url: r.url,
      domain: domainOf(r.url),
      snippet: stripTags(r.description || ""),
      content: stripTags(r.description || ""),
      score: undefined,
    }));
  }
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, "");
}
