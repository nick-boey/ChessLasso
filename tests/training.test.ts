import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Runtime } from '../server/runtime.js';
import { CoachRuntime } from '../server/coach.js';
import { snapshot } from '../src/lib/chess.js';
import { createApp } from '../server/app.js';

const plan = 'Measure independent opening decisions across three games.';
for (const kind of ['review', 'assessment-game'] as const) {
  void test(`the coach consults the plan after an observed loss and chooses ${kind}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lasso-training-'));
    const host = new Runtime(directory);
    try {
      const board = new Chess();
      board.move('f3');
      board.move('e5');
      const workspace = host.store.workspace();
      workspace.game = snapshot(board);
      workspace.mode = 'live';
      workspace.quiet = true;
      host.store.save(workspace);
      host.store.write('plans/current.md', '# Training plan\n\n' + plan);
      host.engine = { play: async () => 'd8h4', analyze: async () => ({}) };
      let calls = 0;
      host.coach = new CoachRuntime({
        sessionsDir: host.sessionDirectory(),
        getSettings: () => ({ mode: 'mock', provider: 'google', model: 'gemini-3.8-flash' }),
        getPrompt: async () => ({ text: host.prompts('coach'), version: 'test' }),
        invokeTool: (name, args, context) => host.tool(name, args, 'coach', context),
        mockResponses: (_message, context) => {
          calls++;
          assert.match(String(context.plan), /Measure independent opening/);
          assert.equal(context.postGamePlanning, true);
          return [
            fauxAssistantMessage(
              fauxToolCall('choose_next_activity', {
                version: context.version,
                kind,
                planExcerpt: plan,
                ...(kind === 'review' ? { reviewPly: 2 } : { measurement: 'opening-principles' }),
              }),
            ),
            ...(kind === 'assessment-game'
              ? [
                  fauxAssistantMessage(
                    fauxToolCall('start_activity', {
                      version: context.version,
                      fen: new Chess().fen(),
                      quiet: true,
                      activityType: 'observation',
                    }),
                  ),
                ]
              : []),
            fauxAssistantMessage(
              'The e2 pawn attacks d3. This unrelated prose must remain hidden.',
            ),
          ];
        },
      });
      const api = createApp(host, { authentication: false });
      const result = await api.request('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notation: 'g4', version: workspace.version, commandId: 'loss' }),
      });
      assert.equal(result.status, 200);
      const response = await result.json();
      assert.equal(calls, 1);
      assert.match(response.note, /Black won by checkmate/);
      assert.match(response.note, /training plan/);
      assert.match(response.note, /Measure independent opening/);
      assert.doesNotMatch(response.note, /e2 pawn|unrelated prose|could not verify/);
      if (kind === 'review') {
        assert.equal(response.workspace.gameId, workspace.gameId);
        assert.equal(response.workspace.game.over, true);
        assert.equal(response.reviewPly, 2);
        assert.match(response.note, /review/i);
      } else {
        assert.notEqual(response.workspace.gameId, workspace.gameId);
        assert.equal(response.workspace.quiet, true);
        assert.match(response.note, /another independent game/);
        assert.match(response.note, /opening principles/);
      }
    } finally {
      host.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

void test('post-game board replacement requires a plan-backed coach decision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lasso-training-guard-'));
  const host = new Runtime(directory);
  try {
    const workspace = host.store.workspace();
    workspace.game = snapshot(new Chess('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'));
    host.store.save(workspace);
    const context = { ...host.coachContext(), postGamePlanning: true };
    await assert.rejects(
      host.tool(
        'start_activity',
        { version: workspace.version, fen: new Chess().fen() },
        'coach',
        context,
      ),
      /choose.*next activity/i,
    );
    await assert.rejects(
      host.tool(
        'choose_next_activity',
        {
          version: workspace.version,
          kind: 'assessment-game',
          measurement: 'opening-principles',
          planExcerpt: 'Invented plan',
        },
        'coach',
        context,
      ),
      /current training plan/i,
    );
    const planning = { ...context, planningId: 'turn-one' };
    await host.tool(
      'choose_next_activity',
      {
        version: workspace.version,
        kind: 'assessment-game',
        measurement: 'opening-principles',
        planExcerpt: host.store.read('plans/current.md').slice(0, 200),
      },
      'coach',
      planning,
    );
    const setup = { version: workspace.version, fen: new Chess().fen(), quiet: true };
    await assert.rejects(
      host.tool('start_activity', setup, 'coach', { ...planning, planningId: 'turn-two' }),
      /choose.*next activity/i,
    );
    host.store.write(
      'plans/current.md',
      'Review this completed game before beginning more independent games.',
    );
    await assert.rejects(
      host.tool('start_activity', setup, 'coach', planning),
      /choose.*next activity/i,
    );
    assert.deepEqual(host.store.workspace().game, workspace.game);
  } finally {
    host.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
