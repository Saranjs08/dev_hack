'use strict';

/* ==========================================================================
   LexaFlow frontend — Echo Show simulator + live MCP telemetry inspector
   ========================================================================== */

const DEFAULT_SCENARIOS = [
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
    title: 'Sick Day + 8 AM Flight',
    subtitle: 'Climate · Recovery Kit · Wake-up Briefing',
    icon: '🌧️',
    accent: '#7c5cff',
    badge: 'Budget guardrail',
    prompt:
      "Alexa, I'm feeling under the weather and have an 8 AM flight—adjust bedroom climate, reorder my cold recovery kit under $25, and set a wake-up briefing.",
  },
  {
    id: 'recall-swap',
    title: 'Recall + Swap Tortillas',
    subtitle: 'Memory recall · Cart mutation · Persistence',
    icon: '🧠',
    accent: '#ff8a65',
    badge: 'Cross-session',
    prompt:
      "Alexa, what did we decide about Friday's dinner, and swap the tortillas for organic corn shells.",
  },
];

const SERVICE_COLORS = {
  agent: '#7c5cff',
  memory: '#ff5ccf',
  commerce: '#5ee6a8',
  smarthome: '#ff8a65',
  media: '#00d4ff',
  voice: '#ffca62',
  mcp: '#8ea7d8',
};

const SERVICE_ICONS = {
  agent: '✦',
  memory: '🧠',
  commerce: '🛒',
  smarthome: '💡',
  media: '🎛️',
  voice: '🔊',
  mcp: '◇',
};

const CAROUSEL_META = {
  music: { kicker: 'Now queued', icon: '♫', hint: 'Tap a track to preview' },
  recipe: { kicker: 'Recipe guide', icon: '◉', hint: 'Step-by-step · allergy checked' },
  device: { kicker: 'Live home', icon: '◈', hint: 'Matter + Ring feeds' },
  routine: { kicker: 'Morning briefing', icon: '☼', hint: 'Scheduled for 6:00 AM' },
};

const state = {
  scenarios: DEFAULT_SCENARIOS,
  runtime: null,
  memory: null,
  telemetry: [],
  carousels: [],
  dag: [],
  lastMeta: null,
  filter: 'all',
  activeTab: 'stream',
  autoScroll: true,
  busy: false,
  checkoutBusy: false,
  muted: false,
  speaking: false,
  listening: false,
  recognition: null,
  sessionId: `web_${Math.random().toString(36).slice(2, 10)}`,
  purchaseSuccess: null,
  expandedFrames: new Set(),
  rawVisible: false,
  voices: [],
  sseConnected: false,
  helloShown: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const dom = {};

function cacheDom() {
  dom.echoScreen = $('#echoScreen');
  dom.conversation = $('#conversation');
  dom.scenarioStrip = $('#scenarioStrip');
  dom.chatForm = $('#chatForm');
  dom.chatInput = $('#chatInput');
  dom.sendBtn = $('#sendBtn');
  dom.micBtn = $('#micBtn');
  dom.micSupport = $('#micSupport');
  dom.voiceState = $('#voiceState');
  dom.waveform = $('#waveform');
  dom.carouselArea = $('#carouselArea');
  dom.commerceArea = $('#commerceArea');
  dom.multimodal = $('#multimodal');
  dom.bedrockChip = $('#bedrockChip');
  dom.bedrockMode = $('#bedrockMode');
  dom.muteBtn = $('#muteBtn');
  dom.resetBtn = $('#resetBtn');
  dom.memoryReset = $('#memoryReset');
  dom.streamList = $('#streamList');
  dom.streamCount = $('#streamCount');
  dom.streamStats = $('#streamStats');
  dom.panelStream = $('#panel-stream');
  dom.memoryGraph = $('#memoryGraph');
  dom.memoryRaw = $('#memoryRaw');
  dom.memoryRevision = $('#memoryRevision');
  dom.rawToggle = $('#rawToggle');
  dom.dagSummary = $('#dagSummary');
  dom.dagList = $('#dagList');
  dom.latencyFoot = $('#latencyFoot');
  dom.autoScroll = $('#autoScroll');
  dom.toasts = $('#toasts');
  dom.confirmModal = $('#confirmModal');
  dom.cancelReset = $('#cancelReset');
  dom.confirmReset = $('#confirmReset');
  dom.speechHint = $('#speechHint');
  dom.bigClock = $('#bigClock');
  dom.bigDate = $('#bigDate');
  dom.stageTime = $('#stageTime');
  dom.stageDate = $('#stageDate');
}

/* ==========================================================================
   Utilities
   ========================================================================== */

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeColor(value, fallback = '#00d4ff') {
  return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? value : fallback;
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function shortId(value) {
  const raw = String(value === undefined || value === null ? '—' : value);
  if (raw.length <= 14) return raw;
  return `${raw.slice(0, 10)}…`;
}

function formatClock(date = new Date()) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatLongDate(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function formatStageDate(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatIsoDate(value) {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function timeOnly(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightJson(value) {
  let json;
  try {
    json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch (_) {
    json = String(value);
  }
  if (json === undefined) json = 'null';

  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let className = 'json-number';
      if (/^"/.test(match)) {
        className = /:$/.test(match.trim()) ? 'json-key' : 'json-string';
      } else if (/^(true|false)$/.test(match)) {
        className = 'json-boolean';
      } else if (match === 'null') {
        className = 'json-null';
      }
      return `<span class="${className}">${match}</span>`;
    },
  );
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* ==========================================================================
   Toasts
   ========================================================================== */

function toast(message, type = 'info', duration = 4200) {
  const icons = { success: '✓', error: '!', warning: '!', info: '✦' };
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `
    <span class="toast-icon">${icons[type] || '✦'}</span>
    <span class="toast-copy"></span>
  `;
  element.querySelector('.toast-copy').textContent = String(message);
  dom.toasts.appendChild(element);
  setTimeout(() => {
    element.classList.add('is-leaving');
    setTimeout(() => element.remove(), 280);
  }, duration);
}

/* ==========================================================================
   Voice output
   ========================================================================== */

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  state.voices = window.speechSynthesis.getVoices() || [];
}

function pickVoice() {
  if (!state.voices.length) return null;
  const preferred = [
    /Google US English/i,
    /Microsoft Aria/i,
    /Samantha/i,
    /Microsoft Jenny/i,
    /zira/i,
  ];
  for (const pattern of preferred) {
    const found = state.voices.find(
      (voice) => pattern.test(voice.name) && /^en/i.test(voice.lang),
    );
    if (found) return found;
  }
  return state.voices.find((voice) => /^en[-_]US/i.test(voice.lang)) || state.voices[0];
}

function setActivity(mode, label) {
  dom.echoScreen.classList.remove('is-speaking', 'is-listening', 'is-thinking');
  if (mode) dom.echoScreen.classList.add(`is-${mode}`);
  if (label) {
    dom.voiceState.innerHTML = `<span class="voice-dot"></span> ${escapeHtml(label)}`;
  }
}

function speak(text) {
  if (!('speechSynthesis' in window) || state.muted) return;
  const clean = String(text || '')
    .replace(/[✦◈▶♫◉☼]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
  if (!clean) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang || 'en-US';
  utterance.rate = 1.02;
  utterance.pitch = 1.02;
  utterance.volume = 1;

  utterance.onstart = () => {
    state.speaking = true;
    setActivity('speaking', 'Speaking');
  };
  utterance.onend = () => {
    state.speaking = false;
    if (!state.busy && !state.listening) setActivity(null, 'Ready');
  };
  utterance.onerror = () => {
    state.speaking = false;
    if (!state.busy && !state.listening) setActivity(null, 'Ready');
  };
  window.speechSynthesis.speak(utterance);
}

function initMute() {
  const stored = localStorage.getItem('lexaflow.muted');
  state.muted = stored === 'true';
  updateMuteButton();
  dom.muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    localStorage.setItem('lexaflow.muted', String(state.muted));
    updateMuteButton();
    if (state.muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    toast(state.muted ? 'Alexa voice output muted.' : 'Alexa voice output on.', 'info', 2200);
  });
}

function updateMuteButton() {
  dom.muteBtn.setAttribute('aria-pressed', String(state.muted));
  dom.muteBtn.setAttribute(
    'aria-label',
    state.muted ? 'Unmute Alexa voice output' : 'Mute Alexa voice output',
  );
  dom.muteBtn.title = state.muted ? 'Unmute voice output' : 'Mute voice output';
}

/* ==========================================================================
   Conversation
   ========================================================================== */

function addMessage(role, text, options = {}) {
  const message = document.createElement('div');
  message.className = `msg msg-${role === 'user' ? 'user' : 'alexa'}`;
  const label = role === 'user' ? 'You' : 'Alexa+';
  message.innerHTML = `
    <div class="msg-meta">
      ${role === 'user' ? '' : '<span class="msg-spark" aria-hidden="true"></span>'}
      <span>${label}</span>
      ${options.tag ? `<span class="msg-tag">${escapeHtml(options.tag)}</span>` : ''}
    </div>
    <div class="msg-bubble"></div>
  `;
  message.querySelector('.msg-bubble').textContent = String(text || '');
  dom.conversation.appendChild(message);

  while (dom.conversation.children.length > 8) {
    dom.conversation.firstElementChild.remove();
  }
  dom.conversation.scrollTop = dom.conversation.scrollHeight;
  return message;
}

function addThinking() {
  const message = document.createElement('div');
  message.className = 'msg msg-alexa msg-thinking';
  message.id = 'thinkingMessage';
  message.innerHTML = `
    <div class="msg-meta">
      <span class="msg-spark" aria-hidden="true"></span>
      <span>Alexa+</span>
    </div>
    <div class="msg-bubble" aria-label="Alexa is thinking">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>
  `;
  dom.conversation.appendChild(message);
  dom.conversation.scrollTop = dom.conversation.scrollHeight;
  return message;
}

function removeThinking() {
  const existing = $('#thinkingMessage');
  if (existing) existing.remove();
}

function addWelcome() {
  addMessage(
    'alexa',
    'Hi Maya. Friday Taco Night for six is confirmed, and your draft Whole Foods cart is ready. Tap a scenario above, use the mic, or ask me to orchestrate something.',
  );
}

/* ==========================================================================
   Chat orchestration
   ========================================================================== */

function setBusy(busy) {
  state.busy = busy;
  dom.sendBtn.disabled = busy;
  dom.micBtn.disabled = busy;
  $$('.scenario-card').forEach((button) => {
    button.disabled = busy;
  });
  if (busy) {
    setActivity('thinking', 'Orchestrating');
  } else if (!state.speaking && !state.listening) {
    setActivity(null, 'Ready');
  }
}

async function submitMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || state.busy) return;

  if (state.listening && state.recognition) {
    try {
      state.recognition.abort();
    } catch (_) {
      /* noop */
    }
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  state.speaking = false;
  state.purchaseSuccess = null;

  addMessage('user', text);
  addThinking();
  dom.chatInput.value = '';
  setBusy(true);

  try {
    const data = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, sessionId: state.sessionId }),
    });

    removeThinking();
    addMessage('alexa', data.reply, { tag: data.source === 'bedrock' ? 'Bedrock' : 'Fallback' });

    applyStateSnapshot(data);
    if (Array.isArray(data.carousels) && data.carousels.length) {
      renderCarousels(data.carousels, { replace: true });
    }
    renderCommerce(
      data.cart || data.commerce?.cart || data.state?.commerce?.activeCart,
      data.commerce?.purchase || data.purchase,
      data.commerce?.verification || data.cart?.verification,
    );
    renderDag(data.dag || [], data);
    dom.latencyFoot.textContent = `${data.latencyMs || 0} ms`;

    if (data.fallbackReason) {
      toast('Bedrock was unavailable, so the Smart Agentic Fallback completed the workflow.', 'warning', 5000);
    }

    speak(data.reply);
  } catch (error) {
    removeThinking();
    addMessage(
      'alexa',
      'I hit a snag while orchestrating that request. The server is still running — please try again or reset the demo state.',
    );
    toast(error.message || 'The request failed.', 'error', 6000);
    setActivity(null, 'Ready');
  } finally {
    setBusy(false);
    dom.chatInput.focus();
  }
}

/* ==========================================================================
   Scenarios
   ========================================================================== */

function renderScenarios(scenarios) {
  const list = Array.isArray(scenarios) && scenarios.length ? scenarios : DEFAULT_SCENARIOS;
  state.scenarios = list;
  dom.scenarioStrip.innerHTML = list
    .map(
      (scenario) => `
      <button
        class="scenario-card"
        type="button"
        style="--accent:${safeColor(scenario.accent)}"
        data-prompt="${escapeHtml(scenario.prompt)}"
        title="${escapeHtml(scenario.prompt)}"
      >
        <span class="scenario-icon" aria-hidden="true">${escapeHtml(scenario.icon || '✦')}</span>
        <span class="scenario-copy">
          <span class="scenario-title">${escapeHtml(scenario.title)}</span>
          <span class="scenario-sub">${escapeHtml(scenario.subtitle || '')}</span>
        </span>
      </button>
    `,
    )
    .join('');
}

/* ==========================================================================
   Commerce card
   ========================================================================== */

function cartItemBadges(item) {
  const tags = (item.dietaryTags || []).slice(0, 2);
  if (!tags.length) return '';
  return `
    <div class="item-tags">
      ${tags.map((tag) => `<span class="item-tag">${escapeHtml(tag)}</span>`).join('')}
    </div>
  `;
}

function renderCommerce(cart, purchase, verification) {
  if (state.purchaseSuccess) {
    const order = state.purchaseSuccess;
    dom.commerceArea.innerHTML = `
      <div class="purchase-card">
        <div class="purchase-success">
          <span class="success-icon" aria-hidden="true">✓</span>
          <div>
            <h3>Order confirmed with Alexa+</h3>
            <p>${escapeHtml(order.itemCount || 0)} items · ${money(order.total)} · ${escapeHtml(
              order.merchant || '',
            )} · ${escapeHtml(order.eta || 'On the way')}</p>
            <p class="order-id">${escapeHtml(order.id || '')}</p>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
    dom.commerceArea.innerHTML = `
      <div class="empty-cart">
        <span class="emoji" aria-hidden="true">🛒</span>
        <span>Your cart is empty. Tap the Taco Night scenario to build an allergy-checked cart.</span>
      </div>
    `;
    return;
  }

  const items = cart.items;
  const verify = verification || cart.verification || { passed: true, message: 'Allergy verified.' };
  const token =
    purchase?.confirmationToken ||
    cart.purchase?.confirmationToken ||
    cart.confirmationToken ||
    null;
  const budgetCap = Number(cart.budgetCap) || 75;
  const total = Number(cart.total) || 0;
  const percent = Math.min(100, Math.round((total / budgetCap) * 100));
  const over = total > budgetCap;
  const firstFlag = (cart.flags || [])[0];
  const ready = Boolean(token && items.length);

  dom.commerceArea.innerHTML = `
    <div class="purchase-card">
      <div class="purchase-head">
        <span class="merchant-logo" aria-hidden="true">${escapeHtml(
          (cart.merchant || 'WF')
            .split(/\s+/)
            .map((word) => word[0])
            .join('')
            .slice(0, 2),
        )}</span>
        <div class="purchase-title-wrap">
          <div class="purchase-kicker"><span aria-hidden="true">◉</span> Voice purchasing card</div>
          <h3 class="purchase-title">${escapeHtml(cart.occasion || cart.recipe?.name || 'Household cart')}</h3>
          <p class="purchase-merchant">${escapeHtml(cart.merchant || '')} · ${items.length} items · ${
            cart.servings || 0
          } servings</p>
        </div>
        <div class="purchase-badges">
          <span class="badge ${verify.passed ? 'green' : 'amber'}">${
            verify.passed ? '✓ Allergy verified' : 'Review needed'
          }</span>
          <span class="badge ${over ? 'amber' : 'accent'}">${over ? 'Over budget' : 'Within budget'}</span>
        </div>
      </div>

      <div class="verify-strip ${verify.passed ? '' : 'is-warning'}">
        <span class="verify-icon" aria-hidden="true">${verify.passed ? '✓' : '!'}</span>
        <span>${escapeHtml(verify.message || 'Dietary guardrails applied.')}</span>
      </div>
      ${
        firstFlag
          ? `<div class="verify-strip is-warning"><span class="verify-icon" aria-hidden="true">!</span><span>${escapeHtml(
              firstFlag,
            )}</span></div>`
          : ''
      }

      <div class="cart-items" aria-label="Cart items">
        ${items
          .map((item) => {
            const swap = (item.swapOptions || [])[0];
            return `
              <div class="cart-item">
                <span class="item-art" style="--accent:${safeColor(item.accent)}" aria-hidden="true">${escapeHtml(
                  item.emoji || '🛒',
                )}</span>
                <div class="item-main">
                  <div class="item-name">${escapeHtml(item.name)}</div>
                  <div class="item-brand">${escapeHtml(item.brand || '')} · ${escapeHtml(item.unit || '')}</div>
                  ${cartItemBadges(item)}
                </div>
                <div class="item-value">
                  <span class="item-price">${money(item.lineTotal)}</span>
                  <span class="item-qty">×${item.quantity || 1}</span>
                  ${
                    swap
                      ? `<button class="swap-btn" type="button" data-swap-from="${escapeHtml(
                          item.sku,
                        )}" data-swap-to="${escapeHtml(swap.sku)}" title="Swap for ${escapeHtml(
                          swap.name,
                        )}">Swap</button>`
                      : ''
                  }
                </div>
              </div>
            `;
          })
          .join('')}
      </div>

      <div class="purchase-foot">
        <div class="totals">
          <div class="total-row"><span>Subtotal</span><span>${money(cart.subtotal)}</span></div>
          <div class="total-row"><span>Estimated tax</span><span>${money(cart.tax)}</span></div>
          <div class="total-row grand"><span>Alexa+ total</span><span>${money(total)}</span></div>
        </div>
        <div class="budget-meter">
          <div class="budget-labels ${over ? 'is-over' : ''}">
            <span>${money(total)} of ${money(budgetCap)} cap</span>
            <strong>${over ? `${money(total - budgetCap)} over` : `${money(budgetCap - total)} left`}</strong>
          </div>
          <div class="budget-track">
            <div class="budget-fill ${over ? 'is-over' : ''}" style="width:${percent}%"></div>
          </div>
        </div>
        <button
          class="confirm-btn"
          type="button"
          data-action="confirm-purchase"
          data-cart-id="${escapeHtml(cart.id || '')}"
          data-token="${escapeHtml(token || '')}"
          ${ready ? '' : 'disabled'}
        >
          <span aria-hidden="true">🔒</span>
          Confirm Alexa+ Voice Purchase
        </button>
        <p class="purchase-note">Simulated checkout · explicit confirmation required · demo data only</p>
      </div>
    </div>
  `;
}

async function handlePurchase(button) {
  if (state.checkoutBusy) return;
  const cartId = button.dataset.cartId;
  const token = button.dataset.token;
  if (!cartId || !token) {
    toast('This cart has no valid confirmation token. Rebuild it first.', 'warning');
    return;
  }

  state.checkoutBusy = true;
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Confirming with Amazon Pay…';
  setActivity('thinking', 'Checking out');

  try {
    const data = await apiFetch('/api/purchase/confirm', {
      method: 'POST',
      body: JSON.stringify({
        cartId,
        confirmationToken: token,
        channel: 'ui_tap',
        sessionId: state.sessionId,
      }),
    });

    state.purchaseSuccess = data.order;
    state.memory = data.memory || data.state || state.memory;
    renderCommerce(data.cart, null, null);
    renderMemory();
    mergeTelemetry(data.telemetry || []);
    renderStream();
    renderStreamStats();
    addMessage('alexa', data.speech || 'Purchase confirmed.', { tag: 'Checkout' });
    speak(data.speech);
    toast(`Order ${data.order.id} confirmed · ${money(data.order.total)}`, 'success', 5200);
  } catch (error) {
    button.disabled = false;
    button.innerHTML = original;
    toast(error.message || 'Checkout failed.', 'error', 6000);
    setActivity(null, 'Ready');
  } finally {
    state.checkoutBusy = false;
  }
}

async function handleSwap(button) {
  const from = button.dataset.swapFrom;
  const to = button.dataset.swapTo;
  if (!from || !to) return;
  button.disabled = true;
  button.textContent = 'Swapping…';

  try {
    const data = await apiFetch('/api/cart/update', {
      method: 'POST',
      body: JSON.stringify({ action: 'swap', from, to, sessionId: state.sessionId }),
    });
    state.memory = data.state || state.memory;
    state.purchaseSuccess = null;
    renderCommerce(data.cart, data.purchase, data.verification);
    renderMemory();
    mergeTelemetry(data.telemetry || []);
    renderStream();
    renderStreamStats();
    addMessage('alexa', data.speech || 'Cart updated.', { tag: 'Cart mutation' });
    speak(data.speech);
    toast(data.mutation?.description || 'Cart item swapped.', 'success');
    setActivity(null, 'Ready');
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Swap';
    toast(error.message || 'Could not swap that item.', 'error');
  }
}

/* ==========================================================================
   Local state snapshot merge
   ========================================================================== */

function mergeTelemetry(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return;
  const byId = new Map(state.telemetry.map((frame) => [frame.frameId, frame]));
  for (const frame of frames) {
    if (frame && frame.frameId) byId.set(frame.frameId, frame);
  }
  state.telemetry = [...byId.values()]
    .sort((a, b) => {
      const timeDiff = Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0);
      return timeDiff || (a.seq || 0) - (b.seq || 0);
    })
    .slice(-120);
}

function applyStateSnapshot(data) {
  if (!data) return;
  if (data.state) state.memory = data.state;
  if (data.memory) state.memory = data.memory;
  if (data.runtime) state.runtime = data.runtime;
  if (data.bedrock) state.runtime = data.bedrock;
  mergeTelemetry(data.telemetry || []);
  renderMemory();
  renderStream();
  renderStreamStats();
  updateRuntime(state.runtime);
}

/* ==========================================================================
   Multimodal carousel rendering
   ========================================================================== */

function renderCarousels(carousels, options = {}) {
  const incoming = (Array.isArray(carousels) ? carousels : []).filter(
    (carousel) => carousel && Array.isArray(carousel.cards) && carousel.cards.length,
  );

  if (options.replace) {
    state.carousels = [];
  }

  for (const carousel of incoming) {
    const duplicate = state.carousels.some(
      (existing) =>
        existing.id === carousel.id ||
        (existing.carouselType === carousel.carouselType &&
          existing.header?.title === carousel.header?.title),
    );
    if (!duplicate) state.carousels.push(carousel);
  }

  state.carousels = state.carousels.slice(-4);
  renderCarouselBlocks();
}

function mediaActionGlyph(kind, index) {
  if (kind === 'music') return '▶';
  if (kind === 'recipe') return String(index + 1);
  if (kind === 'routine') return '☼';
  return '◈';
}

function mediaCardHtml(card, index, kind) {
  const accent = safeColor(card.accent || card.color);
  const badges = (card.badges || card.dietaryTags || []).slice(0, 3);
  return `
    <article
      class="media-card"
      style="--accent:${accent}"
      data-card-title="${escapeHtml(card.title || 'Card')}"
      data-card-kind="${escapeHtml(kind)}"
      tabindex="0"
      role="button"
      aria-label="${escapeHtml(card.title || 'Multimodal card')}"
    >
      <div class="media-art">
        <span class="media-emoji" aria-hidden="true">${escapeHtml(card.emoji || '✦')}</span>
        <span class="play-glyph" aria-hidden="true">${mediaActionGlyph(kind, index)}</span>
      </div>
      <div class="media-title">${escapeHtml(card.title || '')}</div>
      <div class="media-sub">${escapeHtml(card.subtitle || '')}</div>
      ${
        badges.length
          ? `<div class="badge-row">${badges
              .map((badge) => `<span class="badge accent">${escapeHtml(badge)}</span>`)
              .join('')}</div>`
          : ''
      }
      <div class="media-meta">${escapeHtml(card.meta || '')}</div>
    </article>
  `;
}

function carouselBlockHtml(carousel) {
  const kind = carousel.carouselType || 'music';
  const meta = CAROUSEL_META[kind] || CAROUSEL_META.music;
  const accent = safeColor(carousel.theme?.accent, '#00d4ff');
  return `
    <section class="carousel-block" style="--accent:${accent}" aria-label="${escapeHtml(
      carousel.header?.title || 'Carousel',
    )}">
      <div class="carousel-head">
        <div class="carousel-heading">
          <div class="carousel-kicker"><span aria-hidden="true">${meta.icon}</span> ${escapeHtml(
            meta.kicker,
          )} · ${escapeHtml(kind)}</div>
          <h3 class="carousel-title">${escapeHtml(carousel.header?.title || 'Echo Show carousel')}</h3>
          <p class="carousel-sub">${escapeHtml(carousel.header?.subtitle || '')}</p>
        </div>
        <span class="carousel-hint">${escapeHtml(carousel.hint || meta.hint)}</span>
      </div>
      <div class="carousel-track" role="list">
        ${carousel.cards.map((card, index) => mediaCardHtml(card, index, kind)).join('')}
      </div>
    </section>
  `;
}

function renderCarouselBlocks() {
  if (!state.carousels.length) {
    dom.carouselArea.innerHTML = `
      <div class="empty-showcase">
        <span class="empty-icon" aria-hidden="true">✦</span>
        <div>
          <strong>Echo Show display is ready</strong>
          Ask for a playlist, a recipe guide, or the Ring camera feeds — cards will render here.
        </div>
      </div>
    `;
    return;
  }
  dom.carouselArea.innerHTML = state.carousels.map(carouselBlockHtml).join('');
}

/* ==========================================================================
   Household memory graph
   ========================================================================== */

function memberInitials(name) {
  return String(name || '?')
    .split(/\s+/)
    .map((part) => part[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function renderMemory() {
  const memory = state.memory;
  if (!dom.memoryRevision || !dom.memoryGraph) return;

  if (!memory || !memory.household) {
    dom.memoryRevision.textContent = 'revision —';
    dom.memoryGraph.innerHTML = `
      <div class="mem-card wide">
        <div class="mem-label"><span class="mem-icon">◌</span> Loading</div>
        <p class="mem-text">Connecting to persistent household memory in data/session_memory.json…</p>
      </div>
    `;
    return;
  }

  const household = memory.household || {};
  const members = Array.isArray(household.members) ? household.members : [];
  const allergies = Array.isArray(household.allergies) ? household.allergies : [];
  const caps = household.budgetCaps || {};
  const devices = Array.isArray(memory.connectedDevices) ? memory.connectedDevices : [];
  const plans = Array.isArray(memory.activePlans) ? memory.activePlans : [];
  const cart = memory.commerce?.activeCart || null;
  const conversation = memory.conversation || {};
  const preferences = household.preferences || {};
  const revision = memory.meta?.revision ?? '—';

  dom.memoryRevision.textContent = `revision ${revision} · ${formatDateTime(memory.meta?.updatedAt)}`;
  dom.memoryRaw.innerHTML = highlightJson(memory);

  const memberRows = members
    .map((member, index) => {
      const accents = ['#00d4ff', '#7c5cff', '#ff8a65'];
      const allergyTags = (member.allergies || []).map((allergy) => {
        if (typeof allergy === 'string') {
          return `<span class="member-tag alert">⚠ ${escapeHtml(allergy)}</span>`;
        }
        return `<span class="member-tag alert">⚠ ${escapeHtml(allergy.allergen || 'allergy')} · ${escapeHtml(
          allergy.severity || 'high',
        )}</span>`;
      });
      return `
        <div class="member-row">
          <span class="member-avatar" style="--accent:${accents[index % accents.length]}">${escapeHtml(
            memberInitials(member.name),
          )}</span>
          <div class="member-copy">
            <div class="member-name">${escapeHtml(member.name || 'Member')} <span class="member-tag">${escapeHtml(
              member.role || 'member',
            )}</span></div>
            <div class="member-tags">
              ${(member.dietary || [])
                .map((diet) => `<span class="member-tag">${escapeHtml(diet)}</span>`)
                .join('')}
              ${allergyTags.join('')}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  const allergyTags = allergies
    .map(
      (entry) => `
      <span class="tag orange">⚠ ${escapeHtml(entry.member || 'Household')}: ${escapeHtml(
        entry.allergen || 'allergen',
      )} · ${escapeHtml(entry.severity || 'high')}</span>
    `,
    )
    .join('');

  const budgetRows = [
    ['Grocery / order', Number(caps.groceryPerOrder) || 75],
    ['Monthly grocery', Number(caps.monthlyGrocery) || 320],
    ['Recovery kit', Number(caps.recoveryKit) || 25],
  ]
    .map(([label, value]) => {
      const percent = Math.max(8, Math.min(100, Math.round((value / 320) * 100)));
      return `
        <div class="budget-item">
          <div class="budget-item-line"><span>${escapeHtml(label)}</span><strong>${money(value)}</strong></div>
          <div class="mini-meter"><span style="width:${percent}%"></span></div>
        </div>
      `;
    })
    .join('');

  const deviceRows = devices
    .slice(0, 4)
    .map(
      (device) => `
      <div class="device-row">
        <span class="device-status" style="background:${
          device.status === 'online' ? 'var(--green)' : 'var(--muted)'
        }"></span>
        <span class="device-name">${escapeHtml(device.name || device.id)}</span>
        <span class="device-room">${escapeHtml(device.room || '')}</span>
      </div>
    `,
    )
    .join('');

  const plan = plans[0];
  const planHtml = plan
    ? `
      <div class="plan-card">
        <div class="mem-title">${escapeHtml(plan.title || 'Active plan')}</div>
        <div class="plan-meta">
          <span class="tag cyan">${escapeHtml(formatIsoDate(plan.date))}</span>
          <span class="tag">${escapeHtml(plan.time || '—')}</span>
          <span class="tag">${escapeHtml(String(plan.guests || 0))} guests</span>
          <span class="tag green">${escapeHtml(plan.status || 'planned')}</span>
        </div>
        <p class="mem-text">${escapeHtml(plan.notes || '')}</p>
        <div class="tag-row">
          ${(plan.dietaryConstraints || [])
            .map((constraint) => `<span class="tag orange">${escapeHtml(constraint)}</span>`)
            .join('')}
        </div>
      </div>
    `
    : '<p class="mem-text">No active household plans saved.</p>';

  const cartItems = (cart?.items || []).slice(0, 4);
  const cartHtml = cart
    ? `
      <div class="mem-title">${escapeHtml(cart.occasion || 'Active cart')}</div>
      <div class="mem-big">${money(cart.total)} <small>· ${cart.items?.length || 0} items</small></div>
      <div class="tag-row" style="margin-top:4px">
        <span class="tag ${cart.verification?.passed ? 'green' : 'orange'}">${
          cart.verification?.passed ? 'Allergy verified' : 'Review needed'
        }</span>
        <span class="tag cyan">${escapeHtml(cart.status || 'draft')}</span>
        <span class="tag">${escapeHtml(cart.merchant || '')}</span>
      </div>
      <div class="cart-mini-items">
        ${cartItems
          .map(
            (item) => `
            <div class="cart-mini-row">
              <span>${escapeHtml(item.quantity || 1)} × ${escapeHtml(item.name)}</span>
              <span>${money(item.lineTotal)}</span>
            </div>
          `,
          )
          .join('')}
      </div>
    `
    : '<p class="mem-text">No active cart. Build one from a scenario.</p>';

  const preferenceTags = Object.entries(preferences)
    .slice(0, 6)
    .map(
      ([key, value]) =>
        `<span class="tag" title="${escapeHtml(value)}">${escapeHtml(key)}</span>`,
    )
    .join('');

  dom.memoryGraph.innerHTML = `
    <div class="mem-card wide" style="--accent:#00d4ff">
      <div class="mem-label"><span class="mem-icon">◈</span> Household profile</div>
      <div class="mem-title">${escapeHtml(household.name || 'Household')}</div>
      <p class="mem-text">${escapeHtml(household.primaryUser || '—')} · ${escapeHtml(
        household.location || '',
      )} · ${escapeHtml(household.timezone || '')}</p>
      <div class="member-list" style="margin-top:6px">${memberRows}</div>
    </div>

    <div class="mem-card wide" style="--accent:#ff8a65">
      <div class="mem-label"><span class="mem-icon">⚠</span> Allergy safety graph</div>
      <div class="tag-row">
        ${allergyTags || '<span class="tag green">No household allergies recorded</span>'}
      </div>
      <p class="mem-text" style="margin-top:4px">Every commerce call is filtered against this graph before cards render.</p>
    </div>

    <div class="mem-card" style="--accent:#5ee6a8">
      <div class="mem-label"><span class="mem-icon">$</span> Budget caps</div>
      <div class="budget-list">${budgetRows}</div>
    </div>

    <div class="mem-card" style="--accent:#7c5cff">
      <div class="mem-label"><span class="mem-icon">⌂</span> Connected devices</div>
      <div class="device-list">${deviceRows || '<p class="mem-text">No devices.</p>'}</div>
    </div>

    <div class="mem-card wide" style="--accent:#ffca62">
      <div class="mem-label"><span class="mem-icon">☼</span> Next active plan</div>
      ${planHtml}
    </div>

    <div class="mem-card wide" style="--accent:#00d4ff">
      <div class="mem-label"><span class="mem-icon">🛒</span> Commerce memory</div>
      ${cartHtml}
    </div>

    <div class="mem-card wide" style="--accent:#ff5ccf">
      <div class="mem-label"><span class="mem-icon">🧠</span> Conversation memory</div>
      <p class="mem-text">${escapeHtml(conversation.summary || 'No conversation summary yet.')}</p>
      <p class="mem-text" style="margin-top:4px"><strong>Last turn:</strong> ${escapeHtml(
        conversation.lastUserUtterance || '—',
      )}</p>
      <p class="mem-text" style="margin-top:2px"><strong>Alexa:</strong> ${escapeHtml(
        conversation.lastAlexaResponse || '—',
      )}</p>
    </div>

    <div class="mem-card wide" style="--accent:#8ea7d8">
      <div class="mem-label"><span class="mem-icon">◇</span> Stored preferences</div>
      <div class="tag-row">${preferenceTags || '<span class="tag">None saved</span>'}</div>
    </div>
  `;
}

/* ==========================================================================
   MCP JSON-RPC stream inspector
   ========================================================================== */

function classifyFrame(frame) {
  const method = String(frame?.method || '');
  const transport = String(frame?.transport || '');
  if (transport === 'bedrock' || transport === 'fallback' || method.startsWith('bedrock/')) {
    return 'bedrock';
  }
  if (method.startsWith('resources/') || method.includes('resource')) return 'resources';
  if (/tools\/call|checkout|cart/.test(method)) return 'tools';
  return 'other';
}

function filteredFrames() {
  if (state.filter === 'all') return state.telemetry;
  return state.telemetry.filter((frame) => classifyFrame(frame) === state.filter);
}

function frameNoteText(frame) {
  const note = frame?.note;
  if (!note) return '';
  if (typeof note === 'string') return note;
  if (note.message) return note.message;
  if (note.error) return `${note.error} · ${note.message || ''}`;
  const parts = [];
  if (note.action) parts.push(note.action);
  if (note.tool) parts.push(note.tool);
  if (note.itemCount !== undefined) parts.push(`${note.itemCount} items`);
  if (note.total !== undefined) parts.push(money(note.total));
  if (note.cards !== undefined) parts.push(`${note.cards} cards`);
  if (note.commands !== undefined) parts.push(`${note.commands} device commands`);
  if (note.scheduled) parts.push(typeof note.scheduled === 'string' ? note.scheduled : 'scheduled');
  return parts.join(' · ');
}

function rpcFrameHtml(frame) {
  const category = classifyFrame(frame);
  const isError = Boolean(frame.payload?.error) || frame.direction === 'error';
  const isResponse = frame.direction === 'response';
  const isExpanded = state.expandedFrames.has(frame.frameId);
  const note = frameNoteText(frame);
  const classes = [
    'rpc-frame',
    isResponse ? 'is-response' : '',
    isError ? 'is-error' : '',
    category === 'bedrock' ? 'is-bedrock' : '',
    category === 'resources' ? 'is-resource' : '',
    isExpanded ? '' : 'is-collapsed',
  ]
    .filter(Boolean)
    .join(' ');

  return `
    <div class="${classes}" data-frame-id="${escapeHtml(frame.frameId)}">
      <button class="rpc-head" type="button" data-toggle-frame="${escapeHtml(frame.frameId)}" aria-expanded="${isExpanded}">
        <span class="rpc-dir">${isResponse ? '← res' : '→ req'}</span>
        <span class="rpc-method">${escapeHtml(frame.method || 'unknown')}</span>
        <span class="rpc-id">#${escapeHtml(shortId(frame.rpcId ?? '—'))}</span>
        <span class="rpc-meta-right">
          <span class="rpc-transport">${escapeHtml(frame.transport || 'mcp')}</span>
          ${
            typeof frame.latencyMs === 'number'
              ? `<span class="rpc-latency">${frame.latencyMs}ms</span>`
              : ''
          }
          <span class="rpc-time">${escapeHtml(timeOnly(frame.timestamp))}</span>
        </span>
      </button>
      ${note ? `<div class="rpc-note">${escapeHtml(note)}</div>` : ''}
      <div class="rpc-payload">
        <pre class="json-pre">${highlightJson(frame.payload)}</pre>
      </div>
    </div>
  `;
}

function renderStream() {
  if (!dom.streamList) return;
  const frames = filteredFrames();
  dom.streamCount.textContent = String(state.telemetry.length);

  if (!frames.length) {
    const emptyCopy = {
      all: 'Run a demo scenario or call a tool from /mcp to see every JSON-RPC request and response here.',
      tools: 'No tool-call frames yet. The four MCP tools will appear here as the agent invokes them.',
      resources: 'No resource reads yet. Try memory://household/profile from the MCP inspector.',
      bedrock: 'No Bedrock frames yet. Without AWS credentials, the Smart Agentic Fallback handles the plan.',
    };
    dom.streamList.innerHTML = `
      <div class="stream-empty">
        <span class="empty-glyph" aria-hidden="true">◇</span>
        <strong>Waiting for ${escapeHtml(state.filter === 'all' ? 'MCP traffic' : state.filter)}</strong>
        <p>${escapeHtml(emptyCopy[state.filter] || emptyCopy.all)}</p>
      </div>
    `;
    return;
  }

  dom.streamList.innerHTML = frames
    .slice(-90)
    .map(rpcFrameHtml)
    .join('');

  if (state.autoScroll) {
    dom.panelStream.scrollTop = dom.panelStream.scrollHeight;
  }
}

function renderStreamStats() {
  if (!dom.streamStats) return;
  const frames = state.telemetry;
  const toolCalls = frames.filter(
    (frame) => frame.direction === 'request' && frame.method === 'tools/call',
  ).length;
  const responses = frames.filter(
    (frame) => frame.direction === 'response' && typeof frame.latencyMs === 'number',
  );
  const average = responses.length
    ? Math.round(responses.reduce((sum, frame) => sum + frame.latencyMs, 0) / responses.length)
    : 0;
  const errors = frames.filter((frame) => frame.payload?.error).length;

  dom.streamStats.innerHTML = `
    <span class="stat-chip"><strong>${frames.length}</strong> frames</span>
    <span class="stat-chip"><strong>${toolCalls}</strong> tool calls</span>
    <span class="stat-chip"><strong>${average}</strong> ms avg</span>
    <span class="stat-chip"><strong>${errors}</strong> errors</span>
    <span class="stat-chip"><span class="live-dot" style="width:4px;height:4px"></span> ${
      state.sseConnected ? 'SSE live' : 'SSE reconnecting'
    }</span>
  `;
}

/* ==========================================================================
   Execution DAG
   ========================================================================== */

function renderDag(dag, meta) {
  state.dag = Array.isArray(dag) ? dag : [];
  if (!dom.dagSummary || !dom.dagList) return;

  const source = meta?.sourceLabel || (meta?.source === 'bedrock' ? 'AWS Bedrock' : 'Smart Agentic Fallback');
  const intent = meta?.intent || state.dag.find((node) => node.id === 'node_plan')?.summary || '—';
  const latency = Number(meta?.latencyMs) || 0;
  const steps = state.dag.filter((node) => node.id !== 'node_plan').length;

  dom.dagSummary.innerHTML = `
    <div class="dag-summary-card">
      <span class="label">Agent source</span>
      <span class="value accent" title="${escapeHtml(source)}">${escapeHtml(source)}</span>
    </div>
    <div class="dag-summary-card">
      <span class="label">Intent</span>
      <span class="value">${escapeHtml(intent)}</span>
    </div>
    <div class="dag-summary-card">
      <span class="label">End-to-end latency</span>
      <span class="value">${latency ? `${latency} ms` : '—'}</span>
    </div>
    <div class="dag-summary-card">
      <span class="label">Executed steps</span>
      <span class="value">${steps || 0}</span>
    </div>
  `;

  if (!state.dag.length) {
    dom.dagList.innerHTML = `
      <div class="dag-empty">
        <span class="glyph" aria-hidden="true">✦</span>
        <strong>No execution graph yet</strong>
        <p>Ask LexaFlow for something multi-service. The planner, each MCP tool, and the voice synthesis step will appear here.</p>
      </div>
    `;
    return;
  }

  dom.dagList.innerHTML = state.dag
    .map((node, index) => {
      const service = node.service || 'mcp';
      const color = SERVICE_COLORS[service] || SERVICE_COLORS.mcp;
      const icon = SERVICE_ICONS[service] || SERVICE_ICONS.mcp;
      const status = node.status === 'error' ? 'error' : 'ok';
      return `
        <div class="dag-step" style="--svc-color:${color};animation-delay:${index * 35}ms">
          <span class="dag-icon" aria-hidden="true">${icon}</span>
          <div class="dag-body">
            <div class="dag-title-row">
              <span class="dag-title">${escapeHtml(node.title || node.tool || 'Step')}</span>
              <span class="dag-duration">${
                typeof node.durationMs === 'number' ? `${node.durationMs} ms` : ''
              }</span>
            </div>
            <div class="dag-meta">
              <span class="dag-status ${status === 'error' ? 'is-error' : ''}">${status}</span>
              <span>${escapeHtml(node.serviceLabel || service)}</span>
            </div>
            <div class="dag-tool" title="${escapeHtml(node.summary || node.tool || '')}">${escapeHtml(
              node.tool || '',
            )}${node.summary ? ` · ${escapeHtml(node.summary)}` : ''}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

/* ==========================================================================
   Runtime status, tabs, filters
   ========================================================================== */

function updateRuntime(runtime) {
  if (!dom.bedrockMode || !dom.bedrockChip) return;
  const current = runtime || state.runtime;
  if (!current) {
    dom.bedrockMode.textContent = 'Checking…';
    return;
  }
  const live = current.mode === 'bedrock' || current.configured === true;
  dom.bedrockMode.textContent = live ? 'Live' : 'Fallback';
  dom.bedrockChip.classList.toggle('is-live', live);
  dom.bedrockChip.classList.toggle('is-fallback', !live);
  dom.bedrockChip.title = `${current.modeLabel || current.mode || 'Agent runtime'} · ${
    current.modelLabel || ''
  } · ${current.reason || ''}`;
}

function setTab(tab) {
  const name = ['stream', 'memory', 'dag'].includes(tab) ? tab : 'stream';
  state.activeTab = name;
  $$('.tab').forEach((button) => {
    const active = button.dataset.tab === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('.tab-panel').forEach((panel) => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle('is-active', active);
    if (active) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  });
  if (name === 'stream') renderStream();
  if (name === 'memory') renderMemory();
}

function setFilter(filter) {
  const allowed = ['all', 'tools', 'resources', 'bedrock'];
  state.filter = allowed.includes(filter) ? filter : 'all';
  $$('.filter').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.filter === state.filter);
  });
  renderStream();
}

function toggleFrame(frameId) {
  if (!frameId) return;
  if (state.expandedFrames.has(frameId)) state.expandedFrames.delete(frameId);
  else state.expandedFrames.add(frameId);
  const frame = dom.streamList?.querySelector(`[data-frame-id="${CSS.escape(frameId)}"]`);
  if (!frame) return;
  const expanded = state.expandedFrames.has(frameId);
  frame.classList.toggle('is-collapsed', !expanded);
  frame.querySelector('.rpc-head')?.setAttribute('aria-expanded', String(expanded));
}

/* ==========================================================================
   Live updates
   ========================================================================== */

let refreshTimer = null;

function scheduleRefresh(delay = 450) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshState(true);
  }, delay);
}

function connectEvents() {
  if (!('EventSource' in window)) return;
  const source = new EventSource('/api/events');

  source.onopen = () => {
    state.sseConnected = true;
    renderStreamStats();
  };

  source.onerror = () => {
    state.sseConnected = false;
    renderStreamStats();
  };

  source.addEventListener('hello', () => {
    state.sseConnected = true;
    renderStreamStats();
    if (!state.helloShown) {
      state.helloShown = true;
    }
  });

  source.addEventListener('telemetry', (event) => {
    try {
      const frame = JSON.parse(event.data);
      mergeTelemetry([frame]);
      if (state.activeTab === 'stream') renderStream();
      renderStreamStats();
    } catch (_) {
      /* ignore malformed frame */
    }
  });

  source.addEventListener('memory', () => {
    scheduleRefresh();
  });
}

/* ==========================================================================
   State loading
   ========================================================================== */

async function refreshState(silent = false) {
  try {
    const data = await apiFetch('/api/state');
    state.memory = data.state || state.memory;
    state.runtime = data.runtime || state.runtime;
    if (Array.isArray(data.scenarios) && data.scenarios.length) {
      renderScenarios(data.scenarios);
    }
    mergeTelemetry(data.telemetry || []);
    renderMemory();
    renderStream();
    renderStreamStats();
    updateRuntime(state.runtime);

    if (!state.purchaseSuccess) {
      const cart = state.memory?.commerce?.activeCart;
      renderCommerce(
        cart,
        cart ? { confirmationToken: cart.confirmationToken } : null,
        cart ? cart.verification : null,
      );
    }

    if (!silent) dom.latencyFoot.textContent = `${data.telemetryStats?.averageLatencyMs || 0} ms`;
  } catch (error) {
    if (!silent) {
      toast(error.message || 'Could not load demo state.', 'error', 5000);
    }
  }
}

async function loadShowcase() {
  try {
    const data = await apiFetch('/api/showcase');
    if (Array.isArray(data.carousels) && data.carousels.length) {
      renderCarousels(data.carousels, { replace: true });
    }
  } catch (error) {
    toast(error.message || 'Could not render the startup showcase.', 'warning', 4500);
  }
}

/* ==========================================================================
   Reset flow
   ========================================================================== */

function openResetModal() {
  dom.confirmModal.classList.remove('hidden');
  dom.confirmReset.focus();
}

function closeResetModal() {
  dom.confirmModal.classList.add('hidden');
  dom.resetBtn.focus();
}

async function resetDemo() {
  dom.confirmReset.disabled = true;
  dom.cancelReset.disabled = true;
  const label = dom.confirmReset.textContent;
  dom.confirmReset.textContent = 'Resetting…';

  try {
    const data = await apiFetch('/api/state/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });

    state.purchaseSuccess = null;
    state.carousels = [];
    state.telemetry = [];
    state.dag = [];
    state.expandedFrames.clear();
    state.memory = data.state;
    state.runtime = data.runtime;
    dom.carouselArea.innerHTML = '';
    renderMemory();
    renderStream();
    renderStreamStats();
    renderDag([]);
    updateRuntime(state.runtime);

    const cart = state.memory?.commerce?.activeCart;
    renderCommerce(
      cart,
      cart ? { confirmationToken: cart.confirmationToken } : null,
      cart ? cart.verification : null,
    );

    await loadShowcase();
    await refreshState(true);

    addMessage('alexa', 'Demo state restored. The Rivera household seed, draft taco cart, and memory graph are back.', {
      tag: 'Reset',
    });
    toast('Household memory, cart, and telemetry restored to the seed.', 'success', 5000);
  } catch (error) {
    toast(error.message || 'Could not reset the demo.', 'error', 6000);
  } finally {
    dom.confirmReset.disabled = false;
    dom.cancelReset.disabled = false;
    dom.confirmReset.textContent = label || 'Reset demo state';
    closeResetModal();
  }
}

/* ==========================================================================
   Clock, microphone, composer
   ========================================================================== */

function updateClock() {
  const now = new Date();
  if (dom.bigClock) dom.bigClock.textContent = formatClock(now);
  if (dom.bigDate) dom.bigDate.textContent = formatLongDate(now);
  if (dom.stageTime) dom.stageTime.textContent = formatClock(now);
  if (dom.stageDate) dom.stageDate.textContent = formatStageDate(now);
}

function buildWaveform() {
  if (!dom.waveform) return;
  const bars = 42;
  const markup = [];
  for (let index = 0; index < bars; index += 1) {
    const height = 5 + ((index * 13) % 17);
    const delay = ((index % 9) * 0.08).toFixed(2);
    markup.push(
      `<span style="--bar-height:${height}px;--bar-delay:${delay}s"></span>`,
    );
  }
  dom.waveform.innerHTML = markup.join('');
}

function initComposer() {
  dom.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitMessage(dom.chatInput.value);
  });

  dom.scenarioStrip.addEventListener('click', (event) => {
    const button = event.target.closest('.scenario-card');
    if (!button || button.disabled) return;
    submitMessage(button.dataset.prompt || button.textContent);
  });

  dom.carouselArea.addEventListener('click', (event) => {
    const card = event.target.closest('.media-card');
    if (!card) return;
    const title = card.dataset.cardTitle || 'Card';
    const kind = card.dataset.cardKind || 'media';
    toast(`Opened ${kind} card · ${title}`, 'info', 2400);
    if (kind === 'music') speak(`Previewing ${title}.`);
  });

  dom.carouselArea.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.media-card');
    if (!card) return;
    event.preventDefault();
    card.click();
  });

  dom.commerceArea.addEventListener('click', (event) => {
    const confirmButton = event.target.closest('[data-action="confirm-purchase"]');
    if (confirmButton) {
      handlePurchase(confirmButton);
      return;
    }
    const swapButton = event.target.closest('.swap-btn');
    if (swapButton) handleSwap(swapButton);
  });
}

function initMic() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    if (dom.micSupport) dom.micSupport.textContent = 'Voice input unsupported';
    if (dom.micBtn) {
      dom.micBtn.disabled = true;
      dom.micBtn.title = 'This browser does not expose the Web Speech recognition API.';
    }
    return;
  }

  const recognition = new Recognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  state.recognition = recognition;

  recognition.onstart = () => {
    state.listening = true;
    dom.micBtn.classList.add('is-listening');
    setActivity('listening', 'Listening');
    if (dom.speechHint) dom.speechHint.textContent = 'Listening — speak your request';
  };

  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript;
    if (transcript) submitMessage(transcript);
  };

  recognition.onerror = (event) => {
    const ignored = ['no-speech', 'aborted'];
    if (!ignored.includes(event.error)) {
      const messages = {
        'not-allowed': 'Microphone permission was blocked. Type your request instead.',
        'audio-capture': 'No microphone was found. Type your request instead.',
        network: 'Speech recognition needs a network connection.',
      };
      toast(messages[event.error] || `Voice input error: ${event.error}`, 'warning', 4500);
    }
  };

  recognition.onend = () => {
    state.listening = false;
    dom.micBtn.classList.remove('is-listening');
    if (dom.speechHint) dom.speechHint.textContent = 'Tap a scenario, speak, or type a request';
    if (!state.busy && !state.speaking) setActivity(null, 'Ready');
  };

  dom.micBtn.addEventListener('click', () => {
    if (state.busy) return;
    if (state.listening) {
      try {
        recognition.stop();
      } catch (_) {
        /* noop */
      }
      return;
    }
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      recognition.start();
    } catch (error) {
      toast('Voice input is already starting. Try again in a moment.', 'info', 2400);
    }
  });
}

function initChrome() {
  $$('.tab').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  });

  $$('.filter').forEach((button) => {
    button.addEventListener('click', () => setFilter(button.dataset.filter));
  });

  dom.streamList.addEventListener('click', (event) => {
    const head = event.target.closest('[data-toggle-frame]');
    if (head) toggleFrame(head.dataset.toggleFrame);
  });

  dom.autoScroll.addEventListener('change', () => {
    state.autoScroll = dom.autoScroll.checked;
    if (state.autoScroll) {
      dom.panelStream.scrollTop = dom.panelStream.scrollHeight;
    }
  });

  dom.rawToggle.addEventListener('click', () => {
    state.rawVisible = !state.rawVisible;
    dom.memoryRaw.classList.toggle('hidden', !state.rawVisible);
    dom.rawToggle.textContent = state.rawVisible ? 'Visual view' : 'Raw JSON';
  });

  dom.resetBtn.addEventListener('click', openResetModal);
  dom.memoryReset.addEventListener('click', openResetModal);
  dom.cancelReset.addEventListener('click', closeResetModal);
  dom.confirmReset.addEventListener('click', resetDemo);
  dom.confirmModal.addEventListener('click', (event) => {
    if (event.target === dom.confirmModal) closeResetModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.confirmModal.classList.contains('hidden')) {
      closeResetModal();
    }
  });
}

/* ==========================================================================
   Bootstrap
   ========================================================================== */

async function init() {
  cacheDom();
  buildWaveform();
  renderScenarios(DEFAULT_SCENARIOS);
  renderDag([]);
  renderMemory();
  renderStream();
  renderStreamStats();
  initMute();
  initComposer();
  initMic();
  initChrome();
  updateClock();
  setInterval(updateClock, 20_000);
  addWelcome();
  connectEvents();

  loadVoices();
  if ('speechSynthesis' in window) {
    window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  }

  await refreshState(true);
  await loadShowcase();
  await refreshState(true);
  updateRuntime(state.runtime);
  setTab('stream');
  dom.chatInput.focus();
}

document.addEventListener('DOMContentLoaded', init);

