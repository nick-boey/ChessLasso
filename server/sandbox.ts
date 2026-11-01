import { getQuickJS } from 'quickjs-emscripten';

export type SearchFile = { path: string; text: string };

/** Runs against a supplied snapshot; the VM never receives host filesystem/network handles. */
export async function searchArchive(script: string, files: SearchFile[]): Promise<unknown> {
  if (typeof script !== 'string' || script.length > 32_768)
    throw new Error('Search script too large');
  if (
    files.length > 500 ||
    files.some(
      (file) =>
        !/^[\w./ -]+$/.test(file.path) ||
        file.path.startsWith('/') ||
        file.path.split('/').includes('..') ||
        typeof file.text !== 'string',
    )
  ) {
    throw new Error('Invalid search snapshot');
  }
  const input = JSON.stringify(files);
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error('Search snapshot too large');
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = performance.now() + 2_000;
  runtime.setInterruptHandler(() => performance.now() > deadline);
  const context = runtime.newContext();
  try {
    const result = context.evalCode(
      `'use strict';
      const files = ${input};
      for (const file of files) Object.freeze(file);
      Object.freeze(files);
      const answer = (() => { ${script}\n })();
      const output = JSON.stringify(answer ?? null);
      if (output.length > 65536) throw new Error('Search output too large');
      output;`,
      'archive-search.js',
    );
    if (result.error) {
      result.error.dispose();
      throw new Error('Search failed: invalid script, resource limit, or unavailable capability');
    }
    try {
      const output = context.getString(result.value);
      if (Buffer.byteLength(output) > 65_536) throw new Error('Search output too large');
      return JSON.parse(output);
    } finally {
      result.value.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
