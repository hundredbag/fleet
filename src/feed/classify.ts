import type { FeedItem } from './source.js';

/**
 * Capability categorization. v1 is a transparent keyword heuristic over the
 * item's name/description; the classifier is an INJECTABLE seam (like the
 * recommend Scorer and the conflict judge) so a vector/LLM classifier — and
 * semantic "find me a skill that does X" search — can replace it without
 * touching callers.
 */
export type Classifier = (item: FeedItem) => string;

const RULES: [category: string, re: RegExp][] = [
  ['git/vcs', /\b(git|github|gitlab|commit|branch|merge|rebase|pull-?request|pr)\b/i],
  ['testing', /\b(test|tdd|e2e|coverage|vitest|jest|playwright-test|unit)\b/i],
  ['docs/writing', /\b(doc|docs|documentation|readme|writing|blog|markdown|changelog)\b/i],
  ['data/db', /\b(sql|database|db|postgres|mysql|sqlite|mongo|redis|analytics|etl|csv)\b/i],
  ['web/browser', /\b(browser|web|playwright|puppeteer|scrape|screenshot|dom|css|frontend|react|vue)\b/i],
  ['devops/cloud', /\b(deploy|docker|kubernetes|k8s|terraform|aws|gcp|azure|ci|cd|infra|cloud|actions)\b/i],
  ['security', /\b(secur|auth|oauth|secret|vulnerab|pentest|crypto|audit)\b/i],
  ['design/media', /\b(design|figma|image|video|audio|diagram|excalidraw|svg|ui|ux)\b/i],
  ['ai/agents', /\b(agent|llm|prompt|mcp|claude|gpt|gemini|codex|rag|embedding)\b/i],
  ['productivity', /\b(task|todo|note|calendar|email|slack|jira|linear|notion)\b/i],
];

/** Default keyword classifier: first matching category, else 'other'. */
export const defaultClassifier: Classifier = (item) => {
  const text = `${item.name} ${item.identifier ?? ''} ${item.description ?? ''}`;
  for (const [category, re] of RULES) if (re.test(text)) return category;
  return 'other';
};
