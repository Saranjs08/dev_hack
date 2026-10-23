'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const { createSeedMemory } = require('./seed');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_DATA_FILE = path.join(ROOT_DIR, 'data', 'session_memory.json');
const DATA_FILE = path.resolve(process.env.LEXAFLOW_DATA_FILE || DEFAULT_DATA_FILE);

const MAX_TELEMETRY_FRAMES = 160;
const bus = new EventEmitter();
bus.setMaxListeners(100);

let telemetryFrames = [];
let telemetrySeq = 0;

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDataDir() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function writeMemoryFile(memory) {
  ensureDataDir();
  const payload = `${JSON.stringify(memory, null, 2)}\n`;
  const tempFile = `${DATA_FILE}.tmp`;
  try {
    fs.writeFileSync(tempFile, payload, 'utf8');
    fs.renameSync(tempFile, DATA_FILE);
  } catch (error) {
    // Windows can occasionally lock a file during antivirus scans. Falling back
    // to a direct write keeps the demo resilient without losing state.
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {
      /* noop */
    }
    fs.writeFileSync(DATA_FILE, payload, 'utf8');
  }
}

function initializeStore() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    writeMemoryFile(createSeedMemory());
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || !parsed.household || !parsed.commerce) {
      throw new Error('Memory file is missing required sections.');
    }
  } catch (error) {
    const backup = `${DATA_FILE}.corrupt-${Date.now()}.bak`;
    try {
      fs.copyFileSync(DATA_FILE, backup);
    } catch (_) {
      /* noop */
    }
    writeMemoryFile(createSeedMemory());
  }
}

function readMemory() {
  initializeStore();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function updateMemory(mutator) {
  const memory = readMemory();
  const beforeRevision = Number(memory.meta && memory.meta.revision) || 0;
  const result = mutator(memory) || {};
  memory.meta = memory.meta || {};
  memory.meta.revision = beforeRevision + 1;
  memory.meta.updatedAt = new Date().toISOString();
  memory.meta.store = path.relative(ROOT_DIR, DATA_FILE).replace(/\\/g, '/');
  writeMemoryFile(memory);
  bus.emit('memory', {
    revision: memory.meta.revision,
    updatedAt: memory.meta.updatedAt,
  });
  return { memory, result };
}

function resetMemory() {
  writeMemoryFile(createSeedMemory());
  telemetryFrames = [];
  telemetrySeq = 0;
  const memory = readMemory();
  bus.emit('memory', {
    revision: memory.meta.revision,
    updatedAt: memory.meta.updatedAt,
    reset: true,
  });
  return memory;
}

function recordFrame(frame) {
  telemetrySeq += 1;
  const normalized = {
    frameId: frame.frameId || uuidv4(),
    seq: telemetrySeq,
    timestamp: frame.timestamp || new Date().toISOString(),
    direction: frame.direction || 'request',
    method: frame.method || 'unknown',
    rpcId: frame.rpcId === undefined ? null : frame.rpcId,
    sessionId: frame.sessionId || null,
    transport: frame.transport || 'mcp',
    latencyMs: frame.latencyMs === undefined ? null : frame.latencyMs,
    payload: frame.payload === undefined ? null : frame.payload,
    note: frame.note || null,
  };

  telemetryFrames.push(normalized);
  if (telemetryFrames.length > MAX_TELEMETRY_FRAMES) {
    telemetryFrames = telemetryFrames.slice(-MAX_TELEMETRY_FRAMES);
  }
  bus.emit('telemetry', normalized);
  return normalized;
}

function getTelemetry(limit = 60) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 60, MAX_TELEMETRY_FRAMES));
  return telemetryFrames.slice(-safeLimit);
}

function getTelemetryStats() {
  const responses = telemetryFrames.filter(
    (frame) => frame.direction === 'response' && typeof frame.latencyMs === 'number',
  );
  const totalLatency = responses.reduce((sum, frame) => sum + frame.latencyMs, 0);
  return {
    frames: telemetryFrames.length,
    responseFrames: responses.length,
    toolCalls: telemetryFrames.filter(
      (frame) => frame.direction === 'request' && frame.method === 'tools/call',
    ).length,
    averageLatencyMs: responses.length ? Math.round(totalLatency / responses.length) : 0,
  };
}

function pathInfo() {
  return {
    dataFile: path.relative(ROOT_DIR, DATA_FILE).replace(/\\/g, '/'),
    absoluteDataFile: DATA_FILE,
    rootDir: ROOT_DIR,
  };
}

module.exports = {
  ROOT_DIR,
  DATA_FILE,
  bus,
  initializeStore,
  readMemory,
  updateMemory,
  resetMemory,
  recordFrame,
  getTelemetry,
  getTelemetryStats,
  pathInfo,
  deepClone,
  uuid: uuidv4,
};
