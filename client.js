/**
 * dsh-peak-price-guard — Client half.
 *
 * Hand-written module-loader bundle (no build toolchain required). Two
 * surfaces: a frame-wide modal in `shell.overlay` (two/three-button confirm
 * with a premium estimate, plus a deferred-park status card) and a settings
 * page in `settings.section`. Host RPC goes over the Typert gateway's SRC
 * endpoints `peak-price-guard/<method>`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-price-guard',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const CSS = '.pkg-peak-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);pointer-events:auto;z-index:1000;padding:24px}' +
      '.pkg-peak-card{width:100%;max-width:440px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);border-radius:16px;padding:20px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:8px}' +
      '.pkg-peak-title{margin:0;font-size:16px;font-weight:600;line-height:22px}' +
      '.pkg-peak-question{margin:0;font-size:14px;line-height:22px}' +
      '.pkg-peak-model{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.pkg-peak-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
      '.pkg-peak-cost{margin:0;font-size:13px;line-height:20px;font-weight:600}' +
      '.pkg-peak-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}' +
      '.pkg-peak-btn{min-width:88px;height:32px;border-radius:8px;font-size:14px;line-height:20px;cursor:pointer;padding:0 16px}' +
      '.pkg-peak-btn:disabled{opacity:0.5;cursor:default}' +
      '.pkg-peak-cancel{border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:transparent;color:var(--dsw-alias-label-primary)}' +
      '.pkg-peak-defer{border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:transparent;color:var(--dsw-alias-label-secondary)}' +
      '.pkg-peak-continue{border:1px solid transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-specific-input-major)}' +
      '.pkg-peak-page{display:flex;flex-direction:column;gap:16px;padding:4px 0;color:var(--dsw-alias-label-primary)}' +
      '.pkg-peak-row{display:flex;align-items:center;justify-content:space-between;gap:16px}' +
      '.pkg-peak-label{font-size:14px;line-height:22px}' +
      '.pkg-peak-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
      '.pkg-peak-input{width:96px;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:transparent;color:var(--dsw-alias-label-primary);padding:0 10px;font-size:14px}' +
      '.pkg-peak-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.pkg-peak-status-ok{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.pkg-peak-status-err{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-danger,#e5484d)}'

    const styleId = 'dsh-peak-price-guard-css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + styleId + '"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-peak-price-guard'
      tag.dataset.pluginCss = styleId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function rpc(ctx, method, args) {
      const connection = ctx.connection
      if (connection === undefined) return Promise.resolve(null)
      return connection.rpc
        .call('/api', 'peak-price-guard/' + method, { args: args === undefined ? {} : args })
        .then((result) => {
          if (result && typeof result === 'object' && result.ok === true) {
            return result.value === undefined ? null : result.value
          }
          return null
        })
        .catch((error) => {
          console.error('[peak-price-guard] rpc ' + method + ' failed:', error && error.message)
          return null
        })
    }

    function formatYuan(yuan) {
      if (!Number.isFinite(yuan)) return ''
      if (yuan < 0.01) return '<¥0.01'
      return '¥' + yuan.toFixed(2)
    }

    function formatTokens(n) {
      if (!Number.isFinite(n)) return '?'
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
      return String(Math.round(n))
    }

    function beijingHhMm(ms) {
      return new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16)
    }

    function costLine(cost) {
      if (cost === null || typeof cost !== 'object') return null
      return (
        '预估本次高峰溢价 ' +
        formatYuan(cost.yuan) +
        '（上限：输入 ' +
        formatTokens(cost.inputTokens) +
        ' tokens 全按未命中缓存、输出最多 ' +
        formatTokens(cost.outputTokens) +
        ' tokens）'
      )
    }

    function PeakModal(props) {
      const ctx = props.ctx
      const [gate, setGate] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        const poll = () =>
          rpc(ctx, 'peakPending').then((pending) => {
            if (cancelled) return
            if (pending !== null && typeof pending === 'object') {
              setGate((current) => {
                if (current !== null && current.gateId === pending.gateId && current.state === pending.state && current.deferUntil === pending.deferUntil) {
                  return current
                }
                return pending
              })
            }
          })
        poll()
        const dispose = ctx.interval(poll, 800)
        return () => {
          cancelled = true
          dispose()
        }
      }, [])

      const answer = (action) => {
        if (gate === null || busy) return
        setBusy(true)
        rpc(ctx, 'peakAnswer', { gateId: gate.gateId, action }).then((value) => {
          const consumed = value !== null && typeof value === 'object' && typeof value.ok === 'boolean'
          if (consumed && action !== 'defer') setGate(null)
          // defer keeps the modal open; the next poll switches it to the deferred card.
          setBusy(false)
        })
      }

      if (gate === null) return null
      const deferred = gate.state === 'deferred'
      return React.createElement(
        'div',
        { className: 'pkg-peak-backdrop' },
        React.createElement(
          'div',
          { className: 'pkg-peak-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pkg-peak-title' },
          React.createElement('h2', { id: 'pkg-peak-title', className: 'pkg-peak-title' }, deferred ? '已延后到空闲时段' : '高峰时段价格提醒'),
          deferred
            ? React.createElement('p', { className: 'pkg-peak-question' }, '本请求将在北京时间 ' + (gate.deferUntil ? beijingHhMm(gate.deferUntil) : '—') + ' 空闲时段自动执行。')
            : React.createElement('p', { className: 'pkg-peak-question' }, gate.question),
          !deferred && gate.model ? React.createElement('p', { className: 'pkg-peak-model' }, '模型：' + gate.model) : null,
          !deferred && gate.cost ? React.createElement('p', { className: 'pkg-peak-cost' }, costLine(gate.cost)) : null,
          deferred
            ? React.createElement('p', { className: 'pkg-peak-note' }, '期间会话保持运行，后续消息会排队在空闲时段依次执行。')
            : gate.note
              ? React.createElement('p', { className: 'pkg-peak-note' }, gate.note)
              : null,
          React.createElement(
            'div',
            { className: 'pkg-peak-actions' },
            deferred
              ? React.createElement(
                  'button',
                  { type: 'button', className: 'pkg-peak-btn pkg-peak-cancel', disabled: busy, onClick: () => answer('deny') },
                  '取消延后',
                )
              : React.createElement(
                  'button',
                  { type: 'button', className: 'pkg-peak-btn pkg-peak-cancel', disabled: busy, onClick: () => answer('deny') },
                  '取消',
                ),
            deferred
              ? null
              : React.createElement(
                  'button',
                  { type: 'button', className: 'pkg-peak-btn pkg-peak-defer', disabled: busy, onClick: () => answer('defer') },
                  '延后执行',
                ),
            React.createElement(
              'button',
              { type: 'button', className: 'pkg-peak-btn pkg-peak-continue', disabled: busy, onClick: () => answer('allow') },
              deferred ? '立即执行' : '继续',
            ),
          ),
        ),
      )
    }

    function PeakSettings(props) {
      const ctx = props.ctx
      const [config, setConfig] = React.useState(null)
      const [hours, setHours] = React.useState('4')
      const [enabled, setEnabled] = React.useState(true)
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      const load = () =>
        rpc(ctx, 'peakGetConfig').then((value) => {
          if (value === null || typeof value !== 'object') return
          setConfig(value)
          setHours(String(value.promptWindowHours))
          setEnabled(value.enabled !== false)
        })

      React.useEffect(() => {
        load()
      }, [])

      const save = () => {
        if (saving) return
        setSaving(true)
        setMessage(null)
        rpc(ctx, 'peakSetConfig', { enabled, promptWindowHours: Number(hours) }).then((value) => {
          setSaving(false)
          if (value !== null && typeof value === 'object' && value.ok === true) {
            setConfig(value.config)
            setHours(String(value.config.promptWindowHours))
            setEnabled(value.config.enabled !== false)
            setMessage({ ok: true, text: '已保存' })
          } else {
            const text = value && typeof value.error === 'string' ? value.error : '保存失败'
            setMessage({ ok: false, text })
            load()
          }
        })
      }

      return React.createElement(
        'div',
        { className: 'pkg-peak-page' },
        React.createElement(
          'div',
          { className: 'pkg-peak-row' },
          React.createElement(
            'label',
            { className: 'pkg-peak-label' },
            '启用拦截',
            React.createElement(
              'input',
              {
                type: 'checkbox',
                checked: enabled,
                onChange: (event) => setEnabled(event.target.checked),
              },
            ),
          ),
          config !== null
            ? React.createElement('span', { className: 'pkg-peak-status' }, config.peakNow ? '当前：高峰时段' : '当前：空闲时段')
            : null,
        ),
        React.createElement(
          'div',
          { className: 'pkg-peak-row' },
          React.createElement('span', { className: 'pkg-peak-label' }, '提醒间隔（小时）'),
          React.createElement(
            'input',
            {
              type: 'number',
              className: 'pkg-peak-input',
              min: '0.25',
              max: '168',
              step: '0.5',
              value: hours,
              onChange: (event) => setHours(event.target.value),
            },
          ),
        ),
        React.createElement('p', { className: 'pkg-peak-hint' }, '每个会话在此时间间隔内只提醒一次；修改后立即生效（已缓存的会话选择会被重置）。'),
        React.createElement(
          'div',
          { className: 'pkg-peak-actions' },
          message !== null
            ? React.createElement('span', { className: message.ok ? 'pkg-peak-status-ok' : 'pkg-peak-status-err' }, message.text)
            : null,
          React.createElement(
            'button',
            { type: 'button', className: 'pkg-peak-btn pkg-peak-continue', disabled: saving, onClick: save },
            saving ? '保存中…' : '保存',
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'peak-price-guard' }, () =>
          React.createElement(PeakModal, { ctx }),
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'peak-price-guard', order: 12, label: '高峰提醒' }, () =>
          React.createElement(PeakSettings, { ctx }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'timer', 'connection']
    return module.exports
  },
})
