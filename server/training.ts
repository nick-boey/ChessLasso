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
  if (
    typeof args.explanation !== 'string' ||
    !args.explanation.trim() ||
    args.explanation.length > 4000
  )
    throw new Error('Explain your choice of next activity in your own words.');
  let reviewPly: number | undefined;
  if (args.kind === 'review') {
    reviewPly =
      typeof args.reviewPly === 'number'
        ? args.reviewPly
        : Math.max(0, workspace.game.moves.length - 2);
    gameAtPly(workspace.game.pgn, reviewPly);
    if (reviewPly >= workspace.game.moves.length)
      throw new Error('Choose a position before the game ended for review.');
  } else if (args.kind === 'assessment-game') {
    if (
      typeof args.measurement !== 'string' ||
      !args.measurement.trim() ||
      args.measurement.length > 200
    )
      throw new Error('Specify what the next independent game will measure.');
  } else if (args.kind !== 'practice')
    throw new Error('Choose review, assessment-game or practice.');
  return {
    kind: args.kind,
    gameId: workspace.gameId,
    version: workspace.version,
    planHash: createHash('sha256').update(plan).digest('hex'),
    reviewPly,
    text: args.explanation,
  };
}
