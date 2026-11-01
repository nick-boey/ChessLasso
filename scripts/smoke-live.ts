import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { CoachRuntime } from '../server/coach.js';

const provider = process.env.CHESSLASSO_PROVIDER === 'fireworks' ? 'fireworks' : 'google';
const model = process.env.CHESSLASSO_MODEL ?? 'gemini-3.8-flash';
const directory = await mkdtemp(join(tmpdir(), 'chesslasso-live-check-'));
const context = { fen: new Chess().fen(), pgn: '', version: 0 };
const runtime = new CoachRuntime({
  sessionsDir: directory,
  getSettings: () => ({ mode: 'live', provider, model, timeoutMs: 45000 }),
  getPrompt: async () => ({
    text: await readFile('config/prompts/coach.md', 'utf8'),
    version: 'live-check',
  }),
  invokeTool: async (name) => {
    if (name !== 'inspect_board')
      throw new Error('Smoke check permits only board inspection and engine analysis.');
    return context;
  },
});
try {
  const result = await runtime.run(await readFile('config/prompts/live-smoke.md', 'utf8'), context);
  assert.ok(result.actions.some((action) => action.name === 'inspect_board'));
  assert.ok(result.actions.some((action) => action.name === 'analyse_position'));
  assert.ok(result.text.trim());
  console.log(
    JSON.stringify({
      ok: true,
      provider,
      model,
      tools: result.actions.map((action) => action.name),
      usage: result.usage,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      provider,
      model,
      error:
        error instanceof Error &&
        /^(?:Coach turn|Provider request|The configured model|Missing |Smoke check|Host did)/.test(
          error.message,
        )
          ? error.message
          : 'Live tool check failed. Verify model access, provider credentials, connectivity and quota.',
    }),
  );
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
