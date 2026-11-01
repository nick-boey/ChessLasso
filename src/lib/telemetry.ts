import { context, trace, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';

export type Signal = 'traces' | 'logs' | 'metrics';
export const operations = [
  'load',
  'request',
  'move',
  'coach',
  'engine',
  'tool',
  'render',
  'reconnect',
  'presence',
  'notation',
  'daily',
  'backup',
  'development',
  'rollout',
  'shutdown',
] as const;
export type Operation = (typeof operations)[number];
export type Diagnostic = {
  service: 'chesslasso.web' | 'chesslasso.server' | 'chesslasso.worker';
  name: Operation;
  attributes: Record<string, string | number | boolean>;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  value?: number;
};
const dimensions: Record<string, readonly string[]> = {
  outcome: ['ok', 'error', 'rejected', 'offline', 'dropped'],
  method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  surface: ['web', 'server', 'worker'],
  state: ['visible', 'hidden', 'focused', 'blurred', 'connected', 'disconnected'],
};
export function safeAttributes(
  input: Attributes | Record<string, unknown> = {},
): Diagnostic['attributes'] {
  const output: Diagnostic['attributes'] = {};
  for (const [key, choices] of Object.entries(dimensions)) {
    const value = input[key];
    if (typeof value === 'string' && choices.includes(value)) output[key] = value;
  }
  if (
    typeof input.status === 'number' &&
    Number.isInteger(input.status) &&
    input.status >= 100 &&
    input.status <= 599
  )
    output.status = input.status;
  return output;
}

/** Explicit exporters keep private bodies out of SDK serialization and metric dimensions. */
export function createSignals(
  service: Diagnostic['service'],
  send: (signal: Signal, records: Diagnostic[]) => void,
) {
  const resource = resourceFromAttributes({ 'service.name': service, 'service.version': '0.2.0' });
  const name = (value: string): Operation =>
    operations.includes(value as Operation) ? (value as Operation) : 'request';
  const traces = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(
        {
          export(spans, callback) {
            send(
              'traces',
              spans.map((span) => ({
                service,
                name: name(span.name),
                attributes: safeAttributes(span.attributes),
                traceId: span.spanContext().traceId,
                spanId: span.spanContext().spanId,
                parentSpanId: span.parentSpanContext?.spanId,
                durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
              })),
            );
            callback({ code: 0 });
          },
          shutdown: async () => {},
        },
        {
          maxQueueSize: 256,
          maxExportBatchSize: 32,
          scheduledDelayMillis: 1000,
          exportTimeoutMillis: 2000,
        },
      ),
    ],
  });
  const logger = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: {
          export(records, callback) {
            send(
              'logs',
              records.map((record) => ({
                service,
                name: name(typeof record.body === 'string' ? record.body : 'request'),
                attributes: safeAttributes(record.attributes),
                traceId: record.spanContext?.traceId,
                spanId: record.spanContext?.spanId,
              })),
            );
            callback({ code: 0 });
          },
          forceFlush: async () => {},
          shutdown: async () => {},
        },
        maxQueueSize: 256,
        maxExportBatchSize: 32,
        scheduledDelayMillis: 1000,
        exportTimeoutMillis: 2000,
      }),
    ],
  });
  const meter = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: {
          export(metrics, callback) {
            const records: Diagnostic[] = [];
            for (const scope of metrics.scopeMetrics)
              for (const metric of scope.metrics)
                for (const point of metric.dataPoints) {
                  const value = typeof point.value === 'number' ? point.value : point.value.sum;
                  if (typeof value === 'number' && Number.isFinite(value))
                    records.push({
                      service,
                      name: name(metric.descriptor.name),
                      attributes: safeAttributes(point.attributes),
                      value,
                    });
                }
            send('metrics', records.slice(0, 256));
            callback({ code: 0 });
          },
          selectAggregationTemporality: () => AggregationTemporality.DELTA,
          forceFlush: async () => {},
          shutdown: async () => {},
        },
        exportIntervalMillis: 10_000,
        exportTimeoutMillis: 2000,
      }),
    ],
  });
  const tracer = traces.getTracer(service);
  const log = logger.getLogger(service);
  const instruments = new Map<
    Operation,
    ReturnType<ReturnType<MeterProvider['getMeter']>['createCounter']>
  >();
  const duration = meter.getMeter(service).createHistogram('request', { unit: 'ms' });
  const event = (operation: Operation, attributes: Attributes = {}, span?: Span) => {
    const clean = safeAttributes(attributes);
    log.emit({
      body: operation,
      attributes: clean,
      context: span ? trace.setSpan(context.active(), span) : context.active(),
    });
    let counter = instruments.get(operation);
    if (!counter) {
      counter = meter.getMeter(service).createCounter(operation);
      instruments.set(operation, counter);
    }
    counter.add(1, clean);
  };
  return {
    tracer,
    traces,
    meter,
    logger,
    event,
    async operation<T>(
      operation: Operation,
      fn: () => Promise<T>,
      attributes: Attributes = {},
    ): Promise<T> {
      const span = tracer.startSpan(operation, { attributes: safeAttributes(attributes) });
      const started = performance.now();
      try {
        const result = await context.with(trace.setSpan(context.active(), span), fn);
        if (attributes.outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
        event(operation, { ...attributes, outcome: attributes.outcome ?? 'ok' }, span);
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        event(operation, { ...attributes, outcome: 'error' }, span);
        throw error;
      } finally {
        duration.record(performance.now() - started, safeAttributes(attributes));
        span.end();
      }
    },
    async flush() {
      await Promise.allSettled([traces.forceFlush(), logger.forceFlush(), meter.forceFlush()]);
    },
    async close() {
      await Promise.allSettled([traces.shutdown(), logger.shutdown(), meter.shutdown()]);
    },
  };
}
