// Vocabulary packs — optional, per-industry bundles of jargon -> plain-language
// mappings that extend the translation dictionary. A team picks the packs that
// fit their product (config.vocabPacks) and their commit copy gets friendlier
// out of the box, without hand-writing every term.
//
// Precedence: packs fill in terms the base dictionary doesn't cover, but the
// user's own config.dictionary always wins (see mergeVocabPacks) — explicit
// configuration beats a preset.

export const VOCAB_PACKS = {
  saas: {
    tenant: 'account',
    'multi-tenant': '',
    churn: 'cancellations',
    'rate limit': 'usage limit',
    'rate limiting': 'usage limits',
    'feature flag': 'setting',
    uptime: 'availability',
    SLA: 'service guarantee',
    provisioning: 'setup',
  },
  ecommerce: {
    'checkout flow': 'checkout',
    fulfillment: 'order handling',
    SKU: 'product',
    'abandoned cart': 'unfinished order',
    inventory: 'stock',
    chargeback: 'disputed payment',
    storefront: 'shop',
  },
  fintech: {
    ledger: 'records',
    reconciliation: 'balancing',
    KYC: 'identity check',
    settlement: 'payment processing',
    ACH: 'bank transfer',
    payout: 'payment',
    underwriting: 'approval',
  },
  agency: {
    retainer: 'plan',
    deliverable: 'work',
    deliverables: 'work',
    sprint: 'work cycle',
    stakeholder: 'your team',
    wireframe: 'layout',
    mockup: 'design preview',
  },
  mobile: {
    'push notification': 'notification',
    'push notifications': 'notifications',
    'deep link': 'link',
    'cold start': 'app launch time',
    crash: 'app crash',
    'in-app purchase': 'purchase',
  },
};

/**
 * Merge the named vocab packs under the user's dictionary. Packs are applied in
 * order, then the user's explicit `dictionary` is layered on top so it always
 * wins. Unknown pack names are warned about and skipped (validateConfig turns
 * them into a hard error for the main build; the commit-msg hook is fail-open).
 */
export function mergeVocabPacks(dictionary = {}, packNames = []) {
  const merged = {};
  for (const name of packNames) {
    const pack = VOCAB_PACKS[name];
    if (pack) Object.assign(merged, pack);
    else console.warn(`portal: unknown vocab pack "${name}" — ignoring.`);
  }
  Object.assign(merged, dictionary); // explicit user dictionary wins
  return merged;
}
