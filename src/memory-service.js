'use strict';

const store = require('./store');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'is', 'are',
  'was', 'were', 'with', 'my', 'our', 'me', 'we', 'i', 'you', 'what', 'did', 'do',
  'does', 'about', 'this', 'that', 'it', 'be', 'have', 'has', 'can', 'please',
  'alexa', 'friday', 'saturday', 'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'today', 'tomorrow',
]);

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function daysSince(timestamp) {
  const then = Date.parse(timestamp || '');
  if (Number.isNaN(then)) return 30;
  return Math.max(0, (Date.now() - then) / 86_400_000);
}

/**
 * Time-decayed relevance score.
 * U(m, q) = 0.6 * similarity + 0.25 * e^(-0.02 * ageDays) + 0.15 * safety
 */
function scoreFact(fact, queryTokens) {
  const factTokens = tokenize(`${fact.key} ${fact.value} ${fact.category}`);
  let overlap = 0;
  for (const token of queryTokens) {
    if (factTokens.has(token)) overlap += 1;
  }
  const similarity = queryTokens.size ? overlap / Math.min(queryTokens.size, 8) : 0;
  const decay = Math.exp(-0.02 * daysSince(fact.confirmedAt || fact.createdAt));
  const safety =
    fact.category === 'safety' || fact.category === 'budget' || fact.category === 'allergy'
      ? 1
      : 0;

  return {
    score: Number((0.6 * similarity + 0.25 * decay + 0.15 * safety).toFixed(4)),
    similarity: Number(similarity.toFixed(4)),
    decay: Number(decay.toFixed(4)),
    safety,
  };
}

function rankFacts(facts, query, limit = 6) {
  const queryTokens = tokenize(query);
  return (facts || [])
    .map((fact) => {
      const scored = scoreFact(fact, queryTokens);
      return {
        id: fact.id,
        key: fact.key,
        value: fact.value,
        category: fact.category,
        confidence: fact.confidence,
        confirmedAt: fact.confirmedAt,
        score: scored.score,
        scoreBreakdown: scored,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function profileSnapshot(memory) {
  const household = memory.household || {};
  return {
    household: {
      id: household.id,
      name: household.name,
      primaryUser: household.primaryUser,
      timezone: household.timezone,
      location: household.location,
      members: household.members || [],
      allergies: household.allergies || [],
      dietaryProfiles: household.dietaryProfiles || [],
      budgetCaps: household.budgetCaps || {},
      preferences: household.preferences || {},
    },
    activePlans: (memory.activePlans || []).map((plan) => ({ ...plan })),
    devices: (memory.connectedDevices || []).map((device) => ({
      id: device.id,
      name: device.name,
      type: device.type,
      room: device.room,
      status: device.status,
      state: device.state || {},
    })),
    scenes: (memory.scenes || []).map((scene) => ({ ...scene })),
    routines: (memory.routines || []).map((routine) => ({ ...routine })),
    cart: memory.commerce && memory.commerce.activeCart
      ? {
          id: memory.commerce.activeCart.id,
          status: memory.commerce.activeCart.status,
          itemCount: (memory.commerce.activeCart.items || []).length,
          total: memory.commerce.activeCart.total,
          occasion: memory.commerce.activeCart.occasion,
        }
      : null,
    lastOrder: memory.commerce ? memory.commerce.lastOrder : null,
    recentOrders: memory.commerce ? (memory.commerce.orderHistory || []).slice(-3) : [],
    conversation: memory.conversation
      ? {
          summary: memory.conversation.summary,
          lastUserUtterance: memory.conversation.lastUserUtterance,
          lastAlexaResponse: memory.conversation.lastAlexaResponse,
          updatedAt: memory.conversation.updatedAt,
        }
      : null,
  };
}

function mergeMembers(existingMembers, incomingMembers) {
  const members = Array.isArray(existingMembers) ? existingMembers : [];
  if (!Array.isArray(incomingMembers)) return members;

  for (const incoming of incomingMembers) {
    if (!incoming || typeof incoming !== 'object') continue;
    const key = String(incoming.id || incoming.name || '').toLowerCase();
    if (!key) continue;
    const index = members.findIndex(
      (member) =>
        String(member.id || '').toLowerCase() === key ||
        String(member.name || '').toLowerCase() === key,
    );
    if (index >= 0) {
      members[index] = { ...members[index], ...incoming };
    } else {
      members.push(incoming);
    }
  }
  return members;
}

function syncAllergyGraph(memory) {
  const household = memory.household || {};
  const flattened = [];
  for (const member of household.members || []) {
    for (const allergy of member.allergies || []) {
      if (typeof allergy === 'string') {
        flattened.push({ member: member.name, allergen: allergy, severity: 'high' });
      } else if (allergy && allergy.allergen) {
        flattened.push({
          member: member.name,
          allergen: allergy.allergen,
          severity: allergy.severity || 'high',
        });
      }
    }
  }
  if (flattened.length) {
    household.allergies = flattened;
  }
  return household.allergies || [];
}

function upsertPlan(memory, planInput) {
  if (!planInput || typeof planInput !== 'object') return null;
  const plans = Array.isArray(memory.activePlans) ? memory.activePlans : [];
  const title = String(planInput.title || planInput.name || '').trim();
  if (!title) return null;

  const normalized = title.toLowerCase();
  const index = plans.findIndex(
    (plan) =>
      (planInput.id && plan.id === planInput.id) ||
      String(plan.title || '').toLowerCase() === normalized,
  );

  const base = index >= 0 ? plans[index] : {
    id: planInput.id || `plan_${normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    createdAt: new Date().toISOString(),
  };

  const merged = {
    ...base,
    ...planInput,
    title,
    status: planInput.status || base.status || 'planned',
    updatedAt: new Date().toISOString(),
  };

  if (index >= 0) {
    plans[index] = merged;
  } else {
    plans.push(merged);
  }
  memory.activePlans = plans;

  const factKey = `${normalized.replace(/[^a-z0-9]+/g, '_')}_plan`;
  const facts = Array.isArray(memory.facts) ? memory.facts : [];
  const factIndex = facts.findIndex((fact) => fact.key === factKey);
  const factValue = `${merged.title}${merged.date ? ` on ${merged.date}` : ''}${
    merged.time ? ` at ${merged.time}` : ''
  }${merged.guests ? ` for ${merged.guests} guests` : ''}. ${
    merged.notes || 'Saved by the LexaFlow household memory tool.'
  }`;
  const fact = {
    id: factIndex >= 0 ? facts[factIndex].id : `fact_${factKey}`,
    key: factKey,
    value: factValue,
    category: 'plan',
    confidence: 0.97,
    createdAt: factIndex >= 0 ? facts[factIndex].createdAt : new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  };
  if (factIndex >= 0) facts[factIndex] = fact;
  else facts.push(fact);
  memory.facts = facts;

  return merged;
}

function upsertFact(memory, factInput) {
  if (!factInput || typeof factInput !== 'object') return null;
  const value = String(factInput.value || factInput.note || '').trim();
  if (!value) return null;

  const key =
    String(factInput.key || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_') || `fact_${Date.now()}`;
  const facts = Array.isArray(memory.facts) ? memory.facts : [];
  const index = facts.findIndex((fact) => fact.key === key);
  const saved = {
    id: index >= 0 ? facts[index].id : `fact_${key}`,
    key,
    value,
    category: factInput.category || 'note',
    confidence: Number(factInput.confidence) || 0.9,
    createdAt: index >= 0 ? facts[index].createdAt : new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  };
  if (index >= 0) facts[index] = saved;
  else facts.push(saved);
  memory.facts = facts;
  return saved;
}

function memoryGetOrUpdate(args = {}) {
  const operation = String(args.operation || 'get').toLowerCase();

  if (operation === 'get') {
    const memory = store.readMemory();
    const relevantFacts = rankFacts(
      memory.facts,
      args.query || memory.conversation?.lastUserUtterance || '',
      Number(args.limit) || 6,
    );
    return {
      operation: 'get',
      profile: profileSnapshot(memory),
      relevantFacts,
      revision: memory.meta.revision,
      updatedAt: memory.meta.updatedAt,
      speech: `Loaded ${memory.household.name} memory: ${
        (memory.household.members || []).length
      } members, ${(memory.household.allergies || []).length} allergy constraint${
        (memory.household.allergies || []).length === 1 ? '' : 's'
      }, and ${(memory.activePlans || []).length} active plan${
        (memory.activePlans || []).length === 1 ? '' : 's'
      }.`,
      message: 'Household profile loaded from persistent cross-session memory.',
    };
  }

  if (operation === 'search') {
    const memory = store.readMemory();
    const results = rankFacts(memory.facts, args.query || '', Number(args.limit) || 6);
    const planMatches = (memory.activePlans || []).filter((plan) => {
      const haystack = `${plan.title} ${plan.notes} ${plan.date} ${plan.location}`.toLowerCase();
      return String(args.query || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 3)
        .some((token) => haystack.includes(token));
    });
    return {
      operation: 'search',
      query: args.query || '',
      profile: profileSnapshot(memory),
      results,
      matchingPlans: planMatches,
      summary:
        results[0]?.value ||
        'No matching household memory was found. I can save a new preference or plan.',
      revision: memory.meta.revision,
      speech: results.length
        ? `I found ${results.length} relevant household memories. ${results[0].value}`
        : 'I could not find a matching household memory yet.',
    };
  }

  if (operation === 'update') {
    const { memory, result } = store.updateMemory((draft) => {
      draft.household = draft.household || {};
      const updated = [];
      const updates = args.updates && typeof args.updates === 'object' ? args.updates : {};

      if (updates.preferences && typeof updates.preferences === 'object') {
        draft.household.preferences = {
          ...(draft.household.preferences || {}),
          ...updates.preferences,
        };
        updated.push('household.preferences');
      }
      if (updates.budgetCaps && typeof updates.budgetCaps === 'object') {
        draft.household.budgetCaps = {
          ...(draft.household.budgetCaps || {}),
          ...updates.budgetCaps,
        };
        updated.push('household.budgetCaps');
      }
      if (Array.isArray(updates.allergies)) {
        draft.household.allergies = updates.allergies;
        updated.push('household.allergies');
      }
      if (Array.isArray(updates.dietaryProfiles)) {
        draft.household.dietaryProfiles = updates.dietaryProfiles;
        updated.push('household.dietaryProfiles');
      }
      if (Array.isArray(updates.members)) {
        draft.household.members = mergeMembers(draft.household.members, updates.members);
        syncAllergyGraph(draft);
        updated.push('household.members');
      }

      let savedPlan = null;
      if (args.plan) {
        savedPlan = upsertPlan(draft, args.plan);
        if (savedPlan) updated.push('activePlans');
      }

      let savedFact = null;
      if (args.fact) {
        savedFact = upsertFact(draft, args.fact);
        if (savedFact) updated.push(`facts.${savedFact.key}`);
      }
      if (args.note) {
        savedFact = upsertFact(draft, {
          key: `note_${Date.now()}`,
          value: args.note,
          category: args.category || 'note',
          confidence: 0.9,
        });
        updated.push('facts');
      }

      return { updated, savedPlan, savedFact, profile: profileSnapshot(draft) };
    });

    const relevantFacts = rankFacts(
      memory.facts,
      args.query || args.plan?.title || args.note || '',
      5,
    );

    return {
      operation: 'update',
      updated: result.updated,
      profile: result.profile,
      plan: result.savedPlan,
      fact: result.savedFact,
      relevantFacts,
      revision: memory.meta.revision,
      updatedAt: memory.meta.updatedAt,
      speech:
        result.updated.length > 0
          ? `Saved ${result.updated.join(', ')} to persistent household memory.`
          : 'No memory fields were changed.',
      message: 'Cross-session memory updated.',
    };
  }

  if (operation === 'reset') {
    if (args.confirm !== true) {
      const error = new Error(
        'Refusing to reset household memory without confirm: true. This is a destructive operation.',
      );
      error.code = 'CONFIRMATION_REQUIRED';
      throw error;
    }
    const memory = store.resetMemory();
    return {
      operation: 'reset',
      reset: true,
      profile: profileSnapshot(memory),
      revision: memory.meta.revision,
      speech: 'Household memory has been reset to the demo seed state.',
      message: 'Persistent memory reset.',
    };
  }

  const error = new Error(
    `Unsupported memory operation "${operation}". Use get, search, update, or reset.`,
  );
  error.code = 'INVALID_OPERATION';
  throw error;
}

module.exports = {
  memoryGetOrUpdate,
  rankFacts,
  profileSnapshot,
  tokenize,
};
