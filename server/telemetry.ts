import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { context, propagation, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  createSignals,
  operations,
  safeAttributes,
  type Diagnostic,
  type Signal,
} from '../src/lib/telemetry.js';

const retentionMs = 90 * 24 * 60 * 60_000;
const signalNames: Signal[] = ['traces', 'logs', 'metrics'];
type Envelope = { receivedAt: number; signal: Signal; records: Diagnostic[] };

function safeRecord(input: unknown): Diagnostic | null {
  if (!input || typeof input !== 'object') return null;
  const item = input as Record<string, unknown>;
  if (
    !['chesslasso.web', 'chesslasso.server', 'chesslasso.worker'].includes(String(item.service)) ||
    !operations.includes(item.name as Diagnostic['name'])
  )
    return null;
  const output: Diagnostic = {
    service: item.service as Diagnostic['service'],
    name: item.name as Diagnostic['name'],
    attributes: safeAttributes(
      typeof item.attributes === 'object' && item.attributes
        ? (item.attributes as Record<string, unknown>)
        : {},
    ),
  };
  for (const key of ['traceId', 'spanId', 'parentSpanId'] as const) {
    const length = key === 'traceId' ? 32 : 16;
    if (typeof item[key] === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(item[key]))
      output[key] = item[key];
  }
  for (const key of ['durationMs', 'value'] as const)
    if (typeof item[key] === 'number' && Number.isFinite(item[key]) && Math.abs(item[key]) < 1e15)
      output[key] = item[key];
  return output;
}

export async function createTelemetry(options: {
  directory: string;
  excludedRoots: string[];
  now?: () => number;
  maxBytes?: number;
}) {
  const canonical = async (input: string): Promise<string> => {
    try {
      return await realpath(input);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return path.join(await canonical(path.dirname(input)), path.basename(input));
    }
  };
  const directory = await canonical(path.resolve(options.directory));
  const now = options.now ?? Date.now;
  for (const input of options.excludedRoots) {
    const root = await canonical(path.resolve(input));
    const relative = path.relative(root, directory);
    if (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    )
      throw new Error('Telemetry must be outside Git repositories');
  }
  // Canonical paths permit macOS /var aliases while keeping archive aliases excluded.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let dropped = 0,
    failures = 0,
    queued = 0,
    bytes = 0;
  let chain = Promise.resolve();
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const files = async () =>
    (await readdir(directory)).filter((name) =>
      /^(traces|logs|metrics)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name),
    );
  for (const name of await files()) bytes += (await stat(path.join(directory, name))).size;
  const enqueue = (task: () => Promise<void>) => {
    if (queued >= 128) {
      dropped++;
      return false;
    }
    queued++;
    chain = chain
      .then(task)
      .catch(() => {
        failures++;
        dropped++;
      })
      .finally(() => queued--);
    return true;
  };
  const read = async (file: string): Promise<Envelope[]> => {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Telemetry file is a symlink');
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as Envelope;
          return Number.isFinite(value.receivedAt) &&
            value.receivedAt > now() - retentionMs &&
            value.receivedAt <= now() &&
            signalNames.includes(value.signal)
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
  };
  const cleanup = async () => {
    for (const name of await files()) {
      const file = path.join(directory, name);
      const retained = await read(file);
      const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
      if (!retained.length) await rm(file);
      else {
        await writeFile(
          temporary,
          retained.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
          { mode: 0o600 },
        );
        await rename(temporary, file);
      }
    }
    // Startup removes abandoned compaction copies, which could otherwise outlive the TTL.
    for (const name of await readdir(directory))
      if (/^(traces|logs|metrics)-.*\.tmp$/.test(name)) await rm(path.join(directory, name));
    bytes = 0;
    for (const name of await files()) bytes += (await stat(path.join(directory, name))).size;
  };
  await cleanup();
  const timer = setInterval(
    () => {
      enqueue(cleanup);
    },
    24 * 60 * 60_000,
  );
  timer.unref();
  return {
    ingest(signal: Signal, input: unknown) {
      if (!signalNames.includes(signal) || !Array.isArray(input) || input.length > 256)
        return false;
      const records = input.map(safeRecord).filter((item): item is Diagnostic => item !== null);
      if (!records.length) return false;
      const receivedAt = now();
      const line = JSON.stringify({ receivedAt, signal, records }) + '\n';
      if (Buffer.byteLength(line) > 128 * 1024) {
        dropped += records.length;
        return false;
      }
      return enqueue(async () => {
        if (receivedAt <= now() - retentionMs) {
          dropped += records.length;
          return;
        }
        const size = Buffer.byteLength(line);
        if (bytes + size > maxBytes) {
          dropped += records.length;
          return;
        }
        const file = path.join(
          directory,
          `${signal}-${new Date(receivedAt).toISOString().slice(0, 10)}.jsonl`,
        );
        try {
          if ((await lstat(file)).isSymbolicLink()) throw new Error('Telemetry file is a symlink');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await appendFile(file, line, { mode: 0o600 });
        bytes += size;
      });
    },
    async cleanup() {
      enqueue(cleanup);
      await chain;
    },
    async query(signal: Signal, limit = 256) {
      await chain;
      const output: Envelope[] = [];
      for (const name of (await files()).sort().reverse()) {
        if (name.startsWith(`${signal}-`)) output.push(...(await read(path.join(directory, name))));
        if (output.length >= Math.min(1000, limit)) break;
      }
      return output.slice(0, Math.max(0, Math.min(1000, limit)));
    },
    status: () => ({ dropped, failures, queued, bytes, retentionDays: 90, directory }),
    async close() {
      clearInterval(timer);
      await chain;
    },
  };
}

export type TelemetryStore = Awaited<ReturnType<typeof createTelemetry>>;
export function initTelemetry(store: TelemetryStore) {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const signals = createSignals('chesslasso.server', (signal, records) => {
    store.ingest(signal, records);
  });
  trace.setGlobalTracerProvider(signals.traces);
  return {
    ...signals,
    withTrace<T>(traceparent: string | undefined, work: () => Promise<T>) {
      const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(traceparent ?? '');
      const parent =
        match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])
          ? trace.setSpanContext(ROOT_CONTEXT, {
              traceId: match[1],
              spanId: match[2],
              traceFlags: parseInt(match[3], 16) & 1,
              isRemote: true,
            })
          : propagation.extract(ROOT_CONTEXT, {});
      return context.with(parent, work);
    },
  };
}
