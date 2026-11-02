/** Agent-owned teaching configuration. Operational permissions and tool contracts stay in code. */
export const teachingPromptNames = [
  'coach',
  'assistant-coach',
  'assistant',
  'consolidation',
  'planner',
  'retro',
  'question-feedback',
  'after-move',
  'opponent',
  'game-complete',
  'daily',
] as const;
export function isTeachingPrompt(value: unknown): value is (typeof teachingPromptNames)[number] {
  return typeof value === 'string' && teachingPromptNames.some((name) => name === value);
}
