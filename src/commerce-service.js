'use strict';

const store = require('./store');
const {
  TAX_RATE,
  getProduct,
  searchProducts,
  selectRecipe,
} = require('./catalog');

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const money = (value) => `$${Number(value || 0).toFixed(2)}`;
const normalize = (value) => String(value || '').trim().toLowerCase();

function createLine(product, quantity, options = {}) {
  const qty = Math.max(1, Math.min(Number(quantity) || 1, 99));
  return {
    lineId: `line_${store.uuid()}`,
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    category: product.category,
    unit: product.unit,
    emoji: product.emoji,
    accent: product.accent,
    quantity: qty,
    unitPrice: product.price,
    lineTotal: roundMoney(product.price * qty),
    rating: product.rating,
    reviews: product.reviews,
    dietaryTags: product.dietaryTags,
    allergens: product.allergens,
    badges: product.dietaryTags.slice(0, 3),
    optional: Boolean(options.optional),
    priority: Number(options.priority) || 50,
    swapOptions: (product.substitutes || [])
      .map((sku) => getProduct(sku))
      .filter(Boolean)
      .map((substitute) => ({
        sku: substitute.sku,
        name: substitute.name,
        price: substitute.price,
        emoji: substitute.emoji,
        dietaryTags: substitute.dietaryTags,
        allergens: substitute.allergens,
      })),
  };
}

function recalculate(cart) {
  const items = Array.isArray(cart.items) ? cart.items : [];
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const tax = roundMoney(subtotal * TAX_RATE);
  const total = roundMoney(subtotal + tax);
  const budgetCap = Number(cart.budgetCap) || 75;
  cart.subtotal = subtotal;
  cart.tax = tax;
  cart.total = total;
  cart.budgetCap = budgetCap;
  cart.remainingBudget = roundMoney(budgetCap - total);
  cart.budgetStatus = total <= budgetCap ? 'within' : 'over';
  cart.itemCount = items.length;
  cart.updatedAt = new Date().toISOString();
  return cart;
}

function verificationFor(items, checkedAllergens) {
  const checked = [...new Set(checkedAllergens.map((allergen) => normalize(allergen)).filter(Boolean))];
  const violations = [];
  for (const item of items) {
    const allergens = (item.allergens || []).map(normalize);
    for (const allergen of checked) {
      if (allergens.includes(allergen)) {
        violations.push({ item: item.name, allergen });
      }
    }
  }
  const passed = violations.length === 0;
  return {
    passed,
    checkedAllergens: checked,
    violations,
    message: passed
      ? checked.length
        ? `All ${items.length} items verified against: ${checked.join(', ')}. No conflicts found.`
        : `All ${items.length} items verified. No household allergy conflicts found.`
      : `Blocked ${violations.length} allergy conflict${violations.length === 1 ? '' : 's'}.`,
  };
}

function purchaseIntent(cart) {
  const ready = Boolean(cart.items && cart.items.length);
  if (ready) cart.confirmationToken = `vp_${store.uuid()}`;
  return {
    ready,
    requiresConfirmation: true,
    confirmationToken: ready ? cart.confirmationToken : null,
    merchant: cart.merchant,
    total: cart.total,
    note: 'Checkout requires a second, explicit confirmation tap or voice turn.',
  };
}

function emptyCart(merchant = 'Whole Foods Market') {
  return recalculate({
    id: `cart_${store.uuid()}`,
    merchant,
    status: 'empty',
    occasion: null,
    servings: 0,
    currency: 'USD',
    items: [],
    budgetCap: 75,
    flags: [],
    verification: {
      passed: true,
      checkedAllergens: [],
      violations: [],
      message: 'Cart is empty.',
    },
    changeLog: [],
    confirmationToken: null,
    createdAt: new Date().toISOString(),
  });
}

function collectAllergens(memory, args) {
  const allergens = new Set();
  for (const entry of (memory.household && memory.household.allergies) || []) {
    if (entry && entry.allergen) allergens.add(normalize(entry.allergen));
  }
  for (const member of (memory.household && memory.household.members) || []) {
    for (const allergy of member.allergies || []) {
      if (typeof allergy === 'string') allergens.add(normalize(allergy));
      else if (allergy && allergy.allergen) allergens.add(normalize(allergy.allergen));
    }
  }
  for (const allergen of args.allergens || []) allergens.add(normalize(allergen));
  return [...allergens].filter(Boolean);
}

function saveCart(cart) {
  const { memory } = store.updateMemory((draft) => {
    draft.commerce = draft.commerce || {};
    draft.commerce.activeCart = cart;
  });
  return memory;
}

function buildCart(args, memory) {
  const recipe = selectRecipe(args.occasion, args.context);
  const requestedServings =
    Number(args.servings) || (recipe.id === 'recipe_cold_recovery_kit' ? 1 : 6);
  const scaleBase = recipe.id === 'recipe_gluten_free_taco_night' ? Number(args.servings) || 6 : 6;
  const scale = recipe.id === 'recipe_gluten_free_taco_night' ? scaleBase / 6 : 1;
  const allergens = collectAllergens(memory, args);
  const strictDietary = (args.dietaryConstraints || []).map(normalize);
  const merchant =
    args.store ||
    (recipe.id === 'recipe_cold_recovery_kit' ? 'Amazon Fresh' : 'Whole Foods Market');
  const budgetCap =
    Number(args.budgetCap) ||
    (recipe.id === 'recipe_cold_recovery_kit'
      ? Number(memory.household?.budgetCaps?.recoveryKit) || 25
      : Number(memory.household?.budgetCaps?.groceryPerOrder) || 75);

  const blockedItems = [];
  const items = [];

  for (const line of recipe.lines) {
    const product = getProduct(line.sku);
    if (!product) continue;
    const productAllergens = (product.allergens || []).map(normalize);
    const conflict = allergens.find((allergen) => productAllergens.includes(allergen));
    if (conflict) {
      blockedItems.push({ sku: product.sku, name: product.name, allergen: conflict });
      continue;
    }
    if (
      (strictDietary.includes('vegetarian') || strictDietary.includes('vegan')) &&
      product.category === 'Meat & Seafood'
    ) {
      blockedItems.push({ sku: product.sku, name: product.name, diet: 'vegetarian' });
      continue;
    }
    const scaledQuantity =
      scale === 1 ? line.quantity : Math.max(1, Math.round(line.quantity * scale));
    items.push(
      createLine(product, scaledQuantity, {
        optional: line.optional,
        priority: line.priority,
      }),
    );
  }

  const cart = recalculate({
    id: `cart_${store.uuid()}`,
    merchant,
    status: 'draft',
    occasion: args.occasion || recipe.name,
    recipe: { id: recipe.id, name: recipe.name, subtitle: recipe.subtitle },
    servings: requestedServings,
    currency: 'USD',
    items,
    budgetCap,
    flags: [],
    verification: verificationFor(items, allergens),
    changeLog: [],
    createdAt: new Date().toISOString(),
  });

  let guard = 0;
  while (cart.total > cart.budgetCap && guard < 20) {
    guard += 1;
    const removable = cart.items
      .filter((item) => item.optional)
      .sort((a, b) => b.priority - a.priority || b.lineTotal - a.lineTotal)[0];
    if (!removable) break;
    cart.items = cart.items.filter((item) => item.lineId !== removable.lineId);
    cart.flags.push(
      `Dropped ${removable.name} (${money(removable.lineTotal)}) to stay under the ${money(
        cart.budgetCap,
      )} budget.`,
    );
    recalculate(cart);
  }

  if (cart.total > cart.budgetCap) {
    cart.flags.push(
      `Cart is ${money(cart.total - cart.budgetCap)} above the budget cap. Core meal items were preserved.`,
    );
  }

  cart.verification = verificationFor(cart.items, allergens);
  if (blockedItems.length) {
    cart.verification.blockedItems = blockedItems;
    cart.flags.push(
      `${blockedItems.length} ingredient${blockedItems.length === 1 ? '' : 's'} blocked by dietary guardrails.`,
    );
  }
  cart.purchase = purchaseIntent(cart);
  saveCart(cart);

  const allergyLine = allergens.length
    ? `Every item passed the ${allergens.join(', ')} allergy check.`
    : 'No allergy conflicts were found.';
  const budgetLine =
    cart.budgetStatus === 'within'
      ? `${money(cart.remainingBudget)} remains under your ${money(cart.budgetCap)} cap.`
      : `Heads up: this is ${money(cart.total - cart.budgetCap)} over your ${money(
          cart.budgetCap,
        )} cap.`;

  return {
    action: 'build',
    cart,
    summary: {
      itemCount: cart.items.length,
      subtotal: cart.subtotal,
      tax: cart.tax,
      total: cart.total,
      budgetCap: cart.budgetCap,
      remainingBudget: cart.remainingBudget,
      budgetStatus: cart.budgetStatus,
      currency: 'USD',
    },
    verification: cart.verification,
    purchase: cart.purchase,
    flags: cart.flags,
    blockedItems,
    merchant: cart.merchant,
    message: `${recipe.name} cart built at ${cart.merchant}.`,
    speech: `I built your ${recipe.name} cart at ${cart.merchant}: ${
      cart.items.length
    } items, ${money(cart.total)} total. ${allergyLine} ${budgetLine} Tap Confirm Alexa+ Voice Purchase when you're ready.`,
    card: {
      type: 'AlexaPlusPurchaseCard',
      title: recipe.name,
      subtitle: `${cart.merchant} · ${cart.servings} servings`,
      verificationBadge: cart.verification.passed ? 'Allergy Verified' : 'Review Needed',
      budgetBadge: cart.budgetStatus === 'within' ? 'Within Budget' : 'Over Budget',
    },
  };
}

function findLineIndex(cart, query) {
  const q = normalize(query);
  if (!q) return -1;
  const exact = cart.items.findIndex((item) => normalize(item.sku) === q);
  if (exact >= 0) return exact;
  const direct = cart.items.findIndex((item) => normalize(item.name).includes(q));
  if (direct >= 0) return direct;

  const terms = q.split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  return cart.items.findIndex((item) => {
    const product = getProduct(item.sku);
    const haystack = [
      item.name,
      item.brand,
      item.category,
      ...((product && product.keywords) || []),
    ]
      .join(' ')
      .toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

function findTargetProduct(query) {
  const q = normalize(query);
  if (!q) return null;
  const direct = getProduct(query);
  if (direct) return direct;
  const exact = searchProducts(query, 5).find(
    (product) => normalize(product.name) === q || normalize(product.sku) === q,
  );
  if (exact) return exact;
  return searchProducts(query, 1)[0] || null;
}

function mergeDuplicateLines(cart) {
  const merged = new Map();
  for (const item of cart.items) {
    if (merged.has(item.sku)) {
      const existing = merged.get(item.sku);
      existing.quantity += item.quantity;
      existing.lineTotal = roundMoney(existing.quantity * existing.unitPrice);
    } else {
      merged.set(item.sku, { ...item });
    }
  }
  cart.items = [...merged.values()];
  return cart;
}

function cartAfterRebuild(args, memory) {
  const plan = (memory.activePlans || []).find((entry) =>
    /taco|dinner/i.test(`${entry.title} ${entry.type}`),
  );
  const buildArgs = {
    occasion: args.occasion || plan?.title || 'Friday Taco Night',
    servings: plan?.guests || args.servings || 6,
    budgetCap: plan?.budgetCap || args.budgetCap,
    store: args.store || 'Whole Foods Market',
    context: 'swap operation',
  };
  const built = buildCart(buildArgs, memory);
  return built.cart;
}

function commerceBuildAndPurchase(args = {}) {
  const memory = store.readMemory();
  const action = normalize(args.action) || 'get';

  if (action === 'get' || action === 'quote') {
    const cart = memory.commerce?.activeCart || emptyCart();
    if (action === 'quote' && cart.items?.length) {
      recalculate(cart);
      cart.verification = verificationFor(
        cart.items,
        collectAllergens(memory, args),
      );
      cart.purchase = purchaseIntent(cart);
      saveCart(cart);
    } else {
      recalculate(cart);
    }
    const ready = Boolean(cart.items?.length);
    return {
      action,
      cart,
      summary: {
        itemCount: cart.items.length,
        subtotal: cart.subtotal,
        tax: cart.tax,
        total: cart.total,
        budgetCap: cart.budgetCap,
        remainingBudget: cart.remainingBudget,
        budgetStatus: cart.budgetStatus,
        currency: 'USD',
      },
      verification: cart.verification,
      purchase: cart.purchase || purchaseIntent(cart),
      flags: cart.flags || [],
      merchant: cart.merchant,
      message: ready ? 'Active cart loaded.' : 'Your cart is currently empty.',
      speech: ready
        ? `Your ${cart.merchant} cart has ${cart.items.length} items and totals ${money(
            cart.total,
          )}. ${cart.verification.message}`
        : 'Your cart is empty right now. I can build a fresh one whenever you like.',
    };
  }

  if (action === 'build') {
    return buildCart(args, memory);
  }

  if (action === 'swap') {
    let cart = memory.commerce?.activeCart || emptyCart(args.store);
    let rebuilt = false;
    if (!cart.items || cart.items.length === 0) {
      cart = cartAfterRebuild(args, memory);
      rebuilt = true;
    }

    const target =
      findTargetProduct(args.to) ||
      findTargetProduct('organic corn shells') ||
      getProduct('WF-TORT-CORN-ORG');
    if (!target) {
      throw new Error('Could not resolve a replacement product for the swap.');
    }

    let index = findLineIndex(cart, args.from || 'tortillas');
    if (index < 0 && /tortilla|shell/i.test(String(args.from || ''))) {
      index = cart.items.findIndex((item) => /tortilla|shell/i.test(item.name));
    }
    if (index < 0) {
      const quantity = Math.max(1, Number(args.quantity) || 1);
      cart.items.push(createLine(target, quantity, { priority: 40 }));
      cart.changeLog = [
        ...(cart.changeLog || []),
        {
          type: 'add',
          at: new Date().toISOString(),
          description: `${target.name} added because the requested item was not in the cart.`,
        },
      ].slice(-10);
    } else {
      const previous = cart.items[index];
      if (previous.sku === target.sku) {
        const newLine = createLine(target, previous.quantity, {
          optional: previous.optional,
          priority: previous.priority,
        });
        cart.items[index] = newLine;
        cart.changeLog = [
          ...(cart.changeLog || []),
          {
            type: 'swap',
            at: new Date().toISOString(),
            description: `${previous.name} was refreshed with a new ${target.name} line.`,
            from: { name: previous.name, sku: previous.sku },
            to: { name: target.name, sku: target.sku },
            priceDelta: 0,
          },
        ].slice(-10);
      } else {
        const newLine = createLine(target, previous.quantity, {
          optional: previous.optional,
          priority: previous.priority,
        });
        cart.items[index] = newLine;
        cart.changeLog = [
          ...(cart.changeLog || []),
          {
            type: 'swap',
            at: new Date().toISOString(),
            description: `${previous.name} swapped for ${target.name}.`,
            from: {
              name: previous.name,
              sku: previous.sku,
              price: previous.lineTotal,
            },
            to: {
              name: target.name,
              sku: target.sku,
              price: newLine.lineTotal,
            },
            priceDelta: roundMoney(newLine.lineTotal - previous.lineTotal),
          },
        ].slice(-10);
      }
    }

    mergeDuplicateLines(cart);
    cart.verification = verificationFor(cart.items, collectAllergens(memory, args));
    cart.status = 'draft';
    cart.flags = (cart.flags || []).filter((flag) => !/^Dropped/.test(flag));
    recalculate(cart);
    if (cart.total > cart.budgetCap) {
      cart.flags.push(
        `Cart is ${money(cart.total - cart.budgetCap)} above the ${money(cart.budgetCap)} budget cap after the swap.`,
      );
    }
    cart.purchase = purchaseIntent(cart);
    saveCart(cart);

    const latest = (cart.changeLog || []).slice(-1)[0];
    return {
      action: 'swap',
      cart,
      rebuilt,
      mutation: latest,
      summary: {
        itemCount: cart.items.length,
        subtotal: cart.subtotal,
        tax: cart.tax,
        total: cart.total,
        budgetCap: cart.budgetCap,
        remainingBudget: cart.remainingBudget,
        budgetStatus: cart.budgetStatus,
        currency: 'USD',
      },
      verification: cart.verification,
      purchase: cart.purchase,
      flags: cart.flags,
      merchant: cart.merchant,
      message: latest?.description || 'Cart swap completed.',
      speech: `Done. ${latest?.description || 'The cart has been updated.'} Your ${
        cart.merchant
      } cart now has ${cart.items.length} items and totals ${money(cart.total)}. ${
        cart.verification.passed
          ? 'Everything still passes the household allergy check.'
          : 'One item needs review for allergy safety.'
      }`,
    };
  }

  if (action === 'add') {
    let cart = memory.commerce?.activeCart || emptyCart(args.store);
    if (!cart.items || cart.items.length === 0) {
      cart = cartAfterRebuild(args, memory);
    }
    const target = findTargetProduct(args.to || args.item || args.name);
    if (!target) throw new Error('Could not find that product in the demo catalog.');
    const quantity = Math.max(1, Number(args.quantity) || 1);
    if (collectAllergens(memory, args).some((allergen) => target.allergens.includes(allergen))) {
      const error = new Error(
        `${target.name} conflicts with the household allergy graph and was not added.`,
      );
      error.code = 'ALLERGEN_BLOCKED';
      throw error;
    }
    const existingIndex = cart.items.findIndex((item) => item.sku === target.sku);
    if (existingIndex >= 0) {
      cart.items[existingIndex].quantity += quantity;
      cart.items[existingIndex].lineTotal = roundMoney(
        cart.items[existingIndex].quantity * cart.items[existingIndex].unitPrice,
      );
    } else {
      cart.items.push(createLine(target, quantity, { priority: 40 }));
    }
    cart.changeLog = [
      ...(cart.changeLog || []),
      {
        type: 'add',
        at: new Date().toISOString(),
        description: `${quantity} × ${target.name} added to the cart.`,
      },
    ].slice(-10);
    recalculate(cart);
    cart.verification = verificationFor(cart.items, collectAllergens(memory, args));
    cart.purchase = purchaseIntent(cart);
    saveCart(cart);
    return {
      action: 'add',
      cart,
      mutation: (cart.changeLog || []).slice(-1)[0],
      summary: {
        itemCount: cart.items.length,
        subtotal: cart.subtotal,
        tax: cart.tax,
        total: cart.total,
        budgetCap: cart.budgetCap,
        remainingBudget: cart.remainingBudget,
        budgetStatus: cart.budgetStatus,
        currency: 'USD',
      },
      verification: cart.verification,
      purchase: cart.purchase,
      flags: cart.flags,
      merchant: cart.merchant,
      message: `Added ${target.name}.`,
      speech: `Added ${quantity} ${target.name} to your ${cart.merchant} cart. The total is now ${money(
        cart.total,
      )}.`,
    };
  }

  if (action === 'remove') {
    const cart = memory.commerce?.activeCart || emptyCart();
    const index = findLineIndex(cart, args.from || args.name || args.sku);
    if (index < 0) {
      return {
        action: 'remove',
        cart,
        removed: false,
        message: 'That item was not in the cart.',
        speech: 'I could not find that item in your cart.',
      };
    }
    const [removed] = cart.items.splice(index, 1);
    cart.changeLog = [
      ...(cart.changeLog || []),
      {
        type: 'remove',
        at: new Date().toISOString(),
        description: `${removed.name} removed from the cart.`,
      },
    ].slice(-10);
    recalculate(cart);
    cart.verification = verificationFor(cart.items, collectAllergens(memory, args));
    cart.purchase = purchaseIntent(cart);
    saveCart(cart);
    return {
      action: 'remove',
      cart,
      removed: true,
      mutation: (cart.changeLog || []).slice(-1)[0],
      summary: {
        itemCount: cart.items.length,
        subtotal: cart.subtotal,
        tax: cart.tax,
        total: cart.total,
        budgetCap: cart.budgetCap,
        remainingBudget: cart.remainingBudget,
        budgetStatus: cart.budgetStatus,
        currency: 'USD',
      },
      verification: cart.verification,
      purchase: cart.purchase,
      flags: cart.flags,
      merchant: cart.merchant,
      message: `Removed ${removed.name}.`,
      speech: `Removed ${removed.name}. Your cart now totals ${money(cart.total)}.`,
    };
  }

  const error = new Error(
    `Unsupported commerce action "${action}". Use build, swap, add, remove, get, or quote.`,
  );
  error.code = 'INVALID_OPERATION';
  throw error;
}

function confirmPurchase(args = {}) {
  const memory = store.readMemory();
  const cart = memory.commerce?.activeCart;
  if (!cart || !cart.items || cart.items.length === 0) {
    const error = new Error('There is no active cart to purchase.');
    error.code = 'EMPTY_CART';
    throw error;
  }
  if (args.cartId && args.cartId !== cart.id) {
    const error = new Error('Cart id does not match the active cart. Refresh and try again.');
    error.code = 'CART_MISMATCH';
    throw error;
  }
  if (cart.confirmationToken && args.confirmationToken !== cart.confirmationToken) {
    const error = new Error(
      'A valid confirmation token is required to complete an Alexa+ voice purchase.',
    );
    error.code = 'INVALID_CONFIRMATION_TOKEN';
    throw error;
  }

  const order = {
    id: `ord_${cart.merchant === 'Amazon Fresh' ? 'af' : 'wf'}_${Date.now()}`,
    merchant: cart.merchant,
    date: new Date().toISOString().slice(0, 10),
    purchasedAt: new Date().toISOString(),
    total: cart.total,
    subtotal: cart.subtotal,
    tax: cart.tax,
    itemCount: cart.items.length,
    items: cart.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    occasion: cart.occasion,
    status: 'confirmed',
    eta: cart.merchant === 'Amazon Fresh' ? 'Today, 2-hour delivery' : 'Tomorrow, 8–10 AM',
    paymentMethod: args.paymentMethod || 'Amazon Pay · Visa •••• 4821',
    confirmation: {
      method: args.channel || 'voice_and_tap',
      tokenVerified: true,
      allergyVerification: cart.verification,
    },
  };

  const nextCart = emptyCart(cart.merchant);
  nextCart.occasion = null;
  store.updateMemory((draft) => {
    draft.commerce = draft.commerce || {};
    draft.commerce.orderHistory = [...(draft.commerce.orderHistory || []), order].slice(-20);
    draft.commerce.lastOrder = order;
    draft.commerce.activeCart = nextCart;
    draft.conversation = draft.conversation || {};
    draft.conversation.lastAlexaResponse = `Order confirmed at ${order.merchant} for ${money(
      order.total,
    )}. ${order.itemCount} items are on the way.`;
    draft.conversation.updatedAt = new Date().toISOString();
  });

  return {
    order,
    cart: nextCart,
    message: `Order ${order.id} confirmed.`,
    speech: `Purchase confirmed. ${order.itemCount} items from ${order.merchant} totaling ${money(
      order.total,
    )} — ${order.eta}. I saved the receipt to household memory.`,
    memory: store.readMemory(),
  };
}

module.exports = {
  commerceBuildAndPurchase,
  confirmPurchase,
  verificationFor,
  recalculate,
  emptyCart,
  roundMoney,
  money,
};
