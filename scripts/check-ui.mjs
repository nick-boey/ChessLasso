import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';

const baseURL = process.env.CHESSLASSO_TEST_URL ?? 'http://127.0.0.1:4174';
const temporary = await mkdtemp(join(tmpdir(), 'chesslasso-browser-'));
let server;
if (!process.env.CHESSLASSO_TEST_URL) {
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
  assert.equal(build.status, 0);
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: '4174',
      CHESSLASSO_RUNTIME_DIR: join(temporary, 'runtime'),
      CHESSLASSO_ARCHIVE_DIR: join(temporary, 'archive'),
      CHESSLASSO_ORIGINS: baseURL,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupError = '';
  server.stderr.on('data', (chunk) => (startupError += chunk.toString()));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(baseURL + '/api/health')).ok) break;
    } catch {}
    if (server.exitCode !== null) throw new Error('Test server failed: ' + startupError);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const output = 'output/playwright';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const errors = [];
const passed = [];
page.on('pageerror', (error) => errors.push(error.message));
const stored = async () => await (await fetch(baseURL + '/api/state')).json();
const pgn = async () => (await stored()).game.pgn;
const move = page.getByRole('textbox', { name: 'Your move', exact: true });
const chat = page.getByRole('textbox', { name: 'Message your coach' });
const send = async (text) => {
  await chat.fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Hint', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.quick-actions button')?.disabled);
};

try {
  await page.goto(baseURL);
  await page.waitForFunction(() => !document.querySelector('#move')?.disabled);
  const initial = await pgn();
  assert.equal(await page.locator('.activity-heading h1').innerText(), 'Development & king safety');
  assert.equal(await page.getByRole('button', { name: 'New game', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /download|export/i }).count(), 0);
  assert.equal(await page.getByText('Practice partner', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Play move', exact: true }).innerText(), '');
  assert.equal(
    await page.getByRole('button', { name: 'Notation guide', exact: true }).innerText(),
    '',
  );
  const beforeClick = await pgn();
  await page.locator('.board-frame').click({ position: { x: 40, y: 40 } });
  assert.equal(await pgn(), beforeClick);
  passed.push(
    'Coach task heading, icon-only move controls and no opponent/new-game/download controls',
  );

  await move.fill('e2e4');
  await move.press('Enter');
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /short algebraic notation/);
  assert.equal(await pgn(), initial);
  await page.keyboard.press('Escape');
  assert.equal(await move.inputValue(), 'e2e4');
  assert.equal(await move.evaluate((element) => element === document.activeElement), true);
  passed.push('Invalid notation opens guide, preserves input/position and restores focus');

  await move.fill('Nc3');
  await move.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('#move').value === '' && !document.querySelector('#move').disabled,
  );
  let played = await pgn();
  const chess = new Chess();
  chess.loadPgn(played);
  assert.equal(chess.history().length, 8);
  assert.equal(chess.history()[6], 'Nc3');
  await page.getByRole('button', { name: 'Flip board', exact: true }).click();
  assert.equal(await page.locator('.board-frame .orientation-black').count(), 1);
  await page.getByRole('button', { name: 'Flip board', exact: true }).click();
  passed.push('Keyboard move validated on server, legal reply played and orientation toggles');

  const previousConversation = await page.locator('.move-conversation').last().innerText();
  assert.equal(await page.locator('.move-conversation').count(), 2);
  await move.fill('O-O');
  await move.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.move-conversation').length === 3);
  assert.equal(await page.locator('.move-conversation').nth(1).innerText(), previousConversation);
  assert.match(await page.locator('.move-conversation').last().innerText(), /5\. O-O/);
  assert.ok(await page.locator('.move-conversation').last().locator('.message').count());
  await page.waitForFunction(() => {
    const feed = document.querySelector('.transcript').getBoundingClientRect();
    const current = document
      .querySelector('.move-conversation:last-child .message:last-child')
      .getBoundingClientRect();
    return current.top >= feed.top && current.bottom <= feed.bottom;
  });
  played = await pgn();
  passed.push(
    'Every accepted move creates a position-linked conversation and scrolls its instructions into view',
  );

  await page.getByRole('button', { name: 'Example', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Go to step 4', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /Get the king safe/);
  await page.waitForFunction(() => {
    const board = document.querySelector('dialog cg-board')?.getBoundingClientRect();
    const king = document.querySelector('dialog piece.white.king')?.getBoundingClientRect();
    return board && king && Math.abs((king.x - board.x) / board.width - 0.75) < 0.01;
  });
  await page.screenshot({ path: `${output}/demonstration.png` });
  await page.getByRole('button', { name: 'Back to my game', exact: true }).click();
  assert.equal(await pgn(), played);
  passed.push('Annotated demonstration changes steps without modifying the game');

  await send('I am considering developing a piece');
  await page.getByRole('button', { name: 'Open question board', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your candidate move', exact: true }).fill('d3');
  await page.getByRole('button', { name: 'Check candidate', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByText(/d3 is a legal candidate/)
    .waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /d3 is a legal candidate/);
  await page.keyboard.press('Escape');
  assert.equal(await pgn(), played);
  passed.push('Board question validates a candidate without modifying the game');

  const markdown = [
    '### Candidate moves',
    '**Develop** a piece, *then* compare `Nf3` and ~~h4~~.',
    '1. Check threats.\n2. Compare candidates.\n   - Keep the king safe.',
    '> Look for forcing moves.',
    '[Reference](https://example.com/chess) [Unsafe](javascript:alert%281%29)',
    '![Tracking image](https://example.com/pixel.png)',
    '<script>window.markdownExecuted = true</script><img src="x" onerror="window.markdownExecuted = true"><svg onload="window.markdownExecuted = true"></svg><a href="data:text/html,unsafe">Unsafe data</a>',
    '| Move | Idea |\n| --- | --- |\n| Nf3 | Develop |',
    '```text\n' + 'Nf3 '.repeat(120) + '\n```',
    ...Array.from(
      { length: 12 },
      (_, index) => `Consideration ${index + 1}: compare the resulting position before committing.`,
    ),
  ].join('\n\n');
  let releaseReply;
  const replyGate = new Promise((resolve) => (releaseReply = resolve));
  let requestStarted;
  const requestGate = new Promise((resolve) => (requestStarted = resolve));
  await page.route('**/api/coach', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.text = markdown;
    body.workspace.conversations.at(-1).messages.at(-1).text = markdown;
    requestStarted();
    await replyGate;
    await route.fulfill({ response, json: body });
  });
  const pendingReply = send('Compare **Nf3** with *h4*.');
  await requestGate;
  await page.waitForFunction(() => {
    const feed = document.querySelector('.transcript').getBoundingClientRect();
    const current = document
      .querySelector('.message.from-player:last-child')
      ?.getBoundingClientRect();
    return current && current.top >= feed.top && current.bottom <= feed.bottom;
  });
  assert.equal(
    await page.locator('.message.from-player').last().locator('strong').innerText(),
    'Nf3',
  );
  releaseReply();
  await pendingReply;
  await page.unroute('**/api/coach');
  const formatted = page.locator('.message').last().locator('.message-content');
  assert.equal(await formatted.locator('h3').innerText(), 'Candidate moves');
  assert.equal(await formatted.locator('strong').innerText(), 'Develop');
  assert.equal(await formatted.locator('em').innerText(), 'then');
  assert.equal(await formatted.locator('del').innerText(), 'h4');
  assert.equal(await formatted.locator('ol > li').count(), 2);
  assert.equal(await formatted.locator('ul > li').count(), 1);
  assert.equal(await formatted.locator('blockquote').innerText(), 'Look for forcing moves.');
  assert.equal(await formatted.locator('table tbody td').count(), 2);
  assert.equal(await formatted.locator('pre code').count(), 1);
  assert.equal(
    await formatted.getByRole('link', { name: 'Reference' }).getAttribute('href'),
    'https://example.com/chess',
  );
  assert.equal(
    await formatted
      .locator('script, img, svg, [onerror], [onload], a[href^="javascript:"], a[href^="data:"]')
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
  await page.waitForFunction(() => {
    const feed = document.querySelector('.transcript').getBoundingClientRect();
    const current = document
      .querySelector('.move-conversation:last-child .message:last-child')
      .getBoundingClientRect();
    return Math.abs(current.top - feed.top - 8) < 2;
  });
  await page.screenshot({ path: `${output}/markdown-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await formatted.evaluate((element) => element.scrollWidth <= element.clientWidth));
  await page.screenshot({ path: `${output}/markdown-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await send('What should I consider next?');
  await page.waitForFunction(() => {
    const feed = document.querySelector('.transcript').getBoundingClientRect();
    const current = document
      .querySelector('.move-conversation:last-child .message:last-child')
      .getBoundingClientRect();
    return current.top >= feed.top && current.bottom <= feed.bottom;
  });
  passed.push('Chat Markdown formats both roles, sanitizes unsafe content and fits mobile');
  passed.push(
    'Each sent message and coach reply scrolls into view, including long replies within one move',
  );

  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByLabel('Monthly model budget').selectOption('hard');
  await page.getByLabel('Amount in USD').fill('25');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector('.move-conversation:last-child .move-context')
      ?.textContent.includes('O-O'),
  );
  assert.deepEqual((await stored()).budget, { mode: 'hard', amount: 25 });
  assert.equal(await pgn(), played);
  passed.push('Budget preference and PGN survive reload');

  const beforeHeading = await pgn();
  await send('Focus on calculation');
  assert.equal(await page.locator('.activity-heading h1').innerText(), 'Compare candidate moves');
  assert.equal(await pgn(), beforeHeading);
  passed.push('Coach changes the task heading/subtitle independently of board state');

  await send('Set up an endgame');
  assert.match(await pgn(), /\[SetUp "1"\]/);
  assert.equal(await page.locator('.activity-heading h1').innerText(), 'Activate your king');
  await send('Start a new game');
  assert.equal((await stored()).quiet, true);
  await page.getByRole('button', { name: 'Resume coaching', exact: true }).click();
  await page.getByRole('button', { name: 'Observe', exact: true }).waitFor();
  passed.push(
    'Coach setup actions load a custom position/full game and observation can be resumed',
  );

  const beforeOffline = await pgn();
  await context.setOffline(true);
  await move.fill('e4');
  await move.press('Enter');
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /disconnected/);
  assert.equal(await pgn(), beforeOffline);
  await context.setOffline(false);
  await move.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('#move').value === '' && !document.querySelector('#move').disabled,
  );
  passed.push('Disconnected submission preserves game and retries after reconnect');

  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  assert.match(await page.locator('main').innerText(), /Baseline not assessed/);
  await page.getByRole('button', { name: 'Journal', exact: true }).click();
  assert.match(await page.locator('main').innerText(), /Coaching diary/);
  await page.getByRole('button', { name: 'Board', exact: true }).click();

  await send('Start a new game');
  await send('Resume coaching and help again');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#move')?.disabled);
  for (const width of [320, 390, 760, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(scrollWidth <= width, `Horizontal overflow at ${width}px: ${scrollWidth}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const conversationCount = await page.locator('.move-conversation').count();
  await move.fill('e4');
  await move.press('Enter');
  await page.waitForFunction(
    (count) => document.querySelectorAll('.move-conversation').length === count + 1,
    conversationCount,
  );
  await page.waitForFunction(() => {
    const current = document.querySelector('.move-conversation:last-child').getBoundingClientRect();
    return current.top >= 0 && current.top < innerHeight;
  });
  passed.push('Mobile move submission reveals current coaching instructions');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  passed.push('Responsive layout has no horizontal overflow at 320, 390, 760, 1024 and 1440px');
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/checks.json`,
    JSON.stringify(
      { baseURL, checkedAt: new Date().toISOString(), passed, pageErrors: errors },
      null,
      2,
    ),
  );
  console.log(
    `${passed.length} browser checks passed. Screenshots: ${output}/desktop.png, mobile.png, demonstration.png`,
  );
} finally {
  await browser.close();
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
