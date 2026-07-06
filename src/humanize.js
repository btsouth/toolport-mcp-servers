'use strict';
// Turn a Stripe-style OpenAPI operationId (`{Method}{PathCamelCase}`) into an
// intent-friendly tool name (`create_customer`, `list_invoices`, `close_dispute`,
// `create_charge_refund`). The NAME is the single biggest lexical-recall lever, so this
// derives good names algorithmically to scale across all 587 tools.
//
//   PostCustomers                 -> create_customer
//   GetCustomers                  -> list_customers
//   GetCustomersCustomer  (/{id}) -> get_customer
//   GetCustomersSearch            -> search_customers
//   PostDisputesDisputeClose      -> close_dispute
//   GetBalance (singleton)        -> get_balance
//   PostChargesChargeRefunds      -> create_charge_refund   (nested: parent-qualified)
//   PostApplicationFeesIdRefunds  -> create_application_fee_refund  (mid-path {id})
//   DeleteWebhookEndpointsWebhookEndpoint -> delete_webhook_endpoint (multi-word {id})

const METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

// A trailing token that denotes an ACTION on a resource (POST /x/{id}/close).
const ACTIONS = {
  Close: 'close', Cancel: 'cancel', Capture: 'capture', Confirm: 'confirm',
  Finalize: 'finalize', Pay: 'pay', Send: 'send', Void: 'void', Approve: 'approve',
  Decline: 'decline', Verify: 'verify', Expire: 'expire', Release: 'release',
  Reverse: 'reverse', Ship: 'ship', Return: 'return', Attach: 'attach',
  Detach: 'detach', Reject: 'reject', Resume: 'resume', Discard: 'discard',
  Renew: 'renew', Restore: 'restore', Deactivate: 'deactivate', Activate: 'activate',
  Reactivate: 'reactivate', Fund: 'fund', Advance: 'advance', Preview: 'preview',
};

// Irregular plurals Stripe uses (the -s heuristic can't singularize these).
const IRREGULAR = { people: 'person', children: 'child' };

function splitCamel(s) {
  return s.match(/[A-Z][a-z0-9]*/g) || [];
}

function singularizeWord(w) {
  const l = w.toLowerCase();
  if (IRREGULAR[l]) return IRREGULAR[l];
  if (l.endsWith('ies')) return l.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(l)) return l.slice(0, -2);
  if (l.endsWith('s') && !l.endsWith('ss')) return l.slice(0, -1);
  return l;
}

function isPlural(w) {
  return singularizeWord(w) !== w.toLowerCase();
}

// True when single-word `param` is the {id} placeholder for collection `coll`.
function isDupParam(param, coll) {
  return isPlural(coll) && !isPlural(param) && singularizeWord(param) === singularizeWord(coll);
}

function snakeLower(tokens) {
  return tokens.map((t) => t.toLowerCase()).join('_');
}

// snake_case a token list, singularizing only the LAST word.
function singularPhrase(tokens) {
  if (!tokens.length) return '';
  const head = tokens.slice(0, -1).map((t) => t.toLowerCase());
  return [...head, singularizeWord(tokens[tokens.length - 1])].join('_');
}

// A multi-word {id} placeholder: tokens[i..] mirrors the singular of collection `cur`
// (WebhookEndpoints -> {webhook_endpoint}).
function matchesMultiWordParam(tokens, i, cur) {
  if (cur.length < 2) return false;
  const seg = tokens.slice(i, i + cur.length);
  return seg.length === cur.length && singularPhrase(seg) === singularPhrase(cur);
}

// Split a path's tokens into parent qualifiers (each a singular collection phrase whose
// {id} we're inside) and the trailing final resource noun.
function splitResource(tokens) {
  const qualifiers = []; // singular collection phrases, e.g. "customer", "application_fee"
  let cur = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'Id' && cur.length) { qualifiers.push(singularPhrase(cur)); cur = []; i++; continue; }
    if (cur.length && isDupParam(t, cur[cur.length - 1])) {
      qualifiers.push(singularPhrase(cur));
      cur = [];
      i++;
      // Absorb Stripe's `{singular}ExposedId` / trailing-`Id` param-name suffix into the
      // SAME param, so /subscriptions/{subscription_exposed_id} stays one level
      // (get_subscription), not a phantom nested "exposed" resource.
      while (i < tokens.length && (tokens[i] === 'Exposed' || tokens[i] === 'Id')) i++;
      continue;
    }
    if (matchesMultiWordParam(tokens, i, cur)) { qualifiers.push(singularPhrase(cur)); i += cur.length; cur = []; continue; }
    cur.push(t); i++;
  }
  let finalTokens = cur;
  let finalIsSingular = false;
  if (!finalTokens.length && qualifiers.length) {
    finalTokens = [qualifiers.pop()]; // action/delete on an item: the item IS the resource
    finalIsSingular = true;
  }
  return { qualifiers, finalTokens, finalIsSingular };
}

/**
 * @param {string} op operationId, e.g. "PostChargesChargeRefunds"
 * @returns {{ name: string, resourceKey: string, verb: string }}
 */
function humanize(op) {
  const method = METHODS.find((m) => op.startsWith(m) && /[A-Z]/.test(op[m.length] || ''));
  if (!method) {
    const rk = singularPhrase(splitCamel(op));
    return { name: rk || op.toLowerCase(), resourceKey: rk, verb: 'call', nesting: 0, single: false };
  }
  let tokens = splitCamel(op.slice(method.length));
  if (!tokens.length) return { name: method.toLowerCase(), resourceKey: '', verb: method.toLowerCase(), nesting: 0, single: false };

  // Trailing action / search token.
  let action = null;
  let search = false;
  const last = tokens[tokens.length - 1];
  if (ACTIONS[last]) { action = ACTIONS[last]; tokens = tokens.slice(0, -1); }
  else if (last === 'Search') { search = true; tokens = tokens.slice(0, -1); }

  // splitResource consumes params in any position (leading / middle / trailing, single-
  // or multi-word, or a literal `Id`). A path that ends AT an item ({id}) is a single
  // resource - that's what `finalIsSingular` means - so POST /x/{id} reads as update, not
  // create, and never collides with the collection's create.
  const { qualifiers, finalTokens, finalIsSingular } = splitResource(tokens);
  const isSingle = finalIsSingular;
  const resourceKey = finalIsSingular ? snakeLower(finalTokens) : singularPhrase(finalTokens);
  const singular = [...qualifiers, resourceKey].join('_');
  const plural = [...qualifiers, snakeLower(finalTokens)].join('_');
  // `nesting` = how many parent collections deep (0 = a top-level resource, its item, or an
  // item action); `single` = the op addresses one item. Used to pick the "core" subset.
  const meta = { resourceKey, nesting: qualifiers.length, single: finalIsSingular };

  if (action) return { name: `${action}_${singular}`, verb: action, ...meta };
  if (search) return { name: `search_${plural}`, verb: 'search', ...meta };

  // Method-aware verb, applied to BOTH the by-id and the (mis-detected) collection case,
  // so a DELETE / PUT / PATCH is never mislabeled `create_`.
  if (method === 'Delete') return { name: `delete_${singular}`, verb: 'delete', ...meta };
  if (method === 'Put' || method === 'Patch') return { name: `update_${singular}`, verb: 'update', ...meta };
  if (method === 'Post') {
    return isSingle
      ? { name: `update_${singular}`, verb: 'update', ...meta } // POST /x/{id} = update
      : { name: `create_${singular}`, verb: 'create', ...meta };
  }
  // GET.
  if (isSingle) return { name: `get_${singular}`, verb: 'get', ...meta };
  const finalLast = finalTokens[finalTokens.length - 1] || '';
  if (!finalIsSingular && !isPlural(finalLast)) return { name: `get_${singular}`, verb: 'get', ...meta };
  return { name: `list_${plural}`, verb: 'list', ...meta };
}

// ---- Verb-style operationIds (Clerk, and many hand-authored specs) ----------------
// e.g. CreateEmailAddress -> create_email_address, GetClientList -> list_clients,
// GetClient -> get_client. The verb is already intent-shaped, so this is mostly snake-
// casing + a `...List` -> list_ (plural) normalization.

// Normalize a handful of verb synonyms to a canonical verb; anything else is used
// literally (Vercel's `upload`/`record`/`import`, etc.).
const VERB_MAP = {
  Get: 'get', Read: 'get', Retrieve: 'get', Create: 'create', Update: 'update', Patch: 'update',
  Delete: 'delete', Remove: 'delete', List: 'list', Verify: 'verify', Prepare: 'prepare',
  Revoke: 'revoke', Ban: 'ban', Unban: 'unban', Lock: 'lock', Unlock: 'unlock', Merge: 'merge',
  Upsert: 'upsert', Set: 'set', Change: 'change', Disable: 'disable', Enable: 'enable',
  Reset: 'reset', Attempt: 'attempt', Send: 'send', Approve: 'approve', Reject: 'reject',
};

function pluralizeWord(w) {
  const l = w.toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(l)) return `${l}es`;
  if (/[^aeiou]y$/.test(l)) return `${l.slice(0, -1)}ies`;
  return `${l}s`;
}

function humanizeVerb(op) {
  if (!op) return { name: '', resourceKey: '', verb: 'call', nesting: 0, single: false };
  // Normalize a lowercase-first camelCase id (Vercel: createDeployment) so the leading verb
  // is captured by splitCamel.
  const tokens = splitCamel(op.charAt(0).toUpperCase() + op.slice(1));
  if (!tokens.length) return { name: op.toLowerCase(), resourceKey: '', verb: 'call', nesting: 0, single: false };
  // Verb-first convention: the first token is the verb (normalized via VERB_MAP, else used
  // literally).
  let verb = VERB_MAP[tokens[0]] || tokens[0].toLowerCase();
  let rest = tokens.slice(1);
  // A trailing "List" (Clerk's GetXList) also means a collection read.
  if (rest.length && rest[rest.length - 1] === 'List') {
    rest = rest.slice(0, -1);
    verb = 'list';
  }
  // get + an already-plural resource is a list (Vercel: getDeployments -> list_deployments,
  // vs getDeployment -> get_deployment).
  if (verb === 'get' && rest.length && isPlural(rest[rest.length - 1])) verb = 'list';
  const resourceKey = singularPhrase(rest);
  if (verb === 'list') {
    // Pluralize the resource, but don't double-pluralize one that's already plural
    // (Vercel's listAccessGroups -> access_groups, not access_groupses).
    const last = rest[rest.length - 1] || '';
    const head = rest.slice(0, -1).map((t) => t.toLowerCase());
    const lastPlural = isPlural(last) ? last.toLowerCase() : pluralizeWord(last);
    return { name: `list_${[...head, lastPlural].join('_')}`, resourceKey, verb, nesting: 0, single: false };
  }
  return {
    name: rest.length ? `${verb}_${resourceKey}` : verb,
    resourceKey,
    verb,
    nesting: 0,
    single: !['create'].includes(verb),
  };
}

module.exports = { humanize, humanizeVerb, singularizeWord, splitCamel };
