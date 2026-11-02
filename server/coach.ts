import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { InMemoryCredentialStore, type JsonObject } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import { CoachingVerification, VerificationError } from './verification.js';
import { positionReference } from './board-facts.js';
const verificationReference = (context: CoachContext) =>
  positionReference(context.fen, context.version).id;
import definitions from '../config/prompts/tools.json' with { type: 'json' };
import mock from '../config/mock-coach.json' with { type: 'json' };

export type CoachRole =
  | 'coach'
  | 'assistant-coach'
  | 'consolidation'
  | 'planner'
  | 'retro'
  | 'question-feedback';
export interface CoachContext {
  fen: string;
  pgn: string;
  version: number;
  activity?: unknown;
  quiet?: boolean;
  [key: string]: unknown;
}
export interface CoachSettings {
  mode: 'mock' | 'live';
  provider: 'google' | 'fireworks';
  model: string;
  timeoutMs?: number;
  /** Finite per-turn cap. The final request is reserved for a terminal response. */
  maxRequests?: number;
}
export interface CoachUsage {
  input: number;
  output: number;
  cost: number;
}
export interface CoachAction {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}
export interface CoachResult {
  text: string;
  actions: CoachAction[];
  usage: CoachUsage;
  sessionId: string;
}
export interface CoachHost {
  sessionsDir: string;
  getSettings: () => CoachSettings;
  getPrompt: (role: CoachRole) => Promise<{ text: string; version: string }>;
  invokeTool: (
    name: string,
    args: Record<string, unknown>,
    context: CoachContext,
  ) => Promise<unknown>;
  beforePaidCall?: () => void;
  onUsage?: (usage: CoachUsage) => void;
  /** Scripted provider responses used only in mock mode. */
  mockResponses?: (message: string, context: CoachContext, role: CoachRole) => FauxResponseStep[];
  onEvent?: (event: { type: string; tool?: string }) => void;
}

export const coachingToolNames = definitions.map((tool) => tool.name);
const reviewTools = new Set([
  'inspect_board',
  'analyse_position',
  'verify_claims',
  'read_history',
  'search_history',
]);
const meetingForbidden = new Set([
  'publish_coaching',
  'start_activity',
  'play_move',
  'set_opponent',
  'show_demonstration',
  'ask_question',
  'write_player_note',
  'record_intervention',
]);

function dictionary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid tool object.');
  return value as Record<string, unknown>;
}

export function redactCoachText(text: string) {
  let safe = text;
  for (const name of [
    'GEMINI_API_KEY',
    'FIREWORKS_API_KEY',
    'CHESSLASSO_TOKEN',
    'CHESSLASSO_ACCESS_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ]) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) safe = safe.replaceAll(secret, '[REDACTED]');
  }
  return safe
    .replace(/AIza[\w-]{25,}/g, '[REDACTED]')
    .replace(/(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sk-[\w-]{20,})/g, '[REDACTED]')
    .replace(/(Bearer\s+)[\w.\-/+=]{16,}/gi, '$1[REDACTED]');
}

function redactValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' ? redactCoachText(item) : item,
    ),
  ) as T;
}

/** A host-owned resource loader deliberately discovers no filesystem instructions or extensions. */
function resources(prompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export type CoachFailureCode =
  | 'input_size'
  | 'request_budget'
  | 'timeout'
  | 'provider_failure'
  | 'tool_limit';
export class CoachFailure extends Error {
  override name = 'CoachFailure';
  constructor(
    public code: CoachFailureCode,
    message: string,
  ) {
    super(redactCoachText(message));
  }
}

export class CoachRuntime {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private host: CoachHost) {}

  run(message: string, context: CoachContext, role: CoachRole = 'coach'): Promise<CoachResult> {
    const pending = this.queue.then(() => this.runTurn(message, context, role));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async runTurn(
    message: string,
    context: CoachContext,
    role: CoachRole,
  ): Promise<CoachResult> {
    if (!message.trim() || message.length > 48000)
      throw new CoachFailure('input_size', 'Coach message exceeds its limit.');
    const config = this.host.getSettings();
    const storedPrompt = await this.host.getPrompt(role);
    const prompt = { ...storedPrompt, text: redactCoachText(storedPrompt.text) };
    message = redactCoachText(message);
    context = redactValue(context);
    if (!prompt.text.trim() || prompt.text.length > 48000)
      throw new CoachFailure('input_size', 'Invalid coaching prompt.');
    const sessionDir = join(
      resolve(this.host.sessionsDir),
      new Date().toISOString().slice(0, 10),
      role,
    );
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const faux =
      config.mode === 'mock'
        ? fauxProvider({ provider: 'chesslasso-mock', tokensPerSecond: 1000000 })
        : undefined;
    if (faux) runtime.registerNativeProvider(faux.provider);
    const model = faux?.getModel() ?? runtime.getModel(config.provider, config.model);
    if (!model)
      throw new CoachFailure(
        'provider_failure',
        'The configured model is not in the installed Pi catalog. Choose an explicit available model.',
      );
    if (!faux) {
      const key =
        config.provider === 'google' ? process.env.GEMINI_API_KEY : process.env.FIREWORKS_API_KEY;
      if (!key)
        throw new CoachFailure(
          'provider_failure',
          `Missing ${config.provider === 'google' ? 'GEMINI_API_KEY' : 'FIREWORKS_API_KEY'}.`,
        );
      await runtime.setRuntimeApiKey(config.provider, key);
    }
    const configuredRequests = config.maxRequests ?? 8;
    if (!Number.isInteger(configuredRequests) || configuredRequests < 1 || configuredRequests > 8)
      throw new CoachFailure(
        'request_budget',
        'Model request budget must be an integer from 1 to 8.',
      );
    const maxRequests = configuredRequests;
    const startedAt = Date.now();
    const timeoutMs = Math.min(120000, Math.max(5000, config.timeoutMs ?? 60000));
    let paidCalls = 0;
    let terminalFailure: CoachFailure | undefined;
    let finalRequest = false;
    const cachedReads = new Map<string, unknown>();
    const stream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (selected, transcript, options) => {
      if (++paidCalls > maxRequests) {
        terminalFailure = new CoachFailure(
          'request_budget',
          'Coach turn exhausted its model request budget.',
        );
        throw terminalFailure;
      }
      if (
        role !== 'coach' &&
        role !== 'question-feedback' &&
        (paidCalls === maxRequests || Date.now() - startedAt > timeoutMs * 0.75)
      ) {
        finalRequest = true;
        transcript = {
          ...transcript,
          tools: [],
          messages: [
            ...transcript.messages,
            {
              role: 'system',
              content: JSON.stringify({
                finalRequest: true,
                remainingModelRequests: 1,
                toolCallsAllowed: false,
              }),
              toolsRemoved: definitions.map(({ name }) => ({ name })),
              timestamp: Date.now(),
            },
          ],
        };
      }
      if (!faux) this.host.beforePaidCall?.();
      return stream(selected, transcript, { ...options, maxTokens: 1800 });
    };
    const actions: CoachAction[] = [];
    let verification = new CoachingVerification(context);
    const playerFacing = role === 'coach' || role === 'question-feedback';
    const allowed = definitions.filter(
      (tool) =>
        role === 'coach' ||
        (role === 'assistant-coach' || role === 'question-feedback'
          ? reviewTools.has(tool.name) ||
            (role === 'question-feedback' && tool.name === 'publish_coaching')
          : !meetingForbidden.has(tool.name)),
    );
    let calls = 0;
    const customTools: ToolDefinition[] = allowed.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as TSchema,
      executionMode: 'sequential',
      execute: async (_id, raw, signal) => {
        if (finalRequest) {
          terminalFailure = new CoachFailure(
            'request_budget',
            'Final model request must return a stage response without more tools.',
          );
          throw terminalFailure;
        }
        if (++calls > 20) {
          terminalFailure = new CoachFailure('tool_limit', 'Coach turn reached its tool limit.');
          throw terminalFailure;
        }
        if (signal?.aborted) throw new Error('Coach tool cancelled.');
        let args = redactValue(dictionary(raw));
        this.host.onEvent?.({ type: 'tool_start', tool: tool.name });
        const readKey = ['read_history', 'search_history'].includes(tool.name)
          ? JSON.stringify([tool.name, args])
          : undefined;
        let result: unknown;
        try {
          if (['analyse_position', 'verify_claims', 'publish_coaching'].includes(tool.name)) {
            const board = dictionary(await this.host.invokeTool('inspect_board', {}, context));
            if (board.version !== verification.root.version || board.fen !== verification.root.fen)
              throw new VerificationError(
                'false-claim',
                'The referenced board changed. Inspect it again.',
              );
          }
          if (readKey && cachedReads.has(readKey)) result = cachedReads.get(readKey);
          else if (tool.name === 'inspect_board') {
            result = await this.host.invokeTool(tool.name, args, context);
            const fresh = dictionary(result);
            if (
              typeof fresh.fen !== 'string' ||
              typeof fresh.pgn !== 'string' ||
              typeof fresh.version !== 'number'
            )
              throw new Error('Host did not supply a referenced position.');
            if (fresh.fen !== verification.root.fen || fresh.version !== verification.root.version)
              verification = new CoachingVerification({
                fen: fresh.fen,
                pgn: fresh.pgn,
                version: fresh.version,
              });
          } else if (tool.name === 'analyse_position')
            result = await verification.analyse(args, signal);
          else if (tool.name === 'verify_claims') result = verification.verify(args);
          else if (tool.name === 'publish_coaching') {
            result = await verification.publish(args, async (evidence) => {
              await this.host.invokeTool(
                'record_verified_assistance',
                {
                  ...evidence,
                  kind: 'verified_coaching',
                },
                { ...context, fen: verification.root.fen, version: verification.root.version },
              );
            });
          } else {
            args = verification.visibleTool(tool.name, args);
            result = await this.host.invokeTool(tool.name, args, context);
          }
        } catch (error) {
          if (error instanceof VerificationError)
            await this.host.invokeTool(
              'record_verification_failure',
              {
                category: error.category,
                reference: verification.root,
                reason: error.message,
              },
              context,
            );
          throw error;
        }
        result = redactValue(result);
        if (readKey) cachedReads.set(readKey, result);
        const encoded = JSON.stringify(result ?? null);
        if (encoded.length > 96000) throw new Error('Tool result exceeded its limit.');
        actions.push({ name: tool.name, args, result });
        this.host.onEvent?.({ type: 'tool_end', tool: tool.name });
        return { content: [{ type: 'text', text: encoded }], details: {} };
      },
    }));
    const manager =
      role === 'coach'
        ? SessionManager.continueRecent(sessionDir, sessionDir)
        : SessionManager.create(sessionDir, sessionDir);
    const appendMessage = manager.appendMessage.bind(manager);
    manager.appendMessage = (entry) => appendMessage(redactValue(entry));
    const appendCustomEntry = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = (type, data) => appendCustomEntry(type, redactValue(data));
    manager.appendCustomEntry('chesslasso.run', {
      role,
      promptVersion: prompt.version,
      effectivePrompt: prompt.text,
      provider: model.provider,
      model: model.id,
      tools: allowed.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
      appVersion: process.env.npm_package_version ?? '0.2.0',
      boardVersion: context.version,
    });
    const { session } = await createAgentSession({
      cwd: sessionDir,
      agentDir: sessionDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: 'low',
      resourceLoader: resources(prompt.text),
      tools: allowed.map((tool) => tool.name),
      customTools,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0 },
      }),
    });
    const active = session.getActiveToolNames();
    if (active.some((name) => !allowed.some((tool) => tool.name === name))) {
      session.dispose();
      throw new Error('Unexpected privileged tool in coaching session.');
    }
    const usage: CoachUsage = { input: 0, output: 0, cost: 0 };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const item = event.message.usage;
        const delta = {
          input: item.input + item.cacheRead,
          output: item.output,
          cost: item.cost.total,
        };
        usage.input += delta.input;
        usage.output += delta.output;
        usage.cost += delta.cost;
        if (!faux) this.host.onUsage?.(delta);
      }
    });
    const timeout = setTimeout(() => {
      terminalFailure = new CoachFailure('timeout', 'Coach turn exceeded its time limit.');
      void session.abort();
    }, timeoutMs);
    try {
      if (faux)
        faux.setResponses(
          this.host.mockResponses?.(message, context, role) ??
            this.mockResponses(message, context, role),
        );
      await session.prompt(JSON.stringify({ message, context, promptVersion: prompt.version }), {
        expandPromptTemplates: false,
      });
      const last = [...session.messages].reverse().find((entry) => entry.role === 'assistant');
      if (
        last?.role === 'assistant' &&
        (last.stopReason === 'error' || last.stopReason === 'aborted')
      )
        throw (
          terminalFailure ??
          new CoachFailure(
            last.stopReason === 'aborted' ? 'timeout' : 'provider_failure',
            last.stopReason === 'aborted'
              ? 'Coach turn timed out or was cancelled.'
              : 'Provider request failed. Check credentials, quota and the configured model.',
          )
        );
      if (terminalFailure) throw terminalFailure;
      const rawText = session.getLastAssistantText() ?? '';
      const text = playerFacing ? verification.finalText(rawText) : rawText;
      if (
        playerFacing &&
        text !== rawText &&
        !actions.some((action) => action.name === 'publish_coaching')
      )
        await this.host.invokeTool(
          'record_verification_failure',
          {
            category: 'unverified-output',
            reference: verification.root,
            reason: 'Unstructured assistant text was withheld from the player.',
          },
          context,
        );
      if (!text.trim() && !actions.length) throw new Error('Coach returned no usable response.');
      return {
        text: redactCoachText(text.slice(0, 16000)),
        actions,
        usage,
        sessionId: manager.getSessionId(),
      };
    } catch (error) {
      if (terminalFailure) throw terminalFailure;
      if (error instanceof CoachFailure) throw error;
      throw new CoachFailure(
        'provider_failure',
        'Provider request failed. Check credentials, quota and the configured model.',
      );
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      session.dispose();
    }
  }

  private mockResponses(message: string, context: CoachContext, role: CoachRole) {
    const text = message.toLowerCase();
    if (role !== 'coach') return [fauxAssistantMessage(mock.default)];
    const version = context.version;
    let response = mock.default;
    let name = 'ask_question';
    let args: Record<string, unknown> = { text: response, fen: context.fen };
    if (/example|show me|demonstrat|lesson/.test(text)) {
      response = mock.example;
      name = 'show_demonstration';
      args = mock.demonstration;
    } else if (/new game|fresh game|full game/.test(text)) {
      response = mock.newGame;
      name = 'start_activity';
      args = {
        version,
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        activityType: 'observation',
        quiet: true,
      };
    } else if (/endgame|simpler position|set.*position/.test(text)) {
      response = mock.position;
      name = 'start_activity';
      args = { version, fen: '8/7k/8/8/8/4K3/4P3/8 w - - 0 1', activityType: 'endgame' };
    } else if (/focus on|training goal|change.*heading/.test(text)) {
      name = 'start_activity';
      args = { version, activityType: 'calculation' };
    } else if (/quiet|less interrupt|keep thinking|observe/.test(text)) {
      response = mock.quiet;
      name = 'start_activity';
      args = { version, quiet: true };
    } else if (/resume|help again/.test(text)) {
      response = mock.resume;
      name = 'start_activity';
      args = { version, quiet: false };
    } else if (/hint|help|stuck/.test(text)) {
      response = mock.hint;
      name = 'record_intervention';
      args = {
        version,
        trigger: message.slice(0, 500),
        timing: 'asked',
        reason: mock.hint,
        text: mock.hint,
      };
    }
    return [
      fauxAssistantMessage(fauxToolCall(name, args as JsonObject)),
      fauxAssistantMessage(
        fauxToolCall('publish_coaching', {
          version,
          referenceId: verificationReference(context),
          verificationIds: [],
          prompt: /quiet|observe/.test(text) ? 'observation' : 'candidate',
        }),
      ),
      fauxAssistantMessage(response),
    ];
  }
}
