/**
 * dsh-peak-price-guard — Host half.
 *
 * Intercepts every DeepSeek streaming model call through the `llm/stream`
 * waterfall. When the current Beijing time falls inside a peak window
 * (09:00-12:00 / 14:00-18:00, 2x price) and this session has no decision for
 * the current prompt window, it parks the request behind a "gate" and lets
 * the browser half (client.js) show a two-button modal. The user's choice is
 * recorded per session and reused until `promptWindowHours` elapse.
 *
 * Configurable through the user-settings document (settings → 高峰提醒) when
 * a settings provider exists: `enabled` and `promptWindowHours` apply live;
 * the composition row config supplies the `base` layer (and the only layer
 * when no settings provider is mounted). `extraProviders` (row config) adds
 * custom provider ids that route to api.deepseek.com.
 *
 * Client <-> Host communication uses the Typert gateway's SRC mode: this
 * service extends `TypertRemoteService` and marks its methods with the
 * `Remote` protocol directly (no typert build transform required), so the
 * browser can call `peak-price-guard/<method>` over the /api RPC.
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const name = 'peak-price-guard'
export const inject = ['timer']

/** The official DeepSeek provider id registered by dsh-llm-deepseek. */
const TARGET_PROVIDER = 'deepseek-official'
/** Peak windows in Beijing minutes-since-midnight: 09:00-12:00 and 14:00-18:00. */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]
/** Fail-open timeout: if no browser answers the gate in this time, the request proceeds. */
const GATE_TIMEOUT_MS = 120 * 1000
const MIN_WINDOW_HOURS = 0.25
const MAX_WINDOW_HOURS = 168

/** Durable user-settings schema (schemastery z, as every dsh namespace uses). */
const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  promptWindowHours: z.number().default(4),
})

function normalizeHours(hours) {
  const n = Number(hours ?? 4)
  if (!Number.isFinite(n)) return 4
  return Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, n))
}

function beijingMinutes(nowMs) {
  const bj = new Date(nowMs + 8 * 3600 * 1000)
  return bj.getUTCHours() * 60 + bj.getUTCMinutes()
}

function isPeakTime(nowMs) {
  const t = beijingMinutes(nowMs)
  return PEAK_WINDOWS.some((w) => t >= w[0] && t < w[1])
}

function prune(service) {
  while (service.decisions.size > 500) service.decisions.delete(service.decisions.keys().next().value)
}

class PeakPriceGuardService extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, 'peakPriceGuard', { namespace: 'peak-price-guard' })
    // SRC remote markers without the typert build transform: the compiled form
    // of `@Remote('peakPending')` is exactly this call (see dsh-typert-protocol).
    // The initializer must run with `this` = the service instance so the marker
    // lands on PeakPriceGuardService.prototype — capture it in a closure.
    const self = this
    for (const method of ['peakPending', 'peakAnswer', 'peakGetConfig', 'peakSetConfig']) {
      Remote(method)(function () {}, {
        kind: 'method',
        name: method,
        static: false,
        private: false,
        addInitializer: (initializer) => initializer.call(self),
      })
    }
    this.enabled = !(config?.enabled === false)
    this.promptWindowMs = normalizeHours(config?.promptWindowHours) * 3600 * 1000
    this.extraProviders = Array.isArray(config?.extraProviders)
      ? config.extraProviders.filter((p) => typeof p === 'string').map((p) => p.toLowerCase())
      : []
    this.decisions = new Map()
    this.pendingAsks = new Map()
    this.gates = new Map()
    this.gateSeq = 0
    this.settingsScope = undefined
  }

  applyConfig(next) {
    if (next === null || typeof next !== 'object') return
    this.enabled = next.enabled !== false
    this.promptWindowMs = normalizeHours(next.promptWindowHours) * 3600 * 1000
    // Any config change resets cooldown state so the new behavior applies now.
    this.decisions.clear()
    this.pendingAsks.clear()
  }

  isDeepseek(options) {
    // Provider-id based only: model names may contain "deepseek" on third-party
    // providers (e.g. OpenRouter) whose pricing is not the official peak scheme.
    const provider = String(options?.provider ?? '').toLowerCase()
    return provider === TARGET_PROVIDER || provider.includes('deepseek') || this.extraProviders.includes(provider)
  }

  /** SRC remote: the oldest pending gate for the browser modal, or null. */
  peakPending() {
    for (const gate of this.gates.values()) {
      return { gateId: gate.id, model: gate.model, question: gate.question, note: gate.note }
    }
    return null
  }

  /** SRC remote: the user's two-button answer. */
  peakAnswer(args) {
    const gateId = args !== null && typeof args === 'object' ? String(args.gateId) : ''
    const gate = this.gates.get(gateId)
    if (gate === undefined) return { ok: false }
    gate.resolve(args && args.allow === true ? 'allow' : 'deny')
    return { ok: true }
  }

  /** SRC remote: live config snapshot for the settings page. */
  peakGetConfig() {
    return {
      enabled: this.enabled,
      promptWindowHours: this.promptWindowMs / 3600000,
      extraProviders: [...this.extraProviders],
      peakNow: isPeakTime(Date.now()),
      cachedDecisions: this.decisions.size,
      openGates: this.gates.size,
    }
  }

  /** SRC remote: persist config through the user-settings document. */
  async peakSetConfig(args) {
    if (this.settingsScope === undefined) {
      return { ok: false, error: 'settings provider unavailable' }
    }
    const patch = {}
    if (args !== null && typeof args === 'object') {
      if (typeof args.enabled === 'boolean') patch.enabled = args.enabled
      if (args.promptWindowHours !== undefined) {
        const n = Number(args.promptWindowHours)
        if (!Number.isFinite(n) || n < MIN_WINDOW_HOURS || n > MAX_WINDOW_HOURS) {
          return { ok: false, error: `promptWindowHours must be between ${MIN_WINDOW_HOURS} and ${MAX_WINDOW_HOURS}` }
        }
        patch.promptWindowHours = n
      }
    }
    if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' }
    try {
      await this.settingsScope.update(patch)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, config: this.peakGetConfig() }
  }

  decide(ctx, options) {
    const sessionId = options.sessionId
    const nowMs = Date.now()
    const rec = this.decisions.get(sessionId)
    if (rec !== undefined && nowMs - rec.at < this.promptWindowMs) return Promise.resolve(rec.decision)

    const pending = this.pendingAsks.get(sessionId)
    if (pending !== undefined) return pending

    // Only root sessions have a human answerer; subagents pass through.
    const agents = ctx.get('agents')
    const agent = agents?.get(sessionId)
    const isRoot = agent !== undefined && agents.roots().indexOf(agent) !== -1
    if (!isRoot) return Promise.resolve('allow')

    const askPromise = new Promise((resolve) => {
      const gateId = `gate-${++this.gateSeq}`
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        this.gates.delete(gateId)
        this.decisions.set(sessionId, { decision: outcome, at: Date.now() })
        this.pendingAsks.delete(sessionId)
        prune(this)
        resolve(outcome)
      }
      this.gates.set(gateId, {
        id: gateId,
        sessionId,
        model: String(options.model || options.provider || ''),
        question: '当前是 DeepSeek 高峰时段（北京时间 9:00–12:00 / 14:00–18:00），API 价格为空闲时段的两倍。是否继续本次请求？',
        note: `本会话在接下来 ${this.promptWindowMs / 3600000} 小时内不再提醒。`,
        resolve: finish,
      })
      ctx.timeout(GATE_TIMEOUT_MS).then(() => {
        console.warn(`[peak-price-guard] gate ${gateId} timed out, passing through`)
        finish('allow')
      })
      options.signal?.addEventListener('abort', () => finish('allow'), { once: true })
    })

    this.pendingAsks.set(sessionId, askPromise)
    return askPromise
  }
}

async function* guarded(ctx, service, options, next) {
  if (options === null || typeof options !== 'object') { yield* next(); return }
  if (!service.enabled) { yield* next(); return }
  if (!service.isDeepseek(options)) { yield* next(); return }
  if (options.purpose !== undefined) { yield* next(); return }
  if (typeof options.sessionId !== 'string' || options.sessionId === '') { yield* next(); return }
  if (!isPeakTime(Date.now())) { yield* next(); return }
  if (options.signal?.aborted === true) { yield* next(); return }

  const decision = await service.decide(ctx, options)
  if (decision === 'deny') {
    // A terminal finish chunk, the same protocol real adapter failures use,
    // so the agent loop handles it through its graceful request-error path.
    // providerRetryAfterMs beyond the retry policy's max delay makes the
    // shipped llm-retry skip its backoff — the denial already applies to the
    // whole cooldown, so retrying is pure waste.
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `本次 DeepSeek 请求已被取消：用户在高峰时段（北京时间 9:00–12:00 / 14:00–18:00，价格翻倍）选择不继续。本会话接下来 ${service.promptWindowMs / 3600000} 小时内不再提示。`,
          code: 'PEAK_PRICE_DENIED',
          providerRetryAfterMs: Number.MAX_SAFE_INTEGER,
        },
      },
    }
    return
  }
  yield* next()
}

export function apply(ctx, config) {
  const service = new PeakPriceGuardService(ctx, config)

  // Durable settings when a settings provider is mounted: the row config is
  // the composition `base`, the user document layers on top, and every commit
  // applies live through the watch.
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      settingsNamespace('peak-price-guard'),
      ConfigSchema,
      {
        base: {
          enabled: service.enabled,
          promptWindowHours: service.promptWindowMs / 3600000,
        },
        validate: (value) => {
          if (!Number.isFinite(value.promptWindowHours) || value.promptWindowHours < MIN_WINDOW_HOURS || value.promptWindowHours > MAX_WINDOW_HOURS) {
            throw new Error(`promptWindowHours must be between ${MIN_WINDOW_HOURS} and ${MAX_WINDOW_HOURS}`)
          }
        },
      },
    )
    service.settingsScope = scope
    service.applyConfig(scope.get())
    scope.watch((next) => service.applyConfig(next))
  })

  ctx.on('llm/stream', (options, next) => guarded(ctx, service, options, next))

  // Plugin unload: release parked requests so they fail over to their turn signals.
  ctx.effect(() => () => {
    for (const gate of [...service.gates.values()]) gate.resolve('allow')
    service.gates.clear()
    service.pendingAsks.clear()
  })
}
