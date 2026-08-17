/**
 * dsh-peak-price-guard — Host half.
 *
 * Intercepts every DeepSeek streaming model call through the `llm/stream`
 * waterfall. Inside Beijing peak windows (09:00-12:00 / 14:00-18:00, 2x
 * price) each root session gets a gate: the browser modal offers
 *   [取消] [延后执行] [继续]
 * plus an upper-bound premium estimate. "延后执行" parks the request until
 * the next off-peak boundary (or a configured Beijing hour) and then
 * proceeds automatically; messages sent meanwhile queue in the inbox.
 *
 * Smart routing (row config / settings): small requests below
 * `smallRequestTokens` auto-pass; keyword tables (`autoAllowKeywords` /
 * `autoDeferKeywords`, matched on the last user message) auto-allow or
 * auto-defer; `globalAllowlist` model substrings are never gated; `mode:
 * observe` logs everything and never gates (stats show what guarding would
 * have saved). Every handled request leaves one inconspicuous signature log
 * line, and stats (counts, saved estimate, per-hour heatmap, actual paid
 * premium from usage chunks) persist to a small JSON file under DSH_HOME.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const name = 'peak-price-guard'
export const inject = ['timer']

const TARGET_PROVIDER = 'deepseek-official'
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]
const GATE_TIMEOUT_MS = 120 * 1000
const MIN_WINDOW_HOURS = 0.25
const MAX_WINDOW_HOURS = 168
const DEFAULT_MAX_OUTPUT_TOKENS = 2048
const PREMIUM_FACTOR = 0.5
const SIGNATURE = '[dsh-peak-price-guard] 已为您拦截高峰请求 v1.3.0'

/** Built-in peak pricing, CNY per 1M tokens (official V4 table; off-peak = 0.5x). */
const DEFAULT_PRICING = {
  'deepseek-v4-flash': { inputMiss: 3.0, cacheHit: 0.1, output: 9.0 },
  'deepseek-v4-pro': { inputMiss: 9.0, cacheHit: 0.3, output: 27.0 },
}

const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  promptWindowHours: z.number().default(4),
  mode: z.union(['guard', 'observe']).default('guard'),
  smallRequestTokens: z.number().default(0),
  deferHour: z.number().default(-1),
})

function statsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugins', 'peak-price-guard-stats.json')
}

function freshStats() {
  return {
    requests: 0,
    autoAllowedSmall: 0,
    autoAllowedKeyword: 0,
    autoDeferredKeyword: 0,
    continued: 0,
    deferred: 0,
    denied: 0,
    observeLog: 0,
    savedYuan: 0,
    actualPaidPeakYuan: 0,
    byHour: new Array(24).fill(0),
  }
}

function loadStats() {
  try {
    const raw = readFileSync(statsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const base = freshStats()
      for (const key of Object.keys(base)) {
        if (typeof parsed[key] === 'number') base[key] = parsed[key]
      }
      if (Array.isArray(parsed.byHour)) {
        for (let i = 0; i < 24; i++) base.byHour[i] = Number(parsed.byHour[i]) || 0
      }
      return base
    }
  } catch {
    // missing or corrupt stats file: start fresh
  }
  return freshStats()
}

function saveStats(stats) {
  try {
    const file = statsPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(stats))
  } catch {
    // stats persistence is best-effort
  }
}

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

/** Milliseconds until the next off-peak boundary, or the next occurrence of `deferHour` (Beijing). */
function delayToOffPeak(nowMs, deferHour) {
  const bj = new Date(nowMs + 8 * 3600 * 1000)
  if (Number.isInteger(deferHour) && deferHour >= 0 && deferHour <= 23) {
    const target = new Date(bj)
    target.setUTCHours(deferHour, 0, 0, 0)
    if (target.getTime() <= bj.getTime()) target.setUTCDate(target.getUTCDate() + 1)
    return Math.max(60 * 1000, target.getTime() - bj.getTime())
  }
  const t = beijingMinutes(nowMs)
  let target
  if (t >= 9 * 60 && t < 12 * 60) target = 12 * 60
  else if (t >= 14 * 60 && t < 18 * 60) target = 18 * 60
  if (target === undefined) return 0
  return Math.max(60 * 1000, (target - t) * 60 * 1000)
}

function prune(service) {
  while (service.decisions.size > 500) service.decisions.delete(service.decisions.keys().next().value)
}

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

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    return blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ').toLowerCase()
  }
  return ''
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
    this.mode = config?.mode === 'observe' ? 'observe' : 'guard'
    this.smallRequestTokens = Number(config?.smallRequestTokens) > 0 ? Number(config.smallRequestTokens) : 0
    this.deferHour = Number.isInteger(config?.deferHour) && config.deferHour >= -1 && config.deferHour <= 23 ? config.deferHour : -1
    this.autoAllowKeywords = (Array.isArray(config?.autoAllowKeywords) ? config.autoAllowKeywords : [])
      .filter((k) => typeof k === 'string' && k !== '')
      .map((k) => k.toLowerCase())
    this.autoDeferKeywords = (Array.isArray(config?.autoDeferKeywords) ? config.autoDeferKeywords : [])
      .filter((k) => typeof k === 'string' && k !== '')
      .map((k) => k.toLowerCase())
    this.globalAllowlist = (Array.isArray(config?.globalAllowlist) ? config.globalAllowlist : [])
      .filter((k) => typeof k === 'string' && k !== '')
      .map((k) => k.toLowerCase())
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
    this.stats = loadStats()
  }

  applyConfig(next) {
    if (next === null || typeof next !== 'object') return
    this.enabled = next.enabled !== false
    this.promptWindowMs = normalizeHours(next.promptWindowHours) * 3600 * 1000
    this.mode = next.mode === 'observe' ? 'observe' : 'guard'
    this.smallRequestTokens = Number(next.smallRequestTokens) > 0 ? Number(next.smallRequestTokens) : 0
    this.deferHour = Number.isInteger(next.deferHour) && next.deferHour >= -1 && next.deferHour <= 23 ? next.deferHour : -1
    this.decisions.clear()
    this.pendingAsks.clear()
  }

  isDeepseek(options) {
    const provider = String(options?.provider ?? '').toLowerCase()
    return provider === TARGET_PROVIDER || provider.includes('deepseek') || this.extraProviders.includes(provider)
  }

  estimatePremium(tokenMeter, options) {
    const price = pricingFor(this, options.model)
    if (price === undefined) return undefined
    const inputTokens = estimateInputTokens(tokenMeter, options.messages)
    const maxOut = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : DEFAULT_MAX_OUTPUT_TOKENS
    const yuan = (inputTokens * price.inputMiss + maxOut * price.output) * PREMIUM_FACTOR / 1e6
    return { yuan, inputTokens, outputTokens: maxOut, price }
  }

  /** Actual premium paid for one completed call, from its usage chunk. */
  actualPremium(price, usage) {
    if (price === undefined || usage === null || typeof usage !== 'object') return 0
    const input = Number(usage.inputTokens) || 0
    const cacheRead = Number(usage.cacheReadTokens) || 0
    const output = Number(usage.outputTokens) || 0
    return (input * price.inputMiss + cacheRead * price.cacheHit + output * price.output) * PREMIUM_FACTOR / 1e6
  }

  bumpStats(counter) {
    this.stats[counter] += 1
    saveStats(this.stats)
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

  peakPending() {
    for (const gate of this.gates.values()) return this.gateSummary(gate)
    return null
  }

  peakAnswer(args) {
    const gateId = args !== null && typeof args === 'object' ? String(args.gateId) : ''
    const gate = this.gates.get(gateId)
    if (gate === undefined) return { ok: false }
    let action = args && typeof args.action === 'string' ? args.action : ''
    if (action === '' && args && typeof args.allow === 'boolean') action = args.allow ? 'allow' : 'deny'
    if (action === 'defer') {
      if (gate.state !== 'deferred') {
        this.stats.savedYuan += gate.cost?.yuan ?? 0
        this.bumpStats('deferred')
        this.defer(gate)
      }
      return { ok: true }
    }
    if (action === 'allow') this.bumpStats('continued')
    gate.resolve(action === 'allow' ? 'allow' : 'deny')
    return { ok: true }
  }

  defer(gate) {
    const delayMs = delayToOffPeak(Date.now(), this.deferHour)
    if (gate.timeoutDisposer !== undefined) {
      gate.timeoutDisposer()
      gate.timeoutDisposer = undefined
    }
    gate.state = 'deferred'
    gate.deferUntil = Date.now() + delayMs
    gate.timeoutDisposer = ctxTimeoutSafe(this.ctx, () => {
      console.log(`[dsh-peak-price-guard] gate ${gate.id} off-peak reached, executing deferred request`)
      gate.resolve('allow')
    }, delayMs)
  }

  peakGetConfig() {
    return {
      enabled: this.enabled,
      promptWindowHours: this.promptWindowMs / 3600000,
      mode: this.mode,
      smallRequestTokens: this.smallRequestTokens,
      deferHour: this.deferHour,
      extraProviders: [...this.extraProviders],
      autoAllowKeywords: [...this.autoAllowKeywords],
      autoDeferKeywords: [...this.autoDeferKeywords],
      globalAllowlist: [...this.globalAllowlist],
      pricing: { ...this.pricing },
      peakNow: isPeakTime(Date.now()),
      cachedDecisions: this.decisions.size,
      openGates: this.gates.size,
      stats: this.stats,
    }
  }

  async peakSetConfig(args) {
    if (this.settingsScope === undefined) {
      return { ok: false, error: 'settings provider unavailable' }
    }
    const patch = {}
    if (args !== null && typeof args === 'object') {
      if (typeof args.enabled === 'boolean') patch.enabled = args.enabled
      if (args.mode === 'guard' || args.mode === 'observe') patch.mode = args.mode
      if (args.smallRequestTokens !== undefined) {
        const n = Number(args.smallRequestTokens)
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'smallRequestTokens must be a non-negative number' }
        patch.smallRequestTokens = n
      }
      if (args.deferHour !== undefined) {
        const n = Number(args.deferHour)
        if (!Number.isInteger(n) || n < -1 || n > 23) return { ok: false, error: 'deferHour must be an integer between -1 and 23' }
        patch.deferHour = n
      }
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

  createGate(ctx, options, premium, autoDefer) {
    const sessionId = options.sessionId
    return new Promise((resolve) => {
      const gateId = `gate-${++this.gateSeq}`
      let settled = false
      const gate = {
        id: gateId,
        sessionId,
        model: String(options.model || options.provider || ''),
        question: '当前是 DeepSeek 高峰时段（北京时间 9:00–12:00 / 14:00–18:00），API 价格为空闲时段的两倍。是否继续本次请求？',
        note: `本会话在接下来 ${this.promptWindowMs / 3600000} 小时内不再提醒。`,
        cost: premium === undefined ? null : { yuan: premium.yuan, inputTokens: premium.inputTokens, outputTokens: premium.outputTokens },
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
        if (outcome === 'deny') {
          this.stats.savedYuan += premium?.yuan ?? 0
          this.bumpStats('denied')
        }
        resolve(outcome)
      }
      gate.resolve = finish
      this.gates.set(gateId, gate)
      gate.timeoutDisposer = ctxTimeoutSafe(ctx, () => {
        console.warn(`[dsh-peak-price-guard] gate ${gateId} timed out, passing through`)
        finish('allow')
      }, GATE_TIMEOUT_MS)
      options.signal?.addEventListener('abort', () => finish('allow'), { once: true })
      if (autoDefer === true) this.defer(gate)
    })
  }

  decide(ctx, options) {
    const sessionId = options.sessionId
    const nowMs = Date.now()
    const rec = this.decisions.get(sessionId)
    if (rec !== undefined && nowMs - rec.at < this.promptWindowMs) return Promise.resolve(rec.decision)

    const pending = this.pendingAsks.get(sessionId)
    if (pending !== undefined) return pending

    const agents = ctx.get('agents')
    const agent = agents?.get(sessionId)
    const isRoot = agent !== undefined && agents.roots().indexOf(agent) !== -1
    if (!isRoot) return Promise.resolve('allow')

    const tokenMeter = ctx.get('tokenMeter')
    const premium = this.estimatePremium(tokenMeter, options)
    const model = String(options.model ?? '').toLowerCase()
    const userText = lastUserText(options.messages)
    this.stats.requests += 1
    this.stats.byHour[new Date(Date.now() + 8 * 3600 * 1000).getUTCHours()] += 1

    if (this.mode === 'observe') {
      this.stats.savedYuan += premium?.yuan ?? 0
      this.bumpStats('observeLog')
      console.log(SIGNATURE + ' [observe]')
      return Promise.resolve('allow')
    }
    if (this.globalAllowlist.some((id) => model.includes(id))) {
      console.log(SIGNATURE + ' [allowlist]')
      return Promise.resolve('allow')
    }
    if (this.smallRequestTokens > 0 && premium !== undefined && premium.inputTokens <= this.smallRequestTokens) {
      this.bumpStats('autoAllowedSmall')
      console.log(SIGNATURE + ` [small:${premium.inputTokens}t]`)
      return Promise.resolve('allow')
    }
    if (userText !== '' && this.autoAllowKeywords.some((k) => userText.includes(k))) {
      this.bumpStats('autoAllowedKeyword')
      console.log(SIGNATURE + ' [keyword-allow]')
      return Promise.resolve('allow')
    }

    const autoDefer = userText !== '' && this.autoDeferKeywords.some((k) => userText.includes(k))
    if (autoDefer) {
      this.stats.savedYuan += premium?.yuan ?? 0
      this.bumpStats('autoDeferredKeyword')
      console.log(SIGNATURE + ' [keyword-defer]')
    }
    const askPromise = this.createGate(ctx, options, premium, autoDefer)
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

  // Pass through while capturing the usage chunk to account the actually paid premium.
  const price = pricingFor(service, options.model)
  let usage
  try {
    for await (const chunk of next()) {
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') usage = chunk.usage
      yield chunk
    }
  } finally {
    if (decision === 'allow' && usage !== undefined && price !== undefined) {
      service.stats.actualPaidPeakYuan += service.actualPremium(price, usage)
      saveStats(service.stats)
    }
  }
}

export function apply(ctx, config) {
  const service = new PeakPriceGuardService(ctx, config)

  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      settingsNamespace('peak-price-guard'),
      ConfigSchema,
      {
        base: {
          enabled: service.enabled,
          promptWindowHours: service.promptWindowMs / 3600000,
          mode: service.mode,
          smallRequestTokens: service.smallRequestTokens,
          deferHour: service.deferHour,
        },
        validate: (value) => {
          if (!Number.isFinite(value.promptWindowHours) || value.promptWindowHours < MIN_WINDOW_HOURS || value.promptWindowHours > MAX_WINDOW_HOURS) {
            throw new Error(`promptWindowHours must be between ${MIN_WINDOW_HOURS} and ${MAX_WINDOW_HOURS}`)
          }
          if (value.mode !== 'guard' && value.mode !== 'observe') throw new Error('mode must be guard or observe')
          if (!Number.isFinite(value.smallRequestTokens) || value.smallRequestTokens < 0) throw new Error('smallRequestTokens must be non-negative')
          if (!Number.isInteger(value.deferHour) || value.deferHour < -1 || value.deferHour > 23) throw new Error('deferHour must be between -1 and 23')
        },
      },
    )
    service.settingsScope = scope
    service.applyConfig(scope.get())
    scope.watch((next) => service.applyConfig(next))
  })

  ctx.on('llm/stream', (options, next) => guarded(ctx, service, options, next))

  ctx.effect(() => () => {
    for (const gate of [...service.gates.values()]) gate.resolve('allow')
    service.gates.clear()
    service.pendingAsks.clear()
    saveStats(service.stats)
  })
}
