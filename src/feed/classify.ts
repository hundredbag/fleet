import type { FeedItem } from './source.js';

/**
 * Capability categorization. v1 is a transparent keyword heuristic over the
 * item's name/description; the classifier is an INJECTABLE seam (like the
 * recommend Scorer and the conflict judge) so a vector/LLM classifier — and
 * semantic "find me a skill that does X" search — can replace it without
 * touching callers.
 */
export type Classifier = (item: FeedItem) => string;

// NOTE: stems use `\w*` (not a trailing \b) so 'testing'/'security-scanner'
// still match; `\bauth\b` stays whole-word so 'author' doesn't read as security.
const RULES: [category: string, re: RegExp][] = [
  ['git/vcs', /\b(git\w*|github|gitlab|commit\w*|branch\w*|merge|rebase|pull-?request|pr)\b/i],
  ['testing', /\b(test\w*|tdd|e2e|coverage|vitest|jest|unit-test\w*)\b/i],
  ['docs/writing', /\b(docs?\b|document\w*|readme|writing|blog\w*|markdown|changelog)/i],
  ['data/db', /\b(sql|database\w*|db|postgres\w*|mysql|sqlite|mongo\w*|redis|analytics|etl|csv)\b/i],
  [
    'web/browser',
    /\b(browser|web|playwright|puppeteer|scrap\w*|screenshot\w*|dom|css|frontend|react|vue)\b/i,
  ],
  [
    'devops/cloud',
    /\b(deploy\w*|docker|kubernetes|k8s|terraform|aws|gcp|azure|ci|cd|infra\w*|cloud|actions)\b/i,
  ],
  [
    'security',
    /\b(secur\w*|authenticat\w*|authoriz\w*|auth\b|oauth|secret\w*|vulnerab\w*|pentest\w*|crypto|audit\w*)/i,
  ],
  ['design/media', /\b(design\w*|figma|image\w*|video\w*|audio|diagram\w*|excalidraw|svg|ui|ux)\b/i],
  ['ai/agents', /\b(agent\w*|llm|prompt\w*|mcp|claude|gpt|gemini|codex|rag|embedding\w*)\b/i],
  ['productivity', /\b(task\w*|todo|note\w*|calendar|email|slack|jira|linear|notion)\b/i],
];

/** Default keyword classifier: first matching category, else 'other'. */
export const defaultClassifier: Classifier = (item) => {
  const text = `${item.name} ${item.identifier ?? ''} ${item.description ?? ''}`;
  for (const [category, re] of RULES) if (re.test(text)) return category;
  return 'other';
};
