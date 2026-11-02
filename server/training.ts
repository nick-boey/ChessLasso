import { createHash } from 'node:crypto';
import { gameAtPly } from '../src/lib/chess.js';
import type { Workspace } from './store.js';

export interface NextActivity {
  kind: 'review' | 'assessment-game' | 'practice';
  gameId: string;
  version: number;
  planningId?: string;
  planHash: string;
  reviewPly?: number;
  text: string;
}
const measurements = {
  'independent-decisions': 'your independent decisions',
  'opening-principles': 'your use of opening principles',
  calculation: 'your independent calculation',
};
export function chooseNextActivity(
  workspace: Workspace,
  plan: string,
  args: Record<string, unknown>,
): NextActivity {
  if (!workspace.game.over)
    throw new Error('Complete the current game before choosing a post-game activity.');
  if (
    typeof args.planExcerpt !== 'string' ||
    args.planExcerpt.trim().length < 10 ||
    args.planExcerpt.length > 1000 ||
    !plan.includes(args.planExcerpt)
  )
    throw new Error('Cite an exact excerpt from the current training plan.');
  let text: string;
  let reviewPly: number | undefined;
  if (args.kind === 'review') {
    reviewPly =
      typeof args.reviewPly === 'number'
        ? args.reviewPly
        : Math.max(0, workspace.game.moves.length - 2);
    gameAtPly(workspace.game.pgn, reviewPly);
    if (reviewPly >= workspace.game.moves.length)
      throw new Error('Choose a position before the game ended for review.');
    text =
      'Let’s review this game before adding more practice. We’ll look back at the selected position: what was your intention, and which reply were you expecting?';
  } else if (args.kind === 'assessment-game') {
    const measurement =
      typeof args.measurement === 'string'
        ? measurements[args.measurement as keyof typeof measurements]
        : undefined;
    if (!measurement) throw new Error('Specify what the next independent game will measure.');
    text = `We’re continuing with another independent game to observe ${measurement}. I’ll hold coaching until it ends so this remains an unassisted sample, then use it to decide what to work on.`;
  } else if (args.kind === 'practice') {
    text =
      'I’m choosing focused practice next, using the training plan below to set the activity rather than automatically starting another game.';
  } else throw new Error('Choose review, assessment-game or practice.');
  return {
    kind: args.kind,
    gameId: workspace.gameId,
    version: workspace.version,
    planHash: createHash('sha256').update(plan).digest('hex'),
    reviewPly,
    text: `I’ve reviewed your current training plan:\n\n> ${args.planExcerpt.split('\n').join('\n> ')}\n\n${text}`,
  };
}
