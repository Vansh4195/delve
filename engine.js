// Delve research engine — the multi-agent orchestration.
//
// Pipeline:
//   1. Planner agent   — decompose the question into sub-questions + search queries
//   2. Search agents   — run all sub-question searches in parallel (web search)
//   3. Reader/analyst  — extract relevant evidence per sub-question from sources
//   4. Critic agent    — adversarially check drafted claims against the sources
//   5. Writer agent    — stream a cited report, incorporating the critic's verdicts
//
// Every step emits trace events so the UI can show the agents working live.

import { makeLLM } from "./llm.js";
import { makeSearch } from "./search.js";

const PLANNER_SYSTEM = `You are the planning agent in a deep-research system.
Given a user's research question, break it into focused sub-questions that, answered together, fully cover the question. For each sub-question, write ONE precise web-search query (keywords, not a sentence). Avoid overlap between sub-questions. Prefer sub-questions that surface different angles, tradeoffs, evidence, and counter-evidence.`;

const ANALYST_SYSTEM = `You are an analyst agent. You are given a sub-question and a set of numbered web sources (title + extracted text). Extract only the claims that are directly supported by these sources and relevant to the sub-question. For each claim, cite the source number(s) it comes from. Be concise and factual. If the sources do not actually answer the sub-question, say so explicitly. Never invent citations or facts not present in the sources.`;

const CRITIC_SYSTEM = `You are an adversarial fact-checking critic. You are given research claims, each tagged with the source numbers it supposedly comes from, plus the source texts. For each claim, decide whether the cited sources actually support it. Be skeptical: flag unsupported claims, overstated certainty, claims that go beyond what the source says, and claims where sources disagree. Output a verdict per claim.`;

const WRITER_SYSTEM = `You are the lead writer of a deep-research report. Write a clear, well-structured report in Markdown that directly answers the user's question, grounded ONLY in the verified evidence provided. Rules:
- Use inline citations in the form [n] referring to the numbered sources. Cite every non-obvious factual claim.
- Respect the critic's verdicts: do not assert claims the critic marked unsupported; where evidence conflicts or is weak, say so plainly.
- Structure: a short direct answer up top, then sections with headings, then a brief "Caveats / open questions" section.
- Be substantive but do not pad. Do not fabricate sources or citation numbers beyond those provided.
- Do not include a "Sources" list at the end; the UI renders that separately.`;

// JSON tool schemas (work for both Anthropic tool_use and OpenAI functions).
const PLAN_TOOL = {
  name: "submit_plan",
  description: "Submit the research plan as sub-questions with search queries.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sub_questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string", description: "A focused sub-question." },
            query: { type: "string", description: "One concise web-search query." },
          },
          required: ["question", "query"],
        },
      },
    },
    required: ["sub_questions"],
  },
};

const VERIFY_TOOL = {
  name: "submit_verdicts",
  description: "Submit a verdict for each claim.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            claim: { type: "string" },
            status: { type: "string", enum: ["supported", "partially_supported", "unsupported", "conflicting"] },
            note: { type: "string", description: "Short reason for the verdict." },
          },
          required: ["claim", "status", "note"],
        },
      },
    },
    required: ["verdicts"],
  },
};

export async function runResearch(config, callbacks) {
  const {
    question,
    breadth = 4,
    depth = 5,
    llm: llmConfig,
    search: searchConfig,
    signal,
  } = config;

  const { onTrace, onReportToken, onReportReset, onSources, onDone } = callbacks;

  const llm = makeLLM({ ...llmConfig, signal });
  const search = makeSearch({ ...searchConfig, signal });

  // -- 1. Planner -----------------------------------------------------------
  const planId = onTrace({ agent: "planner", title: "Decomposing the question", status: "running" });
  let plan;
  try {
    plan = await llm.toolJSON(
      PLANNER_SYSTEM,
      `Research question:\n"""${question}"""\n\nProduce exactly ${breadth} sub-questions.`,
      PLAN_TOOL,
      { maxTokens: 1024 }
    );
  } catch (e) {
    onTrace({ id: planId, status: "error", detail: e.message });
    throw e;
  }
  const subQuestions = (plan.sub_questions || []).slice(0, breadth);
  if (subQuestions.length === 0) {
    onTrace({ id: planId, status: "error", detail: "Planner produced no sub-questions." });
    throw new Error("Planner produced no sub-questions.");
  }
  onTrace({
    id: planId,
    status: "done",
    detail: subQuestions.map((s, i) => `${i + 1}. ${s.question}`).join("\n"),
  });

  // -- 2. Parallel search ---------------------------------------------------
  // Each sub-question gets its own search-agent trace row that updates live.
  const sourceMap = new Map(); // url -> { ...source, n }
  let nextN = 1;

  function registerSource(s) {
    if (!s.url) return null;
    if (sourceMap.has(s.url)) return sourceMap.get(s.url);
    const entry = { ...s, n: nextN++ };
    sourceMap.set(s.url, entry);
    return entry;
  }

  const searchTasks = subQuestions.map((sq, i) => {
    const tid = onTrace({ agent: `search ${i + 1}`, title: sq.query, status: "running" });
    return search
      .search(sq.query, { maxResults: depth })
      .then((results) => {
        const registered = results.map(registerSource).filter(Boolean);
        onTrace({
          id: tid,
          status: "done",
          detail: `${registered.length} sources`,
        });
        return { sq, results: registered };
      })
      .catch((e) => {
        onTrace({ id: tid, status: "error", detail: e.message });
        return { sq, results: [], error: e.message };
      });
  });

  const searchResults = await Promise.all(searchTasks);
  const allSources = [...sourceMap.values()].sort((a, b) => a.n - b.n);
  if (allSources.length === 0) {
    throw new Error("No sources found across any sub-question. Check the search key and try a broader question.");
  }
  onSources && onSources(allSources);

  // -- 3. Analyst (per sub-question, parallel) ------------------------------
  const analystTasks = searchResults
    .filter((r) => r.results.length > 0)
    .map(({ sq, results }, idx) => {
      const tid = onTrace({ agent: `analyst ${idx + 1}`, title: `Reading sources for: ${sq.question}`, status: "running" });
      const sourceBlock = results
        .map((r) => `[${r.n}] ${r.title} (${r.domain})\n${clip(r.content, 1400)}`)
        .join("\n\n");
      return llm
        .stream(
          ANALYST_SYSTEM,
          `Sub-question: ${sq.question}\n\nSources:\n${sourceBlock}\n\nExtract supported, cited claims relevant to the sub-question.`,
          { maxTokens: 900 }
        )
        .then((text) => {
          onTrace({ id: tid, status: "done", detail: clip(text, 220) });
          return { sq, analysis: text };
        })
        .catch((e) => {
          onTrace({ id: tid, status: "error", detail: e.message });
          return { sq, analysis: "", error: e.message };
        });
    });

  const analyses = (await Promise.all(analystTasks)).filter((a) => a.analysis);
  if (analyses.length === 0) {
    throw new Error("Analyst agents produced no evidence. The model calls may have failed — check the LLM key.");
  }

  const evidence = analyses
    .map((a) => `### ${a.sq.question}\n${a.analysis}`)
    .join("\n\n");

  // -- 4. Critic (adversarial verification) ---------------------------------
  const critId = onTrace({ agent: "critic", title: "Verifying claims against sources", status: "running" });
  const sourceCorpus = allSources
    .map((r) => `[${r.n}] ${r.title} (${r.domain})\n${clip(r.content, 900)}`)
    .join("\n\n");
  let verdicts = [];
  try {
    const out = await llm.toolJSON(
      CRITIC_SYSTEM,
      `Drafted evidence (claims with citation numbers):\n${evidence}\n\nSource corpus:\n${sourceCorpus}\n\nReturn a verdict for each distinct claim.`,
      VERIFY_TOOL,
      { maxTokens: 2048 }
    );
    verdicts = out.verdicts || [];
    const counts = tally(verdicts);
    onTrace({
      id: critId,
      status: "done",
      detail: `${verdicts.length} claims checked — ${counts.supported} supported, ${counts.partially_supported} partial, ${counts.unsupported} unsupported, ${counts.conflicting} conflicting`,
    });
  } catch (e) {
    // Verification is best-effort; if it fails, continue without it.
    onTrace({ id: critId, status: "error", detail: `Skipped: ${e.message}` });
  }

  // -- 5. Writer (streams the cited report) ---------------------------------
  const writeId = onTrace({ agent: "writer", title: "Writing the cited report", status: "running" });
  onReportReset && onReportReset();
  const verdictBlock = verdicts.length
    ? verdicts.map((v) => `- (${v.status}) ${v.claim} — ${v.note}`).join("\n")
    : "No critic verdicts available; rely directly on the source corpus and flag any uncertainty.";

  const writerPrompt = `User's research question:\n"""${question}"""\n\nVerified evidence (sub-question findings):\n${evidence}\n\nCritic's verdicts:\n${verdictBlock}\n\nNumbered sources (cite as [n]):\n${allSources.map((r) => `[${r.n}] ${r.title} — ${r.url}`).join("\n")}\n\nWrite the final report now.`;

  let report = "";
  try {
    report = await llm.stream(WRITER_SYSTEM, writerPrompt, {
      maxTokens: 4096,
      onToken: (t) => onReportToken && onReportToken(t),
    });
    onTrace({ id: writeId, status: "done", detail: "Report complete." });
  } catch (e) {
    onTrace({ id: writeId, status: "error", detail: e.message });
    throw e;
  }

  onDone && onDone({ report, sources: allSources, verdicts });
  return { report, sources: allSources, verdicts };
}

function clip(s, n) {
  s = (s || "").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function tally(verdicts) {
  const c = { supported: 0, partially_supported: 0, unsupported: 0, conflicting: 0 };
  for (const v of verdicts) if (c[v.status] !== undefined) c[v.status]++;
  return c;
}
