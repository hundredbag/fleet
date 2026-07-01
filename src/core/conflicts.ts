import type { Inventory, RuleCapability } from './types.js';
import { surfaceOf } from './types.js';

/**
 * Semantic / impact analysis (Part C). The real hazard is opposing intent among
 * **always-on** capabilities (rules co-present every turn) — gated capabilities
 * (MCP tools, skills) rarely interfere. This is a deliberately SHALLOW,
 * heuristic, keyword-axis detector with light negation + word-boundary guards.
 * It flags *candidates* (low confidence); it does NOT claim certainty, and it
 * only sees fleet-managed rule blocks (not hand-written instruction prose).
 * Real semantic judgement is the central hub's job (LLM-scored) — inject it via
 * the `judge` parameter; `AXES`/`detectOpposition` are the offline fallback.
 */

export type Confidence = 'low' | 'medium' | 'high';

export const RESOLUTION_HINT =
  'resolve by scoping one to a sub-agent, setting precedence, or making it a triggered skill instead of always-on';

interface Axis {
  name: string;
  a: string[];
  b: string[];
}

const AXES: Axis[] = [
  {
    name: 'verbosity',
    a: ['terse', 'brief', 'concise', 'succinct', 'minimal', 'short answer', 'keep it short'],
    b: [
      'verbose',
      'detailed',
      'thorough',
      'elaborate',
      'comprehensive',
      'exhaustive',
      'in depth',
      'in-depth',
      'at length',
    ],
  },
  {
    name: 'autonomy',
    a: ['ask first', 'ask before', 'confirm before', 'require approval', 'wait for approval'],
    b: ['without asking', 'autonomously', 'do not ask', "don't ask", 'just do it', 'no confirmation'],
  },
  {
    name: 'tone',
    a: ['formal tone', 'professional'],
    b: ['casual', 'informal', 'playful', 'friendly tone'],
  },
];

const NEG_TAIL = /(?:\b(?:not|never|avoid|without|no|cannot|dont)\b|n['’]t)[\s\S]{0,12}$/i;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if `kw` occurs as a whole token AND not immediately negated. */
function occursAffirmatively(text: string, kw: string): boolean {
  const re = new RegExp(`(^|[^a-z])${esc(kw)}(?![a-z])`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index + (m[1] ? m[1].length : 0));
    if (!NEG_TAIL.test(before)) return true; // a non-negated occurrence
  }
  return false;
}

function polesOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const ax of AXES) {
    if (ax.a.some((k) => occursAffirmatively(text, k))) out.add(`${ax.name}:a`);
    if (ax.b.some((k) => occursAffirmatively(text, k))) out.add(`${ax.name}:b`);
  }
  return out;
}

/** The axis on which two texts take OPPOSITE poles, or null (heuristic). */
export function detectOpposition(textA: string, textB: string): string | null {
  const pa = polesOf(textA);
  const pb = polesOf(textB);
  for (const ax of AXES) {
    if (
      (pa.has(`${ax.name}:a`) && pb.has(`${ax.name}:b`)) ||
      (pa.has(`${ax.name}:b`) && pb.has(`${ax.name}:a`))
    ) {
      return ax.name;
    }
  }
  return null;
}

export type Judge = (textA: string, textB: string) => string | null;

export interface ConflictFinding {
  agent: string;
  a: string;
  b: string;
  axis: string;
  confidence: Confidence;
  suggestion: string;
}

/** Heuristic conflicts among always-on rules co-present on the SAME agent. */
export function analyzeConflicts(inv: Inventory, judge: Judge = detectOpposition): ConflictFinding[] {
  const rules = inv.items.filter(
    (i): i is RuleCapability => i.kind === 'rule' && surfaceOf(i.kind) === 'always-on',
  );
  const byAgent = new Map<string, RuleCapability[]>();
  for (const r of rules) {
    const list = byAgent.get(r.agent) ?? [];
    list.push(r);
    byAgent.set(r.agent, list);
  }
  const findings: ConflictFinding[] = [];
  for (const [agent, rs] of byAgent) {
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const axis = judge(rs[i]!.body, rs[j]!.body);
        if (axis) {
          findings.push({
            agent,
            a: rs[i]!.name,
            b: rs[j]!.name,
            axis,
            confidence: 'low',
            suggestion: RESOLUTION_HINT,
          });
        }
      }
    }
  }
  return findings;
}

/** Existing always-on rules whose intent opposes `body` (for install-time impact). */
export function opposingRules(
  rules: RuleCapability[],
  body: string,
  exceptName: string,
  judge: Judge = detectOpposition,
): { name: string; axis: string }[] {
  return rules
    .filter((r) => r.name !== exceptName)
    .map((r) => ({ name: r.name, axis: judge(body, r.body) }))
    .filter((x): x is { name: string; axis: string } => x.axis !== null);
}
