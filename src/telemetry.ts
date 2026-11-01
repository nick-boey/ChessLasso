import { createSignals, type Diagnostic, type Signal } from './lib/telemetry.js';

export function initializeTelemetry() {
  const original = window.fetch.bind(window);
  let pending = 0;
  const signals = createSignals('chesslasso.web', (signal: Signal, records: Diagnostic[]) => {
    if (!records.length || pending >= 4) return;
    pending++;
    void original(`/api/telemetry/${signal}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(records),
      signal: AbortSignal.timeout(2000),
    })
      .catch(() => {})
      .finally(() => pending--);
  });
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
      location.href,
    );
    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/api/telemetry/')
    )
      return original(input, init);
    const operation = url.pathname.includes('/move')
      ? 'move'
      : url.pathname.includes('/coach')
        ? 'coach'
        : 'request';
    const span = signals.tracer.startSpan(operation);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const trace = span.spanContext();
    headers.set('traceparent', `00-${trace.traceId}-${trace.spanId}-01`);
    try {
      const response = await original(input, { ...init, headers });
      signals.event(
        operation,
        { outcome: response.ok ? 'ok' : 'error', status: response.status },
        span,
      );
      return response;
    } catch (error) {
      signals.event(operation, { outcome: 'offline' }, span);
      throw error;
    } finally {
      span.end();
    }
  };
  const loaded = signals.tracer.startSpan('load');
  signals.event('load', {}, loaded);
  loaded.end();
  const visible = () => signals.event('presence', { state: document.visibilityState });
  const focused = () =>
    signals.event('presence', { state: document.hasFocus() ? 'focused' : 'blurred' });
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('focus', focused);
  window.addEventListener('blur', focused);
  window.addEventListener('pagehide', () => {
    void signals.flush();
  });
  return signals;
}
