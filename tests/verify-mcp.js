'use strict';

/**
 * LexaFlow — automated MCP 2025-11-25 verification.
 *
 * Spawns the real Express server on an ephemeral port with an isolated temp
 * data file, then exercises the Streamable HTTP transport, all four MCP tools,
 * every resource, prompts, checkout guardrails, state persistence, the REST
 * API, and both SSE streams. Prints PASS/FAIL checks for judges.
 *
 * Run with: npm test
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'src', 'server.js');
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lexaflow-verify-'));
const DATA_FILE = path.join(TEMP_DIR, 'session_memory.json');

const EXPECTED_TOOLS = [
  'memory_get_or_update',
  'commerce_build_and_purchase_cart',
  'smarthome_orchestrate_scene',
  'media_render_multimodal_carousel',
];

const EXPECTED_RESOURCES = [
  'memory://household/profile',
  'memory://commerce/active-cart',
  'telemetry://mcp/recent-calls',
];

let child = null;
let baseUrl = '';
let sessionId = '';
let rpcSeq = 0;
let passed = 0;
let failed = 0;
let total = 0;

const paint = {
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

function line() {
  console.log(paint.dim('─'.repeat(76)));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const logs = [];
    let buffer = '';
    let settled = false;

    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: '0',
        NODE_ENV: 'test',
        LEXAFLOW_DATA_FILE: DATA_FILE,
        LEXAFLOW_BEDROCK: 'off',
        LEXAFLOW_TOOL_DELAY_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Server did not print LEXAFLOW_LISTENING within 15s.\n${logs.join('').slice(-3000)}`,
        ),
      );
    }, 15_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      logs.push(chunk);
      buffer += chunk;
      const match = buffer.match(/LEXAFLOW_LISTENING\s+(\{[^\r\n]+\})/);
      if (match && !settled) {
        try {
          const info = JSON.parse(match[1]);
          settled = true;
          clearTimeout(timer);
          resolve({ port: info.port, logs });
        } catch (error) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Could not parse LEXAFLOW_LISTENING payload: ${match[1]}`));
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      logs.push(chunk);
    });

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Server exited before listening (code ${code}).\n${logs.join('').slice(-3000)}`,
        ),
      );
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* noop */
      }
      resolve();
    }, 4000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch (_) {
      clearTimeout(timer);
      resolve();
    }
  });
}

function removeTempDir() {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch (_) {
    /* Windows can hold the file briefly; the OS temp cleaner will catch it. */
  }
}

async function test(name, fn) {
  total += 1;
  const label = String(total).padStart(2, '0');
  try {
    await fn();
    passed += 1;
    console.log(`${paint.green('PASS')} ${paint.dim(label)}  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`${paint.red('FAIL')} ${paint.dim(label)}  ${name}`);
    const message = error && error.message ? error.message : String(error);
    console.log(paint.red(`        ${message.split('\n')[0]}`));
  }
}

async function mcpRpc(method, params, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: options.accept || 'application/json',
    'MCP-Protocol-Version': '2025-11-25',
  };

  if (options.sessionId !== undefined) {
    if (options.sessionId) headers['Mcp-Session-Id'] = options.sessionId;
  } else if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  const body = { jsonrpc: '2.0', method };
  if (!options.notification) {
    body.id = options.id === undefined ? ++rpcSeq : options.id;
  }
  if (params !== undefined) body.params = params;

  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const nextSessionId = response.headers.get('mcp-session-id');
  if (nextSessionId) sessionId = nextSessionId;

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = null;
  }

  return { response, text, payload };
}

async function callTool(name, args) {
  const { response, payload } = await mcpRpc('tools/call', { name, arguments: args });
  assert.equal(response.status, 200, `tools/call HTTP status was ${response.status}`);
  assert.ok(payload && payload.result, `tools/call returned no result: ${JSON.stringify(payload)}`);
  return payload.result;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }
  return { response, status: response.status, ok: response.ok, data };
}

async function readSseUntil(url, headers, needle, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader = null;
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    assert.equal(response.status, 200, `SSE endpoint returned ${response.status}`);
    assert.ok(
      String(response.headers.get('content-type') || '').includes('text/event-stream'),
      'SSE endpoint did not return text/event-stream',
    );
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(needle) && text.length < 24_000) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return { response, text };
  } finally {
    clearTimeout(timer);
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {
        /* noop */
      }
    }
    controller.abort();
  }
}

async function main() {
  console.log('');
  console.log(paint.bold('  LexaFlow · MCP 2025-11-25 verification suite'));
  console.log(paint.dim(`  Temporary state: ${DATA_FILE}`));
  line();

  const { port, logs } = await startServer();
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(paint.dim(`  Server listening on ${baseUrl} (isolated temp state)`));
  console.log('');

  try {
    await test('GET /mcp advertises the Streamable HTTP endpoint and four tools', async () => {
      const response = await fetch(`${baseUrl}/mcp`, { headers: { Accept: 'application/json' } });
      assert.equal(response.status, 200);
      const info = await response.json();
      assert.equal(info.protocolVersion, '2025-11-25');
      assert.equal(info.transport, 'Streamable HTTP');
      assert.equal(info.tools.length, 4);
      for (const name of EXPECTED_TOOLS) assert.ok(info.tools.includes(name), `missing ${name}`);
    });

    await test('initialize negotiates exactly 2025-11-25 and issues a session id', async () => {
      const { response, payload } = await mcpRpc('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'lexaflow-verify-mcp', version: '1.0.0' },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('mcp-protocol-version'), '2025-11-25');
      assert.ok(response.headers.get('mcp-session-id'), 'no Mcp-Session-Id header returned');
      assert.equal(payload.jsonrpc, '2.0');
      assert.equal(payload.result.protocolVersion, '2025-11-25');
      assert.equal(payload.result.serverInfo.name, 'lexaflow-mcp');
      assert.ok(payload.result.capabilities.tools, 'tools capability missing');
      assert.ok(payload.result.capabilities.resources, 'resources capability missing');
      assert.ok(payload.result.capabilities.prompts, 'prompts capability missing');
    });

    await test('notifications/initialized is accepted with 202', async () => {
      const { response } = await mcpRpc('notifications/initialized', undefined, {
        notification: true,
      });
      assert.equal(response.status, 202);
    });

    await test('ping returns an empty JSON-RPC result', async () => {
      const { response, payload } = await mcpRpc('ping');
      assert.equal(response.status, 200);
      assert.deepEqual(payload.result, {});
    });

    await test('tools/list returns exactly the four required tools with schemas', async () => {
      const { payload } = await mcpRpc('tools/list');
      const tools = payload.result.tools;
      assert.equal(tools.length, 4);
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.ok(tool.description.length > 40, `${tool.name} description is too short`);
        assert.ok(tool.annotations, `${tool.name} is missing annotations`);
      }
    });

    await test('memory_get_or_update get loads the Rivera household graph', async () => {
      const result = await callTool('memory_get_or_update', { operation: 'get', limit: 6 });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.equal(data.operation, 'get');
      assert.match(data.profile.household.name, /Rivera/i);
      assert.equal(data.profile.household.members.length, 3);
      assert.equal(data.profile.household.allergies[0].allergen, 'gluten');
      assert.ok(data.relevantFacts.length > 0);
      assert.ok(data.revision >= 1);
    });

    await test('memory_get_or_update search ranks the gluten safety fact', async () => {
      const result = await callTool('memory_get_or_update', {
        operation: 'search',
        query: 'Ben gluten free allergy safety',
        limit: 6,
      });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.ok(data.results.length > 0);
      assert.ok(
        data.results.some((fact) => fact.key === 'ben_gluten_allergy'),
        'gluten safety fact was not returned',
      );
      assert.ok(
        data.results[0].scoreBreakdown.safety >= 0,
        'score breakdown is missing the safety component',
      );
    });

    await test('memory_get_or_update update persists a fact and increments revision', async () => {
      const before = await callTool('memory_get_or_update', { operation: 'get' });
      const beforeRevision = before.structuredContent.revision;
      const result = await callTool('memory_get_or_update', {
        operation: 'update',
        fact: {
          key: 'verification_marker',
          value: 'Automated verification confirmed cross-session persistence.',
          category: 'note',
          confidence: 0.99,
        },
      });
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.updated.includes('facts.verification_marker'));
      assert.ok(result.structuredContent.revision > beforeRevision);
      const search = await callTool('memory_get_or_update', {
        operation: 'search',
        query: 'verification marker',
      });
      assert.ok(
        search.structuredContent.results.some((fact) => fact.key === 'verification_marker'),
      );
    });

    await test('commerce get returns the seeded draft cart with an allergen check', async () => {
      const result = await callTool('commerce_build_and_purchase_cart', { action: 'get' });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.ok(data.cart.items.length >= 4);
      assert.equal(data.cart.status, 'draft');
      assert.equal(data.verification.passed, true);
      assert.match(data.verification.message, /verified/i);
      assert.equal(typeof data.purchase.confirmationToken, 'string');
    });

    await test('commerce swap mutates the seed cart and keeps it allergy safe', async () => {
      const result = await callTool('commerce_build_and_purchase_cart', {
        action: 'swap',
        from: 'Gluten-Free Flour Tortillas',
        to: 'Organic Corn Shells',
      });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.equal(data.action, 'swap');
      assert.ok(data.mutation, 'swap did not return a mutation description');
      assert.equal(data.verification.passed, true);
      assert.ok(
        data.cart.items.some((item) => item.sku === 'WF-TORT-CORN-ORG'),
        'corn shells are missing after the swap',
      );
      assert.ok(
        !data.cart.items.some((item) => item.allergens.includes('gluten')),
        'a gluten item survived the swap',
      );
    });

    await test('commerce build creates an allergy-safe taco cart under $75', async () => {
      const result = await callTool('commerce_build_and_purchase_cart', {
        action: 'build',
        occasion: 'Friday Taco Night',
        context: 'six guests, patio dinner, Ben gluten-free, Maya vegetarian',
        servings: 6,
        budgetCap: 75,
        store: 'Whole Foods Market',
      });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.equal(data.action, 'build');
      assert.ok(data.cart.items.length >= 10, 'expected a full taco cart');
      assert.ok(
        data.cart.items.every((item) => !item.allergens.includes('gluten')),
        'cart contains a gluten conflict',
      );
      assert.equal(data.verification.passed, true);
      assert.ok(data.summary.total <= 75, `cart total ${data.summary.total} exceeds $75`);
      assert.equal(data.summary.currency, 'USD');
      assert.ok(data.purchase.confirmationToken.startsWith('vp_'));
      assert.ok(
        data.cart.items.some((item) => item.sku === 'WF-CHORIZO-PLANT'),
        'vegetarian chorizo is missing',
      );
    });

    await test('commerce add rejects a gluten product via the allergy guardrail', async () => {
      const result = await callTool('commerce_build_and_purchase_cart', {
        action: 'add',
        item: 'Flour Tortillas',
        quantity: 1,
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'ALLERGEN_BLOCKED');
      assert.match(result.structuredContent.error.message, /allergy graph|conflict/i);
    });

    await test('smarthome set_scene schedules warm patio lights for Friday 7 PM', async () => {
      const result = await callTool('smarthome_orchestrate_scene', {
        action: 'set_scene',
        scene: 'Patio Warm Glow',
        room: 'Patio',
        context: 'Friday taco night on the patio',
        time: '19:00',
        days: ['Friday'],
        lights: { color: 'Warm Amber', hex: '#ffb86b', brightness: 45, power: 'on' },
      });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.equal(data.action, 'set_scene');
      assert.ok(data.scheduled, 'no schedule was returned');
      assert.match(data.scheduled.label, /Friday/);
      assert.match(data.scheduled.label, /7:00 PM/);
      assert.ok(data.commands.length > 0, 'no device commands were issued');
      assert.equal(data.scene.state.brightness, 45);
    });

    await test('smarthome get_status reflects the applied patio light state', async () => {
      const result = await callTool('smarthome_orchestrate_scene', { action: 'get_status' });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      const light = data.devices.find((device) => device.id === 'hue-patio');
      assert.ok(light, 'patio light is missing');
      assert.equal(light.state.brightness, 45);
      assert.equal(light.state.color, 'Warm Amber');
      assert.ok(data.scenes.some((scene) => scene.name === 'Patio Warm Glow'));
    });

    await test('smarthome adjust_climate sets bedroom temperature and humidifier', async () => {
      const result = await callTool('smarthome_orchestrate_scene', {
        action: 'adjust_climate',
        room: 'Bedroom',
        climate: { targetTempF: 68, mode: 'auto' },
        humidifier: 'low',
      });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      const thermostat = data.devices.find((device) => device.id === 'thermostat-bedroom');
      const humidifier = data.devices.find((device) => device.id === 'humidifier-bedroom');
      assert.equal(thermostat.state.targetTempF, 68);
      assert.equal(humidifier.state.power, 'on');
      assert.equal(humidifier.state.level, 'low');
    });

    await test('media renders a music carousel with playable card metadata', async () => {
      const result = await callTool('media_render_multimodal_carousel', {
        action: 'render',
        type: 'music',
        title: 'Latin Jazz Dinner Party',
        context: 'Friday taco night',
      });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.equal(data.type, 'music');
      assert.equal(data.carousel.carouselType, 'music');
      assert.ok(data.carousel.cards.length >= 3);
      assert.ok(data.carousel.cards.every((card) => card.emoji && card.accent && card.meta));
      assert.equal(data.playlist.provider, 'Amazon Music');
    });

    await test('media renders the six-step gluten-free recipe carousel', async () => {
      const result = await callTool('media_render_multimodal_carousel', {
        action: 'render',
        type: 'recipe',
        context: 'gluten-free taco night',
      });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.equal(data.carousel.carouselType, 'recipe');
      assert.equal(data.carousel.cards.length, 6);
      assert.ok(
        data.carousel.cards.some((card) => /corn shells/i.test(card.title)),
        'corn shell step is missing',
      );
    });

    await test('media renders live device and Ring camera cards', async () => {
      const result = await callTool('media_render_multimodal_carousel', {
        action: 'render',
        type: 'device',
        context: 'Ring and bedroom status',
      });
      assert.equal(result.isError, false);
      const data = result.structuredContent;
      assert.equal(data.carousel.carouselType, 'device');
      assert.ok(data.carousel.cards.length >= 4);
      assert.ok(
        data.carousel.cards.some((card) => /ring/i.test(card.title)),
        'Ring camera card is missing',
      );
    });

    await test('resources/list exposes the three required resource URIs', async () => {
      const { payload } = await mcpRpc('resources/list');
      const resources = payload.result.resources;
      assert.equal(resources.length, 3);
      assert.deepEqual(resources.map((resource) => resource.uri).sort(), [...EXPECTED_RESOURCES].sort());
      for (const resource of resources) {
        assert.equal(resource.mimeType, 'application/json');
        assert.ok(resource.description.length > 20);
      }
    });

    await test('resources/read memory://household/profile returns the remembered plan', async () => {
      const { payload } = await mcpRpc('resources/read', {
        uri: 'memory://household/profile',
      });
      assert.equal(payload.result.contents.length, 1);
      const content = payload.result.contents[0];
      assert.equal(content.mimeType, 'application/json');
      const data = JSON.parse(content.text);
      assert.equal(data.resource, 'memory://household/profile');
      assert.match(data.profile.household.name, /Rivera/i);
      assert.ok(Array.isArray(data.rankedFacts));
      assert.ok(data.revision >= 1);
    });

    await test('resources/read memory://commerce/active-cart returns the current cart', async () => {
      const { payload } = await mcpRpc('resources/read', {
        uri: 'memory://commerce/active-cart',
      });
      const data = JSON.parse(payload.result.contents[0].text);
      assert.equal(data.resource, 'memory://commerce/active-cart');
      assert.ok(data.cart, 'no active cart in the resource');
      assert.ok(data.cart.items.length > 0);
      assert.ok(data.cart.total > 0);
    });

    await test('resources/read telemetry://mcp/recent-calls returns captured frames', async () => {
      const { payload } = await mcpRpc('resources/read', {
        uri: 'telemetry://mcp/recent-calls',
      });
      const data = JSON.parse(payload.result.contents[0].text);
      assert.equal(data.resource, 'telemetry://mcp/recent-calls');
      assert.ok(data.frames.length > 0, 'telemetry ring buffer is empty');
      assert.ok(data.stats.toolCalls > 0, 'no tool calls were recorded');
      assert.ok(data.frames.some((frame) => frame.method === 'tools/call'));
    });

    await test('prompts/list exposes four orchestration prompts', async () => {
      const { payload } = await mcpRpc('prompts/list');
      const prompts = payload.result.prompts;
      assert.equal(prompts.length, 4);
      assert.ok(prompts.some((prompt) => prompt.name === 'host-dinner'));
      assert.ok(prompts.some((prompt) => prompt.name === 'wellness-recovery'));
      assert.ok(prompts.some((prompt) => prompt.name === 'cross-session-recall'));
    });

    await test('prompts/get host-dinner builds an allergy-aware instruction', async () => {
      const { payload } = await mcpRpc('prompts/get', {
        name: 'host-dinner',
        arguments: {
          occasion: 'Taco Night',
          guests: '6',
          dietary: 'gluten-free for Ben, vegetarian for Maya',
        },
      });
      const message = payload.result.messages[0];
      assert.equal(message.role, 'user');
      assert.match(message.content.text, /Taco Night/);
      assert.match(message.content.text, /gluten/i);
      assert.match(message.content.text, /confirmation/i);
    });

    await test('tools/call unknown tool returns an MCP tool error, not a protocol crash', async () => {
      const result = await callTool('does_not_exist', {});
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'UNKNOWN_TOOL');
    });

    await test('unsupported JSON-RPC method returns -32601 with supported list', async () => {
      const { response, payload } = await mcpRpc('does/not/exist');
      assert.equal(response.status, 200);
      assert.equal(payload.error.code, -32601);
      assert.ok(payload.error.data.supported.includes('tools/call'));
    });

    await test('POST /mcp can return a single JSON-RPC SSE response', async () => {
      const { response, text } = await mcpRpc('tools/list', undefined, {
        accept: 'text/event-stream',
      });
      assert.equal(response.status, 200);
      assert.ok(
        String(response.headers.get('content-type') || '').includes('text/event-stream'),
        'POST SSE did not use text/event-stream',
      );
      const dataLine = text.split('\n').find((entry) => entry.startsWith('data: '));
      assert.ok(dataLine, 'no SSE data line returned');
      const payload = JSON.parse(dataLine.slice(6));
      assert.equal(payload.result.tools.length, 4);
    });

    await test('GET /mcp with text/event-stream opens the server-to-client stream', async () => {
      const headers = {
        Accept: 'text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
      };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      const { text } = await readSseUntil(`${baseUrl}/mcp`, headers, 'LexaFlow MCP');
      assert.match(text, /LexaFlow MCP 2025-11-25 Streamable HTTP stream connected/);
    });

    await test('GET /api/health reports fallback runtime and persistent memory', async () => {
      const { status, data } = await api('/api/health');
      assert.equal(status, 200);
      assert.equal(data.status, 'ok');
      assert.equal(data.protocolVersion, '2025-11-25');
      assert.equal(data.mcp.toolCount, 4);
      assert.equal(data.mcp.resourceCount, 3);
      assert.equal(data.bedrock.mode, 'smart-fallback');
      assert.ok(data.memory.revision >= 1);
      assert.ok(data.memory.file);
    });

    await test('GET /api/state returns memory, telemetry, MCP metadata, and scenarios', async () => {
      const { status, data } = await api('/api/state');
      assert.equal(status, 200);
      assert.match(data.state.household.name, /Rivera/i);
      assert.ok(Array.isArray(data.telemetry));
      assert.ok(data.telemetryStats.toolCalls > 0);
      assert.equal(data.mcp.protocolVersion, '2025-11-25');
      assert.equal(data.scenarios.length, 3);
      assert.equal(data.runtime.mode, 'smart-fallback');
    });

    await test('GET /api/showcase renders three startup carousels through the MCP tool layer', async () => {
      const { status, data } = await api('/api/showcase');
      assert.equal(status, 200);
      assert.equal(data.carousels.length, 3);
      assert.deepEqual(
        data.carousels.map((carousel) => carousel.carouselType).sort(),
        ['device', 'music', 'recipe'],
      );
    });

    let chatData = null;

    await test('/api/chat runs the multi-service Taco Night fallback workflow', async () => {
      const { status, data } = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'verify-web-session',
          message:
            "Alexa, host Taco Night for 6 on Friday—Ben is gluten-free, set patio lights to warm at 7 PM, and queue Latin Jazz.",
        }),
      });
      assert.equal(status, 200);
      assert.equal(data.source, 'fallback');
      assert.equal(data.intent, 'host');
      assert.ok(data.toolCalls.length >= 6, `only ${data.toolCalls.length} tool calls ran`);
      assert.ok(data.dag.length >= 6, 'execution DAG is missing steps');
      assert.ok(data.cart.items.length >= 10, 'chat did not produce a full cart');
      assert.equal(data.commerce.verification.passed, true);
      assert.ok(data.carousels.length >= 2, 'chat did not render music and recipe carousels');
      assert.equal(data.runtime.mode, 'smart-fallback');
      assert.ok(data.latencyMs > 0);
      assert.ok(data.state.conversation.lastUserUtterance.includes('Taco Night'));
      chatData = data;
    });

    await test('/api/chat persists the confirmed plan into household memory', async () => {
      assert.ok(chatData, 'chat workflow did not complete');
      const plans = chatData.state.activePlans;
      assert.ok(
        plans.some((plan) => /Taco Night/i.test(plan.title) && plan.guests === 6),
        'Taco Night plan was not persisted',
      );
      assert.ok(
        chatData.state.facts.some((fact) => fact.key === 'friday_taco_night'),
        'friday_taco_night fact was not persisted',
      );
    });

    await test('/api/purchase/confirm rejects an invalid confirmation token', async () => {
      assert.ok(chatData?.cart, 'no cart available for checkout test');
      const { status, data } = await api('/api/purchase/confirm', {
        method: 'POST',
        body: JSON.stringify({
          cartId: chatData.cart.id,
          confirmationToken: 'vp_invalid_token',
        }),
      });
      assert.equal(status, 409);
      assert.equal(data.code, 'INVALID_CONFIRMATION_TOKEN');
    });

    let order = null;

    await test('/api/purchase/confirm completes checkout and empties the active cart', async () => {
      assert.ok(chatData?.purchase?.confirmationToken, 'no purchase token available');
      const { status, data } = await api('/api/purchase/confirm', {
        method: 'POST',
        body: JSON.stringify({
          cartId: chatData.cart.id,
          confirmationToken: chatData.purchase.confirmationToken,
          channel: 'verification_test',
        }),
      });
      assert.equal(status, 200);
      assert.ok(data.order, 'no order returned');
      assert.equal(data.order.status, 'confirmed');
      assert.equal(data.order.itemCount, chatData.cart.items.length);
      assert.equal(data.order.total, chatData.cart.total);
      assert.equal(data.cart.items.length, 0);
      assert.equal(data.memory.commerce.lastOrder.id, data.order.id);
      assert.match(data.speech, /Purchase confirmed/i);
      order = data.order;
    });

    await test('checkout is persisted into order history and survives /api/state', async () => {
      assert.ok(order, 'checkout did not complete');
      const { status, data } = await api('/api/state');
      assert.equal(status, 200);
      assert.equal(data.state.commerce.activeCart.items.length, 0);
      assert.equal(data.state.commerce.lastOrder.id, order.id);
      assert.ok(
        data.state.commerce.orderHistory.some((entry) => entry.id === order.id),
        'order is missing from order history',
      );
      assert.ok(data.telemetry.some((frame) => frame.method === 'checkout/confirm'));
    });

    await test('/api/state/reset refuses destructive reset without confirmation', async () => {
      const { status, data } = await api('/api/state/reset', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.equal(status, 400);
      assert.match(data.error, /confirm/i);
    });

    await test('/api/state/reset restores the demo seed and clears telemetry', async () => {
      const { status, data } = await api('/api/state/reset', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      assert.equal(status, 200);
      assert.equal(data.reset, true);
      assert.equal(data.state.meta.revision, 1);
      assert.equal(data.state.commerce.activeCart.items.length, 5);
      assert.equal(data.state.commerce.lastOrder, null);
      assert.equal(data.telemetry.length, 0);
      assert.equal(data.telemetryStats.frames, 0);
    });

    await test('GET /api/events opens the live telemetry SSE stream', async () => {
      const { text } = await readSseUntil(
        `${baseUrl}/api/events`,
        { Accept: 'text/event-stream' },
        'event: hello',
      );
      assert.match(text, /event: hello/);
      assert.match(text, /LexaFlow telemetry connected/);
    });

    await test('DELETE /mcp terminates the session and old session ids are rejected', async () => {
      assert.ok(sessionId, 'no session id available to delete');
      const oldSessionId = sessionId;
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'DELETE',
        headers: {
          'Mcp-Session-Id': oldSessionId,
          'MCP-Protocol-Version': '2025-11-25',
        },
      });
      assert.equal(response.status, 204);

      const rejected = await mcpRpc(
        'tools/list',
        undefined,
        { sessionId: oldSessionId, accept: 'application/json' },
      );
      assert.equal(rejected.response.status, 404);
      assert.equal(rejected.payload.error.code, -32000);
    });
  } finally {
    line();
    if (failed === 0) {
      console.log(
        paint.green(
          paint.bold(`  ✓ ${passed}/${total} checks passed — LexaFlow MCP 2025-11-25 is ready.`),
        ),
      );
    } else {
      console.log(
        paint.red(paint.bold(`  ✗ ${passed}/${total} checks passed · ${failed} failed`)),
      );
    }
    line();
    console.log('');

    if (failed !== 0 && logs.length) {
      console.log(paint.dim('  Server log tail:'));
      console.log(paint.dim(logs.join('').slice(-3000)));
    }

    await stopServer();
    removeTempDir();
    process.exitCode = failed === 0 ? 0 : 1;
  }
}

main().catch(async (error) => {
  console.error('');
  console.error(paint.red('  Verification aborted before checks could complete.'));
  console.error(paint.red(`  ${error && error.stack ? error.stack : error}`));
  console.error('');
  await stopServer();
  removeTempDir();
  process.exitCode = 1;
});
