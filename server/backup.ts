import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';
const exec = promisify(execFile);
export class Backup {
  private running = false;
  constructor(
    private store: Store,
    private remote = process.env.CHESSLASSO_ARCHIVE_REPO ?? 'nick-boey/ChessLasso-coaching',
  ) {}
  async checkpoint() {
    if (this.running) return;
    this.running = true;
    try {
      this.store.flushEvents();
      this.store.checkpoint();
      const visibility = await exec(
        'gh',
        ['repo', 'view', this.remote, '--json', 'visibility', '--jq', '.visibility'],
        { timeout: 15000 },
      );
      if (visibility.stdout.trim() !== 'PRIVATE')
        throw new Error('Backup repository must be private.');
      const cwd = this.store.archive;
      if (!existsSync(join(cwd, '.git'))) await exec('git', ['init', '-b', 'main'], { cwd });
      const remotes = (await exec('git', ['remote'], { cwd })).stdout.trim().split('\n');
      const url = `https://github.com/${this.remote}.git`;
      if (!remotes.includes('origin')) await exec('git', ['remote', 'add', 'origin', url], { cwd });
      const actual = (await exec('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();
      if (actual !== url && actual !== `git@github.com:${this.remote}.git`)
        throw new Error('Archive remote does not match the verified private repository.');
      const files = this.store.files();
      if (
        Object.values(files).some((text) =>
          /(?:AIza[\w-]{25,}|gh[pousr]_[\w]{20,}|-----BEGIN .*PRIVATE KEY-----)/.test(text),
        )
      )
        throw new Error('Possible credential found in coaching archive; backup stopped.');
      await exec('git', ['add', '--', 'profile', 'plans', 'backlog'], { cwd });
      for (const dir of [
        'games',
        'diary',
        'events',
        'sessions',
        'meetings',
        'prompts',
        'releases',
        'research',
        'workspace',
      ])
        if (existsSync(join(cwd, dir))) await exec('git', ['add', '--', dir], { cwd });
      const dirty = (await exec('git', ['diff', '--cached', '--name-only'], { cwd })).stdout.trim();
      if (dirty)
        await exec('git', ['commit', '-m', `Coaching checkpoint ${new Date().toISOString()}`], {
          cwd,
          timeout: 30000,
        });
      await exec('git', ['push', '-u', 'origin', 'main'], { cwd, timeout: 45000 });
      this.store.put('backup', { ok: true, at: new Date().toISOString(), pending: false });
    } catch (error) {
      this.store.put('backup', {
        ok: false,
        at: new Date().toISOString(),
        pending: true,
        error:
          error instanceof Error
            ? error.message.replace(/https?:\/\/\S+/g, '[remote]')
            : 'Backup unavailable',
      });
    } finally {
      this.running = false;
    }
  }
}
