/**
 * dsh-peak-price-guard — Host half.
 *
 * Intercepts every DeepSeek streaming model call through the `llm/stream`
 * waterfall. Inside Beijing peak windows (09:00-12:00 / 14:00-18:00, 2x
 * price) each root session gets a gate: the browser modal offers
 *   [取消] [延后执行] [继续]
 * plus an upper-bound premium estimate for this request. "延后执行" parks
 * the request until the next off-peak boundary (12:00 / 18:00) and then
 * proceeds automatically; messages sent meanwhile queue in the inbox and
 * run off-peak.
 *
 * Configurable through the user-settings document (settings → 高峰提醒)
 * when a settings provider exists; the composition row config supplies the
 * `base` layer. Row-only config: `extraProviders`, `pricing` overrides.
 *
 * Client <-> Host communication uses the Typert gateway's SRC mode (no
 * typert build transform; markers installed through the `Remote` protocol).
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
/** Fail-open timeout for unanswered gates. */
const GATE_TIMEOUT_MS = 120 * 1000
const MIN_WINDOW_HOURS = 0.25
const MAX_WINDOW_HOURS = 168
/** Output-token assumption when the request declares no maxTokens. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2048
/** Built-in peak pricing, CNY per 1M tokens (official V4 table; off-peak = 0.5x). */
const DEFAULT_PRICING = {
  'deepseek-v4-flash': { inputMiss: 3.0, cacheHit: 0.1, output: 9.0 },
  'deepseek-v4-pro': { inputMiss: 9.0, cacheHit: 0.3, output: 27.0 },
}
/** Peak premium multiplier: off-peak price is half the peak price. */
const PREMIUM_FACTOR = 0.5

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

/** Milliseconds until the next off-peak boundary while inside a peak window. */
function delayToNextOffPeak(nowMs) {
  const t = beijingMinutes(nowMs)
  let target
  if (t >= 9 * 60 && t < 12 * 60) target = 12 * 60 // lunch gap
  else if (t >= 14 * 60 && t < 18 * 60) target = 18 * 60 // night
  if (target === undefined) return 0
  const delayMinutes = target - t
  return Math.max(60 * 1000, delayMinutes * 60 * 1000)
}

function prune(service) {
  while (service.decisions.size > 500) service.decisions.delete(service.decisions.keys().next().value)
}

/** Rough token count when the tokenMeter service is unavailable. */
function roughBlockTokens(block) {
  let text = ''
  if (typeof block === 'object' && block !== null) {
    if (typeof block.text === 'string') text = block.text
    else if (typeof block.arguments === 'string') text = block.arguments
    else if (typeof block.name === 'string') text += block.name
  }
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
    else if (code > 0x2e80) cjk += 1
    else if (code > 0x7f) other += 0.5
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 3.5)
}

function estimateInputTokens(tokenMeter, messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) {
    try {
      if (tokenMeter !== undefined) total += Number(tokenMeter.estimateMessage(message)) || 0
      else {
        const blocks = Array.isArray(message?.content) ? message.content : []
        for (const block of blocks) total += roughBlockTokens(block)
      }
    } catch {
      const blocks = Array.isArray(message?.content) ? message.content : []
      for (const block of blocks) total += roughBlockTokens(block)
    }
  }
  return total
}

function pricingFor(service, model) {
  const key = String(model ?? '').toLowerCase()
  for (const [modelId, price] of Object.entries(service.pricing)) {
    if (key.includes(modelId)) return price
  }
  return undefined
}

class PeakPriceGuardService extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, 'peakPriceGuard', { namespace: 'peak-price-guard' })
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
    this.pricing = { ...DEFAULT_PRICING }
    if (config?.pricing !== null && typeof config?.pricing === 'object') {
      for (const [modelId, price] of Object.entries(config.pricing)) {
        if (price !== null && typeof price === 'object' && Number.isFinite(Number(price.inputMiss))) {
          this.pricing[String(modelId).toLowerCase()] = {
            inputMiss: Number(price.inputMiss),
            cacheHit: Number.isFinite(Number(price.cacheHit)) ? Number(price.cacheHit) : 0,
            output: Number.isFinite(Number(price.output)) ? Number(price.output) : 0,
          }
        }
      }
    }
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

  /** Upper-bound peak premium for one request, or undefined when the model has no price entry. */
  estimatePremium(tokenMeter, options) {
    const price = pricingFor(this, options.model)
    if (price === undefined) return undefined
    const inputTokens = estimateInputTokens(tokenMeter, options.messages)
    const maxOut = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : DEFAULT_MAX_OUTPUT_TOKENS
    // Input assumed fully uncached (cache hits are the only unknown that could
    // lower this), output capped at maxTokens — a conservative upper bound.
    const yuan = (inputTokens * price.inputMiss + maxOut * price.output) * PREMIUM_FACTOR / 1e6
    return { yuan, inputTokens, outputTokens: maxOut }
  }

  gateSummary(gate) {
    return {
      gateId: gate.id,
      model: gate.model,
      question: gate.question,
      note: gate.note,
      cost: gate.cost,
      state: gate.state,
      deferUntil: gate.deferUntil,
    }
  }

  /** SRC remote: the oldest pending gate for the browser modal, or null. */
  peakPending() {
    for (const gate of this.gates.values()) return this.gateSummary(gate)
    return null
  }

  /** SRC remote: the user's answer — 'allow' | 'deny' | 'defer' (legacy `allow` boolean maps too). */
  peakAnswer(args) {
    const gateId = args !== null && typeof args === 'object' ? String(args.gateId) : ''
    const gate = this.gates.get(gateId)
    if (gate === undefined) return { ok: false }
    let action = args && typeof args.action === 'string' ? args.action : ''
    if (action === '' && args && typeof args.allow === 'boolean') action = args.allow ? 'allow' : 'deny'
    if (action === 'defer') {
      if (gate.state !== 'deferred') this.defer(gate)
      return { ok: true }
    }
    gate.resolve(action === 'allow' ? 'allow' : 'deny')
    return { ok: true }
  }

  /** Park one asking gate until the next off-peak boundary. */
  defer(gate) {
    const delayMs = delayToNextOffPeak(Date.now())
    if (gate.timeoutDisposer !== undefined) {
      gate.timeoutDisposer()
      gate.timeoutDisposer = undefined
    }
    gate.state = 'deferred'
    gate.deferUntil = Date.now() + delayMs
    gate.timeoutDisposer = ctxTimeoutSafe(this.ctx, () => {
      console.log(`[peak-price-guard] gate ${gate.id} off-peak reached, executing deferred request`)
      gate.resolve('allow')
    }, delayMs)
  }

  /** SRC remote: live config snapshot for the settings page. */
  peakGetConfig() {
    return {
      enabled: this.enabled,
      promptWindowHours: this.promptWindowMs / 3600000,
      extraProviders: [...this.extraProviders],
      pricing: { ...this.pricing },
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

    const tokenMeter = ctx.get('tokenMeter')
    const premium = this.estimatePremium(tokenMeter, options)

    const askPromise = new Promise((resolve) => {
      const gateId = `gate-${++this.gateSeq}`
      let settled = false
      const gate = {
        id: gateId,
        sessionId,
        model: String(options.model || options.provider || ''),
        question: '当前是 DeepSeek 高峰时段（北京时间 9:00–12:00 / 14:00–18:00），API 价格为空闲时段的两倍。是否继续本次请求？',
        note: `本会话在接下来 ${this.promptWindowMs / 3600000} 小时内不再提醒。`,
        cost: premium === undefined ? null : premium,
        state: 'asking',
        deferUntil: null,
        timeoutDisposer: undefined,
        resolve: undefined,
      }
      const finish = (outcome) => {
        if (settled) return
        settled = true
        if (gate.timeoutDisposer !== undefined) {
          gate.timeoutDisposer()
          gate.timeoutDisposer = undefined
        }
        this.gates.delete(gateId)
        this.decisions.set(sessionId, { decision: outcome, at: Date.now() })
        this.pendingAsks.delete(sessionId)
        prune(this)
        resolve(outcome)
      }
      gate.resolve = finish
      this.gates.set(gateId, gate)
      gate.timeoutDisposer = ctxTimeoutSafe(ctx, () => {
        console.warn(`[peak-price-guard] gate ${gateId} timed out, passing through`)
        finish('allow')
      }, GATE_TIMEOUT_MS)
      options.signal?.addEventListener('abort', () => finish('allow'), { once: true })
    })

    this.pendingAsks.set(sessionId, askPromise)
    return askPromise
  }
}

function ctxTimeoutSafe(ctx, callback, delayMs) {
  try {
    return ctx.timeout(callback, delayMs)
  } catch {
    return () => {}
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
