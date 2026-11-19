#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Suppress Node's ExperimentalWarning for built-in node:sqlite in logs
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) return;
  if (warning && warning.name === 'ExperimentalWarning' && String(warning.message).includes('SQLite')) return;
  return origEmitWarning.call(this, warning, ...args);
};

let DatabaseSync = null;
try {
  const sqliteMod = await import('node:sqlite');
  DatabaseSync = sqliteMod.DatabaseSync;
} catch {
  // Fallback if node:sqlite is unavailable
}

const DAILY_STORE_SCHEMA_VERSION = 4;

// Record exact completion mtime when a step is first observed at the tail of transcript.jsonl
const stepFinishObservedMs = new Map();

// Cache for per-session DB telemetry keyed by sessionId -> { mtimeMs, map }
const dbTelemetryCache = new Map();

// Cache for per-session daily usage keyed by sessionId -> { mtimeMs, perDay }
const sessionDailyCache = new Map();

// Cache for session title extracted from first 8KB of transcript.jsonl: id -> { size, title }
const sessionTitleCache = new Map();

// Short-lived cache for aggregated daily usage to avoid scanning 100+ sessions every 2s
let dailyUsageCache = { ts: 0, latestMtimeMs: 0, result: null };

function getAppDataDir() {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    const p = process.env.ANTIGRAVITY_APP_DATA_DIR.trim();
    if (fs.existsSync(p)) return p;
  }
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function getBrainDir() {
  return path.join(getAppDataDir(), 'brain');
}

function getConversationsDir() {
  return path.join(getAppDataDir(), 'conversations');
}

function getDailyHistoryStorePath() {
  return path.join(getAppDataDir(), 'token_daily_history.json');
}

function extractUserTitle(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const text = (match ? match[1] : rawContent).replace(/\s+/g, ' ').trim();
  return text.slice(0, 48) + (text.length > 48 ? '…' : '');
}

function formatModelDisplayName(raw) {
  if (!raw) return 'Default';
  return raw.replace(/\bArgon\b/gi, 'Pro');
}

function formatRawModelId(rawId) {
  const s = String(rawId || '').trim();
  if (!s) return 'Default';
  if (/orchestrator[-_]*argon/i.test(s)) return 'Orchestrator (Pro)';
  if (/orchestrator[-_]*neon/i.test(s)) return 'Orchestrator (Neon)';
  if (/orchestrator[-_]*hydrogen/i.test(s)) return 'Orchestrator (Hydrogen)';
  if (/orchestrator/i.test(s)) return 'Orchestrator (Carbon)';
  if (/flash[-_]*lite/i.test(s)) return 'Gemini Flash Lite';
  if (/gemini-3\.8-flash/i.test(s)) return 'Gemini 3.8 Flash';
  if (/gemini-3\.7-flash/i.test(s)) return 'Gemini 3.7 Flash';
  if (/flash/i.test(s)) return 'Gemini Flash';
  if (/neon/i.test(s)) return 'Gemini 4 Neon';
  if (/hydrogen[-_]*tiered[-_]*xhigh/i.test(s)) return 'Gemini 4 Hydrogen (XHigh)';
  if (/hydrogen[-_]*tiered[-_]*high/i.test(s)) return 'Gemini 4 Hydrogen (High)';
  if (/hydrogen/i.test(s)) return 'Gemini 4 Hydrogen';
  if (/carbon/i.test(s)) return 'Gemini 4 Carbon';
  if (/argon/i.test(s)) return 'Gemini 4 Pro';
  if (/opus/i.test(s)) return 'Claude Opus';
  if (/sonnet/i.test(s)) return 'Claude Sonnet';
  if (/haiku/i.test(s)) return 'Claude Haiku';
  return formatModelDisplayName(s);
}

function shortEngineName(name) {
  const s = String(name || '').trim();
  if (!s) return 'Executor';
  if (/3\.8[\s-]*flash/i.test(s)) return '3.8 Flash';
  if (/3\.7[\s-]*flash/i.test(s)) return '3.7 Flash';
  if (/flash[\s-]*lite/i.test(s)) return 'Flash Lite';
  if (/flash/i.test(s)) return 'Flash';
  if (/neon/i.test(s)) return 'Neon';
  if (/hydrogen/i.test(s)) return 'Hydrogen';
  if (/carbon/i.test(s)) return 'Carbon';
  if (/argon|gemini.*pro/i.test(s)) return 'Pro';
  if (/opus/i.test(s)) return 'Opus';
  if (/sonnet/i.test(s)) return 'Sonnet';
  if (/haiku/i.test(s)) return 'Haiku';
  return s.replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, '').replace(/\s*\([^)]+\)\s*$/, '').trim() || s;
}

function extractModelName(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  const match = rawContent.match(
    /changed setting `Model Selection` from [^\n]*? to ([^\n]+?)\.\s*No need to comment/i
  );
  if (!match) return '';
  return formatModelDisplayName(match[1].trim());
}

function createOrchTracker() {
  let active = false;
  let phase = 'plan';
  let plannerBase = 'Carbon';

  function isOrchPlannerLabel(label) {
    return /^\s*orchestrator\b/i.test(String(label || ''));
  }

  function isOrchPlannerId(modelId) {
    return /orchestrator/i.test(String(modelId || ''));
  }

  function isOrchWorkerLabel(label) {
    return /\(\s*orchestrator\s*\)\s*$/i.test(String(label || ''));
  }

  function isOrchWorkerId(modelId) {
    return /[-_]worker[-_]/i.test(String(modelId || ''));
  }

  function extractPlannerBase(label, modelId = '') {
    if (isOrchPlannerLabel(label)) {
      const m = String(label || '').match(/\(([^)]+)\)/);
      if (m) {
        const cleaned = formatModelDisplayName(m[1])
          .replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, '')
          .trim();
        if (cleaned && !/^orchestrator$/i.test(cleaned)) return cleaned;
      }
    }
    const id = String(modelId || '');
    if (isOrchPlannerId(id)) {
      if (/argon/i.test(id)) return 'Pro';
      if (/neon/i.test(id)) return 'Neon';
      if (/hydrogen/i.test(id)) return 'Hydrogen';
      if (/carbon/i.test(id)) return 'Carbon';
    }
    return '';
  }

  function extractWorkerModel(uiLabel, modelId) {
    if (isOrchWorkerLabel(uiLabel)) {
      const stripped = String(uiLabel)
        .replace(/\s*\(\s*orchestrator\s*\)\s*$/i, '')
        .trim();
      return formatModelDisplayName(stripped);
    }
    if (uiLabel && !isOrchPlannerLabel(uiLabel)) {
      return formatModelDisplayName(uiLabel);
    }
    if (modelId && !isOrchPlannerId(modelId)) {
      return formatRawModelId(modelId);
    }
    return '';
  }

  return {
    onMessage(step) {
      if (!step) return;
      const content = typeof step.content === 'string' ? step.content : '';
      const isPlanOffMsg = content.includes('Plan mode is off');
      const isPlanReviewMsg =
        !isPlanOffMsg && /(?:^|\n)\s*\[plan review(?:\s+due)?\]/m.test(content);

      if (step.type === 'USER_INPUT') {
        const m = extractModelName(content);
        if (m) {
          if (isOrchPlannerLabel(m)) {
            active = true;
            const base = extractPlannerBase(m);
            if (base) plannerBase = base;
          } else {
            active = false;
          }
        }
        phase = isPlanReviewMsg ? 'review' : 'plan';
      } else if (step.type === 'SYSTEM_MESSAGE') {
        if (isPlanOffMsg) {
          if (active) phase = 'exec';
        } else if (isPlanReviewMsg) {
          active = true;
          phase = 'review';
        }
      }
    },

    onPlannerStep(step, dbStep, fallbackModel) {
      const tools = Array.isArray(step?.tool_calls)
        ? step.tool_calls.map((tc) => tc.name).filter(Boolean)
        : [];
      const uiLabel = dbStep?.rawUiLabel || '';
      const modelId = dbStep?.rawModelId || '';

      const plannerStep = isOrchPlannerLabel(uiLabel) || isOrchPlannerId(modelId);
      const workerStep = !plannerStep && (isOrchWorkerLabel(uiLabel) || isOrchWorkerId(modelId));

      if (plannerStep) {
        active = true;
        const base = extractPlannerBase(uiLabel, modelId);
        if (base) plannerBase = base;
        if (phase === 'exec') phase = 'review';
      } else if (workerStep) {
        active = true;
        phase = 'exec';
      } else if (uiLabel && phase !== 'exec') {
        active = false;
      }

      if (tools.includes('exit_plan_mode') || tools.includes('enter_plan_mode')) {
        active = true;
      }

      if (!active) {
        const resolved = dbStep?.model || fallbackModel;
        return {
          orch: null,
          displayModel: resolved,
          pricingModel: resolved,
        };
      }

      const currentPhase = phase;
      const handoff = tools.includes('exit_plan_mode')
        ? 'to_exec'
        : tools.includes('enter_plan_mode')
          ? 'to_plan'
          : null;

      let engine = plannerBase || 'Carbon';
      let pricingModel = engine;

      if (currentPhase === 'exec') {
        const concreteExec = extractWorkerModel(uiLabel, modelId);
        engine = concreteExec ? shortEngineName(concreteExec) : 'Exec';
        pricingModel = concreteExec || 'Gemini Flash';
      }

      if (handoff === 'to_exec') {
        phase = 'exec';
      } else if (handoff === 'to_plan') {
        phase = 'review';
      }

      return {
        orch: {
          phase: currentPhase,
          engine,
          plannerBase,
          handoff,
        },
        displayModel: `Orchestrator (${plannerBase})`,
        pricingModel,
      };
    },
  };
}

function toLocalDateStr(isoOrMs) {
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Official API Pricing Table (USD per 1M tokens) matching Antigravity ModelPricingInfo
 * Cache Read is 0.1x (90% discount) of base input price across Gemini & Claude.
 */
function getModelPricing(modelName, promptContextTokens = 0) {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('opus')) {
    return {
      tier: 'Claude Opus',
      inputPricePerM: 5.0,
      cacheReadPricePerM: 0.5,
      outputPricePerM: 25.0,
    };
  }
  if (m.includes('sonnet') || m.includes('claude')) {
    return {
      tier: 'Claude Sonnet',
      inputPricePerM: 3.0,
      cacheReadPricePerM: 0.3,
      outputPricePerM: 15.0,
    };
  }
  if (m.includes('haiku')) {
    return {
      tier: 'Claude Haiku',
      inputPricePerM: 1.0,
      cacheReadPricePerM: 0.1,
      outputPricePerM: 5.0,
    };
  }
  if (/flash[\s-]*lite/.test(m)) {
    return {
      tier: 'Gemini Flash Lite',
      inputPricePerM: 0.1,
      cacheReadPricePerM: 0.01,
      outputPricePerM: 0.4,
    };
  }
  if (m.includes('flash')) {
    return {
      tier: 'Gemini Flash',
      inputPricePerM: 0.3,
      cacheReadPricePerM: 0.03,
      outputPricePerM: 2.5,
    };
  }
  // Gemini 4 Neon / Hydrogen / Carbon / Pro (>200k tiered context pricing)
  const familyLabel = m.includes('neon')
    ? 'Gemini 4 Neon'
    : m.includes('hydrogen')
      ? 'Gemini 4 Hydrogen'
      : m.includes('carbon')
        ? 'Gemini 4 Carbon'
        : 'Gemini Pro';
  if (promptContextTokens > 200000) {
    return {
      tier: `${familyLabel} (>200k)`,
      inputPricePerM: 4.0,
      cacheReadPricePerM: 0.4,
      outputPricePerM: 18.0,
    };
  }
  return {
    tier: `${familyLabel} (≤200k)`,
    inputPricePerM: 2.0,
    cacheReadPricePerM: 0.2,
    outputPricePerM: 12.0,
  };
}

/**
 * Calculates per-step API quota cost (USD), cache savings, and weighted equivalent tokens
 * (normalized to 1x base input token: Input*1 + Cache*0.1 + Output*(outPrice/inPrice)).
 */
function calcStepQuota(modelName, inputTokens, cacheTokens, outputTokens) {
  const promptTokens = inputTokens + cacheTokens;
  const pricing = getModelPricing(modelName, promptTokens);

  const inputCostUsd = (inputTokens * pricing.inputPricePerM) / 1e6;
  const cacheCostUsd = (cacheTokens * pricing.cacheReadPricePerM) / 1e6;
  const outputCostUsd = (outputTokens * pricing.outputPricePerM) / 1e6;
  const costUsd = inputCostUsd + cacheCostUsd + outputCostUsd;

  const uncachedCostUsd =
    (promptTokens * pricing.inputPricePerM + outputTokens * pricing.outputPricePerM) / 1e6;
  const savedUsd = Math.max(0, uncachedCostUsd - costUsd);
  const savedPct = uncachedCostUsd > 0 ? Math.round((savedUsd / uncachedCostUsd) * 100) : 0;

  const cacheWeight = pricing.inputPricePerM > 0 ? pricing.cacheReadPricePerM / pricing.inputPricePerM : 0.1;
  const outputWeight = pricing.inputPricePerM > 0 ? pricing.outputPricePerM / pricing.inputPricePerM : 6.0;
  const equivTokens = Math.round(
    inputTokens + cacheTokens * cacheWeight + outputTokens * outputWeight
  );

  return {
    costUsd: Number(costUsd.toFixed(6)),
    inputCostUsd: Number(inputCostUsd.toFixed(6)),
    cacheCostUsd: Number(cacheCostUsd.toFixed(6)),
    outputCostUsd: Number(outputCostUsd.toFixed(6)),
    savedUsd: Number(savedUsd.toFixed(6)),
    savedPct,
    equivTokens,
    cacheWeight: Number(cacheWeight.toFixed(2)),
    outputWeight: Number(outputWeight.toFixed(1)),
    pricing,
  };
}

// --- Minimal Protobuf Decoder for conversations/<id>.db ---
function readVarint(buf, offset) {
  let res = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    res |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { val: Number(res), next: pos };
    shift += 7n;
  }
  return { val: Number(res), next: pos };
}

function parseProto(buf) {
  let pos = 0;
  const out = {};
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (tag.next <= pos) break;
    pos = tag.next;
    const fieldNo = tag.val >> 3;
    const wireType = tag.val & 7;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.next;
      (out[fieldNo] = out[fieldNo] || []).push(v.val);
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.next;
      if (len.val < 0 || pos + len.val > buf.length) break;
      const sub = buf.subarray(pos, pos + len.val);
      pos += len.val;
      (out[fieldNo] = out[fieldNo] || []).push(sub);
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else {
      break;
    }
  }
  return out;
}

function parseProtoDurationSec(buf) {
  if (!buf) return 0;
  const p = parseProto(buf);
  const sec = p[1] ? p[1][0] : 0;
  const nanos = p[2] ? p[2][0] : 0;
  return sec + nanos / 1e9;
}

/**
 * Reads exact per-step timing & token breakdown from ~/.gemini/antigravity/conversations/<sessionId>.db
 */
function getSessionDbTelemetry(sessionId, hintMtimeMs = 0) {
  if (!DatabaseSync || !sessionId) return new Map();
  const dbPath = path.join(getConversationsDir(), `${sessionId}.db`);
  if (!fs.existsSync(dbPath)) return new Map();

  try {
    const stat = fs.statSync(dbPath);
    let walMtime = 0;
    try {
      walMtime = fs.statSync(`${dbPath}-wal`).mtimeMs;
    } catch {
      // no wal file
    }
    const effectiveMtime = Math.max(stat.mtimeMs, walMtime, hintMtimeMs);
    const cached = dbTelemetryCache.get(sessionId);
    if (cached && cached.mtimeMs === effectiveMtime) {
      return cached.map;
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const stepMap = new Map();

    try {
      const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      const genByIdx = new Map();

      for (const r of genRows) {
        if (!r.data) continue;
        const raw = Buffer.from(r.data);
        const top = parseProto(raw);
        if (!top[1]?.[0]) continue;
        const m = parseProto(top[1][0]);
        const u = m[4]?.[0] ? parseProto(m[4][0]) : {};
        const f11Sec = m[11]?.[0] ? parseProtoDurationSec(m[11][0]) : 0;
        const f12Sec = m[12]?.[0] ? parseProtoDurationSec(m[12][0]) : 0;
        const rawModelId = m[19]?.[0] ? m[19][0].toString('utf8').trim() : '';
        const rawUiLabel = m[21]?.[0] ? m[21][0].toString('utf8').trim() : '';
        const backendModelEnum = u[1]?.[0] || m[3]?.[0] || 0;
        const model = rawUiLabel
          ? formatModelDisplayName(rawUiLabel)
          : rawModelId
            ? formatRawModelId(rawModelId)
            : '';

        let lastStepIdx = null;
        for (const kvBuf of m[20] || []) {
          const kv = parseProto(kvBuf);
          const k = kv[1]?.[0] ? kv[1][0].toString('utf8') : '';
          const v = kv[2]?.[0] ? kv[2][0].toString('utf8') : '';
          if (k === 'last_step_index') lastStepIdx = Number(v);
        }

        const entry = {
          genIdx: r.idx,
          lastStepIdx,
          model,
          rawModelId,
          rawUiLabel,
          backendModelEnum,
          inputTokens: u[2]?.[0] || 0,
          outputTokens: u[3]?.[0] || 0,
          cacheTokens: u[5]?.[0] || 0,
          thinkingTokens: u[9]?.[0] || 0,
          textTokens: u[10]?.[0] || 0,
          f11Sec,
          f12Sec,
          totalSec: f11Sec + f12Sec,
        };
        genByIdx.set(r.idx, entry);
        if (lastStepIdx !== null && !Number.isNaN(lastStepIdx)) {
          stepMap.set(lastStepIdx + 1, entry);
        }
      }

      const stepRows = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 ORDER BY idx ASC').all();
      for (const sr of stepRows) {
        if (!sr.metadata) continue;
        const meta = parseProto(Buffer.from(sr.metadata));
        const tCreated = meta[1]?.[0] ? parseProtoDurationSec(meta[1][0]) : 0;
        const tFirst = meta[6]?.[0] ? parseProtoDurationSec(meta[6][0]) : 0;
        const tDone = meta[7]?.[0] ? parseProtoDurationSec(meta[7][0]) : 0;
        const link = meta[20]?.[0] ? parseProto(meta[20][0]) : {};
        const genIdx = link[3]?.[0];

        const genEntry = genIdx !== undefined ? genByIdx.get(genIdx) : stepMap.get(sr.idx);
        const f11Sec = tFirst > tCreated ? tFirst - tCreated : genEntry?.f11Sec || 0;
        const f12Sec = tDone >= tFirst && tFirst > 0 ? tDone - tFirst : genEntry?.f12Sec || 0;
        const totalSec = tDone > tCreated ? tDone - tCreated : f11Sec + f12Sec;

        stepMap.set(sr.idx, {
          ...(genEntry || {}),
          f11Sec,
          f12Sec,
          totalSec,
        });
      }
    } finally {
      db.close();
    }

    dbTelemetryCache.set(sessionId, { mtimeMs: effectiveMtime, map: stepMap });
    return stepMap;
  } catch {
    return new Map();
  }
}

function listSessions() {
  const brainDir = getBrainDir();
  if (!fs.existsSync(brainDir)) return [];

  const entries = fs.readdirSync(brainDir, { withFileTypes: true });
  const sessions = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'tempmediaStorage') {
      continue;
    }
    const id = entry.name;
    const transcriptPath = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) continue;

    try {
      const stat = fs.statSync(transcriptPath);
      const cachedTitle = sessionTitleCache.get(id);
      let title = `会话 ${id.slice(0, 8)}`;
      if (cachedTitle && (!cachedTitle.title.startsWith('会话 ') || cachedTitle.size === stat.size)) {
        title = cachedTitle.title;
      } else {
        const fd = fs.openSync(transcriptPath, 'r');
        const buf = Buffer.alloc(Math.min(8192, stat.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);

        const firstChunk = buf.toString('utf8');
        const firstLines = firstChunk.split('\n').filter(Boolean);
        for (const line of firstLines.slice(0, 5)) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'USER_INPUT' && obj.content) {
              const extracted = extractUserTitle(obj.content);
              if (extracted) {
                title = extracted;
                break;
              }
            }
          } catch {
            // ignore partial line
          }
        }
        sessionTitleCache.set(id, { size: stat.size, title });
      }

      sessions.push({
        id,
        shortId: id.slice(0, 8),
        title,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    } catch {
      // ignore unreadable session
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions.slice(0, 30);
}

/**
 * Aggregates daily token & quota usage across all sessions in brainDir
 */
function computeDailyUsage(latestMtimeMs = 0) {
  const now = Date.now();
  if (
    dailyUsageCache.result &&
    dailyUsageCache.latestMtimeMs === latestMtimeMs &&
    now - dailyUsageCache.ts < 8000
  ) {
    return dailyUsageCache.result;
  }

  const brainDir = getBrainDir();
  const storePath = getDailyHistoryStorePath();

  let persistentStore = { schemaVersion: DAILY_STORE_SCHEMA_VERSION, sessions: {} };
  try {
    if (fs.existsSync(storePath)) {
      const loaded = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (loaded && loaded.schemaVersion === DAILY_STORE_SCHEMA_VERSION && loaded.sessions) {
        persistentStore = loaded;
      }
    }
  } catch {
    persistentStore = { schemaVersion: DAILY_STORE_SCHEMA_VERSION, sessions: {} };
  }

  let storeDirty = false;

  if (fs.existsSync(brainDir)) {
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'tempmediaStorage') {
        continue;
      }
      const id = entry.name;
      const transcriptPath = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;

      try {
        const stat = fs.statSync(transcriptPath);
        const memCached = sessionDailyCache.get(id);
        if (memCached && memCached.mtimeMs === stat.mtimeMs) {
          if (!persistentStore.sessions[id]) {
            persistentStore.sessions[id] = memCached;
            storeDirty = true;
          }
          continue;
        }

        const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
        const dbMap = getSessionDbTelemetry(id, stat.mtimeMs);
        const orchTracker = createOrchTracker();
        let currentModel = 'Gemini 4 Pro';
        const perDay = {};

        for (const line of lines) {
          try {
            const s = JSON.parse(line);
            if (s.type === 'USER_INPUT' || s.type === 'SYSTEM_MESSAGE') {
              orchTracker.onMessage(s);
              if (s.type === 'USER_INPUT' && s.content) {
                const m = extractModelName(s.content);
                if (m) currentModel = m;
              }
            } else if (s.type === 'PLANNER_RESPONSE' && s.created_at) {
              const dateKey = toLocalDateStr(s.created_at);
              if (!dateKey) continue;
              const dbInfo = dbMap.get(s.step_index);
              if (dbInfo?.model) currentModel = dbInfo.model;

              const { displayModel, pricingModel } = orchTracker.onPlannerStep(s, dbInfo, currentModel || 'Default');
              const modelName = displayModel || 'Default';

              const inp = Number(s.input_tokens || 0);
              const cac = Number(s.cache_read_tokens || 0);
              const out = Number(s.output_tokens || 0);
              const quota = calcStepQuota(pricingModel || modelName, inp, cac, out);

              if (!perDay[dateKey]) {
                perDay[dateKey] = {
                  in: 0,
                  cache: 0,
                  out: 0,
                  costUsd: 0,
                  savedUsd: 0,
                  equivTokens: 0,
                  steps: 0,
                  models: {},
                  modelCosts: {},
                };
              }
              const d = perDay[dateKey];
              d.in += inp;
              d.cache += cac;
              d.out += out;
              d.costUsd += quota.costUsd;
              d.savedUsd += quota.savedUsd;
              d.equivTokens += quota.equivTokens;
              d.steps += 1;
              d.models[modelName] = (d.models[modelName] || 0) + inp + cac + out;
              d.modelCosts[modelName] = (d.modelCosts[modelName] || 0) + quota.costUsd;
            }
          } catch {
            // ignore line
          }
        }

        sessionDailyCache.set(id, { mtimeMs: stat.mtimeMs, perDay });
        persistentStore.sessions[id] = { mtimeMs: stat.mtimeMs, perDay };
        storeDirty = true;
      } catch {
        // ignore
      }
    }
  }

  if (storeDirty) {
    try {
      fs.writeFileSync(storePath, JSON.stringify(persistentStore), 'utf8');
    } catch {
      // ignore write error
    }
  }

  const dailyMap = new Map();
  for (const [, sData] of Object.entries(persistentStore.sessions)) {
    const perDay = sData?.perDay || {};
    for (const [dateKey, metrics] of Object.entries(perDay)) {
      let agg = dailyMap.get(dateKey);
      if (!agg) {
        agg = {
          date: dateKey,
          inputTokens: 0,
          cacheTokens: 0,
          outputTokens: 0,
          netTokens: 0,
          totalTokens: 0,
          equivTokens: 0,
          costUsd: 0,
          savedUsd: 0,
          steps: 0,
          sessions: 0,
          models: {},
          modelCosts: {},
        };
        dailyMap.set(dateKey, agg);
      }
      const inp = Number(metrics.in || 0);
      const cac = Number(metrics.cache || 0);
      const out = Number(metrics.out || 0);
      agg.inputTokens += inp;
      agg.cacheTokens += cac;
      agg.outputTokens += out;
      agg.netTokens += inp + out;
      agg.totalTokens += inp + cac + out;
      agg.equivTokens += Number(metrics.equivTokens || 0);
      agg.costUsd = Number((agg.costUsd + Number(metrics.costUsd || 0)).toFixed(4));
      agg.savedUsd = Number((agg.savedUsd + Number(metrics.savedUsd || 0)).toFixed(4));
      agg.steps += Number(metrics.steps || 0);
      agg.sessions += 1;
      for (const [mName, mTok] of Object.entries(metrics.models || {})) {
        agg.models[mName] = (agg.models[mName] || 0) + mTok;
      }
      for (const [mName, mCost] of Object.entries(metrics.modelCosts || {})) {
        agg.modelCosts[mName] = Number(((agg.modelCosts[mName] || 0) + mCost).toFixed(4));
      }
    }
  }

  const days = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const todayStr = toLocalDateStr(Date.now());
  const todayEntry = dailyMap.get(todayStr) || {
    date: todayStr,
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
    netTokens: 0,
    totalTokens: 0,
    equivTokens: 0,
    costUsd: 0,
    savedUsd: 0,
    steps: 0,
    sessions: 0,
    models: {},
    modelCosts: {},
  };

  let totalAllTime = 0;
  let netAllTime = 0;
  let costAllTimeUsd = 0;
  let maxDailyTotal = 0;
  for (const d of days) {
    totalAllTime += d.totalTokens;
    netAllTime += d.netTokens;
    costAllTimeUsd += d.costUsd;
    if (d.totalTokens > maxDailyTotal) maxDailyTotal = d.totalTokens;
  }

  const result = {
    todayDate: todayStr,
    today: todayEntry,
    maxDailyTotal,
    totalAllTime,
    netAllTime,
    costAllTimeUsd: Number(costAllTimeUsd.toFixed(2)),
    activeDaysCount: days.length,
    days,
  };
  dailyUsageCache = { ts: Date.now(), latestMtimeMs, result };
  return result;
}

function parseSessionStats(sessionId) {
  const sessions = listSessions();
  const brainDir = getBrainDir();
  const cleanSessionId =
    sessionId && sessionId !== '__latest__' ? String(sessionId).trim() : '';

  let targetId = null;
  if (cleanSessionId) {
    const directTp = path.join(brainDir, cleanSessionId, '.system_generated', 'logs', 'transcript.jsonl');
    if (sessions.some((s) => s.id === cleanSessionId) || fs.existsSync(directTp)) {
      targetId = cleanSessionId;
    }
  }
  if (!targetId) {
    targetId = sessions[0]?.id || null;
  }

  const latestMtimeMs = sessions[0]?.mtimeMs || 0;
  const dailyUsage = computeDailyUsage(latestMtimeMs);

  if (!targetId) {
    return {
      activeSessionId: null,
      sessions: [],
      summary: null,
      steps: [],
      dailyUsage,
    };
  }

  const transcriptPath = path.join(brainDir, targetId, '.system_generated', 'logs', 'transcript.jsonl');
  const stat = fs.statSync(transcriptPath);
  const rawLines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const dbMap = getSessionDbTelemetry(targetId, stat.mtimeMs);

  const rawSteps = [];
  for (const line of rawLines) {
    try {
      rawSteps.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }

  if (rawSteps.length > 0) {
    const lastStep = rawSteps[rawSteps.length - 1];
    const key = `${targetId}:${lastStep.step_index}`;
    if (!stepFinishObservedMs.has(key)) {
      stepFinishObservedMs.set(key, stat.mtimeMs);
    }
  }

  const orchTracker = createOrchTracker();
  let currentModel = 'Gemini 4 Pro';
  let sessionTitle = `会话 ${targetId.slice(0, 8)}`;
  const plannerSteps = [];

  let totalInputTokens = 0;
  let totalCacheTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalTextTokens = 0;
  let totalCostUsd = 0;
  let totalSavedUsd = 0;
  let totalEquivTokens = 0;

  let totalMeasuredOutputTokens = 0;
  let totalE2EDurationSec = 0;
  let totalDecodeDurationSec = 0;
  let totalTtftDurationSec = 0;

  let peakDecodeTokPerSec = 0;
  let peakE2ETokPerSec = 0;

  let planSteps = 0;
  let execSteps = 0;
  let reviewSteps = 0;

  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i];
    if (s.type === 'USER_INPUT' || s.type === 'SYSTEM_MESSAGE') {
      orchTracker.onMessage(s);
      if (s.type === 'USER_INPUT' && s.content) {
        if (sessionTitle.startsWith('会话 ')) {
          const t = extractUserTitle(s.content);
          if (t) sessionTitle = t;
        }
        const m = extractModelName(s.content);
        if (m) currentModel = m;
      }
    }

    if (s.type === 'PLANNER_RESPONSE') {
      const dbStep = dbMap.get(s.step_index);
      if (dbStep?.model) {
        currentModel = dbStep.model;
      }

      const { orch, displayModel, pricingModel } = orchTracker.onPlannerStep(s, dbStep, currentModel);
      if (displayModel) {
        currentModel = displayModel;
      }
      if (orch) {
        if (orch.phase === 'plan') planSteps += 1;
        else if (orch.phase === 'exec') execSteps += 1;
        else if (orch.phase === 'review') reviewSteps += 1;
      }

      const inputTokens = Number(s.input_tokens || dbStep?.inputTokens || 0);
      const cacheTokens = Number(s.cache_read_tokens || dbStep?.cacheTokens || 0);
      const outputTokens = Number(s.output_tokens || dbStep?.outputTokens || 0);
      const thinkingTokens = dbStep?.thinkingTokens ?? 0;
      const textTokens = dbStep?.textTokens ?? Math.max(0, outputTokens - thinkingTokens);
      const contextTokens = inputTokens + cacheTokens + outputTokens;

      const quota = calcStepQuota(pricingModel || currentModel, inputTokens, cacheTokens, outputTokens);

      totalInputTokens += inputTokens;
      totalCacheTokens += cacheTokens;
      totalOutputTokens += outputTokens;
      totalThinkingTokens += thinkingTokens;
      totalTextTokens += textTokens;
      totalCostUsd += quota.costUsd;
      totalSavedUsd += quota.savedUsd;
      totalEquivTokens += quota.equivTokens;

      const tStartMs = s.created_at ? Date.parse(s.created_at) : NaN;
      const nextStep = i + 1 < rawSteps.length ? rawSteps[i + 1] : null;

      let durationSec = null;
      let durationSource = 'unknown';

      if (dbStep && dbStep.totalSec > 0.05 && dbStep.totalSec < 600) {
        durationSec = dbStep.totalSec;
        durationSource = 'sqlite_exact';
      } else if (nextStep && nextStep.type !== 'USER_INPUT' && nextStep.created_at) {
        const tEndMs = Date.parse(nextStep.created_at);
        const dt = (tEndMs - tStartMs) / 1000;
        if (dt > 0 && dt < 600) {
          durationSec = dt;
          durationSource = 'next_step';
        }
      } else if (!nextStep) {
        const dt = (stat.mtimeMs - tStartMs) / 1000;
        if (dt > 0 && dt < 600) {
          durationSec = dt;
          durationSource = 'file_mtime';
        }
      } else {
        const observedMs = stepFinishObservedMs.get(`${targetId}:${s.step_index}`);
        if (observedMs) {
          const dt = (observedMs - tStartMs) / 1000;
          if (dt > 0 && dt < 600) {
            durationSec = dt;
            durationSource = 'observed_mtime';
          }
        }
      }

      let ttftSec = null;
      let decodeSec = null;
      let decodeTokPerSec = null;
      let e2eTokPerSec = null;

      if (durationSec && durationSec > 0 && outputTokens > 0) {
        e2eTokPerSec = Number((outputTokens / durationSec).toFixed(1));

        const estPrefillTtft = Math.min(
          durationSec * 0.58,
          2.0 + inputTokens / 8500 + cacheTokens / 140000
        );

        if (dbStep && dbStep.f12Sec >= 1.2 && textTokens >= 60) {
          const netDecodeSec = Math.max(0.3, durationSec - estPrefillTtft);
          const streamRate = textTokens / dbStep.f12Sec;
          const netRate = outputTokens / netDecodeSec;
          if (streamRate >= netRate && streamRate <= 220) {
            decodeTokPerSec = Number(streamRate.toFixed(1));
            ttftSec = Number(estPrefillTtft.toFixed(1));
            decodeSec = Number((outputTokens / streamRate).toFixed(1));
          } else {
            ttftSec = Number(estPrefillTtft.toFixed(1));
            decodeSec = Number(netDecodeSec.toFixed(1));
            decodeTokPerSec = Number(netRate.toFixed(1));
          }
        } else {
          ttftSec = Number(estPrefillTtft.toFixed(1));
          decodeSec = Number(Math.max(0.25, durationSec - estPrefillTtft).toFixed(1));
          decodeTokPerSec = Number((outputTokens / decodeSec).toFixed(1));
        }

        totalMeasuredOutputTokens += outputTokens;
        totalE2EDurationSec += durationSec;
        totalDecodeDurationSec += decodeSec;
        totalTtftDurationSec += ttftSec;

        if (decodeTokPerSec > peakDecodeTokPerSec) {
          peakDecodeTokPerSec = decodeTokPerSec;
        }
        if (e2eTokPerSec > peakE2ETokPerSec) {
          peakE2ETokPerSec = e2eTokPerSec;
        }
      }

      const tools = Array.isArray(s.tool_calls)
        ? s.tool_calls.map((tc) => tc.name).filter(Boolean)
        : [];

      const stepCacheHitRate =
        inputTokens + cacheTokens > 0
          ? Number(((cacheTokens / (inputTokens + cacheTokens)) * 100).toFixed(1))
          : 0;

      plannerSteps.push({
        stepIndex: s.step_index,
        createdAt: s.created_at,
        model: displayModel || currentModel,
        orch,
        inputTokens,
        cacheTokens,
        outputTokens,
        thinkingTokens,
        textTokens,
        contextTokens,
        cacheHitRate: stepCacheHitRate,
        quota,
        durationSec: durationSec ? Number(durationSec.toFixed(1)) : null,
        ttftSec,
        decodeSec,
        f11Sec: dbStep?.f11Sec ? Number(dbStep.f11Sec.toFixed(2)) : null,
        f12Sec: dbStep?.f12Sec ? Number(dbStep.f12Sec.toFixed(2)) : null,
        durationSource,
        decodeTokPerSec,
        e2eTokPerSec,
        tokPerSec: decodeTokPerSec,
        tools,
        hasThinking: Boolean(s.thinking || thinkingTokens > 0),
      });
    }
  }

  const avgDecodeTokPerSec =
    totalDecodeDurationSec > 0
      ? Number((totalMeasuredOutputTokens / totalDecodeDurationSec).toFixed(1))
      : null;

  const avgE2ETokPerSec =
    totalE2EDurationSec > 0
      ? Number((totalMeasuredOutputTokens / totalE2EDurationSec).toFixed(1))
      : null;

  const measuredSteps = plannerSteps.filter((st) => st.decodeTokPerSec !== null);
  const latestMeasured = measuredSteps.length > 0 ? measuredSteps[measuredSteps.length - 1] : null;

  const latestStep = plannerSteps.length > 0 ? plannerSteps[plannerSteps.length - 1] : null;
  const currentContextTokens = latestStep ? latestStep.contextTokens : 0;

  const overallCacheHitRate =
    totalInputTokens + totalCacheTokens > 0
      ? Number(((totalCacheTokens / (totalInputTokens + totalCacheTokens)) * 100).toFixed(1))
      : 0;

  let uiVersion = 1;
  try {
    uiVersion = fs.statSync(path.join(__dirname, 'index.html')).mtimeMs;
  } catch {
    // ignore
  }

  return {
    uiVersion,
    activeSessionId: targetId,
    sessionTitle,
    currentModel,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    sessions,
    dailyUsage,
    summary: {
      stepCount: plannerSteps.length,
      orchSummary: { planSteps, execSteps, reviewSteps },
      totalInputTokens,
      totalCacheTokens,
      totalOutputTokens,
      totalThinkingTokens,
      totalTextTokens,
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      totalSavedUsd: Number(totalSavedUsd.toFixed(4)),
      totalEquivTokens,
      currentContextTokens,
      overallCacheHitRate,
      latestDecodeTokPerSec: latestMeasured ? latestMeasured.decodeTokPerSec : null,
      latestE2ETokPerSec: latestMeasured ? latestMeasured.e2eTokPerSec : null,
      latestTtftSec: latestMeasured ? latestMeasured.ttftSec : null,
      avgDecodeTokPerSec,
      avgE2ETokPerSec,
      peakDecodeTokPerSec: peakDecodeTokPerSec > 0 ? peakDecodeTokPerSec : null,
      peakE2ETokPerSec: peakE2ETokPerSec > 0 ? peakE2ETokPerSec : null,
      latestTokPerSec: latestMeasured ? latestMeasured.decodeTokPerSec : null,
      avgTokPerSec: avgDecodeTokPerSec,
      peakTokPerSec: peakDecodeTokPerSec > 0 ? peakDecodeTokPerSec : null,
      totalMeasuredDurationSec: Number(totalE2EDurationSec.toFixed(1)),
      totalDecodeDurationSec: Number(totalDecodeDurationSec.toFixed(1)),
      totalTtftDurationSec: Number(totalTtftDurationSec.toFixed(1)),
    },
    steps: plannerSteps,
  };
}

// Auto-restart via SidecarManager (restart_policy: "always") when main.mjs is updated on disk
fs.watchFile(__filename, { interval: 1500 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) {
    console.log('[agy-token-monitor] main.mjs changed on disk, exiting for auto-restart...');
    process.exit(0);
  }
});

const standaloneIdx = process.argv.indexOf('--standalone');
if (standaloneIdx !== -1) {
  const port = Number(process.argv[standaloneIdx + 1] || 3299);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(`window.sidecar = { conversationId: null, fetch: (u, o) => fetch(u, o) };`);
      return;
    }
    if (url.pathname === '/api/stats') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const params = body ? JSON.parse(body) : {};
        const sessionId = params.sessionId || url.searchParams.get('sessionId') || null;
        const data = parseSessionStats(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[agy-token-monitor] Standalone server listening on http://127.0.0.1:${port}`);
  });
} else {
  const { SidecarApp, Response } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    return new Response(html, {
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
    });
  });

  app.api('/api/stats', (data) => {
    return parseSessionStats(data?.sessionId || null);
  }, 'POST');

  app.api('/api/stats', (data) => {
    return parseSessionStats(data?.sessionId || null);
  }, 'GET');

  await app.run();
}
