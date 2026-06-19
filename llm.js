// LLM clients — browser-direct (BYO key). Streaming + tool use.
// Anthropic uses the anthropic-dangerous-direct-browser-access CORS path.
// OpenAI is reachable directly from the browser with the bare key.
// Gemini (free) speaks OpenAI's chat-completions shape, so it reuses the
// OpenAI client pointed at Google's OpenAI-compatible endpoint. That endpoint
// returns CORS headers for browser origins, so it works in-app as well as in
// the Node test harness.

export const DEFAULT_MODELS = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
};

// OpenAI-compatible base URLs per provider.
const OPENAI_COMPAT_BASE = {
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
};

// ---- shared streaming SSE reader -------------------------------------------

async function* readSSE(response) {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${truncate(text, 400)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = chunk.split("\n");
      let event = null;
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data };
    }
  }
}

function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n) + "…" : s;
}

// ---- public client factory --------------------------------------------------

export function makeLLM({ provider, apiKey, model, signal }) {
  const resolvedModel = model && model.trim() ? model.trim() : DEFAULT_MODELS[provider];
  if (provider === "anthropic") return new AnthropicClient({ apiKey, model: resolvedModel, signal });
  // OpenAI and Gemini both speak the OpenAI chat-completions shape — same
  // client, different base URL.
  if (provider === "openai" || provider === "gemini") {
    return new OpenAIClient({ apiKey, model: resolvedModel, signal, baseUrl: OPENAI_COMPAT_BASE[provider] });
  }
  throw new Error(`Unknown LLM provider: ${provider}`);
}

// ---- Anthropic --------------------------------------------------------------

class AnthropicClient {
  constructor({ apiKey, model, signal }) {
    this.apiKey = apiKey;
    this.model = model;
    this.signal = signal;
    this.url = "https://api.anthropic.com/v1/messages";
  }

  headers() {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      // Required for direct browser calls (CORS).
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  // Streams text. onToken(textDelta) called incrementally. Returns full text.
  async stream(system, userPrompt, { onToken, maxTokens = 4096 } = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      signal: this.signal,
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userPrompt }],
        stream: true,
      }),
    });
    let full = "";
    for await (const { data } of readSSE(res)) {
      if (data === "[DONE]") break;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        full += json.delta.text;
        onToken && onToken(json.delta.text);
      } else if (json.type === "error") {
        throw new Error(json.error?.message || "Anthropic stream error");
      }
    }
    return full;
  }

  // Non-streaming call that forces a single tool call and returns its parsed input.
  // Used for structured steps (decompose, verify) where we want clean JSON.
  async toolJSON(system, userPrompt, tool, { maxTokens = 2048 } = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      signal: this.signal,
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userPrompt }],
        tools: [{
          name: tool.name,
          description: tool.description,
          input_schema: tool.schema,
        }],
        tool_choice: { type: "tool", name: tool.name },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${truncate(text, 400)}`);
    }
    const json = await res.json();
    const block = (json.content || []).find((b) => b.type === "tool_use");
    if (!block) throw new Error("Anthropic returned no tool_use block");
    return block.input;
  }
}

// ---- OpenAI -----------------------------------------------------------------

class OpenAIClient {
  constructor({ apiKey, model, signal, baseUrl }) {
    this.apiKey = apiKey;
    this.model = model;
    this.signal = signal;
    this.url = baseUrl || "https://api.openai.com/v1/chat/completions";
  }

  headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  async stream(system, userPrompt, { onToken, maxTokens = 4096 } = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      signal: this.signal,
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
        stream: true,
      }),
    });
    let full = "";
    for await (const { data } of readSSE(res)) {
      if (data === "[DONE]") break;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onToken && onToken(delta);
      }
      if (json.error) throw new Error(json.error.message || "OpenAI stream error");
    }
    return full;
  }

  async toolJSON(system, userPrompt, tool, { maxTokens = 2048 } = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      signal: this.signal,
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
        tools: [{
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.schema,
          },
        }],
        tool_choice: { type: "function", function: { name: tool.name } },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${truncate(text, 400)}`);
    }
    const json = await res.json();
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("OpenAI returned no tool call");
    try {
      return JSON.parse(call.function.arguments);
    } catch {
      throw new Error("OpenAI tool arguments were not valid JSON");
    }
  }
}
