'use strict';

const store = require('./store');

const MUSIC_TRACKS = [
  {
    title: 'Café con Leche',
    artist: 'Luna Mar Trio',
    duration: '3:42',
    emoji: '☕',
    accent: '#00d4ff',
    tag: 'Bossa Nova',
  },
  {
    title: 'Trombone Sunset',
    artist: 'Río Azul Sextet',
    duration: '4:18',
    emoji: '🎺',
    accent: '#ff8a65',
    tag: 'Latin Jazz',
  },
  {
    title: 'Mambo in the Kitchen',
    artist: 'Casa Verde',
    duration: '3:05',
    emoji: '💃',
    accent: '#ffca28',
    tag: 'Mambo',
  },
  {
    title: 'Bossa for Six',
    artist: 'Maré Collective',
    duration: '4:51',
    emoji: '🎷',
    accent: '#7c5cff',
    tag: 'Bossa Nova',
  },
  {
    title: 'Patio Lanterns',
    artist: 'The Palma Session',
    duration: '3:36',
    emoji: '🏮',
    accent: '#ff7043',
    tag: 'Dinner Jazz',
  },
  {
    title: 'Ipanema Afterglow',
    artist: 'Sol & Saudade',
    duration: '5:02',
    emoji: '🌅',
    accent: '#4dd0e1',
    tag: 'Cool Jazz',
  },
];

const TACO_STEPS = [
  {
    title: 'Marinate the chicken',
    subtitle: 'Lime, gluten-free taco seasoning, and a little olive oil.',
    meta: 'Step 1 of 6 · 10 min',
    emoji: '🍗',
    accent: '#e07a5f',
    badge: 'Gluten-Free',
  },
  {
    title: 'Warm the corn shells',
    subtitle: 'Eight minutes in the oven at 350°F for a crisp bite.',
    meta: 'Step 2 of 6 · 8 min',
    emoji: '🌽',
    accent: '#f7b733',
    badge: 'Ben-Safe',
  },
  {
    title: 'Sauté the chorizo',
    subtitle: 'Plant-based chorizo for Maya, browned with diced onion.',
    meta: 'Step 3 of 6 · 6 min',
    emoji: '🌱',
    accent: '#7fb069',
    badge: 'Vegetarian',
  },
  {
    title: 'Build the salsa bar',
    subtitle: 'Avocado, cilantro, lime, salsa, and black beans.',
    meta: 'Step 4 of 6 · 5 min',
    emoji: '🥑',
    accent: '#6a994e',
    badge: 'Fresh',
  },
  {
    title: 'Set the patio table',
    subtitle: 'Warm amber lights at 45%, six places, Latin jazz on.',
    meta: 'Step 5 of 6 · 4 min',
    emoji: '🕯️',
    accent: '#ffb86b',
    badge: 'Ambience',
  },
  {
    title: 'Serve and enjoy',
    subtitle: 'Family-style shells, two proteins, and all the toppings.',
    meta: 'Step 6 of 6 · Dinner',
    emoji: '🌮',
    accent: '#00d4ff',
    badge: 'Serves 6',
  },
];

const RECOVERY_STEPS = [
  {
    title: 'Hydrate first',
    subtitle: 'One electrolyte packet in 16 oz of cold water.',
    meta: 'Step 1 of 5 · Now',
    emoji: '💧',
    accent: '#48cae4',
    badge: 'Recovery',
  },
  {
    title: 'Warm the soup',
    subtitle: 'Chicken & rice soup — gluten-free and easy on the stomach.',
    meta: 'Step 2 of 5 · 6 min',
    emoji: '🍲',
    accent: '#f4a261',
    badge: 'Gluten-Free',
  },
  {
    title: 'Brew ginger tea',
    subtitle: 'Add a spoon of wildflower honey when it is ready.',
    meta: 'Step 3 of 5 · 4 min',
    emoji: '🫖',
    accent: '#b7e4c7',
    badge: 'Soothing',
  },
  {
    title: 'Set a quiet alarm',
    subtitle: 'Lights low, humidifier on low, wake-up briefing at 6:00 AM.',
    meta: 'Step 4 of 5 · Tonight',
    emoji: '🌙',
    accent: '#7c5cff',
    badge: 'Rest',
  },
  {
    title: 'Pack the essentials',
    subtitle: 'Electrolytes, tissues, and vitamin C in your carry-on.',
    meta: 'Step 5 of 5 · 8 AM flight',
    emoji: '🧳',
    accent: '#00d4ff',
    badge: 'Flight Ready',
  },
];

const FLIGHT_BRIEFING = [
  {
    title: 'Seattle + San Francisco',
    subtitle: '52°F with light rain here. 64°F and sunny on arrival.',
    meta: 'Weather · Updated 5:55 AM',
    emoji: '🌤️',
    accent: '#4cc9f0',
    badge: 'Live',
  },
  {
    title: '26 min to Sea-Tac',
    subtitle: 'I-5 southbound is clear. Leave by 6:35 AM for an easy arrival.',
    meta: 'Traffic · Light',
    emoji: '🚗',
    accent: '#80ed99',
    badge: 'On Time',
  },
  {
    title: 'Flight AS 214 · On time',
    subtitle: 'Departs 8:00 AM from Gate B12. Boarding begins 7:25 AM.',
    meta: 'Alaska Airlines · Confirmed',
    emoji: '✈️',
    accent: '#7c5cff',
    badge: 'Gate B12',
  },
  {
    title: 'Carry-on checklist',
    subtitle: 'Electrolytes, tissues, vitamin C, charger, and your noise-cancelling headphones.',
    meta: 'Packing · 5 items',
    emoji: '🧳',
    accent: '#ffca28',
    badge: 'Ready',
  },
  {
    title: 'Hydration reminder',
    subtitle: 'Drink 16 oz of water before you leave and take the electrolyte packet with you.',
    meta: 'Wellness · Recovery plan',
    emoji: '💧',
    accent: '#48cae4',
    badge: 'Gentle',
  },
];

function deviceCards(memory) {
  const devices = (memory.connectedDevices || []).filter((device) =>
    /ring|thermostat|light|humidifier/i.test(device.type),
  );
  return devices.slice(0, 6).map((device, index) => {
    const state = device.state || {};
    let subtitle = 'Online and reporting normally.';
    let meta = `${device.room} · ${device.status}`;
    let badge = 'Online';
    let emoji = '🏠';
    let accent = '#00d4ff';

    if (device.type.includes('doorbell')) {
      subtitle = state.lastEvent || 'No recent events.';
      meta = `Battery ${state.battery ?? '—'}% · ${device.room}`;
      badge = 'Ring';
      emoji = '🔔';
      accent = '#4cc9f0';
    } else if (device.type.includes('camera')) {
      subtitle = state.lastEvent || 'Motion clear.';
      meta = `Battery ${state.battery ?? '—'}% · ${device.room}`;
      badge = 'Live Feed';
      emoji = '📹';
      accent = '#7c5cff';
    } else if (device.type.includes('thermostat')) {
      subtitle = `Target ${state.targetTempF ?? 70}°F · ${state.mode || 'auto'} · ${
        state.humidity ?? 42
      }% humidity`;
      meta = `${device.room} · Matter`;
      badge = 'Climate';
      emoji = '🌡️';
      accent = '#ff8a65';
    } else if (device.type.includes('light')) {
      subtitle = `${state.color || 'Warm White'} at ${state.brightness ?? 0}% brightness`;
      meta = `${device.room} · Matter`;
      badge = state.power === 'on' ? 'On' : 'Off';
      emoji = '💡';
      accent = '#ffca28';
    } else if (device.type.includes('humidifier')) {
      subtitle = `${state.level || 'low'} output · ${state.power || 'off'}`;
      meta = `${device.room} · Matter`;
      badge = 'Climate';
      emoji = '💨';
      accent = '#80ed99';
    }

    return {
      id: `device_card_${device.id || index}`,
      type: 'device',
      title: device.name,
      subtitle,
      meta,
      badges: [badge],
      emoji,
      accent,
      status: device.status,
      actions: [{ type: 'LiveView', label: 'View feed' }],
    };
  });
}

function carouselBase(type, title, subtitle, cards, speech, hint) {
  return {
    id: `carousel_${type}_${Date.now()}`,
    type: 'AlexaPlusCarousel',
    carouselType: type,
    header: {
      title,
      subtitle,
      count: cards.length,
    },
    cards,
    hint: hint || 'Swipe or scroll to explore',
    theme: {
      mode: 'dark',
      accent: type === 'music' ? '#7c5cff' : type === 'recipe' ? '#00d4ff' : '#4cc9f0',
    },
    speech,
    renderedAt: new Date().toISOString(),
  };
}

function buildMusicCarousel(args) {
  const requestedCount = Math.min(Math.max(Number(args.count) || 6, 3), MUSIC_TRACKS.length);
  const cards = MUSIC_TRACKS.slice(0, requestedCount).map((track, index) => ({
    id: `music_card_${index + 1}`,
    type: 'music',
    title: track.title,
    subtitle: track.artist,
    meta: `Amazon Music · ${track.duration}`,
    badges: [track.tag],
    emoji: track.emoji,
    accent: track.accent,
    actions: [
      { type: 'Play', label: 'Preview' },
      { type: 'Queue', label: 'Queue' },
    ],
  }));

  return carouselBase(
    'music',
    args.title || 'Latin Jazz Dinner Party',
    args.context
      ? `Curated for: ${args.context}`
      : 'Warm bossa nova and Latin jazz for a six-person patio dinner.',
    cards,
    `Queued the Latin Jazz Dinner Party playlist on Amazon Music. ${requestedCount} picks are on screen, starting with Café con Leche by Luna Mar Trio.`,
    'Tap a track to preview · 18 tracks queued',
  );
}

function buildRecipeCarousel(args) {
  const recovery = /recovery|cold|sick|flight|wellness/i.test(
    `${args.context || ''} ${args.title || ''}`,
  );
  const steps = recovery ? RECOVERY_STEPS : TACO_STEPS;
  const cards = steps.map((step, index) => ({
    id: `recipe_card_${index + 1}`,
    type: 'recipe',
    title: step.title,
    subtitle: step.subtitle,
    meta: step.meta,
    badges: [step.badge, 'Allergy Checked'],
    emoji: step.emoji,
    accent: step.accent,
    actions: [{ type: 'Select', label: index === 0 ? 'Start cooking' : 'Open step' }],
  }));

  return carouselBase(
    'recipe',
    args.title || (recovery ? 'Cold Recovery Ritual' : 'Gluten-Free Taco Night'),
    recovery
      ? 'A five-step recovery guide synced to your flight morning.'
      : 'Six visual steps, checked against Ben’s gluten-free profile.',
    cards,
    recovery
      ? 'I pulled up the five-step recovery ritual: hydrate, warm the soup, brew ginger tea, set a quiet alarm, then pack the essentials.'
      : 'I pulled up the six-step gluten-free taco guide. Step one: marinate the chicken with lime and gluten-free seasoning.',
    'Step-by-step guide · Allergen badges verified',
  );
}

function buildDeviceCarousel(args, memory) {
  const cards = deviceCards(memory);
  return carouselBase(
    'device',
    args.title || 'Home & Ring Camera Feeds',
    'Live Matter and Ring status from the rooms that matter tonight.',
    cards,
    `I pulled up ${cards.length} device feeds. Front Door Ring is online at ${
      memory.connectedDevices?.find((device) => device.id === 'ring-doorbell')?.state?.battery ?? 92
    } percent battery, and the backyard is clear.`,
    'Live status · Tap a tile for the feed',
  );
}

function buildRoutineCarousel(args) {
  const cards = FLIGHT_BRIEFING.map((card, index) => ({
    id: `routine_card_${index + 1}`,
    type: 'routine',
    title: card.title,
    subtitle: card.subtitle,
    meta: card.meta,
    badges: [card.badge],
    emoji: card.emoji,
    accent: card.accent,
    actions: [{ type: 'Select', label: index === 2 ? 'Open boarding pass' : 'Open card' }],
  }));

  return carouselBase(
    'routine',
    args.title || '6:00 AM Flight Wake-Up Briefing',
    'Weather, traffic, flight status, and a gentle recovery checklist.',
    cards,
    'Your 6 AM flight briefing is ready: 52 degrees with light rain, 26 minutes to Sea-Tac, and flight AS 214 is on time at gate B12.',
    'Briefing will speak at 6:00 AM · Monday',
  );
}

function inferType(args) {
  const text = `${args.type || ''} ${args.context || ''} ${args.title || ''}`.toLowerCase();
  if (/routine|briefing|flight|wake|morning/.test(text)) return 'routine';
  if (/music|playlist|jazz|song|track|audio/.test(text)) return 'music';
  if (/recipe|steps|how to|guide|cook|taco night|recovery ritual/.test(text)) return 'recipe';
  if (/device|camera|ring|feed|security|status/.test(text)) return 'device';
  return 'music';
}

function persistMedia(carousel, playlist) {
  store.updateMemory((draft) => {
    draft.media = draft.media || {};
    const recent = Array.isArray(draft.media.recentCarousels) ? draft.media.recentCarousels : [];
    draft.media.recentCarousels = [
      ...recent,
      {
        id: carousel.id,
        type: carousel.carouselType,
        title: carousel.header.title,
        cardCount: carousel.cards.length,
        renderedAt: carousel.renderedAt,
      },
    ].slice(-8);
    if (playlist) draft.media.queuedPlaylist = playlist;
  });
}

function mediaRenderMultimodalCarousel(args = {}) {
  const action = String(args.action || 'render').toLowerCase();
  const memory = store.readMemory();

  if (action === 'list') {
    return {
      action: 'list',
      types: ['music', 'recipe', 'device', 'routine'],
      recentCarousels: memory.media?.recentCarousels || [],
      queuedPlaylist: memory.media?.queuedPlaylist || null,
      message: 'Four carousel renderers are available.',
      speech: 'I can render music, recipe, device, and routine carousels.',
    };
  }

  const type = String(args.type || 'auto').toLowerCase() === 'auto'
    ? inferType(args)
    : String(args.type || 'music').toLowerCase();

  let carousel;
  let playlist = null;

  if (type === 'recipe') {
    carousel = buildRecipeCarousel(args);
  } else if (type === 'device') {
    carousel = buildDeviceCarousel(args, memory);
  } else if (type === 'routine') {
    carousel = buildRoutineCarousel(args);
  } else if (type === 'music') {
    carousel = buildMusicCarousel(args);
    playlist = {
      id: 'playlist_latin_jazz_dinner',
      name: carousel.header.title,
      provider: 'Amazon Music',
      trackCount: 18,
      status: 'queued',
      updatedAt: new Date().toISOString(),
    };
  } else {
    const error = new Error(
      `Unsupported carousel type "${type}". Use music, recipe, device, routine, or auto.`,
    );
    error.code = 'INVALID_OPERATION';
    throw error;
  }

  persistMedia(carousel, playlist);

  return {
    action: 'render',
    type,
    carousel,
    carousels: [carousel],
    playlist,
    cardCount: carousel.cards.length,
    title: carousel.header.title,
    message: `Rendered the ${carousel.header.title} ${type} carousel with ${carousel.cards.length} cards.`,
    speech: carousel.speech,
    hint: carousel.hint,
  };
}

module.exports = { mediaRenderMultimodalCarousel };
