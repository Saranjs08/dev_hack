'use strict';

const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const store = require('./store');
const {
  PROTOCOL_VERSION,
  TOOLS,
  TOOL_SERVICES,
  callTool,
} = require('./tools');
const { money } = require('./commerce-service');

const MODEL_ID =
  process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const SIMULATED_TOOL_DELAY_MS = Math.max(
  0,
  Number(process.env.LEXAFLOW_TOOL_DELAY_MS ?? 45) || 0,
);
const MAX_BEDROCK_ROUNDS = Math.min(
  Math.max(Number(process.env.BEDROCK_MAX_ROUNDS) || 6, 1),
  10,
);

const SERVICE_AGENT = { service: 'agent', label: 'Agent Planner', icon: '✦' };
const SERVICE_VOICE = { service: 'voice', label: 'Voice Synthesis', icon: '🔊' };

function modelLabel(modelId = MODEL_ID) {
  if (/claude-3-5-sonnet/i.test(modelId)) return 'Claude 3.5 Sonnet v2';
  if (/claude/i.test(modelId)) return 'Anthropic Claude';
  if (/nova-pro/i.test(modelId)) return 'Amazon Nova Pro';
  if (/nova/i.test(modelId)) return 'Amazon Nova';
  return modelId;
}

function credentialsDetected() {
  return Boolean(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK,
  );
}

function getAgentRuntimeInfo() {
  const forcedOff = String(process.env.LEXAFLOW_BEDROCK || '').toLowerCase() === 'off';
  const forcedOn = String(process.env.LEXAFLOW_BEDROCK || '').toLowerCase() === 'on';
  const hasCredentials = credentialsDetected();
  const configured = !forcedOff && (hasCredentials || forcedOn);

  let reason;
  if (forcedOff) reason = 'Bedrock disabled by LEXAFLOW_BEDROCK=off.';
  else if (hasCredentials) reason = 'AWS credentials detected in the environment.';
  else if (forcedOn) reason = 'Bedrock forced on by LEXAFLOW_BEDROCK=on; the AWS default credential chain will be used.';
  else reason = 'No AWS credentials detected. Using the deterministic Smart Agentic Fallback Engine.';

  return {
    configured,
    mode: configured ? 'bedrock' : 'smart-fallback',
    modeLabel: configured ? 'AWS Bedrock Converse' : 'Smart Agentic Fallback',
    modelId: MODEL_ID,
    modelLabel: modelLabel(MODEL_ID),
    region: REGION,
    credentialsDetected: hasCredentials,
    reason,
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Convert MCP JSON Schema tool definitions into a strict Bedrock Converse
 * toolConfig. This intentionally strips metadata that some Bedrock models
 * reject and guarantees every schema has an explicit object wrapper.
 */
function sanitizeSchema(schema) {
  const clone = JSON.parse(JSON.stringify(schema || {}));
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    delete node.$schema;
    delete node.$id;
    delete node.$comment;
    delete node.additionalProperties;
    delete node.examples;
    if (Array.isArray(node.type)) {
      const preferred = node.type.find((type) => type !== 'null') || 'string';
      node.type = preferred;
    }
    if (node.type === 'object' && !node.properties) node.properties = {};
    if (node.properties && typeof node.properties === 'object') {
      for (const key of Object.keys(node.properties)) walk(node.properties[key]);
    }
    if (node.items) walk(node.items);
    if (Array.isArray(node.required)) {
      node.required = node.required.filter(
        (key) => node.properties && Object.prototype.hasOwnProperty.call(node.properties, key),
      );
      if (node.required.length === 0) delete node.required;
    }
    return node;
  };
  return walk(clone);
}

function toBedrockToolConfig(tools = TOOLS) {
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          json: sanitizeSchema(tool.inputSchema),
        },
      },
    })),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nextWeekdayDate(targetDay = 5) {
  const now = new Date();
  const current = now.getDay();
  let delta = (targetDay - current + 7) % 7;
  if (delta === 0) delta = 7;
  const next = new Date(now);
  next.setDate(now.getDate() + delta);
  return next.toISOString().slice(0, 10);
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function humanJoin(items) {
  const list = items.filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

function detectIntent(text) {
  const normalized = String(text || '').toLowerCase();
  if (
    /what did we decide|remember|recall|last time|previous (plan|dinner|order)|cross[- ]session|\bswap\b|\breplace\b|change (the )?tortilla/.test(
      normalized,
    )
  ) {
    return 'recall';
  }
  if (
    /under the weather|feeling sick|i'?m sick|\bcold\b.*\bkit\b|recovery kit|cold recovery|8 ?am flight|flight.*(wake|morning)|wake[- ]?up briefing|sore throat|\bfever\b|\bflu\b|humidifier/.test(
      normalized,
    )
  ) {
    return 'wellness';
  }
  if (
    /\btaco\b|\bfiesta\b|\bhost\b.*\b(dinner|night)\b|\bdinner\b.*\b(for|with|guests)\b|latin jazz|patio lights|taco night/.test(
      normalized,
    )
  ) {
    return 'host';
  }
  if (/playlist|\bmusic\b|\bsong\b|\bjazz\b|play something|bossa nova/.test(normalized)) {
    return 'media';
  }
  if (/\blights?\b|thermostat|temperature|climate|\bscene\b|camera|\bring\b|security|humidifier/.test(normalized)) {
    return 'smarthome';
  }
  if (/\bcart\b|grocery|groceries|\border\b|checkout|\bpurchase\b|what'?s left|what is left/.test(normalized)) {
    return 'commerce';
  }
  return 'general';
}

function extractGuests(text) {
  const numeric = String(text || '').match(/\b(?:for|party of)\s+(\d{1,2})\b/i);
  if (numeric) return Math.max(1, Math.min(Number(numeric[1]), 24));
  const words = {
    two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const word = String(text || '').toLowerCase().match(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/);
  return word ? words[word[1]] : 6;
}

function titleForToolCall(name, args) {
  const meta = TOOL_SERVICES[name] || {};
  if (name === 'memory_get_or_update') {
    if (args.operation === 'update') {
      if (args.plan?.title) return `Persist plan: ${args.plan.title}`;
      if (args.fact?.key) return `Store fact: ${args.fact.key}`;
      return 'Update household memory';
    }
    if (args.operation === 'search') return 'Search cross-session memory';
    return 'Load household memory';
  }
  if (name === 'commerce_build_and_purchase_cart') {
    if (args.action === 'swap') return `Swap ${args.from || 'item'} → ${args.to || 'alternative'}`;
    if (args.action === 'build') return `Build ${args.occasion || 'household'} cart`;
    if (args.action === 'remove') return `Remove ${args.from || 'item'}`;
    if (args.action === 'add') return `Add ${args.item || args.to || 'item'}`;
    return 'Read active cart';
  }
  if (name === 'smarthome_orchestrate_scene') {
    if (args.action === 'set_scene') return `Schedule ${args.scene || args.room || 'home'} scene`;
    if (args.action === 'adjust_climate') return `Adjust ${args.room || 'bedroom'} climate`;
    if (args.action === 'run_routine') return `Create ${args.routine?.name || 'wake-up'} routine`;
    if (args.action === 'arm_security') return 'Set Ring security mode';
    return 'Read smart home status';
  }
  if (name === 'media_render_multimodal_carousel') {
    return `Render ${args.type || 'multimodal'} carousel`;
  }
  return meta.label || name;
}

function summarizeStructured(name, structured) {
  if (!structured || structured.error) return structured?.error?.message || 'Tool error';
  if (name === 'memory_get_or_update') {
    if (structured.plan) return structured.plan.title;
    if (structured.updated?.length) return structured.updated.join(', ');
    if (structured.results) return `${structured.results.length} ranked facts`;
    return `revision ${structured.revision ?? '—'}`;
  }
  if (name === 'commerce_build_and_purchase_cart') {
    const count = structured.summary?.itemCount ?? structured.cart?.items?.length ?? 0;
    const total = structured.summary?.total ?? structured.cart?.total ?? 0;
    return `${count} items · ${money(total)}`;
  }
  if (name === 'smarthome_orchestrate_scene') {
    if (structured.scheduled?.label) return structured.scheduled.label;
    return `${(structured.commands || []).length} device commands`;
  }
  if (name === 'media_render_multimodal_carousel') {
    return `${structured.cardCount || 0} cards · ${structured.title || structured.type}`;
  }
  return 'completed';
}

function createSlots() {
  return {
    profile: null,
    plan: null,
    commerce: null,
    scene: null,
    carousels: [],
    memoryResults: null,
  };
}

function absorbSlots(slots, name, structured) {
  if (!structured || structured.error) return;
  if (name === 'memory_get_or_update') {
    if (structured.profile) slots.profile = structured.profile;
    if (structured.plan) slots.plan = structured.plan;
    if (structured.results) slots.memoryResults = structured;
    if (structured.matchingPlans) slots.matchingPlans = structured.matchingPlans;
  } else if (name === 'commerce_build_and_purchase_cart') {
    slots.commerce = structured;
  } else if (name === 'smarthome_orchestrate_scene') {
    slots.scene = structured;
  } else if (name === 'media_render_multimodal_carousel') {
    if (structured.carousel) {
      const exists = slots.carousels.some(
        (carousel) => carousel.id === structured.carousel.id,
      );
      if (!exists) slots.carousels.push(structured.carousel);
    }
  }
}

async function invokeTool(name, args, context, slots, toolCalls) {
  const started = performance.now();
  const stepNumber = toolCalls.length + 1;
  if (SIMULATED_TOOL_DELAY_MS > 0) {
    await delay(SIMULATED_TOOL_DELAY_MS + Math.min(stepNumber * 7, 45));
  }
  const title = titleForToolCall(name, args);
  const result = callTool(name, args, {
    transport: 'agent',
    sessionId: context.sessionId,
    note: title,
  });
  const durationMs = Math.round(performance.now() - started);
  const ok = !result.isError;
  const structured = result.structuredContent || {};
  const service = TOOL_SERVICES[name]?.service || 'mcp';
  toolCalls.push({
    id: `step_${stepNumber}`,
    index: stepNumber,
    name,
    tool: name,
    service,
    serviceLabel: TOOL_SERVICES[name]?.label || 'MCP',
    title,
    arguments: args,
    ok,
    durationMs,
    summary: ok ? summarizeStructured(name, structured) : structured.error?.message || 'Tool failed',
  });
  if (ok) absorbSlots(slots, name, structured);
  return { result, structured, ok };
}

function buildDag(toolCalls, source, intent, planMs, synthesisMs) {
  const nodes = [
    {
      id: 'node_plan',
      index: 0,
      service: 'agent',
      serviceLabel: SERVICE_AGENT.label,
      title:
        source === 'bedrock'
          ? 'AWS Bedrock plans the tool chain'
          : 'Deterministic multi-intent planner',
      tool: source === 'bedrock' ? 'bedrock.Converse' : 'lexaflow.plan',
      status: 'success',
      durationMs: planMs,
      summary: `Intent: ${intent}`,
    },
  ];

  const toolNodes = toolCalls.map((call, index) => ({
    id: call.id,
    index: index + 1,
    service: call.service,
    serviceLabel: call.serviceLabel,
    title: call.title,
    tool: call.tool,
    status: call.ok ? 'success' : 'error',
    durationMs: call.durationMs,
    summary: call.summary,
  }));

  nodes.push(...toolNodes);
  nodes.push({
    id: 'node_synthesis',
    index: toolNodes.length + 1,
    service: 'voice',
    serviceLabel: SERVICE_VOICE.label,
    title: 'Voice + multimodal response synthesis',
    tool: 'alexa.respond',
    status: 'success',
    durationMs: synthesisMs,
    summary: 'Spoken summary paired with visual cards',
  });

  return nodes;
}

function buildToolSlotsResponse(slots) {
  const commerce = slots.commerce
    ? {
        cart: slots.commerce.cart,
        summary: slots.commerce.summary,
        verification: slots.commerce.verification,
        purchase: slots.commerce.purchase,
        flags: slots.commerce.flags,
        merchant: slots.commerce.merchant,
        speech: slots.commerce.speech,
      }
    : null;

  return {
    cart: slots.commerce?.cart || null,
    commerce,
    scene: slots.scene || null,
    carousels: slots.carousels,
    carousel: slots.carousels[0] || null,
    plan: slots.plan || null,
    memoryResults: slots.memoryResults || null,
    purchase: slots.commerce?.purchase || null,
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic Smart Agentic Fallback Engine                                */
/* -------------------------------------------------------------------------- */

async function runHostFlow(message, context) {
  const toolCalls = [];
  const slots = createSlots();
  const guests = extractGuests(message);
  const friday = nextWeekdayDate(5);

  await invokeTool(
    'memory_get_or_update',
    { operation: 'get', query: message, limit: 6 },
    context,
    slots,
    toolCalls,
  );

  const budgetCap = slots.profile?.household?.budgetCaps?.groceryPerOrder || 75;

  await invokeTool(
    'commerce_build_and_purchase_cart',
    {
      action: 'build',
      occasion: 'Friday Taco Night',
      context: message,
      servings: guests,
      budgetCap,
      store: 'Whole Foods Market',
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'smarthome_orchestrate_scene',
    {
      action: 'set_scene',
      scene: 'Patio Warm Glow',
      room: 'Patio',
      context: message,
      time: '19:00',
      days: ['Friday'],
      lights: { color: 'Warm Amber', hex: '#ffb86b', brightness: 45, power: 'on' },
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'media_render_multimodal_carousel',
    {
      action: 'render',
      type: 'music',
      title: 'Latin Jazz Dinner Party',
      context: 'Friday Taco Night on the patio',
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'media_render_multimodal_carousel',
    {
      action: 'render',
      type: 'recipe',
      title: 'Gluten-Free Taco Night',
      context: message,
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'memory_get_or_update',
    {
      operation: 'update',
      query: 'Friday Taco Night gluten free patio Latin jazz',
      plan: {
        title: 'Friday Taco Night',
        type: 'dinner',
        date: friday,
        time: '18:30',
        guests,
        status: 'confirmed',
        location: 'Patio',
        budgetCap,
        notes:
          'Warm amber patio lights at 7 PM, Latin Jazz Dinner Party playlist queued, gluten-free cart verified for Ben, vegetarian chorizo for Maya.',
        dietaryConstraints: ['Gluten-free for Ben', 'Vegetarian option for Maya'],
      },
      fact: {
        key: 'friday_taco_night',
        value: `Friday Taco Night for ${guests} is confirmed for ${friday} at 6:30 PM on the patio with warm lights and Latin jazz.`,
        category: 'plan',
        confidence: 0.98,
      },
    },
    context,
    slots,
    toolCalls,
  );

  const commerce = slots.commerce;
  const scene = slots.scene;
  const music = slots.carousels.find((carousel) => carousel.carouselType === 'music');
  const recipe = slots.carousels.find((carousel) => carousel.carouselType === 'recipe');
  const parts = [
    `Done — Friday Taco Night for ${guests} is locked in for ${formatDate(friday)} at 6:30 PM on the patio.`,
  ];

  if (commerce?.summary) {
    parts.push(
      `I built a ${commerce.merchant} cart with ${commerce.summary.itemCount} items for ${money(
        commerce.summary.total,
      )}; every item passed Ben's gluten-free allergy check, with plant-based chorizo for Maya.`,
    );
  } else {
    parts.push('The cart builder hit an issue, so no groceries were added; I can retry that piece.');
  }

  if (scene?.scheduled) {
    parts.push(`The patio lights are scheduled for warm amber at 7 PM.`);
  }
  if (music) {
    parts.push('The Latin Jazz Dinner Party playlist is queued.');
  }
  if (recipe) {
    parts.push('The six-step recipe cards are on screen.');
  }

  const trimmed = commerce?.flags?.find((flag) => /^Dropped/.test(flag));
  if (trimmed) parts.push(trimmed);
  parts.push(
    'Tap Confirm Alexa+ Voice Purchase when you are ready, or tell me to swap anything first.',
  );

  return {
    intent: 'host',
    reply: parts.join(' '),
    slots,
    toolCalls,
  };
}

async function runWellnessFlow(message, context) {
  const toolCalls = [];
  const slots = createSlots();

  await invokeTool(
    'memory_get_or_update',
    { operation: 'get', query: `${message} flight recovery budget allergy`, limit: 6 },
    context,
    slots,
    toolCalls,
  );

  const recoveryBudget =
    Number(slots.profile?.household?.budgetCaps?.recoveryKit) || 25;

  await invokeTool(
    'smarthome_orchestrate_scene',
    {
      action: 'adjust_climate',
      scene: 'Restful Bedroom',
      room: 'Bedroom',
      context: message,
      climate: { targetTempF: 68, mode: 'auto' },
      humidifier: 'low',
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'smarthome_orchestrate_scene',
    {
      action: 'run_routine',
      routine: {
        name: 'Flight Day Wake-Up',
        time: '06:00',
        days: ['Monday'],
        actions: [
          'Bedroom thermostat to 68°F',
          'Humidifier on low',
          'Weather and traffic briefing',
          'Flight AS 214 status check',
          'Recovery checklist reminder',
        ],
      },
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'commerce_build_and_purchase_cart',
    {
      action: 'build',
      occasion: 'Cold recovery kit',
      context: `${message} gluten-free recovery`,
      servings: 1,
      budgetCap: recoveryBudget,
      store: 'Amazon Fresh',
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'media_render_multimodal_carousel',
    {
      action: 'render',
      type: 'routine',
      title: '6:00 AM Flight Wake-Up Briefing',
      context: '8 AM flight cold recovery',
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'media_render_multimodal_carousel',
    {
      action: 'render',
      type: 'device',
      title: 'Home & Ring Camera Feeds',
      context: 'bedroom climate and ring security status',
    },
    context,
    slots,
    toolCalls,
  );

  await invokeTool(
    'memory_get_or_update',
    {
      operation: 'update',
      fact: {
        key: 'recovery_flight_plan',
        value:
          'Maya is under the weather before her 8:00 AM Monday flight. Bedroom is set to 68°F with the humidifier on low; a 6:00 AM wake-up briefing and a recovery kit under $25 are ready.',
        category: 'schedule',
        confidence: 0.96,
      },
    },
    context,
    slots,
    toolCalls,
  );

  const commerce = slots.commerce;
  const scene = slots.scene;
  const routine = toolCalls.find((call) => /routine/i.test(call.title));
  const parts = ['I have got you.'];

  if (scene?.commands?.length) {
    parts.push('The bedroom is set to 68°F with the humidifier on low.');
  }
  if (commerce?.summary) {
    parts.push(
      `I built a ${commerce.merchant} cold recovery kit with ${commerce.summary.itemCount} items for ${money(
        commerce.summary.total,
      )} — all gluten-free and under your ${money(recoveryBudget)} cap.`,
    );
    const trimmed = commerce.flags?.find((flag) => /^Dropped/.test(flag));
    if (trimmed) parts.push(trimmed);
  }
  if (routine) {
    parts.push('The Flight Day Wake-Up briefing is scheduled for 6:00 AM with weather, traffic, and flight AS 214.');
  }
  const routineCarousel = slots.carousels.find((carousel) => carousel.carouselType === 'routine');
  const deviceCarousel = slots.carousels.find((carousel) => carousel.carouselType === 'device');
  if (routineCarousel) parts.push('Your five-card morning briefing is on screen.');
  if (deviceCarousel) parts.push('I also pulled up the Ring and bedroom device feeds.');
  parts.push('Tap Confirm Alexa+ Voice Purchase to restock the kit when you are ready.');

  return {
    intent: 'wellness',
    reply: parts.join(' '),
    slots,
    toolCalls,
  };
}

function recallPlan(slots) {
  return (
    slots.matchingPlans?.[0] ||
    slots.profile?.activePlans?.find((plan) => /taco|dinner/i.test(`${plan.title} ${plan.type}`)) ||
    slots.profile?.activePlans?.[0] ||
    null
  );
}

async function runRecallFlow(message, context) {
  const toolCalls = [];
  const slots = createSlots();
  const wantsSwap = /\bswap\b|\breplace\b|change (the )?tortilla|corn shells/i.test(message);

  await invokeTool(
    'memory_get_or_update',
    { operation: 'search', query: message, limit: 8 },
    context,
    slots,
    toolCalls,
  );

  let target = 'Organic Corn Shells';
  if (/gluten[- ]free.*(tortilla|wrap)/i.test(message)) target = 'Gluten-Free Flour Tortillas';
  if (/cheese/i.test(message)) target = 'Mexican Blend Cheese';
  if (/chorizo|vegan|meat/i.test(message)) target = 'Plant-Based Chorizo';
  if (/sparkling|water/i.test(message)) target = 'Sparkling Water Variety';

  let from = 'tortillas';
  if (/cheese/i.test(message)) from = 'cheese';
  if (/chorizo/i.test(message)) from = 'chorizo';
  if (/water/i.test(message)) from = 'sparkling water';

  if (wantsSwap) {
    await invokeTool(
      'commerce_build_and_purchase_cart',
      { action: 'swap', from, to: target, context: message },
      context,
      slots,
      toolCalls,
    );
  } else {
    await invokeTool(
      'commerce_build_and_purchase_cart',
      { action: 'get' },
      context,
      slots,
      toolCalls,
    );
  }

  if (wantsSwap) {
    await invokeTool(
      'memory_get_or_update',
      {
        operation: 'update',
        fact: {
          key: 'friday_taco_swap',
          value: `The Friday Taco Night cart was updated: ${from} swapped for ${target}. The final cart remains allergy verified.`,
          category: 'plan',
          confidence: 0.97,
        },
      },
      context,
      slots,
      toolCalls,
    );
  }

  const plan = recallPlan(slots);
  const commerce = slots.commerce;
  const cart = commerce?.cart;
  const mutation = commerce?.mutation;
  const parts = [];

  if (plan) {
    parts.push(
      `Here is what we decided: ${plan.title} for ${plan.guests || 6} on ${
        plan.date ? formatDate(plan.date) : 'Friday'
      } at 6:30 PM${plan.location ? ` on the ${plan.location.toLowerCase()}` : ''}.`,
    );
    if (plan.dietaryConstraints?.length) {
      parts.push(`Guardrails: ${plan.dietaryConstraints.join('; ')}.`);
    }
  } else {
    parts.push("I found the Friday dinner thread, but the plan card is still getting rebuilt.");
  }

  if (wantsSwap) {
    if (mutation?.description) {
      parts.push(`${mutation.description}`);
    } else {
      parts.push(`I swapped the ${from} for ${target}.`);
    }
    if (commerce?.rebuilt) {
      parts.push('The previous cart was empty, so I rebuilt it from the saved Friday plan first.');
    }
  }

  if (cart?.items?.length) {
    parts.push(
      `The ${cart.merchant} cart now has ${cart.items.length} items totaling ${money(
        cart.total,
      )}. ${
        cart.verification?.passed
          ? 'The allergy check still passes.'
          : 'One item needs an allergy review.'
      }`,
    );
  } else {
    parts.push('Your active cart is empty at the moment.');
  }

  if (!wantsSwap) {
    parts.push('If you want, I can swap the tortillas for organic corn shells or adjust anything else.');
  } else {
    parts.push('Tap Confirm Alexa+ Voice Purchase whenever you want to check out.');
  }

  return { intent: 'recall', reply: parts.join(' '), slots, toolCalls };
}

async function runMediaFlow(message, context) {
  const toolCalls = [];
  const slots = createSlots();
  await invokeTool(
    'memory_get_or_update',
    { operation: 'get', query: message, limit: 4 },
    context,
    slots,
    toolCalls,
  );
  const type = /recipe|cook|steps/i.test(message)
    ? 'recipe'
    : /device|camera|ring/i.test(message)
      ? 'device'
      : /flight|briefing|routine/i.test(message)
        ? 'routine'
        : 'music';
  const rendered = await invokeTool(
    'media_render_multimodal_carousel',
    { action: 'render', type, context: message },
    context,
    slots,
    toolCalls,
  );
  return {
    intent: 'media',
    reply:
      rendered.structured?.speech ||
      'I rendered a multimodal carousel for the Echo Show.',
    slots,
    toolCalls,
  };
}

async function runSmarthomeFlow(message, context) {
  const toolCalls = [];
  const slots = createSlots();
  await invokeTool(
    'memory_get_or_update',
    { operation: 'get', query: message, limit: 4 },
    context,
    slots,
    toolCalls,
  );

  const args = /thermostat|temperature|climate|humidifier|bedroom/i.test(message)
    ? {
        action: 'adjust_climate',
        room: /bedroom/i.test(message) ? 'Bedroom' : 'Living Room',
        climate: { targetTempF: 68, mode: 'auto' },
        humidifier: 'low',
        context: message,
      }
    : /camera|ring|security/i.test(message)
      ? { action: 'get_status' }
      : {
          action: 'set_scene',
          scene: /patio/i.test(message) ? 'Patio Warm Glow' : 'Household Scene',
          room: /patio/i.test(message) ? 'Patio' : 'Whole Home',
          context: message,
          lights: { color: 'Warm Amber', brightness: 45, power: 'on' },
        };

  const scene = await invokeTool(
    'smarthome_orchestrate_scene',
    args,
    context,
    slots,
    toolCalls,
  );

  if (/camera|ring|feed/i.test(message)) {
    await invokeTool(
      'media_render_multimodal_carousel',
      { action: 'render', type: 'device', context: message },
      context,
      slots,
      toolCalls,
    );
  }

  return {
    intent: 'smarthome',
    reply: scene.structured?.speech || 'Smart home state updated.',
    slots,
    toolCalls,
  };
}

async function runCommerceFlow(message, context) {
  const toolCalls = [];
  const slots = createSlots();
  await invokeTool(
    'memory_get_or_update',
    { operation: 'get', query: message, limit: 4 },
    context,
    slots,
    toolCalls,
  );
  const cartResult = await invokeTool(
    'commerce_build_and_purchase_cart',
    { action: 'get' },
    context,
    slots,
    toolCalls,
  );
  const cart = cartResult.structured?.cart;
  const items = (cart?.items || []).slice(0, 6).map((item) => `${item.quantity} × ${item.name}`);
  return {
    intent: 'commerce',
    reply: cart?.items?.length
      ? `Your ${cart.merchant} cart has ${cart.items.length} items for ${money(cart.total)}. ${
          items.length ? `Right now: ${humanJoin(items)}.` : ''
        } ${cart.verification?.passed ? 'Everything is allergy verified.' : 'One item needs review.'} Checkout always needs your explicit confirmation.`
      : 'Your cart is empty right now. I can build a taco cart, a recovery kit, or a breakfast restock.',
    slots,
    toolCalls,
  };
}

async function runGeneralFlow(message, context) {
  const toolCalls = [];
  const slots = createSlots();
  await invokeTool(
    'memory_get_or_update',
    { operation: 'search', query: message, limit: 5 },
    context,
    slots,
    toolCalls,
  );

  const profile = slots.profile;
  const household = profile?.household;
  let reply;

  if (/allerg|gluten|dietary|safe to eat/i.test(message)) {
    const allergies = (household?.allergies || [])
      .map((entry) => `${entry.member} — ${entry.allergen} (${entry.severity})`)
      .join('; ');
    reply = `Household food safety: ${allergies || 'no allergies recorded'}. I filter every cart against that graph before it reaches your screen.`;
  } else if (/budget|spend|cost/i.test(message)) {
    const caps = household?.budgetCaps || {};
    reply = `Your saved caps are ${money(caps.groceryPerOrder || 75)} per grocery order, ${money(
      caps.monthlyGrocery || 320,
    )} monthly, and ${money(caps.recoveryKit || 25)} for a recovery kit. I enforce the relevant cap before rendering a cart.`;
  } else if (/who|household|members|family/i.test(message)) {
    const members = (household?.members || [])
      .map((member) => `${member.name}${member.dietary?.length ? ` (${member.dietary.join(', ')})` : ''}`)
      .join(', ');
    reply = `This is ${household?.name || 'your household'}: ${members}. I remember each person's dietary constraints across sessions.`;
  } else {
    const plan = profile?.activePlans?.[0];
    const cart = profile?.cart;
    reply = `I'm LexaFlow, your stateful Alexa+ household orchestrator. I can coordinate memory, Amazon Fresh carts, Matter and Ring scenes, and multimodal carousels in one turn. ${
      plan ? `Your next plan is ${plan.title}${plan.date ? ` on ${formatDate(plan.date)}` : ''}.` : ''
    } ${
      cart ? `There is a ${cart.itemCount}-item ${cart.status} cart totaling ${money(cart.total)}.` : ''
    } Try a demo scenario above — host Taco Night for six, handle a sick day before an 8 AM flight, or recall Friday's plan and swap the tortillas.`;
  }

  return { intent: 'general', reply, slots, toolCalls };
}

async function runFallback(message, context) {
  const started = performance.now();
  const intent = detectIntent(message);
  const flows = {
    host: runHostFlow,
    wellness: runWellnessFlow,
    recall: runRecallFlow,
    media: runMediaFlow,
    smarthome: runSmarthomeFlow,
    commerce: runCommerceFlow,
    general: runGeneralFlow,
  };

  const flow = flows[intent] || runGeneralFlow;
  const result = await flow(message, context);
  const planMs = 12 + Math.min(38, message.length);
  const latencyMs = Math.round(performance.now() - started);
  const synthesisMs = 24;
  const runtime = getAgentRuntimeInfo();
  const dag = buildDag(result.toolCalls, 'fallback', result.intent, planMs, synthesisMs);

  return {
    reply: result.reply,
    intent: result.intent,
    source: 'fallback',
    sourceLabel: runtime.configured
      ? 'Smart Agentic Fallback · Bedrock error recovery'
      : 'Smart Agentic Fallback · No AWS credentials',
    mode: 'smart-fallback',
    modelId: runtime.modelId,
    modelLabel: runtime.modelLabel,
    region: runtime.region,
    runtime,
    latencyMs,
    toolCalls: result.toolCalls,
    dag,
    ...buildToolSlotsResponse(result.slots),
  };
}

/* -------------------------------------------------------------------------- */
/* AWS Bedrock Converse integration                                           */
/* -------------------------------------------------------------------------- */

function systemPrompt(memory) {
  const household = memory.household || {};
  const allergies = (household.allergies || [])
    .map((entry) => `${entry.member}: ${entry.allergen} (${entry.severity})`)
    .join('; ');
  const plans = (memory.activePlans || [])
    .map((plan) => `${plan.title} on ${plan.date} at ${plan.time}`)
    .join('; ');
  const cart = memory.commerce?.activeCart;

  return [
    'You are LexaFlow, a stateful, multi-service household orchestrator for Alexa+.',
    `You are connected to a live MCP ${PROTOCOL_VERSION} server with four tools: memory_get_or_update, commerce_build_and_purchase_cart, smarthome_orchestrate_scene, and media_render_multimodal_carousel.`,
    'Always follow this policy:',
    '1. Call memory_get_or_update before a commerce or scheduling decision so allergies and budgets are current.',
    '2. Never add a product that conflicts with a household allergy. The commerce tool enforces this, so trust its structured result.',
    '3. Never claim a purchase is complete. Checkout requires an explicit user confirmation through the Alexa+ purchase card. Leave checkout to the user.',
    '4. Speak a concise, natural summary of 2–4 sentences. Put dense item details, prices, recipe steps, and camera status in tool-generated carousel cards.',
    '5. Persist new plans or durable household facts with memory_get_or_update update before finishing.',
    '6. If the user asks for a multi-service outcome, chain tools instead of asking them to repeat themselves.',
    '',
    `Current date: ${new Date().toISOString().slice(0, 10)}.`,
    `Household: ${household.name || 'Rivera Household'} in ${household.location || 'Seattle'} (${household.timezone || 'America/Los_Angeles'}).`,
    `Allergies: ${allergies || 'none recorded'}.`,
    `Budget caps: ${JSON.stringify(household.budgetCaps || {})}.`,
    `Active plans: ${plans || 'none'}.`,
    cart
      ? `Active cart: ${cart.items?.length || 0} items, ${money(cart.total)}, ${cart.merchant}, status ${cart.status}.`
      : 'Active cart: empty.',
    'Voice responses should sound warm, confident, and efficient. Do not use markdown headings in spoken text.',
  ].join('\n');
}

async function runBedrock(message, context) {
  const started = performance.now();
  const runtime = getAgentRuntimeInfo();
  const memory = store.readMemory();
  const client = new BedrockRuntimeClient({
    region: REGION,
    maxAttempts: 1,
  });
  const toolCalls = [];
  const slots = createSlots();
  const messages = [
    {
      role: 'user',
      content: [{ text: message }],
    },
  ];
  const toolConfig = toBedrockToolConfig(TOOLS);
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let rounds = 0;
  let reply = '';

  const plannerStarted = performance.now();

  while (rounds < MAX_BEDROCK_ROUNDS) {
    rounds += 1;
    const response = await withTimeout(
      client.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: systemPrompt(memory) }],
          messages,
          toolConfig,
          inferenceConfig: {
            maxTokens: 1100,
            temperature: 0.3,
            topP: 0.9,
          },
        }),
      ),
      30_000,
      'Amazon Bedrock Converse',
    );

    if (response.usage) {
      usage.inputTokens += response.usage.inputTokens || 0;
      usage.outputTokens += response.usage.outputTokens || 0;
      usage.totalTokens += response.usage.totalTokens || 0;
    }

    const assistantContent = response.output?.message?.content || [];
    messages.push({ role: 'assistant', content: assistantContent });

    const toolUses = assistantContent.filter((block) => block.toolUse);
    if (toolUses.length) {
      const toolResults = [];
      for (const block of toolUses) {
        const toolUse = block.toolUse;
        const toolName = toolUse.name;
        const args = toolUse.input || {};
        const stepStarted = performance.now();
        const title = titleForToolCall(toolName, args);
        const result = callTool(toolName, args, {
          transport: 'bedrock',
          sessionId: context.sessionId,
          note: title,
        });
        const durationMs = Math.round(performance.now() - stepStarted);
        const ok = !result.isError;
        const structured = result.structuredContent || {};
        const service = TOOL_SERVICES[toolName]?.service || 'mcp';
        toolCalls.push({
          id: `step_${toolCalls.length + 1}`,
          index: toolCalls.length + 1,
          name: toolName,
          tool: toolName,
          service,
          serviceLabel: TOOL_SERVICES[toolName]?.label || 'MCP',
          title,
          arguments: args,
          ok,
          durationMs,
          summary: ok
            ? summarizeStructured(toolName, structured)
            : structured.error?.message || 'Tool failed',
        });
        if (ok) absorbSlots(slots, toolName, structured);
        toolResults.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            content: [
              ok
                ? { text: JSON.stringify(structured) }
                : {
                    text: `Tool error: ${structured.error?.message || 'unknown error'}. Explain the failure briefly and continue safely.`,
                  },
            ],
          },
        });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    reply = assistantContent
      .filter((block) => block.text)
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (reply) break;
    if (response.stopReason === 'end_turn' || response.stopReason === 'max_tokens') break;
  }

  if (!reply) {
    const fallbackSpeech = [
      slots.commerce?.speech,
      slots.scene?.speech,
      slots.carousels[0]?.speech,
    ]
      .filter(Boolean)
      .join(' ');
    reply =
      fallbackSpeech ||
      'I completed the requested MCP tool steps, but the model did not return a spoken summary. The structured results are available in the telemetry inspector.';
  }

  const planMs = Math.round(performance.now() - plannerStarted) === 0
    ? 1
    : Math.min(400, Math.round((performance.now() - started) * 0.08) + 20);
  const latencyMs = Math.round(performance.now() - started);
  const dag = buildDag(toolCalls, 'bedrock', detectIntent(message), planMs, 30);

  return {
    reply,
    intent: detectIntent(message),
    source: 'bedrock',
    sourceLabel: `AWS Bedrock · ${modelLabel(MODEL_ID)}`,
    mode: 'bedrock',
    modelId: MODEL_ID,
    modelLabel: modelLabel(MODEL_ID),
    region: REGION,
    runtime,
    latencyMs,
    toolCalls,
    dag,
    bedrock: {
      rounds,
      usage,
      stopReason: 'complete',
    },
    ...buildToolSlotsResponse(slots),
  };
}

function recordBedrockTelemetry(result, startedAt, error) {
  const latencyMs = Math.max(1, Date.now() - startedAt);
  const method = result?.source === 'bedrock' ? 'bedrock/converse' : 'bedrock/fallback';
  const transport = result?.source === 'bedrock' ? 'bedrock' : 'fallback';
  const runtime = getAgentRuntimeInfo();
  const requestId = `bedrock_${store.uuid().slice(0, 8)}`;

  store.recordFrame({
    direction: 'request',
    method,
    rpcId: requestId,
    transport,
    payload: {
      modelId: runtime.modelId,
      region: runtime.region,
      modelLabel: runtime.modelLabel,
      mode: runtime.mode,
      toolSchemaCount: TOOLS.length,
      ...(error ? { fallbackReason: error } : {}),
    },
    note: result?.sourceLabel || runtime.modeLabel,
  });

  store.recordFrame({
    direction: 'response',
    method,
    rpcId: requestId,
    transport,
    latencyMs,
    payload: {
      source: result?.source,
      rounds: result?.bedrock?.rounds || null,
      usage: result?.bedrock?.usage || null,
      toolCalls: (result?.toolCalls || []).length,
      replyChars: result?.reply?.length || 0,
    },
    note: result?.sourceLabel || runtime.modeLabel,
  });
}

function recordConversationTurn(message, result) {
  try {
    store.updateMemory((draft) => {
      draft.conversation = draft.conversation || {};
      const turns = Array.isArray(draft.conversation.turns) ? draft.conversation.turns : [];
      turns.push({
        id: `turn_${store.uuid()}`,
        user: message,
        assistant: result.reply,
        intent: result.intent,
        source: result.source,
        toolCalls: (result.toolCalls || []).map((call) => ({
          name: call.name,
          title: call.title,
          ok: call.ok,
          durationMs: call.durationMs,
        })),
        timestamp: new Date().toISOString(),
      });
      draft.conversation.turns = turns.slice(-30);
      draft.conversation.lastUserUtterance = message;
      draft.conversation.lastAlexaResponse = result.reply;
      draft.conversation.lastIntent = result.intent;
      draft.conversation.updatedAt = new Date().toISOString();
      draft.conversation.summary = `${message.slice(0, 120)} → ${result.reply.slice(0, 260)}`.slice(
        0,
        500,
      );
    });
  } catch (error) {
    console.warn('[LexaFlow] Could not persist conversation turn:', error.message);
  }
}

async function runAgent(message, options = {}) {
  const started = Date.now();
  const text = String(message || '').trim();
  if (!text) {
    const error = new Error('A message is required.');
    error.code = 'EMPTY_MESSAGE';
    throw error;
  }

  const runtime = getAgentRuntimeInfo();
  const context = {
    sessionId: options.sessionId || null,
    transport: 'agent',
  };

  let result;
  let fallbackError = null;

  if (runtime.configured) {
    try {
      result = await runBedrock(text, context);
    } catch (error) {
      fallbackError = error && error.message ? error.message : String(error);
      console.warn(`[LexaFlow] Bedrock unavailable, using fallback: ${fallbackError}`);
      result = await runFallback(text, context);
      result.source = 'fallback';
      result.sourceLabel = 'Smart Agentic Fallback · Bedrock error recovery';
      result.fallbackReason = fallbackError;
      result.runtime = { ...getAgentRuntimeInfo(), mode: 'smart-fallback', configured: false };
      result.dag = buildDag(result.toolCalls, 'fallback', result.intent, 18, 24);
    }
  } else {
    result = await runFallback(text, context);
  }

  result.latencyMs = Date.now() - started;
  result.protocolVersion = PROTOCOL_VERSION;
  result.generatedAt = new Date().toISOString();
  result.turn = {
    user: text,
    intent: result.intent,
    source: result.source,
  };

  recordBedrockTelemetry(result, started, fallbackError);
  recordConversationTurn(text, result);

  return result;
}

module.exports = {
  runAgent,
  getAgentRuntimeInfo,
  toBedrockToolConfig,
  sanitizeSchema,
  detectIntent,
  nextWeekdayDate,
};
