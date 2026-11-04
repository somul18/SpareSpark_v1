// Optional LLM layer (Claude). The retrieval engine in knowledge.js makes every decision
// and gathers every source; Claude only writes the explanation and answers coordinator
// chat, grounded on that evidence. Answers that mention a part number or source reference
// that is not in the evidence are discarded and the deterministic text is used instead.
//
// Enabled when ANTHROPIC_API_KEY is set and @anthropic-ai/sdk is installed.

const MODEL = process.env.SPARESPARK_MODEL || 'claude-opus-5-5';
let clientPromise = null;

async function getClient() {
  if (!process.env.ANTHROPIC_API_KEY || process.env.SPARESPARK_LLM === 'off') return null;
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then(({ default: Anthropic }) => new Anthropic())
      .catch(() => null);
  }
  return clientPromise;
}

export async function llmEnabled() {
  return !!(await getClient());
}

const SYSTEM = `You are the Spare Parts Agent in SpareSpark, an industrial maintenance application.
You explain spare-part recommendations to a Logistics Parts Coordinator.
Rules:
- Use only the facts in the EVIDENCE JSON. Never invent parts, compatibility claims, stock levels or sources.
- Cite sources by their exact ref (for example WO-1187) whenever you state a fact from them.
- Do not give numerical compatibility percentages. Use the match classification given (Exact, Documented Supersession, Potential Alternative, Insufficient Evidence).
- Mention installation requirements and any warnings.
- Keep it short and plain: at most 120 words, no markdown headings.`;

function compactEvidence(rec) {
  const pick = (c) => c && {
    part_number: c.part_number, match_type: c.match_type, available: c.available, bin: c.bin,
    compatibility: c.compatibility, warnings: c.warnings,
    evidence: (c.evidence || []).map((e) => ({ ref: e.ref, type: e.source_label, relation: e.relation, excerpt: e.excerpt })),
    install_instructions: c.install_instructions,
  };
  return {
    requested_part: rec.requested_part,
    requested_part_record: rec.requested_part_record,
    robot_model: rec.robot_model,
    match_type: rec.match_type,
    sources_searched: rec.sources_searched,
    relevant_sources: rec.relevant_sources.map((s) => ({ ref: s.ref, type: s.source_label, matched_terms: s.matched_terms })),
    recommended: pick(rec.recommended),
    other_candidates: rec.candidates.filter((c) => c !== rec.recommended).map(pick),
    excluded: rec.excluded.map((x) => ({ ...pick(x), reason: x.reason })),
    install_instructions: rec.install_instructions,
  };
}

// Reject answers that cite anything not present in the evidence.
export function isGrounded(text, rec) {
  const allowedRefs = new Set();
  const allowedParts = new Set([rec.requested_part]);
  for (const s of rec.relevant_sources) allowedRefs.add(s.ref.toUpperCase());
  for (const c of [...rec.candidates, ...rec.excluded, rec.recommended].filter(Boolean)) {
    allowedParts.add(c.part_number);
    for (const e of c.evidence || []) allowedRefs.add(e.ref.toUpperCase());
  }
  for (const n of rec.install_instructions || []) allowedRefs.add(n.ref.toUpperCase());
  const refs = text.match(/\b(?:KB\d{4,}|WO-\d+|TN-\d+|MH-\d+)\b/gi) || [];
  if (refs.some((r) => !allowedRefs.has(r.toUpperCase()))) return false;
  const parts = text.match(/\b[A-Z]{2,4}-\d{2,4}-[A-Z0-9]{1,3}\b/g) || [];
  if (parts.some((p) => !allowedParts.has(p))) return false;
  if (/\d{1,3}\s?%/.test(text)) return false;
  return true;
}

async function ask(userText, rec) {
  const client = await getClient();
  if (!client) return null;
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages: [{ role: 'user', content: `EVIDENCE:\n${JSON.stringify(compactEvidence(rec), null, 1)}\n\n${userText}` }],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text || !isGrounded(text, rec)) return null;
    return text;
  } catch (err) {
    console.warn('[llm] falling back to deterministic text:', err?.message || err);
    return null;
  }
}

export async function explainRecommendation(rec) {
  return ask('Explain the recommendation to the coordinator.', rec);
}

export async function answerChat(question, rec) {
  return ask(`The coordinator asks: "${question.slice(0, 1000)}"\nAnswer using the evidence.`, rec);
}
