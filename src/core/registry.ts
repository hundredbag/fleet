import type { AgentAdapter } from './adapter.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';

/**
 * The built-in adapters. Custom agents (e.g. Hermes) will register here too
 * — that "bring your own agent" path is the differentiator, but for v1 these
 * three cover the user's stack.
 */
export function defaultAdapters(): AgentAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter(), new GeminiAdapter()];
}
