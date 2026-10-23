'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const store = require('./store');
const { router: mcpRouter, getProtocolInfo, closeAllStreams } = require('./mcp-server');
const { runAgent, getAgentRuntimeInfo } = require('./bedrock-agent');
const { confirmPurchase } = require('./commerce-service');
const { callTool, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } = require('./tools');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PORT = Number(process.env.PORT) >= 0 ? Number(process.env.PORT) : 3000;

const SCENARIOS = [
  {
    id: 'taco-night',
    title: 'Taco Night for 6',
    subtitle: 'Memory · Commerce · Smart Home · Music',
    icon: '🌮',
    accent: '#00d4ff',
    badge: 'Multi-service',
    prompt:
      "Alexa, host Taco Night for 6 on Friday—Ben is gluten-free, set patio lights to warm at 7 PM, and queue Latin Jazz.",
  },
  {
    id: 'sick-flight',
    title: 'Under the Weather + 8 AM Flight',
    subtitle: 'Climate · Recovery Kit · Wake-up Briefing',
    icon: '🌧️',
    accent: '#7c5cff',
    badge: 'Budget guardrail',
    prompt:
      "Alexa, I'm feeling under the weather and have an 8 AM flight—adjust bedroom climate, reorder my cold recovery kit under $25, and set a wake-up briefing.",
  },
  {
    id: 'recall-swap',
    title: 'Cross-Session Recall + Swap',
    subtitle: 'Memory recall · Cart mutation · Persistence',
    icon: '🧠',
    accent: '#ff8a65',
    badge: 'Cross-session',
    prompt:
      "Alexa, what did we decide about Friday's dinner, and swap the tortillas for organic corn shells.",
  },
];

store.initializeStore();

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: true,
    credentials: false,
    exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version'],
  }),
);

app.use(
  express.json({
    limit: '2mb',
    type: ['application/json', 'application/*+json'],
  }),
);

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

/* -------------------------------------------------------------------------- */
/* MCP Streamable HTTP 2025-11-25                                             */
/* -------------------------------------------------------------------------- */

app.use('/mcp', mcpRouter);

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  const memory = store.readMemory();
  res.json({
    status: 'ok',
    name: 'LexaFlow',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    mcp: getProtocolInfo(),
    bedrock: getAgentRuntimeInfo(),
    memory: {
      revision: memory.meta?.revision || 0,
      updatedAt: memory.meta?.updatedAt || null,
      file: store.pathInfo().dataFile,
    },
  });
});

app.get('/api/scenarios', (req, res) => {
  res.json({ scenarios: SCENARIOS });
});

app.get('/api/state', (req, res) => {
  const memory = store.readMemory();
  res.json({
    state: memory,
    telemetry: store.getTelemetry(80),
    telemetryStats: store.getTelemetryStats(),
    mcp: getProtocolInfo(),
    runtime: getAgentRuntimeInfo(),
    paths: store.pathInfo(),
    scenarios: SCENARIOS,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/state/reset', (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error: 'Reset requires { "confirm": true }. This restores the demo seed memory.',
    });
  }
  const memory = store.resetMemory();
  return res.json({
    reset: true,
    state: memory,
    telemetry: [],
    telemetryStats: store.getTelemetryStats(),
    mcp: getProtocolInfo(),
    runtime: getAgentRuntimeInfo(),
    message: 'Household memory, cart, and telemetry restored to the demo seed.',
  });
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim();
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : null;
    if (!message) {
      return res.status(400).json({ error: 'A non-empty "message" is required.' });
    }
    if (message.length > 2000) {
      return res.status(413).json({ error: 'Messages are limited to 2,000 characters.' });
    }

    const result = await runAgent(message, { sessionId });
    const memory = store.readMemory();

    return res.json({
      ...result,
      state: memory,
      telemetry: store.getTelemetry(80),
      telemetryStats: store.getTelemetryStats(),
      mcp: getProtocolInfo(),
      runtime: getAgentRuntimeInfo(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/purchase/confirm', (req, res) => {
  const started = Date.now();
  const rpcId = `checkout_${store.uuid().slice(0, 8)}`;
  const body = req.body || {};
  store.recordFrame({
    direction: 'request',
    method: 'checkout/confirm',
    rpcId,
    sessionId: body.sessionId || null,
    transport: 'api',
    payload: {
      cartId: body.cartId || null,
      confirmationTokenPresent: Boolean(body.confirmationToken),
      channel: body.channel || 'ui_tap',
    },
    note: 'Alexa+ 1-click purchase confirmation',
  });

  try {
    const result = confirmPurchase({
      cartId: body.cartId,
      confirmationToken: body.confirmationToken,
      paymentMethod: body.paymentMethod,
      channel: body.channel,
    });
    store.recordFrame({
      direction: 'response',
      method: 'checkout/confirm',
      rpcId,
      sessionId: body.sessionId || null,
      transport: 'api',
      latencyMs: Date.now() - started,
      payload: {
        orderId: result.order.id,
        status: result.order.status,
        total: result.order.total,
        itemCount: result.order.itemCount,
        merchant: result.order.merchant,
      },
      note: result.message,
    });
    return res.json({
      ...result,
      telemetry: store.getTelemetry(80),
      telemetryStats: store.getTelemetryStats(),
      mcp: getProtocolInfo(),
      runtime: getAgentRuntimeInfo(),
      purchaseConfirmedAt: new Date().toISOString(),
    });
  } catch (error) {
    const status =
      error.code === 'EMPTY_CART' || error.code === 'CART_MISMATCH' || error.code === 'INVALID_CONFIRMATION_TOKEN'
        ? 409
        : 400;
    store.recordFrame({
      direction: 'response',
      method: 'checkout/confirm',
      rpcId,
      sessionId: body.sessionId || null,
      transport: 'api',
      latencyMs: Date.now() - started,
      payload: { error: { code: error.code || 'CHECKOUT_ERROR', message: error.message } },
      note: 'Purchase blocked by guardrail',
    });
    return res.status(status).json({
      error: error.message,
      code: error.code || 'CHECKOUT_ERROR',
    });
  }
});

app.post('/api/cart/update', (req, res) => {
  const action = String(req.body?.action || '').toLowerCase();
  if (!['swap', 'add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'action must be swap, add, or remove.' });
  }

  const toolArgs = {
    action,
    from: req.body?.from,
    to: req.body?.to,
    item: req.body?.item,
    quantity: req.body?.quantity,
  };

  const result = callTool('commerce_build_and_purchase_cart', toolArgs, {
    transport: 'api',
    note: 'Echo Show cart card interaction',
  });

  if (result.isError) {
    return res.status(409).json({
      error: result.structuredContent?.error?.message || 'Cart update failed.',
      code: result.structuredContent?.error?.code || 'CART_UPDATE_FAILED',
    });
  }

  return res.json({
    ...result.structuredContent,
    state: store.readMemory(),
    telemetry: store.getTelemetry(80),
    telemetryStats: store.getTelemetryStats(),
    mcp: getProtocolInfo(),
    runtime: getAgentRuntimeInfo(),
  });
});

app.get('/api/showcase', (req, res) => {
  const carousels = [];
  const types = ['music', 'recipe', 'device'];

  for (const type of types) {
    const result = callTool(
      'media_render_multimodal_carousel',
      { action: 'render', type, context: 'LexaFlow welcome showcase' },
      { transport: 'showcase', note: 'Initial Echo Show showcase' },
    );
    if (!result.isError && result.structuredContent?.carousel) {
      carousels.push(result.structuredContent.carousel);
    }
  }

  return res.json({
    carousels,
    generatedAt: new Date().toISOString(),
    message: 'Initial multimodal showcase rendered through the MCP tool layer.',
  });
});

/* -------------------------------------------------------------------------- */
/* Server-Sent Events for the live input/output inspector                     */
/* -------------------------------------------------------------------------- */

const apiSseClients = new Set();

function writeApiSse(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

store.bus.on('telemetry', (frame) => {
  for (const client of apiSseClients) {
    if (!writeApiSse(client.res, 'telemetry', frame)) {
      apiSseClients.delete(client);
      if (client.heartbeat) clearInterval(client.heartbeat);
    }
  }
});

store.bus.on('memory', (snapshot) => {
  for (const client of apiSseClients) {
    if (!writeApiSse(client.res, 'memory', snapshot)) {
      apiSseClients.delete(client);
      if (client.heartbeat) clearInterval(client.heartbeat);
    }
  }
});

app.get('/api/events', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`retry: 3000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ message: 'LexaFlow telemetry connected' })}\n\n`);

  const client = {
    res,
    heartbeat: setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch (_) {
        apiSseClients.delete(client);
        clearInterval(client.heartbeat);
      }
    }, 20_000),
  };
  apiSseClients.add(client);

  req.on('close', () => {
    apiSseClients.delete(client);
    clearInterval(client.heartbeat);
  });
});

/* -------------------------------------------------------------------------- */
/* Static frontend + errors                                                   */
/* -------------------------------------------------------------------------- */

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    if (req.originalUrl.startsWith('/mcp')) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: request body is not valid JSON.' },
      });
    }
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }

  console.error('[LexaFlow] Request error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  return res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? undefined : err?.message,
  });
});

const server = http.createServer(app);

function closeApiStreams() {
  for (const client of [...apiSseClients]) {
    apiSseClients.delete(client);
    clearInterval(client.heartbeat);
    try {
      client.res.end();
    } catch (_) {
      /* noop */
    }
  }
}

function shutdown(signal) {
  console.log(`\n[LexaFlow] ${signal} received. Closing streams and HTTP server…`);
  closeApiStreams();
  closeAllStreams();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

function start(port = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const runtime = getAgentRuntimeInfo();
      console.log('');
      console.log('  ✦ LexaFlow — Stateful MCP & Multimodal Alexa+ Agent');
      console.log(`  ├─ App       http://localhost:${actualPort}`);
      console.log(`  ├─ MCP       http://localhost:${actualPort}/mcp  (2025-11-25 Streamable HTTP)`);
      console.log(`  ├─ Bedrock   ${runtime.modeLabel}${runtime.configured ? ` · ${runtime.modelLabel}` : ''}`);
      console.log(`  ├─ Memory    ${store.pathInfo().dataFile}`);
      console.log('  └─ Scenario  Echo Show simulator + live JSON-RPC inspector');
      console.log('');
      console.log(`LEXAFLOW_LISTENING ${JSON.stringify({ port: actualPort, host: 'localhost' })}`);
      resolve({ server, port: actualPort });
    });
  });
}

if (require.main === module) {
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  start().catch((error) => {
    console.error('[LexaFlow] Failed to start:', error);
    process.exit(1);
  });
}

module.exports = { app, server, start, SCENARIOS };
