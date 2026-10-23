'use strict';

const { getProduct, TAX_RATE } = require('./catalog');

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function buildSeedCartLine(sku, quantity) {
  const product = getProduct(sku);
  if (!product) throw new Error(`Unknown seed SKU: ${sku}`);
  return {
    lineId: `line_seed_${sku.toLowerCase()}`,
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    category: product.category,
    unit: product.unit,
    emoji: product.emoji,
    accent: product.accent,
    quantity,
    unitPrice: product.price,
    lineTotal: roundMoney(product.price * quantity),
    rating: product.rating,
    reviews: product.reviews,
    dietaryTags: product.dietaryTags,
    allergens: product.allergens,
    badges: product.dietaryTags.slice(0, 3),
    swapOptions: (product.substitutes || []).map((substituteSku) => {
      const substitute = getProduct(substituteSku);
      return {
        sku: substitute.sku,
        name: substitute.name,
        price: substitute.price,
        dietaryTags: substitute.dietaryTags,
      };
    }),
  };
}

function createSeedCart() {
  const items = [
    buildSeedCartLine('WF-TORT-GF-08', 2),
    buildSeedCartLine('WF-TORT-CORN-ORG', 1),
    buildSeedCartLine('AF-CHICKEN-THIGH', 1),
    buildSeedCartLine('WF-SALSA', 1),
    buildSeedCartLine('WF-LIME', 3),
  ];
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const tax = roundMoney(subtotal * TAX_RATE);
  const total = roundMoney(subtotal + tax);
  const budgetCap = 75;

  return {
    id: 'cart_demo_friday_taco_draft',
    merchant: 'Whole Foods Market',
    status: 'draft',
    occasion: 'Friday Taco Night',
    servings: 6,
    currency: 'USD',
    items,
    subtotal,
    tax,
    total,
    budgetCap,
    remainingBudget: roundMoney(budgetCap - total),
    budgetStatus: 'within',
    flags: [],
    verification: {
      passed: true,
      checkedAllergens: ['gluten'],
      blockedItems: [],
      message: 'All items verified against the household allergy graph. Ben-safe.',
    },
    changeLog: [],
    confirmationToken: 'vp_demo_friday_taco_draft',
    createdAt: '2026-10-23T16:04:00.000Z',
    updatedAt: '2026-10-23T16:04:00.000Z',
  };
}

function createSeedMemory() {
  const activeCart = createSeedCart();

  return {
    schemaVersion: '2025-11-25',
    seedVersion: '2026-10-23.1',
    meta: {
      revision: 1,
      createdAt: '2026-10-23T17:30:00.000Z',
      updatedAt: '2026-10-23T17:30:00.000Z',
      owner: 'LexaFlow',
      store: 'data/session_memory.json',
    },
    household: {
      id: 'hh_rivera_001',
      name: 'Rivera Household',
      primaryUser: 'Maya',
      timezone: 'America/Los_Angeles',
      location: 'Seattle, WA',
      members: [
        {
          id: 'maya',
          name: 'Maya',
          role: 'owner',
          dietary: ['vegetarian'],
          allergies: [],
          notes: 'Prefers organic produce and Latin jazz while cooking.',
        },
        {
          id: 'ben',
          name: 'Ben',
          role: 'child',
          dietary: ['gluten-free'],
          allergies: [{ allergen: 'gluten', severity: 'high' }],
          notes: 'High-severity gluten allergy. Never add products with a gluten allergen flag.',
        },
        {
          id: 'alex',
          name: 'Alex',
          role: 'partner',
          dietary: [],
          allergies: [],
          notes: 'Handles school pickup on Tuesdays and Thursdays.',
        },
      ],
      allergies: [
        {
          member: 'Ben',
          allergen: 'gluten',
          severity: 'high',
          verifiedAt: '2026-09-02T18:22:00.000Z',
        },
      ],
      dietaryProfiles: [
        { member: 'Maya', preference: 'vegetarian', source: 'voice preference' },
        { member: 'Ben', preference: 'gluten-free', source: 'pediatrician note' },
      ],
      budgetCaps: {
        groceryPerOrder: 75,
        monthlyGrocery: 320,
        recoveryKit: 25,
      },
      preferences: {
        music: 'Latin jazz, bossa nova',
        lighting: 'Warm amber after sunset',
        coffee: 'Oat milk lattes, Oatly Barista',
        store: 'Whole Foods Market for produce, Amazon Fresh for restocks',
        quietHours: '22:00-07:00',
      },
    },
    connectedDevices: [
      {
        id: 'echo-show-15',
        name: 'Kitchen Echo Show 15',
        type: 'echo',
        room: 'Kitchen',
        status: 'online',
        matter: true,
        state: { display: 'LexaFlow', volume: 5 },
      },
      {
        id: 'echo-dot-patio',
        name: 'Patio Echo Dot',
        type: 'echo',
        room: 'Patio',
        status: 'online',
        matter: false,
        state: { volume: 4 },
      },
      {
        id: 'hue-patio',
        name: 'Patio String Lights',
        type: 'matter-light',
        room: 'Patio',
        status: 'online',
        matter: true,
        state: { power: 'on', brightness: 30, color: 'Warm Amber', hex: '#ffb86b' },
      },
      {
        id: 'thermostat-bedroom',
        name: 'Bedroom Thermostat',
        type: 'matter-thermostat',
        room: 'Bedroom',
        status: 'online',
        matter: true,
        state: { targetTempF: 70, mode: 'auto', humidity: 41 },
      },
      {
        id: 'humidifier-bedroom',
        name: 'Bedroom Humidifier',
        type: 'matter-humidifier',
        room: 'Bedroom',
        status: 'online',
        matter: true,
        state: { power: 'off', level: 'low' },
      },
      {
        id: 'ring-doorbell',
        name: 'Front Door Ring',
        type: 'ring-doorbell',
        room: 'Entry',
        status: 'online',
        matter: false,
        state: { battery: 92, motion: 'clear', lastEvent: 'Package delivered · 2:14 PM' },
      },
      {
        id: 'ring-cam-backyard',
        name: 'Backyard Ring Cam',
        type: 'ring-camera',
        room: 'Backyard',
        status: 'online',
        matter: false,
        state: { battery: 78, motion: 'clear', lastEvent: 'No motion for 3 hours' },
      },
    ],
    scenes: [
      {
        id: 'scene_movie_dim',
        name: 'Movie Night Dim',
        room: 'Living Room',
        status: 'saved',
        schedule: null,
        devices: ['hue-patio'],
        state: { color: 'Deep Indigo', hex: '#4c4f9e', brightness: 18 },
        createdAt: '2026-09-14T20:12:00.000Z',
      },
      {
        id: 'scene_morning_kitchen',
        name: 'Good Morning Kitchen',
        room: 'Kitchen',
        status: 'active',
        schedule: { days: ['Weekdays'], time: '06:45' },
        devices: ['echo-show-15'],
        state: { briefing: true, volume: 4 },
        createdAt: '2026-08-30T14:05:00.000Z',
      },
    ],
    routines: [
      {
        id: 'routine_flight_wakeup',
        name: 'Flight Day Wake-Up',
        time: '06:00',
        days: ['Monday'],
        status: 'active',
        actions: ['Bedroom lights to 40%', 'Weather + traffic briefing', 'Flight status check'],
        updatedAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    activePlans: [
      {
        id: 'plan_friday_taco_night',
        title: 'Friday Taco Night',
        type: 'dinner',
        date: '2026-10-30',
        time: '18:30',
        guests: 6,
        status: 'confirmed',
        location: 'Patio',
        budgetCap: 75,
        dietaryConstraints: ['Gluten-free for Ben', 'Vegetarian option for Maya'],
        notes: 'Patio dinner with warm string lights and a Latin jazz playlist.',
        updatedAt: '2026-10-22T19:12:00.000Z',
      },
    ],
    commerce: {
      activeCart,
      lastOrder: null,
      orderHistory: [
        {
          id: 'ord_wf_20260926',
          merchant: 'Whole Foods Market',
          date: '2026-09-26',
          total: 42.18,
          itemCount: 7,
          occasion: 'Sunday family dinner',
          status: 'delivered',
        },
        {
          id: 'ord_af_20261010',
          merchant: 'Amazon Fresh',
          date: '2026-10-10',
          total: 28.74,
          itemCount: 5,
          occasion: 'Pantry restock',
          status: 'delivered',
        },
        {
          id: 'ord_af_20260912',
          merchant: 'Amazon Fresh',
          date: '2026-09-12',
          total: 23.63,
          itemCount: 4,
          occasion: 'Cold recovery kit',
          status: 'delivered',
        },
      ],
    },
    media: {
      queuedPlaylist: {
        id: 'playlist_latin_jazz_dinner',
        name: 'Latin Jazz Dinner Party',
        provider: 'Amazon Music',
        trackCount: 18,
        status: 'queued',
        updatedAt: '2026-10-22T19:12:00.000Z',
      },
      recentCarousels: [],
    },
    conversation: {
      summary:
        'The household planned Friday Taco Night for six, confirmed Ben needs strict gluten-free food, and left a draft taco cart ready for review.',
      turns: [
        {
          id: 'turn_seed_001',
          user: "Alexa, let's do Taco Night for six on Friday. Ben is gluten-free.",
          assistant:
            "Saved. Friday Taco Night for six is in your household plan. I'll keep every tortilla and seasoning gluten-free.",
          intent: 'planning',
          timestamp: '2026-10-22T19:12:00.000Z',
        },
        {
          id: 'turn_seed_002',
          user: "Alexa, what did we decide about Friday's dinner?",
          assistant:
            'Friday Taco Night for six at 6:30 PM on the patio, gluten-free for Ben, with a vegetarian option for Maya. Your draft cart is ready whenever you are.',
          intent: 'recall',
          timestamp: '2026-10-23T16:05:00.000Z',
        },
      ],
      lastUserUtterance: "Alexa, what did we decide about Friday's dinner?",
      lastAlexaResponse:
        'Friday Taco Night for six at 6:30 PM on the patio, gluten-free for Ben, with a vegetarian option for Maya. Your draft cart is ready whenever you are.',
      lastIntent: 'recall',
      updatedAt: '2026-10-23T16:05:00.000Z',
    },
    facts: [
      {
        id: 'fact_ben_gluten',
        key: 'ben_gluten_allergy',
        value:
          'Ben has a high-severity gluten allergy. Every bread, tortilla, and seasoning item must be certified gluten-free.',
        category: 'safety',
        confidence: 0.99,
        createdAt: '2026-08-12T17:10:00.000Z',
        confirmedAt: '2026-10-18T18:40:00.000Z',
      },
      {
        id: 'fact_maya_vegetarian',
        key: 'maya_vegetarian',
        value:
          'Maya prefers vegetarian meals. Group dinners should always include a plant-based protein option.',
        category: 'preference',
        confidence: 0.96,
        createdAt: '2026-08-12T17:12:00.000Z',
        confirmedAt: '2026-10-21T20:15:00.000Z',
      },
      {
        id: 'fact_friday_taco_night',
        key: 'friday_taco_night',
        value:
          'Friday Taco Night for six is planned for the patio at 6:30 PM, with warm string lights and a Latin jazz playlist.',
        category: 'plan',
        confidence: 0.98,
        createdAt: '2026-10-22T19:12:00.000Z',
        confirmedAt: '2026-10-22T19:12:00.000Z',
      },
      {
        id: 'fact_grocery_budget',
        key: 'grocery_budget',
        value:
          'Keep routine grocery orders under $75. The cold recovery kit has a strict $25 cap.',
        category: 'budget',
        confidence: 0.99,
        createdAt: '2026-09-04T16:00:00.000Z',
        confirmedAt: '2026-10-16T17:30:00.000Z',
      },
      {
        id: 'fact_flight',
        key: 'maya_flight',
        value:
          'Maya has an 8:00 AM flight to San Francisco on Monday. The household wants a 6:00 AM wake-up briefing with weather and traffic.',
        category: 'schedule',
        confidence: 0.94,
        createdAt: '2026-10-19T21:05:00.000Z',
        confirmedAt: '2026-10-19T21:05:00.000Z',
      },
      {
        id: 'fact_coffee',
        key: 'coffee_preference',
        value: 'The household prefers oat milk lattes using Oatly Barista oat milk.',
        category: 'preference',
        confidence: 0.88,
        createdAt: '2026-08-28T15:22:00.000Z',
        confirmedAt: '2026-09-30T14:10:00.000Z',
      },
    ],
  };
}

module.exports = { createSeedMemory, roundMoney };
