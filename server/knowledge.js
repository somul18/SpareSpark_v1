// Spare-parts knowledge engine.
//
// Searches structured inventory first, then mines unstructured maintenance knowledge
// (technician notes, work orders, KB articles, maintenance history) for superseded or
// substitute parts. Nothing here knows the demo answer: candidates are extracted from
// the text of the records, and every claim carries the record it came from.

export const MATCH = {
  EXACT: 'Exact',
  SUPERSESSION: 'Documented Supersession',
  POTENTIAL: 'Potential Alternative',
  INSUFFICIENT: 'Insufficient Evidence',
};

const CLASS_RANK = { [MATCH.EXACT]: 0, [MATCH.SUPERSESSION]: 1, [MATCH.POTENTIAL]: 2, [MATCH.INSUFFICIENT]: 3 };
const SOURCE_LABEL = { kb_article: 'Knowledge article', work_order: 'Work order', tech_note: 'Technician note', maintenance_history: 'Maintenance history', inventory: 'Inventory record' };
const AUTHORITATIVE = new Set(['kb_article', 'inventory']);

const CUES = {
  negative: /\b(does not fit|doesn't fit|did not fit|not compatible|incompatible|wrong bolt|returned to stores|do not use|failed again after)\b/i,
  supersession: /\b(supersed\w*|successor|replaces|replacement for)\b/i,
  swap: /\b(swapped in|swap(?:ped)?|installed|replaced|fitted|put in|used)\b/i,
  success: /\b(running fine|successful|passed|returned to production|\bok\b|works|working)\b/i,
  tentative: /\b(tried|stopgap|not verified|unverified|temporary|temp fix|adapter)\b/i,
  install: /\b(shims?|torque|verify|calibrat\w*|re-home|adapter|flange|nm\b)/i,
};

export const canon = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function parsePart(pn) {
  const c = canon(pn);
  const m = c.match(/^([A-Z]{1,4}\d{2,4})([A-Z0-9]*)$/);
  return m ? { canon: c, family: m[1], suffix: m[2] } : { canon: c, family: c, suffix: '' };
}

// Technician shorthand that ends in a period but does not end a sentence.
const ABBREVIATIONS = /\b(red|rev|approx|qty|no|assy|e\.g|i\.e)\.\s+/gi;

function sentences(text) {
  return String(text)
    .replace(ABBREVIATIONS, (m) => m.replace(/\.\s+/, '.\u0000'))
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.replace(/\u0000/g, ' ').trim())
    .filter(Boolean);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regex that matches a part family written loosely: "GR-220", "GR220", "gr 220".
function familyRegex(family) {
  const m = family.match(/^([A-Z]+)(\d+)$/);
  if (!m) return new RegExp(`\\b${escapeRe(family)}`, 'i');
  return new RegExp(`\\b${m[1]}[-\\s]?${m[2]}`, 'i');
}

// Find part numbers mentioned in a sentence, resolved against inventory.
// Handles "GR-220-W2", "GR220W", and bare revisions ("W2 revision") when the
// record is about the requested part family.
function partMentions(sentence, ctx) {
  const found = new Map();
  const re = /\b([A-Z]{1,4})[-\s]?(\d{2,4})(?:[-\s]?([A-Z]\d{0,2}|J\d))?\b/gi;
  for (const m of sentence.matchAll(re)) {
    const c = canon(m[0]);
    if (ctx.byCanon.has(c)) found.set(ctx.byCanon.get(c).part_number, m[0]);
    else if (c === ctx.req.canon) found.set(ctx.requested, m[0]);
  }
  // Bare revision tokens, e.g. "W revision", "replaced with W2". Only resolved within the
  // requested family, and only when the resolved part exists in inventory.
  const lead = ctx.req.suffix ? ctx.req.suffix[0] : null;
  if (lead) {
    const rev = new RegExp(`(?<![A-Za-z0-9-])(${lead}\\d{0,2})(?![A-Za-z0-9-])`, 'g');
    for (const m of sentence.matchAll(rev)) {
      const c = ctx.req.family + m[1];
      if (c === ctx.req.canon) found.set(ctx.requested, m[0]);
      else if (ctx.byCanon.has(c)) found.set(ctx.byCanon.get(c).part_number, m[0]);
    }
  }
  return found;
}

function loadSynonyms(db, component) {
  if (!component) return [];
  const rows = db.prepare('SELECT canonical, variant FROM synonyms').all();
  const comp = component.toLowerCase();
  const canonical = new Set(rows.filter((r) => comp.includes(r.canonical) || comp === r.variant).map((r) => r.canonical));
  const variants = new Set([comp]);
  for (const r of rows) if (canonical.has(r.canonical)) variants.add(r.variant.toLowerCase());
  // Longest first so "wrist gearbox" is reported instead of "gearbox".
  return [...variants].sort((a, b) => b.length - a.length);
}

export function availability(part) {
  if (!part) return 0;
  return Math.max(0, part.qty_on_hand - part.qty_reserved);
}

function compatibility(part, robotModel) {
  if (!robotModel || !part) return 'unknown';
  const models = part.compatible_models.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!models.length) return 'unknown';
  return models.includes(robotModel.toLowerCase()) ? 'listed' : 'not listed';
}

/**
 * Recommend a replacement for `part_number`.
 * @returns structured result; see docs/API.md for the shape.
 */
export function recommend(db, { part_number, robot_model = null, component = null }) {
  const requested = String(part_number || '').trim().toUpperCase();
  if (!requested) throw Object.assign(new Error('part_number is required'), { status: 400 });

  const parts = db.prepare('SELECT * FROM parts').all();
  const byCanon = new Map(parts.map((p) => [canon(p.part_number), p]));
  const req = parsePart(requested);
  const reqPart = byCanon.get(req.canon) || null;
  const ctx = { requested: reqPart ? reqPart.part_number : requested, req, byCanon };
  if (!component) {
    const fc = db.prepare('SELECT component FROM fault_codes WHERE part_number = ? LIMIT 1').get(ctx.requested);
    component = fc?.component || null;
  }

  const tools = [];
  tools.push({ tool: 'inventory.lookup', input: { part_number: ctx.requested }, output: reqPart ? { status: reqPart.status, available: availability(reqPart), bin: reqPart.bin } : 'not found' });

  const result = {
    requested_part: ctx.requested,
    requested_part_record: reqPart ? summarizePart(reqPart, robot_model) : null,
    robot_model,
    component,
    match_type: null,
    recommended: null,
    candidates: [],
    excluded: [],
    relevant_sources: [],
    sources_searched: 0,
    install_instructions: [],
    approval_required: false,
    rationale: '',
    tool_calls: tools,
    method: 'retrieval',
  };

  // 1. Exact match with free stock: done, no knowledge mining needed for the part choice.
  if (reqPart && availability(reqPart) > 0 && reqPart.status !== 'Obsolete') {
    result.match_type = MATCH.EXACT;
    result.recommended = { ...summarizePart(reqPart, robot_model), match_type: MATCH.EXACT, evidence: [inventoryEvidence(reqPart, 'Exact part number in inventory with free stock.')] };
    result.install_instructions = installNotesFor(db, reqPart, [], ctx);
    result.rationale = `Exact part ${reqPart.part_number} is in stock (${availability(reqPart)} available, bin ${reqPart.bin}). No substitute needed.`;
    return result;
  }

  // 2. Knowledge search.
  const synonyms = loadSynonyms(db, component);
  // Inventory parts of the same kind (e.g. other wrist reducers), so records about them count as relevant.
  const sameKind = new Set(parts.filter((p) => p.part_number !== ctx.requested && synonyms.some((v) => v.length > 4 && p.description.toLowerCase().includes(v.replace(/\.$/, ''))) ).map((p) => p.part_number));
  const famRe = familyRegex(req.family);
  const knowledge = db.prepare('SELECT * FROM knowledge ORDER BY created_at DESC').all();
  result.sources_searched = knowledge.length;
  const evidenceByPart = new Map();
  const addEvidence = (pn, ev) => {
    if (!evidenceByPart.has(pn)) evidenceByPart.set(pn, []);
    const list = evidenceByPart.get(pn);
    if (!list.some((e) => e.ref === ev.ref && e.relation === ev.relation)) list.push(ev);
  };

  // Structured supersession from inventory, if inventory happens to know.
  if (reqPart?.superseded_by && byCanon.has(canon(reqPart.superseded_by))) {
    addEvidence(byCanon.get(canon(reqPart.superseded_by)).part_number, inventoryEvidence(reqPart, `Inventory lists ${reqPart.part_number} as superseded by ${reqPart.superseded_by}.`, 'supersession'));
  }

  for (const k of knowledge) {
    const text = `${k.title}. ${k.body}`;
    const lower = text.toLowerCase();
    const matched = [];
    const fullMentions = partMentions(text, ctx);
    if (fullMentions.has(ctx.requested)) matched.push(fullMentions.get(ctx.requested));
    const fam = text.match(famRe);
    if (fam && !matched.some((t) => canon(t).startsWith(req.family))) matched.push(fam[0]);
    const syn = synonyms.find((v) => lower.includes(v));
    if (syn) matched.push(syn);
    const modelMatch = robot_model && k.robot_model && k.robot_model.toLowerCase() === robot_model.toLowerCase();
    const kindMention = [...fullMentions.keys()].find((pn) => sameKind.has(pn));
    if (kindMention && modelMatch) matched.push(fullMentions.get(kindMention));
    const relevant = fullMentions.has(ctx.requested) || !!fam || (syn && (modelMatch || !robot_model)) || (kindMention && modelMatch);
    if (!relevant) continue;

    result.relevant_sources.push({ ref: k.ref, source_type: k.source_type, source_label: SOURCE_LABEL[k.source_type], title: k.title, matched_terms: [...new Set(matched)], robot_model: k.robot_model });

    const successInRecord = CUES.success.test(k.body);
    for (const s of sentences(k.body)) {
      const mentions = partMentions(s, ctx);
      for (const [pn] of mentions) {
        if (pn === ctx.requested) continue;
        let relation = null;
        if (CUES.negative.test(s)) relation = 'contradicts';
        else if (CUES.supersession.test(s)) relation = 'supersession';
        else if (CUES.tentative.test(s) || (CUES.tentative.test(k.body) && CUES.swap.test(s))) relation = 'tentative_use';
        else if (CUES.swap.test(s) && successInRecord) relation = 'successful_swap';
        else if (CUES.swap.test(s)) relation = 'swap_unconfirmed';
        if (!relation) continue;
        addEvidence(pn, { ref: k.ref, source_type: k.source_type, source_label: SOURCE_LABEL[k.source_type], title: k.title, relation, excerpt: s, author: k.author, date: k.created_at.slice(0, 10) });
      }
    }
  }
  tools.push({ tool: 'knowledge.search', input: { part_number: ctx.requested, family: req.family, component, synonyms }, output: { searched: result.sources_searched, relevant: result.relevant_sources.length } });

  // 3. Classify each candidate from its evidence.
  for (const [pn, evidence] of evidenceByPart) {
    const part = byCanon.get(canon(pn));
    const positive = evidence.filter((e) => e.relation !== 'contradicts');
    const negative = evidence.filter((e) => e.relation === 'contradicts');
    const authoritative = positive.some((e) => e.relation === 'supersession' && AUTHORITATIVE.has(e.source_type));
    const fieldConfirmed = new Set(positive.filter((e) => e.relation === 'successful_swap').map((e) => e.ref)).size;
    const compat = compatibility(part, robot_model);
    const warnings = [];

    let match_type;
    if (!positive.length) match_type = MATCH.INSUFFICIENT;
    else if (authoritative) match_type = MATCH.SUPERSESSION;
    else match_type = MATCH.POTENTIAL;
    if (negative.length && positive.length) warnings.push(`Conflicting field reports: ${negative.map((e) => e.ref).join(', ')}.`);
    if (compat === 'not listed') warnings.push(`Inventory does not list ${pn} as compatible with ${robot_model}. Verify fit before use.`);
    if (positive.length && positive.every((e) => e.relation === 'tentative_use')) warnings.push('Only tentative or unverified field use is recorded.');
    if (part && availability(part) === 0) warnings.push('No free stock.');

    const cand = {
      ...summarizePart(part, robot_model),
      part_number: part ? part.part_number : pn,
      match_type,
      evidence,
      supporting_sources: new Set(positive.map((e) => e.ref)).size,
      field_confirmations: fieldConfirmed,
      warnings,
    };
    cand.install_instructions = installNotesFor(db, part, evidence, ctx);
    if (match_type === MATCH.INSUFFICIENT) result.excluded.push({ ...cand, reason: `Contradicted by ${negative.map((e) => e.ref).join(', ')}.` });
    else result.candidates.push(cand);
  }

  result.candidates.sort((a, b) =>
    (CLASS_RANK[a.match_type] - CLASS_RANK[b.match_type])
    || ((b.available > 0) - (a.available > 0))
    || ((a.compatibility === 'not listed') - (b.compatibility === 'not listed'))
    || (b.supporting_sources - a.supporting_sources)
    || (b.field_confirmations - a.field_confirmations));
  result.candidates.forEach((c, i) => { c.rank = i + 1; });

  const best = result.candidates.find((c) => c.available > 0);
  if (best) {
    result.recommended = best;
    result.match_type = best.match_type;
    result.approval_required = true;
    result.install_instructions = best.install_instructions;
  } else {
    result.match_type = MATCH.INSUFFICIENT;
    result.approval_required = true;
  }
  result.rationale = templateRationale(result);
  return result;
}

function summarizePart(part, robotModel) {
  if (!part) return { part_number: null, in_inventory: false, available: 0 };
  return {
    part_number: part.part_number,
    description: part.description,
    status: part.status,
    bin: part.bin,
    qty_on_hand: part.qty_on_hand,
    qty_reserved: part.qty_reserved,
    available: availability(part),
    compatible_models: part.compatible_models,
    compatibility: compatibility(part, robotModel),
    in_inventory: true,
  };
}

function inventoryEvidence(part, excerpt, relation = 'exact') {
  return { ref: `INV:${part.part_number}`, source_type: 'inventory', source_label: SOURCE_LABEL.inventory, title: `Inventory record ${part.part_number}`, relation, excerpt };
}

// Installation guidance, quoted from the records that support the candidate plus the
// inventory record and KB articles about the part.
function installNotesFor(db, part, evidence, ctx) {
  if (!part) return [];
  const notes = [];
  const seen = new Set();
  const push = (text, ref) => {
    const key = text.toLowerCase();
    if (!seen.has(key)) { seen.add(key); notes.push({ text, ref }); }
  };
  if (part.install_notes) push(part.install_notes, `INV:${part.part_number}`);
  const refs = new Set(evidence.filter((e) => e.relation !== 'contradicts').map((e) => e.ref));
  const rows = db.prepare('SELECT * FROM knowledge').all();
  const p = parsePart(part.part_number);
  const famRe = familyRegex(p.family);
  for (const k of rows) {
    const mentionsPart = partMentions(k.body, { ...ctx, req: p, requested: part.part_number }).has(part.part_number);
    const kbForFamily = k.source_type === 'kb_article' && famRe.test(`${k.title} ${k.body}`);
    if (!(refs.has(k.ref) || (k.source_type === 'kb_article' && mentionsPart) || kbForFamily)) continue;
    for (const s of sentences(k.body)) if (CUES.install.test(s)) push(s, k.ref);
  }
  return notes;
}

const RELATION_TEXT = {
  supersession: 'documents a supersession',
  successful_swap: 'records a successful swap',
  tentative_use: 'records tentative use',
  swap_unconfirmed: 'records a swap without a confirmed outcome',
  contradicts: 'reports it does not fit',
  exact: 'exact inventory match',
};

export function templateRationale(r) {
  if (r.match_type === MATCH.EXACT) return r.rationale;
  const req = r.requested_part_record;
  const head = req
    ? `${r.requested_part} has no usable stock (${req.status}, ${req.available} available).`
    : `${r.requested_part} is not in inventory.`;
  if (!r.recommended) {
    return `${head} I searched ${r.sources_searched} maintenance records (${r.relevant_sources.length} relevant) and found no in-stock part with supporting evidence. Escalate to procurement or engineering.`;
  }
  const c = r.recommended;
  const ev = c.evidence.filter((e) => e.relation !== 'contradicts').map((e) => `${e.ref} (${e.source_label.toLowerCase()}) ${RELATION_TEXT[e.relation]}`).join('; ');
  const install = c.install_instructions.length ? ` Installation notes from ${[...new Set(c.install_instructions.map((n) => n.ref))].join(', ')} (see below).` : '';
  const others = r.candidates.filter((x) => x !== c).map((x) => `${x.part_number} (${x.match_type}, ${x.supporting_sources} source${x.supporting_sources === 1 ? '' : 's'})`);
  const excl = r.excluded.map((x) => `${x.part_number}: ${x.reason}`);
  return [
    `${head} I searched ${r.sources_searched} maintenance records and found ${r.relevant_sources.length} relevant ones, including entries that use different names for the part.`,
    `Recommendation: ${c.part_number}, classified as ${c.match_type}. Evidence: ${ev}.`,
    `${c.available} available in bin ${c.bin}.${install}`,
    c.warnings.length ? `Check: ${c.warnings.join(' ')}` : '',
    others.length ? `Other candidates: ${others.join('; ')}.` : '',
    excl.length ? `Excluded: ${excl.join('; ')}` : '',
    'A human must approve this substitute before it is reserved.',
  ].filter(Boolean).join(' ');
}
