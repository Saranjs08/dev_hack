'use strict';

const store = require('./store');
const { memoryGetOrUpdate, profileSnapshot, rankFacts } = require('./memory-service');
const { commerceBuildAndPurchase } = require('./commerce-service');
const { smarthomeOrchestrateScene } = require('./smarthome-service');
const { mediaRenderMultimodalCarousel } = require('./media-service');

const PROTOCOL_VERSION = '2025-11-25';
const SERVER_NAME = 'lexaflow-mcp';
const SERVER_VERSION = '1.0.0';

const TOOL_SERVICES = {
  memory_get_or_update: {
    service: 'memory',
    label: 'Household Memory',
    icon: '🧠',
  },
  commerce_build_and_purchase_cart: {
    service: 'commerce',
    label: 'Amazon Fresh Commerce',
    icon: '🛒',
  },
  smarthome_orchestrate_scene: {
    service: 'smarthome',
    label: 'Smart Home IoT',
    icon: '💡',
  },
  media_render_multimodal_carousel: {
    service: 'media',
    label: 'Multimodal Media',
    icon: '🎛️',
  },
};

const TOOLS = [
  {
    name: 'memory_get_or_update',
    title: 'Household Memory Graph',
    description:
      'Read, search, or update LexaFlow’s persistent cross-session household memory. Stores members, dietary preferences, severe allergies, budget caps, smart home scenes, routines, active plans, and timestamped household facts. Call this before commerce or scheduling so allergy and budget guardrails are current, and call it again to persist a confirmed plan.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['get', 'search', 'update', 'reset'],
          description: 'Memory operation. Use get/search before other tools and update to persist a decision.',
        },
        query: {
          type: 'string',
          description: 'Natural-language query used to rank facts with time decay and a safety boost.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of ranked facts to return.',
        },
        updates: {
          type: 'object',
          description: 'Partial updates for household preferences, budgets, members, allergies, or dietary profiles.',
          properties: {
            preferences: { type: 'object', description: 'Household preference keys to merge.' },
            budgetCaps: { type: 'object', description: 'Budget values to merge, such as groceryPerOrder.' },
            members: {
              type: 'array',
              description: 'Household members to merge by id or name.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  dietary: { type: 'array', items: { type: 'string' } },
                  allergies: { type: 'array' },
                  notes: { type: 'string' },
                },
              },
            },
            allergies: {
              type: 'array',
              description: 'Replacement household allergy entries.',
              items: {
                type: 'object',
                properties: {
                  member: { type: 'string' },
                  allergen: { type: 'string' },
                  severity: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
              },
            },
            dietaryProfiles: { type: 'array', description: 'Replacement dietary profile entries.' },
          },
        },
        plan: {
          type: 'object',
          description: 'Create or update an active plan. Matched by id or title.',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            type: { type: 'string' },
            date: { type: 'string' },
            time: { type: 'string' },
            guests: { type: 'integer' },
            status: { type: 'string', enum: ['planned', 'confirmed', 'completed', 'cancelled'] },
            location: { type: 'string' },
            budgetCap: { type: 'number' },
            notes: { type: 'string' },
            dietaryConstraints: { type: 'array', items: { type: 'string' } },
          },
        },
        fact: {
          type: 'object',
          description: 'Persist a durable, timestamped household fact.',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
            category: {
              type: 'string',
              description: 'For example safety, budget, preference, plan, schedule, or note.',
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['value'],
        },
        note: { type: 'string', description: 'Short note to save as a household fact.' },
        category: { type: 'string', description: 'Category for a note fact.' },
        confirm: {
          type: 'boolean',
          description: 'Must be true to reset memory. Reset is destructive.',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'commerce_build_and_purchase_cart',
    title: 'Amazon Fresh + Whole Foods Cart Builder',
    description:
      'Build or mutate a demo Amazon Fresh / Whole Foods cart with allergy filtering, budget enforcement, dietary badges, ratings, structured product cards, and an explicit confirmation token. It never completes a purchase by itself; the user must confirm on screen via the Alexa+ purchase card.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['build', 'swap', 'add', 'remove', 'get', 'quote'],
          description: 'Cart operation. Build creates a recipe-aware basket; swap replaces an item.',
        },
        occasion: {
          type: 'string',
          description: 'Occasion or meal, e.g. “Friday Taco Night” or “cold recovery kit”.',
        },
        context: { type: 'string', description: 'Optional extra context for recipe selection.' },
        servings: { type: 'integer', minimum: 1, maximum: 24, description: 'Number of servings.' },
        budgetCap: {
          type: 'number',
          minimum: 1,
          description: 'Maximum total including tax. Defaults to the household budget for this recipe type.',
        },
        dietaryConstraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional strict dietary filters such as vegetarian or vegan.',
        },
        allergens: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional allergens to exclude beyond the household allergy graph.',
        },
        store: {
          type: 'string',
          enum: ['Whole Foods Market', 'Amazon Fresh'],
          description: 'Demo merchant. Defaults to Whole Foods for meals and Amazon Fresh for restocks.',
        },
        from: { type: 'string', description: 'Existing item name or SKU to swap or remove.' },
        to: { type: 'string', description: 'Replacement item name or SKU.' },
        item: { type: 'string', description: 'Item name or SKU to add.' },
        quantity: { type: 'integer', minimum: 1, maximum: 24, description: 'Quantity for add or swap.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'smarthome_orchestrate_scene',
    title: 'Matter + Ring Scene Orchestrator',
    description:
      'Configure simulated Echo, Ring, and Matter devices: patio lighting schedules, bedroom climate, humidifiers, wake-up routines, and security modes. Returns structured device commands, resulting state, and a smart-home card for the Echo Show UI.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set_scene', 'adjust_climate', 'run_routine', 'arm_security', 'get_status'],
          description: 'Smart home operation to perform.',
        },
        scene: { type: 'string', description: 'Scene name, e.g. “Patio Warm Glow”.' },
        room: { type: 'string', description: 'Room name, e.g. Patio or Bedroom.' },
        context: { type: 'string', description: 'Free-form context used to infer a scene.' },
        time: { type: 'string', description: 'Schedule time in 24-hour HH:MM format.' },
        days: {
          type: 'array',
          items: { type: 'string' },
          description: 'Days for a scheduled automation, e.g. ["Friday"].',
        },
        lights: {
          type: 'object',
          properties: {
            color: { type: 'string' },
            hex: { type: 'string' },
            brightness: { type: 'integer', minimum: 0, maximum: 100 },
            power: { type: 'string', enum: ['on', 'off'] },
          },
        },
        climate: {
          type: 'object',
          properties: {
            targetTempF: { type: 'integer', minimum: 55, maximum: 85 },
            mode: { type: 'string', enum: ['auto', 'heat', 'cool', 'off'] },
            humidifier: {
              type: ['string', 'object'],
              description: 'Humidifier level or state.',
            },
          },
        },
        humidifier: { type: 'string', enum: ['on', 'off', 'low', 'high'] },
        routine: {
          type: 'object',
          description: 'Wake-up or household routine to create.',
          properties: {
            name: { type: 'string' },
            time: { type: 'string' },
            days: { type: 'array', items: { type: 'string' } },
            actions: { type: 'array', items: { type: 'string' } },
          },
        },
        security: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['armed_home', 'armed_away', 'disarmed'] },
          },
        },
        targetTempF: { type: 'integer', minimum: 55, maximum: 85 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'media_render_multimodal_carousel',
    title: 'Alexa+ APL Multimodal Carousel Renderer',
    description:
      'Render structured APL-style multimodal carousel cards for Alexa+ screens: music playlists, recipe steps, smart home camera feeds, and flight/routine briefings. Cards include emojis, accent colors, badges, metadata, and supported actions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['render', 'list'],
          description: 'Render a carousel or list the supported carousel types.',
        },
        type: {
          type: 'string',
          enum: ['auto', 'music', 'recipe', 'device', 'routine'],
          description: 'Carousel type. Auto infers from context.',
        },
        context: { type: 'string', description: 'Context used to select content.' },
        title: { type: 'string', description: 'Optional custom carousel title.' },
        count: { type: 'integer', minimum: 3, maximum: 12, description: 'Number of cards to render.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

const RESOURCES = [
  {
    uri: 'memory://household/profile',
    name: 'household-profile',
    title: 'Rivera Household Profile',
    description:
      'Persistent cross-session household graph: members, dietary preferences, severe allergies, budget caps, devices, scenes, routines, and active plans.',
    mimeType: 'application/json',
  },
  {
    uri: 'memory://commerce/active-cart',
    name: 'active-cart',
    title: 'Active Commerce Cart',
    description:
      'The current allergy-filtered Amazon Fresh or Whole Foods cart, including item cards, budget verification, and confirmation token.',
    mimeType: 'application/json',
  },
  {
    uri: 'telemetry://mcp/recent-calls',
    name: 'recent-mcp-calls',
    title: 'Recent MCP JSON-RPC Frames',
    description:
      'Ring buffer of recent MCP 2025-11-25 JSON-RPC requests and responses captured by the telemetry inspector.',
    mimeType: 'application/json',
  },
];

const PROMPTS = [
  {
    name: 'host-dinner',
    title: 'Host a multi-service dinner',
    description:
      'Plan a stateful dinner across household memory, commerce, smart home, and media carousels.',
    arguments: [
      { name: 'occasion', description: 'Dinner or event name', required: true },
      { name: 'guests', description: 'Guest count', required: true },
      { name: 'dietary', description: 'Dietary constraints, including allergies', required: false },
    ],
  },
  {
    name: 'wellness-recovery',
    title: 'Build a wellness recovery plan',
    description:
      'Coordinate a constrained recovery kit, bedroom climate, and a flight-morning briefing.',
    arguments: [
      { name: 'flightTime', description: 'Flight departure time', required: false },
      { name: 'budget', description: 'Recovery kit budget cap', required: false },
    ],
  },
  {
    name: 'cross-session-recall',
    title: 'Recall and mutate a prior decision',
    description:
      'Retrieve a prior household plan and mutate the existing cart without losing cross-session state.',
    arguments: [
      { name: 'topic', description: 'The plan or decision to recall', required: true },
      { name: 'change', description: 'Requested mutation', required: false },
    ],
  },
  {
    name: 'media-moment',
    title: 'Render a multimodal moment',
    description: 'Generate a music, recipe, device, or routine carousel for the Echo Show.',
    arguments: [
      { name: 'type', description: 'music, recipe, device, or routine', required: true },
      { name: 'context', description: 'Context for the carousel', required: false },
    ],
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function toolError(message, code = 'TOOL_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateObject(value, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw toolError(`${name} must be an object.`, 'INVALID_ARGUMENT');
  }
  return value;
}

function dispatchTool(name, args) {
  const safeArgs = validateObject(args, 'arguments');
  if (name === 'memory_get_or_update') return memoryGetOrUpdate(safeArgs);
  if (name === 'commerce_build_and_purchase_cart') {
    if (!safeArgs.action) {
      throw toolError('commerce_build_and_purchase_cart requires an action.', 'INVALID_ARGUMENT');
    }
    return commerceBuildAndPurchase(safeArgs);
  }
  if (name === 'smarthome_orchestrate_scene') {
    if (!safeArgs.action) {
      throw toolError('smarthome_orchestrate_scene requires an action.', 'INVALID_ARGUMENT');
    }
    return smarthomeOrchestrateScene(safeArgs);
  }
  if (name === 'media_render_multimodal_carousel') {
    if (!safeArgs.action) safeArgs.action = 'render';
    return mediaRenderMultimodalCarousel(safeArgs);
  }
  throw toolError(`Unknown MCP tool "${name}".`, 'UNKNOWN_TOOL');
}

function summarizeResult(name, structured) {
  const service = TOOL_SERVICES[name]?.service || 'mcp';
  if (service === 'memory') {
    return {
      operation: structured.operation,
      revision: structured.revision,
      updated: structured.updated || null,
    };
  }
  if (service === 'commerce') {
    return {
      action: structured.action,
      itemCount: structured.summary?.itemCount ?? structured.cart?.items?.length ?? 0,
      total: structured.summary?.total ?? structured.cart?.total ?? null,
      merchant: structured.merchant || structured.cart?.merchant || null,
    };
  }
  if (service === 'smarthome') {
    return {
      action: structured.action,
      commands: (structured.commands || []).length,
      scheduled: structured.scheduled || null,
    };
  }
  return {
    action: structured.action,
    type: structured.type,
    cards: structured.cardCount || structured.carousel?.cards?.length || 0,
  };
}

/**
 * Execute a tool with MCP-shaped success/error results and record both sides of
 * the JSON-RPC exchange in telemetry. Agent calls and real HTTP /mcp calls share
 * this path, so the inspector shows every execution.
 */
function callTool(name, args = {}, context = {}) {
  const started = Date.now();
  const rpcId =
    context.rpcId !== undefined
      ? context.rpcId
      : `internal_${store.uuid().slice(0, 8)}`;
  const transport = context.transport || 'internal';
  const sessionId = context.sessionId || null;
  const payloadRequest = {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'tools/call',
    params: { name, arguments: args || {} },
  };

  if (context.record !== false) {
    store.recordFrame({
      direction: 'request',
      method: 'tools/call',
      rpcId,
      sessionId,
      transport,
      payload: payloadRequest,
      note: context.note || null,
    });
  }

  try {
    const structured = dispatchTool(name, args || {});
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structured),
        },
      ],
      structuredContent: structured,
      isError: false,
    };
    const latencyMs = Date.now() - started;

    if (context.record !== false) {
      store.recordFrame({
        direction: 'response',
        method: 'tools/call',
        rpcId,
        sessionId,
        transport,
        latencyMs,
        payload: { jsonrpc: '2.0', id: rpcId, result },
        note: summarizeResult(name, structured),
      });
    }

    return result;
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error && error.message ? error.message : 'Tool execution failed.';
    const code = error && error.code ? error.code : 'TOOL_ERROR';
    const result = {
      content: [{ type: 'text', text: `Error [${code}]: ${message}` }],
      structuredContent: { error: { code, message } },
      isError: true,
    };

    if (context.record !== false) {
      store.recordFrame({
        direction: 'response',
        method: 'tools/call',
        rpcId,
        sessionId,
        transport,
        latencyMs,
        payload: {
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32603, message, data: { toolCode: code } },
        },
        note: { error: code, message },
      });
    }

    return result;
  }
}

function listTools() {
  return TOOLS.map((tool) => ({ ...tool }));
}

function listResources() {
  return RESOURCES.map((resource) => ({ ...resource }));
}

function readResource(uri) {
  const memory = store.readMemory();

  if (uri === 'memory://household/profile') {
    const facts = rankFacts(memory.facts, memory.conversation?.lastUserUtterance || '', 10);
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          resource: 'memory://household/profile',
          protocolVersion: PROTOCOL_VERSION,
          revision: memory.meta.revision,
          updatedAt: memory.meta.updatedAt,
          profile: profileSnapshot(memory),
          rankedFacts: facts,
        },
        null,
        2,
      ),
    };
  }

  if (uri === 'memory://commerce/active-cart') {
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          resource: 'memory://commerce/active-cart',
          protocolVersion: PROTOCOL_VERSION,
          cart: memory.commerce?.activeCart || null,
          lastOrder: memory.commerce?.lastOrder || null,
          orderHistory: (memory.commerce?.orderHistory || []).slice(-5),
        },
        null,
        2,
      ),
    };
  }

  if (uri === 'telemetry://mcp/recent-calls') {
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          resource: 'telemetry://mcp/recent-calls',
          protocolVersion: PROTOCOL_VERSION,
          stats: store.getTelemetryStats(),
          frames: store.getTelemetry(60),
        },
        null,
        2,
      ),
    };
  }

  throw toolError(`Unknown resource URI "${uri}".`, 'UNKNOWN_RESOURCE');
}

function buildPrompt(name, args = {}) {
  const prompt = PROMPTS.find((entry) => entry.name === name);
  if (!prompt) throw toolError(`Unknown prompt "${name}".`, 'UNKNOWN_PROMPT');

  const values = {};
  for (const argument of prompt.arguments || []) {
    values[argument.name] = args[argument.name] || '';
  }

  const household = store.readMemory().household || {};
  const allergyLine = (household.allergies || [])
    .map((entry) => `${entry.member}: ${entry.allergen} (${entry.severity})`)
    .join('; ');

  let text;
  if (name === 'host-dinner') {
    text = `Use the LexaFlow MCP tools to host ${values.occasion || 'dinner'} for ${
      values.guests || 'six'
    } guests. Household allergy graph: ${allergyLine || 'none recorded'}. Dietary constraints: ${
      values.dietary || 'check memory'
    }. Load memory first, build an allergy-safe cart within the household budget, schedule the relevant smart home scene, persist the plan, and render at least one multimodal carousel. Speak a concise summary and leave checkout for explicit user confirmation.`;
  } else if (name === 'wellness-recovery') {
    text = `Use the LexaFlow MCP tools to build a wellness recovery flow${
      values.flightTime ? ` ahead of a ${values.flightTime} flight` : ''
    }. Load household memory, build a recovery kit under ${
      values.budget || 'the saved recovery cap'
    }, adjust bedroom climate and humidity, create a wake-up briefing routine, and render a routine carousel. Respect the gluten allergy and keep checkout behind explicit confirmation.`;
  } else if (name === 'cross-session-recall') {
    text = `Recall the household decision about ${
      values.topic || 'the upcoming plan'
    } using memory_get_or_update search. Then ${
      values.change ? `apply this mutation: ${values.change}.` : 'summarize the plan and current cart.'
    } Preserve cross-session state, report the updated total and allergy verification, and require explicit confirmation before purchase.`;
  } else {
    text = `Render a ${values.type || 'music'} multimodal carousel for Alexa+ using ${
      values.context || 'the current household context'
    }. Return structured cards with badges, metadata, and actions, then speak a concise one-sentence summary.`;
  }

  return {
    description: prompt.description,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ],
  };
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  TOOLS_BY_NAME,
  TOOL_SERVICES,
  RESOURCES,
  PROMPTS,
  callTool,
  dispatchTool,
  listTools,
  listResources,
  readResource,
  buildPrompt,
};
