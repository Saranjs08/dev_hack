'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const store = require('./store');
const {
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  RESOURCES,
  PROMPTS,
  callTool,
  listTools,
  listResources,
  readResource,
  buildPrompt,
} = require('./tools');

const ACCEPTED_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
]);

const sessions = new Map();
const sseClients = new Set();

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error,
  };
}

function rpcResult(id, result) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    result,
  };
}

function pruneSessions() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, session] of sessions.entries()) {
    if (session.lastSeen < cutoff) sessions.delete(id);
  }
  if (sessions.size > 300) {
    const oldest = [...sessions.entries()]
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      .slice(0, sessions.size - 300);
    for (const [id] of oldest) sessions.delete(id);
  }
}

function touchSession(id) {
  if (!id) return null;
  const session = sessions.get(id);
  if (session) session.lastSeen = Date.now();
  return session || null;
}

function recordExchange({
  method,
  id,
  sessionId,
  transport,
  params,
  result,
  error,
  startedAt,
}) {
  const latencyMs = Date.now() - startedAt;
  store.recordFrame({
    direction: 'request',
    method,
    rpcId: id === undefined ? null : id,
    sessionId,
    transport,
    payload: {
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      method,
      ...(params === undefined ? {} : { params }),
    },
  });
  store.recordFrame({
    direction: 'response',
    method,
    rpcId: id === undefined ? null : id,
    sessionId,
    transport,
    latencyMs,
    payload: error
      ? { jsonrpc: '2.0', id: id === undefined ? null : id, error }
      : { jsonrpc: '2.0', id: id === undefined ? null : id, result },
  });
}

function supportedMethods() {
  return [
    'initialize',
    'notifications/initialized',
    'ping',
    'tools/list',
    'tools/call',
    'resources/list',
    'resources/templates/list',
    'resources/read',
    'prompts/list',
    'prompts/get',
    'logging/setLevel',
  ];
}

function initializeResult(message) {
  const clientInfo = message.params?.clientInfo || {};
  const requestedVersion = message.params?.protocolVersion || null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      logging: {},
      completions: {},
    },
    serverInfo: {
      name: SERVER_NAME,
      title: 'LexaFlow — Stateful Alexa+ MCP Server',
      version: SERVER_VERSION,
      description:
        'Stateful, multi-service Model Context Protocol server for Alexa+ household orchestration: memory, commerce, IoT, and multimodal carousels.',
      websiteUrl: 'https://github.com/Hareeshwar-N-K/lexaflow-alexa-plus-mcp',
    },
    instructions: [
      'LexaFlow is a stateful household orchestrator for Alexa+.',
      `Negotiated protocol: ${PROTOCOL_VERSION}. Requested by client: ${requestedVersion || 'not specified'}.`,
      'Load memory_get_or_update before commerce, climate, or scheduling decisions.',
      'Every purchase must be confirmed explicitly by the user through the Alexa+ purchase card.',
      'Speak concise summaries; send dense product, recipe, and device details to multimodal carousels.',
      `Registered client: ${clientInfo.name || 'anonymous'} ${clientInfo.version || ''}`.trim(),
    ].join(' '),
  };
}

function toolListResult() {
  return { tools: listTools() };
}

function resourceListResult() {
  return { resources: listResources() };
}

function promptListResult() {
  return { prompts: PROMPTS };
}

/**
 * Dispatch a decoded JSON-RPC message. Returns a response object, or null for
 * notifications. Tool failures stay inside the MCP tool result (`isError`) as
 * required by the protocol, while protocol-level faults return JSON-RPC errors.
 */
function handleMessage(message, context) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request: expected a single JSON-RPC object.');
  }
  if (message.jsonrpc !== '2.0') {
    return rpcError(message.id, -32600, 'Invalid Request: jsonrpc must be "2.0".');
  }
  if (typeof message.method !== 'string' || !message.method) {
    return rpcError(message.id, -32600, 'Invalid Request: method is required.');
  }

  const method = message.method;
  const isNotification = message.id === undefined || message.id === null;
  const startedAt = Date.now();

  if (method === 'initialize') {
    pruneSessions();
    const sessionId = uuidv4();
    const result = initializeResult(message);
    sessions.set(sessionId, {
      id: sessionId,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      initialized: false,
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: message.params?.clientInfo || null,
      transport: context.transport,
    });
    context.sessionId = sessionId;
    recordExchange({
      method,
      id: message.id,
      sessionId,
      transport: context.transport,
      params: message.params,
      result,
      startedAt,
    });
    return rpcResult(message.id, result);
  }

  if (isNotification) {
    if (method === 'notifications/initialized') {
      const session = touchSession(context.sessionId);
      if (session) session.initialized = true;
      return null;
    }
    if (
      method === 'notifications/cancelled' ||
      method === 'notifications/roots/list_changed' ||
      method === 'notifications/progress'
    ) {
      return null;
    }
    return null;
  }

  const session = touchSession(context.sessionId);
  const send = (result, params, error) => {
    recordExchange({
      method,
      id: message.id,
      sessionId: context.sessionId,
      transport: context.transport,
      params,
      result,
      error,
      startedAt,
    });
    return error ? rpcError(message.id, error.code, error.message, error.data) : rpcResult(message.id, result);
  };

  try {
    if (method === 'ping') {
      return send({}, undefined);
    }
    if (method === 'tools/list') {
      return send(toolListResult(), message.params);
    }
    if (method === 'tools/call') {
      const name = message.params?.name;
      if (!name) {
        const error = { code: -32602, message: 'Invalid params: tools/call requires a tool name.' };
        return send(null, message.params, error);
      }
      const result = callTool(name, message.params?.arguments || {}, {
        rpcId: message.id,
        sessionId: context.sessionId,
        transport: context.transport,
      });
      return rpcResult(message.id, result);
    }
    if (method === 'resources/list') {
      return send(resourceListResult(), message.params);
    }
    if (method === 'resources/templates/list') {
      return send({ resourceTemplates: [] }, message.params);
    }
    if (method === 'resources/read') {
      const uri = message.params?.uri;
      if (!uri) {
        const error = { code: -32602, message: 'Invalid params: resources/read requires a uri.' };
        return send(null, message.params, error);
      }
      const content = readResource(uri);
      return send({ contents: [content] }, message.params);
    }
    if (method === 'prompts/list') {
      return send(promptListResult(), message.params);
    }
    if (method === 'prompts/get') {
      const name = message.params?.name;
      if (!name) {
        const error = { code: -32602, message: 'Invalid params: prompts/get requires a name.' };
        return send(null, message.params, error);
      }
      try {
        return send(buildPrompt(name, message.params?.arguments || {}), message.params);
      } catch (error) {
        return send(null, message.params, { code: -32602, message: error.message });
      }
    }
    if (method === 'logging/setLevel') {
      return send({}, message.params);
    }

    return send(null, message.params, {
      code: -32601,
      message: `Method not found: ${method}`,
      data: { supported: supportedMethods() },
    });
  } catch (error) {
    return send(null, message.params, {
      code: -32603,
      message: error && error.message ? error.message : 'Internal error',
    });
  }
}

function wantsSse(req) {
  if (String(req.query.stream || '').toLowerCase() === 'true') return true;
  const accept = String(req.get('Accept') || '');
  return accept.includes('text/event-stream') && !accept.includes('application/json');
}

function writeSse(res, event, data, id) {
  try {
    if (id !== undefined && id !== null) res.write(`id: ${id}\n`);
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function broadcastTelemetry(frame) {
  if (sseClients.size === 0) return;
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: 'info',
      logger: 'lexaflow.telemetry',
      data: {
        frameId: frame.frameId,
        seq: frame.seq,
        direction: frame.direction,
        method: frame.method,
        rpcId: frame.rpcId,
        transport: frame.transport,
        latencyMs: frame.latencyMs,
        note: frame.note,
        timestamp: frame.timestamp,
      },
    },
  };

  for (const client of sseClients) {
    if (!writeSse(client.res, 'message', notification, frame.seq)) {
      cleanupSseClient(client);
    }
  }
}

function cleanupSseClient(client) {
  if (!client) return;
  sseClients.delete(client);
  if (client.heartbeat) clearInterval(client.heartbeat);
  try {
    client.res.end();
  } catch (_) {
    /* noop */
  }
}

store.bus.on('telemetry', broadcastTelemetry);

const router = express.Router();

router.options('/', (req, res) => {
  res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
  res.status(204).end();
});

router.post('/', (req, res) => {
  const versionHeader = req.get('MCP-Protocol-Version');
  if (versionHeader && !ACCEPTED_PROTOCOL_VERSIONS.has(versionHeader)) {
    return res.status(400).json(
      rpcError(
        null,
        -32600,
        `Unsupported MCP-Protocol-Version "${versionHeader}". This server implements ${PROTOCOL_VERSION}.`,
      ),
    );
  }

  let providedSessionId = req.get('Mcp-Session-Id') || null;
  if (providedSessionId && !sessions.has(providedSessionId)) {
    return res.status(404).json(
      rpcError(null, -32000, 'Session not found. Send initialize to create a new MCP session.'),
    );
  }

  const body = req.body;
  if (Array.isArray(body)) {
    return res.status(400).json(
      rpcError(null, -32600, 'JSON-RPC batching is not supported by MCP 2025-11-25.'),
    );
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json(rpcError(null, -32700, 'Parse error: expected a JSON object.'));
  }

  const context = {
    sessionId: providedSessionId,
    transport: 'mcp-http',
  };

  const response = handleMessage(body, context);
  const sessionId = context.sessionId || providedSessionId;

  if (sessionId) res.setHeader('Mcp-Session-Id', sessionId);
  res.setHeader('MCP-Protocol-Version', PROTOCOL_VERSION);

  if (body.method === 'initialize' && context.sessionId) {
    res.setHeader('Mcp-Session-Id', context.sessionId);
  }

  if (response === null) {
    return res.status(202).end();
  }

  if (wantsSse(req)) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    writeSse(res, 'message', response, response.id ?? undefined);
    return res.end();
  }

  return res.status(200).json(response);
});

router.get('/', (req, res) => {
  const accept = String(req.get('Accept') || '');
  if (!accept.includes('text/event-stream')) {
    return res.status(200).json({
      name: SERVER_NAME,
      protocolVersion: PROTOCOL_VERSION,
      transport: 'Streamable HTTP',
      endpoint: '/mcp',
      methods: supportedMethods(),
      tools: TOOLS.map((tool) => tool.name),
      resources: RESOURCES.map((resource) => resource.uri),
      hint: 'Open this endpoint with Accept: text/event-stream for the server-to-client stream.',
    });
  }

  const versionHeader = req.get('MCP-Protocol-Version');
  if (versionHeader && !ACCEPTED_PROTOCOL_VERSIONS.has(versionHeader)) {
    return res.status(400).json(
      rpcError(null, -32600, `Unsupported MCP-Protocol-Version "${versionHeader}".`),
    );
  }

  const sessionId = req.get('Mcp-Session-Id') || null;
  if (sessionId && !sessions.has(sessionId)) {
    return res.status(404).json(rpcError(null, -32000, 'Session not found.'));
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (sessionId) res.setHeader('Mcp-Session-Id', sessionId);
  res.setHeader('MCP-Protocol-Version', PROTOCOL_VERSION);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': LexaFlow MCP 2025-11-25 Streamable HTTP stream connected\n\n');

  const client = {
    id: uuidv4(),
    res,
    sessionId,
    heartbeat: setInterval(() => {
      try {
        res.write(`: ping ${new Date().toISOString()}\n\n`);
      } catch (_) {
        cleanupSseClient(client);
      }
    }, 20_000),
  };
  sseClients.add(client);

  req.on('close', () => cleanupSseClient(client));
  req.on('error', () => cleanupSseClient(client));
});

router.delete('/', (req, res) => {
  const sessionId = req.get('Mcp-Session-Id') || null;
  if (!sessionId) {
    return res.status(400).json(
      rpcError(null, -32600, 'Mcp-Session-Id header is required to terminate a session.'),
    );
  }
  if (!sessions.has(sessionId)) {
    return res.status(404).json(rpcError(null, -32000, 'Session not found.'));
  }
  sessions.delete(sessionId);
  for (const client of [...sseClients]) {
    if (client.sessionId === sessionId) cleanupSseClient(client);
  }
  return res.status(204).end();
});

function getProtocolInfo() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    endpoint: '/mcp',
    transport: 'Streamable HTTP',
    activeSessions: sessions.size,
    sseClients: sseClients.size,
    toolCount: TOOLS.length,
    resourceCount: RESOURCES.length,
    promptCount: PROMPTS.length,
    methods: supportedMethods(),
  };
}

function closeAllStreams() {
  for (const client of [...sseClients]) cleanupSseClient(client);
}

module.exports = {
  router,
  handleMessage,
  getProtocolInfo,
  closeAllStreams,
  PROTOCOL_VERSION,
};
