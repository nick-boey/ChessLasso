import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { Chess } from 'chess.js';

const baseURL = process.env.CHESSLASSO_TEST_URL ?? 'http://127.0.0.1:5173';
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
const stored = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem('chesslasso-prototype-v1')));
const pgn = async () => (await stored()).pgn;
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
  await page.waitForFunction(() => localStorage.getItem('chesslasso-prototype-v1'));
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
    () =>
      JSON.parse(localStorage.getItem('chesslasso-prototype-v1')).pgn.includes('Nc3') &&
      document.querySelector('#move').value === '',
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
    const current = document.querySelector('.move-conversation:last-child').getBoundingClientRect();
    return Math.abs(current.top - feed.top) < 20;
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
  await page.getByRole('button', { name: 'Check notation', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /d3 is a legal candidate/);
  await page.keyboard.press('Escape');
  assert.equal(await pgn(), played);
  passed.push('Board question validates a candidate without modifying the game');

  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByLabel('Monthly model budget').selectOption('hard');
  await page.getByLabel('Amount in USD').fill('25');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('.move-context')?.textContent.includes('O-O'),
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
    () =>
      JSON.parse(localStorage.getItem('chesslasso-prototype-v1')).pgn.includes('e4') &&
      document.querySelector('#move').value === '',
  );
  passed.push('Disconnected submission preserves game and retries after reconnect');

  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  assert.match(await page.locator('main').innerText(), /Not assessed/);
  await page.getByRole('button', { name: 'Journal', exact: true }).click();
  assert.match(await page.locator('main').innerText(), /Example coaching meeting/);
  await page.getByRole('button', { name: 'Board', exact: true }).click();

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => localStorage.getItem('chesslasso-prototype-v1'));
  for (const width of [320, 390, 760, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(scrollWidth <= width, `Horizontal overflow at ${width}px: ${scrollWidth}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await move.fill('Nc3');
  await move.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.move-conversation').length === 2);
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
}
