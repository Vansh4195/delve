// Delve — app wiring. Settings/keys, trace panel, report streaming.

import { runResearch } from "./engine.js";
import { renderMarkdown } from "./markdown.js";
import { DEFAULT_MODELS } from "./llm.js";

const STORAGE_KEY = "delve.settings.v1";

const $ = (id) => document.getElementById(id);

const els = {
  form: $("askForm"),
  question: $("question"),
  breadth: $("breadth"),
  depth: $("depth"),
  runBtn: $("runBtn"),
  cancelBtn: $("cancelBtn"),
  trace: $("trace"),
  report: $("report"),
  sources: $("sources"),
  sourceList: $("sourceList"),
  copyBtn: $("copyBtn"),
  elapsed: $("elapsed"),
  keyWarning: $("keyWarning"),
  openSettingsInline: $("openSettingsInline"),
  // settings
  settingsBtn: $("settingsBtn"),
  settingsModal: $("settingsModal"),
  closeSettings: $("closeSettings"),
  saveKeys: $("saveKeys"),
  clearKeys: $("clearKeys"),
  llmKey: $("llmKey"),
  llmModel: $("llmModel"),
  modelHint: $("modelHint"),
  searchKey: $("searchKey"),
  searchHint: $("searchHint"),
};

// ---- settings ---------------------------------------------------------------

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function currentSettings() {
  const s = loadSettings();
  return {
    llmProvider: s.llmProvider || "anthropic",
    llmKey: s.llmKey || "",
    llmModel: s.llmModel || "",
    searchProvider: s.searchProvider || "tavily",
    searchKey: s.searchKey || "",
  };
}

function settingsComplete() {
  const s = currentSettings();
  return !!(s.llmKey && s.searchKey);
}

function refreshKeyWarning() {
  els.keyWarning.hidden = settingsComplete();
  els.runBtn.disabled = !settingsComplete();
}

function selectedRadio(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

function openSettings() {
  const s = currentSettings();
  document.querySelector(`input[name="llmProvider"][value="${s.llmProvider}"]`).checked = true;
  document.querySelector(`input[name="searchProvider"][value="${s.searchProvider}"]`).checked = true;
  els.llmKey.value = s.llmKey;
  els.llmModel.value = s.llmModel;
  els.searchKey.value = s.searchKey;
  updateHints();
  els.settingsModal.hidden = false;
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

function updateHints() {
  const llmProvider = selectedRadio("llmProvider");
  const searchProvider = selectedRadio("searchProvider");
  els.modelHint.textContent =
    `Leave blank to use the default (${DEFAULT_MODELS[llmProvider]}).` +
    (llmProvider === "anthropic"
      ? " Anthropic is called directly from the browser via its CORS-enabled path."
      : " Sent directly to the OpenAI API.");
  els.searchHint.textContent =
    searchProvider === "tavily"
      ? "Tavily free tier works well. Get a key at tavily.com — it returns extracted page text used for reading."
      : "Brave Search API key (search.brave.com/api). Returns titles + descriptions used as the readable extract.";
  els.llmKey.placeholder = llmProvider === "anthropic" ? "sk-ant-..." : "sk-...";
  els.searchKey.placeholder = searchProvider === "tavily" ? "tvly-..." : "BSA...";
}

els.settingsBtn.addEventListener("click", openSettings);
els.openSettingsInline.addEventListener("click", openSettings);
els.closeSettings.addEventListener("click", closeSettings);
els.settingsModal.addEventListener("click", (e) => {
  if (e.target === els.settingsModal) closeSettings();
});
document.querySelectorAll('input[name="llmProvider"], input[name="searchProvider"]').forEach((r) =>
  r.addEventListener("change", updateHints)
);

els.saveKeys.addEventListener("click", () => {
  saveSettings({
    llmProvider: selectedRadio("llmProvider"),
    llmKey: els.llmKey.value.trim(),
    llmModel: els.llmModel.value.trim(),
    searchProvider: selectedRadio("searchProvider"),
    searchKey: els.searchKey.value.trim(),
  });
  refreshKeyWarning();
  closeSettings();
});

els.clearKeys.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  els.llmKey.value = "";
  els.llmModel.value = "";
  els.searchKey.value = "";
  refreshKeyWarning();
});

// ---- trace panel ------------------------------------------------------------

let traceSeq = 0;
const traceEls = new Map();

function resetTrace() {
  els.trace.innerHTML = "";
  traceEls.clear();
}

// onTrace handles both creating a new row (no id) and updating one (with id).
function trace(evt) {
  if (evt.id && traceEls.has(evt.id)) {
    const node = traceEls.get(evt.id);
    if (evt.status) {
      node.className = `trace-item ${evt.status}`;
    }
    if (evt.title) node.querySelector(".ttitle").textContent = evt.title;
    if (evt.detail !== undefined) {
      let d = node.querySelector(".tdetail");
      if (!d) {
        d = document.createElement("div");
        d.className = "tdetail";
        node.querySelector(".tbody").appendChild(d);
      }
      d.textContent = evt.detail;
    }
    scrollTrace();
    return evt.id;
  }

  const id = `t${++traceSeq}`;
  const li = document.createElement("li");
  li.className = `trace-item ${evt.status || "info"}`;
  li.innerHTML = `
    <span class="tdot"></span>
    <div class="tbody">
      <div class="tagent">${escapeText(evt.agent || "")}</div>
      <div class="ttitle">${escapeText(evt.title || "")}</div>
      ${evt.detail !== undefined ? `<div class="tdetail">${escapeText(evt.detail)}</div>` : ""}
    </div>`;
  els.trace.appendChild(li);
  traceEls.set(id, li);
  scrollTrace();
  return id;
}

function scrollTrace() {
  els.trace.scrollTop = els.trace.scrollHeight;
}

function escapeText(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// ---- report rendering -------------------------------------------------------

let reportMd = "";
let renderQueued = false;

function resetReport() {
  reportMd = "";
  els.report.innerHTML = '<div class="empty-state">Streaming…</div>';
}

function appendReport(token) {
  reportMd += token;
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      els.report.innerHTML = renderMarkdown(reportMd);
      els.report.scrollTop = els.report.scrollHeight;
    });
  }
}

function renderSources(sources) {
  els.sourceList.innerHTML = sources
    .map(
      (s) => `
      <li id="src-${s.n}">
        <a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">${escapeText(s.title)}</a>
        <span class="src-domain"> ${escapeText(s.domain)}</span>
      </li>`
    )
    .join("");
  els.sources.hidden = sources.length === 0;
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, "&quot;");
}

// ---- run --------------------------------------------------------------------

let controller = null;
let timer = null;
let startTime = 0;

function setRunning(running) {
  els.runBtn.disabled = running || !settingsComplete();
  els.cancelBtn.hidden = !running;
  els.question.disabled = running;
}

function startTimer() {
  startTime = Date.now();
  timer = setInterval(() => {
    const s = ((Date.now() - startTime) / 1000).toFixed(1);
    els.elapsed.textContent = `${s}s`;
  }, 100);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

els.cancelBtn.addEventListener("click", () => {
  if (controller) controller.abort();
});

els.copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(reportMd);
    els.copyBtn.textContent = "Copied";
    setTimeout(() => (els.copyBtn.textContent = "Copy markdown"), 1500);
  } catch {
    els.copyBtn.textContent = "Copy failed";
    setTimeout(() => (els.copyBtn.textContent = "Copy markdown"), 1500);
  }
});

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = els.question.value.trim();
  if (!question) return;
  if (!settingsComplete()) {
    openSettings();
    return;
  }

  const s = currentSettings();
  controller = new AbortController();
  resetTrace();
  resetReport();
  els.sources.hidden = true;
  els.copyBtn.hidden = true;
  setRunning(true);
  startTimer();

  try {
    await runResearch(
      {
        question,
        breadth: parseInt(els.breadth.value, 10),
        depth: parseInt(els.depth.value, 10),
        llm: { provider: s.llmProvider, apiKey: s.llmKey, model: s.llmModel },
        search: { provider: s.searchProvider, apiKey: s.searchKey },
        signal: controller.signal,
      },
      {
        onTrace: trace,
        onReportReset: resetReport,
        onReportToken: appendReport,
        onSources: renderSources,
        onDone: () => {
          els.copyBtn.hidden = false;
        },
      }
    );
  } catch (err) {
    if (err.name === "AbortError") {
      trace({ agent: "system", title: "Cancelled", status: "info" });
    } else {
      trace({ agent: "system", title: "Research failed", status: "error", detail: err.message });
      if (reportMd === "" || /Streaming…/.test(els.report.innerHTML)) {
        els.report.innerHTML = `<div class="empty-state">${escapeText(err.message)}</div>`;
      }
    }
  } finally {
    setRunning(false);
    stopTimer();
    controller = null;
  }
});

// ---- init -------------------------------------------------------------------

refreshKeyWarning();
