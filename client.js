/**
 * dsh-peak-price-guard — Client half.
 *
 * A hand-written module-loader bundle (no build toolchain required): the web
 * app's `window.__ModuleLoader__` executes this file, registers the factory
 * under the package id, and materializes it when the client composition
 * mounts the plugin. The factory receives `require` for platform seed words
 * (`react`) and other registered bundles.
 *
 * The plugin registers a frame-wide modal in the `shell.overlay` slot and
 * polls the Host's SRC remote `peak-price-guard/peakPending` every 800ms.
 * When a gate is pending it shows a two-button card; the answer goes back
 * through `peak-price-guard/peakAnswer`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-price-guard',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const CSS = '.pkg-peak-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);pointer-events:auto;z-index:1000;padding:24px}' +
      '.pkg-peak-card{width:100%;max-width:420px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);border-radius:16px;padding:20px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:8px}' +
      '.pkg-peak-title{margin:0;font-size:16px;font-weight:600;line-height:22px}' +
      '.pkg-peak-question{margin:0;font-size:14px;line-height:22px}' +
      '.pkg-peak-model{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.pkg-peak-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
      '.pkg-peak-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}' +
      '.pkg-peak-btn{min-width:88px;height:32px;border-radius:8px;font-size:14px;line-height:20px;cursor:pointer;padding:0 16px}' +
      '.pkg-peak-btn:disabled{opacity:0.5;cursor:default}' +
      '.pkg-peak-cancel{border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:transparent;color:var(--dsw-alias-label-primary)}' +
      '.pkg-peak-continue{border:1px solid transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-specific-input-major)}'

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
              setGate((current) => (current !== null && current.gateId === pending.gateId ? current : pending))
            }
          })
        poll()
        const dispose = ctx.interval(poll, 800)
        return () => {
          cancelled = true
          dispose()
        }
      }, [])

      const answer = (allow) => {
        if (gate === null || busy) return
        setBusy(true)
        rpc(ctx, 'peakAnswer', { gateId: gate.gateId, allow }).then(() => {
          setGate(null)
          setBusy(false)
        })
      }

      if (gate === null) return null
      return React.createElement(
        'div',
        { className: 'pkg-peak-backdrop' },
        React.createElement(
          'div',
          { className: 'pkg-peak-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pkg-peak-title' },
          React.createElement('h2', { id: 'pkg-peak-title', className: 'pkg-peak-title' }, '高峰时段价格提醒'),
          React.createElement('p', { className: 'pkg-peak-question' }, gate.question),
          gate.model ? React.createElement('p', { className: 'pkg-peak-model' }, '模型：' + gate.model) : null,
          gate.note ? React.createElement('p', { className: 'pkg-peak-note' }, gate.note) : null,
          React.createElement(
            'div',
            { className: 'pkg-peak-actions' },
            React.createElement(
              'button',
              { type: 'button', className: 'pkg-peak-btn pkg-peak-cancel', disabled: busy, onClick: () => answer(false) },
              '取消',
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'pkg-peak-btn pkg-peak-continue', disabled: busy, onClick: () => answer(true) },
              '继续',
            ),
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
    }

    exports.apply = apply
    exports.inject = ['slots', 'timer', 'connection']
    return module.exports
  },
})
