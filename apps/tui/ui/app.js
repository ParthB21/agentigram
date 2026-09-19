// The room view. Replace this file to change how Agentigram looks.
//
// Plain Elm architecture, exactly as the boilerplate ships it: state in the
// constructor, messages folded in update(), a pure view(). It never touches the
// QVAC SDK or the daemon socket directly — inference arrives as 'qvac.*'
// messages and the room arrives as 'room.*' messages, both forwarded by
// bin.mjs, and everything outgoing leaves as a Cmd. That split is what lets
// test/index.js drive the whole negotiation with no model, no daemon, no
// network and no terminal.
//
// The screen answers one question: what is every agent in this room doing, and
// what is about to break. The bottom panel is the negotiation — the only place
// the on-device model's output can leave this laptop, and only on a keypress.
const { quit, batch, spinner, viewport, style } = require('bare-tui')
const {
  CONTRACT_FORMAT,
  contractPrompt,
  explainPrompt,
  fallbackContract,
  parseContract,
  parseSymbolKey,
  tidyExplanation
} = require('../lib/negotiator.js')

const ACCENT = '#5BC8FF'
const WARN = '#F7B955'
const DANGER = '#FF6B6B'
const OK = '#43E97B'
const MUTED = '#6C7A89'

const MIN_WIDTH = 40
const MIN_HEIGHT = 12
const MAX_FEED = 400
const AGENT_ROWS = 5

// Chrome that is always on screen: title, rules, footer.
const HEADER_H = 2
const FOOTER_H = 2
// Negotiation panel: rule, who, explanation, contract, constraint, keys — and
// the least it can be squeezed to while staying actionable.
const PANEL_H = 6
const PANEL_MIN_H = 4

class App {
  constructor({ inference, room, model, version, roomId } = {}) {
    this.inference = inference || null
    this.room = room || null
    this.model = model || 'local model'
    this.version = version || '0.0.0'
    this.roomId = roomId || 'room'

    this.width = 80
    this.height = 24

    // 'loading' -> model downloading; 'ready' -> it can negotiate;
    // 'failed' -> it never loaded, so the panel shows deterministic text only.
    this.phase = 'loading'
    this.percentage = 0

    this.link = 'connecting'
    this.state = null
    this.feed = []

    // The collision currently on the negotiation panel, plus any that arrived
    // while it was busy. One at a time: a queue of half-drafted contracts is
    // not something a person can act on.
    this.current = null
    this.queue = []
    this.seen = new Set()
    this.askId = null

    this.spinner = spinner.create({ frames: spinner.dots, fps: 12 })
    this.body = viewport.create({ width: 0, height: 8 })
    this.follow = true
  }

  init() {
    return this.spinner.init()
  }

  // ── messages ─────────────────────────────────────────────────────────────

  update(msg) {
    switch (msg.type) {
      case 'resize':
        this.width = Math.max(MIN_WIDTH, msg.width || MIN_WIDTH)
        this.height = Math.max(MIN_HEIGHT, msg.height || MIN_HEIGHT)
        this._layout()
        return [this, null]

      case 'spinner.tick': {
        const [next, cmd] = this.spinner.update(msg)
        this.spinner = next
        return [this, cmd]
      }

      // ── the room ──────────────────────────────────────────────────────────

      case 'room.status':
        this.link = msg.status
        return [this, null]

      case 'room.state':
        this.state = msg.state
        this.roomId = msg.state?.roomId || this.roomId
        return this._intake()

      case 'room.event':
        this.feed.push(msg.frame)
        if (this.feed.length > MAX_FEED) this.feed = this.feed.slice(-MAX_FEED)
        this._layout()
        return [this, null]

      case 'room.warn':
        this._note(`[daemon] ${msg.text}`)
        return [this, null]

      case 'room.sent':
        if (this.current) this.current.phase = msg.ok ? 'sent' : 'ready'
        this._note(
          msg.ok
            ? `proposal sent to ${msg.to} — it is now in their agent's context`
            : `could not send proposal: ${msg.error}`
        )
        // Done with this one either way; a failed send stays on screen to retry.
        return msg.ok ? this._advance() : [this, null]

      // ── the model ─────────────────────────────────────────────────────────

      case 'qvac.progress':
        this.percentage = msg.percentage
        return [this, null]

      case 'qvac.loaded':
        this.phase = 'ready'
        this.model = msg.model || this.model
        this._note(`${this.model} loaded on this machine — no API key, no network`)
        return this._pump()

      case 'qvac.delta': {
        if (msg.id !== this.askId || !this.current) return [this, null]
        this.current.raw += msg.text
        // The explanation streams into the panel as it is written; the contract
        // is JSON, so it is shown only once it parses.
        if (this.current.phase === 'explaining') {
          this.current.explanation = tidyExplanation(this.current.raw, this.current.collision)
        }
        return [this, null]
      }

      case 'qvac.thinking': {
        // Reasoning models emit this; nothing on the panel has room for it.
        return [this, null]
      }

      case 'qvac.end':
        if (msg.id !== this.askId || !this.current) return [this, null]
        return this._finishStep()

      case 'qvac.error':
        if (msg.id !== undefined && msg.id !== this.askId) return [this, null]
        this._note(`model error: ${msg.message}`)
        if (this.phase === 'loading') {
          this.phase = 'failed'
          return [this, null]
        }
        // Fall back to the deterministic draft rather than stranding the panel.
        return this._degrade()

      case 'app.notice':
        this._note(msg.text)
        return [this, null]

      case 'mouse':
        if (msg.action === 'wheel') {
          if (msg.button === 'wheelup') this.body.scrollUp(3)
          else this.body.scrollDown(3)
          this.follow = this.body.atBottom
        }
        return [this, null]

      case 'key':
        return this._key(msg)

      default:
        return [this, null]
    }
  }

  _key(msg) {
    const pressed = String(msg)
    if (pressed === 'ctrl+c' || pressed === 'q') return [this, quit]

    const ready = this.current && this.current.phase === 'ready'
    if (pressed === 'enter' && ready) return this._send()
    if (pressed === 'x' && this.current) {
      this._note(`dismissed the ${this.current.collision.tier} collision`)
      return this._advance()
    }
    if (pressed === 'r' && ready) return this._explain(this.current)
    return [this, null]
  }

  // ── the negotiation ──────────────────────────────────────────────────────

  /** Pick up collisions the daemon has opened that this view has not queued. */
  _intake() {
    const open = this.state?.collisions || []
    for (const collision of open) {
      if (this.seen.has(collision.collisionId)) continue
      this.seen.add(collision.collisionId)
      this.queue.push(collision)
    }
    this._layout()
    return this._pump()
  }

  /** Start the next collision if the panel is free and the model can answer. */
  _pump() {
    if (this.current || this.queue.length === 0) return [this, null]
    const collision = this.queue.shift()
    if (this.phase !== 'ready') {
      // No model yet: show what the deterministic layer already knows, so the
      // collision is visible even on a laptop that never loaded weights.
      this.current = this._blank(collision)
      this.current.explanation = collision.detail
      this.current.contract = fallbackContract(collision)
      this.current.phase = 'ready'
      this.current.generated = false
      this._layout()
      return [this, null]
    }
    return this._explain(this._blank(collision))
  }

  _blank(collisionOrCurrent) {
    const collision = collisionOrCurrent.collision || collisionOrCurrent
    return {
      collision,
      explanation: '',
      contract: null,
      generated: false,
      raw: '',
      phase: 'drafting'
    }
  }

  /**
   * Start a negotiation: draft the contract first. Asked to explain a collision
   * cold, a 1B model invents the mechanism; asked to explain a contract it has
   * already drafted, it only has to put one into words. See lib/negotiator.js.
   */
  _explain(target) {
    const next = this._blank(target)
    this.current = next
    this._layout()
    return [
      this,
      () => {
        this.askId = this.inference.ask(
          contractPrompt(next.collision, this.state),
          CONTRACT_FORMAT
        )
        return null
      }
    ]
  }

  /** Contract done -> explain it; explanation done -> wait for the human. */
  _finishStep() {
    const current = this.current
    if (current.phase === 'drafting') {
      const { contract, generated } = parseContract(current.raw, current.collision)
      current.contract = contract
      current.generated = generated
      current.raw = ''
      current.phase = 'explaining'
      this._layout()
      return [
        this,
        () => {
          this.askId = this.inference.ask(
            explainPrompt(current.collision, this.state, contract)
          )
          return null
        }
      ]
    }

    current.explanation = tidyExplanation(current.raw, current.collision)
    current.phase = 'ready'
    this._layout()
    return [this, null]
  }

  /** The model failed mid-negotiation: keep the panel usable with known facts. */
  _degrade() {
    const current = this.current
    if (!current) return [this, null]
    if (!current.explanation) current.explanation = current.collision.detail
    current.contract = current.contract || fallbackContract(current.collision)
    current.generated = false
    current.phase = 'ready'
    this._layout()
    return [this, null]
  }

  /**
   * The only outbound step, and the reason it is bound to a key: a PROPOSAL is
   * agent-visible, so accepting one puts this model's words into a teammate's
   * agent on another laptop. The explanation rides along as PERSONA_LINES,
   * which is dashboard-only and stops here.
   */
  _send() {
    const current = this.current
    const { collision, contract, explanation } = current
    const to = (collision.affectedSessions || []).join(', ')
    current.phase = 'sending'
    this._layout()
    return [
      this,
      async () => {
        try {
          await this.room.narrate([
            { speaker: collision.writerSession, text: explanation },
            {
              speaker: 'agentigram',
              text: `Proposed contract: ${contract.symbol} ${contract.before} → ${contract.after}`
            }
          ])
          await this.room.propose(collision.collisionId, contract, collision.writerSession)
          return { type: 'room.sent', ok: true, to }
        } catch (err) {
          return { type: 'room.sent', ok: false, error: err.message }
        }
      }
    ]
  }

  _advance() {
    this.current = null
    this.askId = null
    this._layout()
    return this._pump()
  }

  _note(text) {
    this.feed.push({ seq: null, eventType: 'NOTE', text })
    if (this.feed.length > MAX_FEED) this.feed = this.feed.slice(-MAX_FEED)
    this._layout()
  }

  // ── layout ───────────────────────────────────────────────────────────────

  /**
   * Budget the rows. The renderer addresses rows absolutely, so a view taller
   * than the terminal scrolls the alt-screen and desyncs every later frame —
   * the total here has to be exact, not approximate.
   *
   * When the terminal is too short for everything, shed in order of what the
   * person can least afford to lose: the agent list shrinks first, then the
   * contract's constraint line, and the room feed keeps its last row.
   */
  _layout() {
    const count = (this.state?.agents || []).length
    // An empty room still draws one "no agents yet" row.
    this.agentRows = Math.max(1, Math.min(AGENT_ROWS, count))
    this.panelRows = this.current ? PANEL_H : 0

    let body = this.height - HEADER_H - FOOTER_H - this.agentRows - this.panelRows
    while (body < 1 && this.agentRows > 1) {
      this.agentRows -= 1
      body += 1
    }
    while (body < 1 && this.panelRows > PANEL_MIN_H) {
      this.panelRows -= 1
      body += 1
    }
    this.bodyRows = Math.max(1, body)

    this.body.width = this.width
    this.body.height = this.bodyRows
    this.body.setContent(this._feedLines().join('\n'))
    if (this.follow) this.body.gotoBottom()
  }

  _feedLines() {
    const width = Math.max(MIN_WIDTH, this.width)
    return this.feed.map((frame) => {
      const tag = frame.eventType === 'NOTE' ? '·' : shortType(frame.eventType)
      const line = `${tag} ${frame.text}`
      return line.length > width ? `${line.slice(0, width - 1)}…` : line
    })
  }

  // ── view ─────────────────────────────────────────────────────────────────

  view() {
    const rows = [this._header(), rule(this.width)]
    rows.push(...this._agents())
    rows.push(...take(this.body.view().split('\n'), this.bodyRows))
    if (this.current) rows.push(...this._panel())
    rows.push(rule(this.width))
    rows.push(this._footer())
    // Belt and braces: _layout budgets these exactly, but a component that
    // renders one row more than asked must not be able to scroll the screen.
    return rows.slice(0, this.height).join('\n')
  }

  _header() {
    const state = this.state || {}
    const left = style()
      .foreground(ACCENT)
      .bold()
      .render(`agentigram ${this.roomId}`)
    const mode = state.mode ? ` ${state.mode}` : ''
    const link =
      this.link === 'connected'
        ? style().foreground(OK).render('daemon ✓')
        : style().foreground(DANGER).render(`daemon ${this.link}`)
    const engine =
      this.phase === 'ready'
        ? style().foreground(OK).render(`${this.model} ✓`)
        : this.phase === 'failed'
          ? style().foreground(DANGER).render('model unavailable')
          : style()
              .foreground(WARN)
              .render(`${this.spinner.view()} loading ${Math.round(this.percentage)}%`)
    return fit(`${left}${mode}  ${link}  ${engine}`, this.width)
  }

  _agents() {
    const agents = (this.state?.agents || []).slice(0, this.agentRows)
    if (agents.length === 0) {
      return [style().foreground(MUTED).render(fit('  no agents in the room yet', this.width))]
    }
    const leases = this.state?.leases || []
    return agents.map((agent) => {
      const held = leases.filter((lease) => lease.sessionId === agent.sessionId).length
      const dot = agent.status === 'active' ? style().foreground(OK).render('●') : style().foreground(MUTED).render('○')
      const name = pad(agent.sessionId, 12)
      const host = pad(agent.host || '', 12)
      const task = agent.intent?.task || (agent.status === 'ended' ? 'left' : 'idle')
      const lock = held ? style().foreground(WARN).render(` 🔒${held}`) : ''
      return fit(`  ${dot} ${name} ${host} ${task}${lock}`, this.width)
    })
  }

  _panel() {
    const { collision, explanation, contract, phase, generated } = this.current
    const symbols = (collision.symbols || []).map((key) => parseSymbolKey(key).name).join(', ')
    const tier = style()
      .foreground(collision.tier === 'PREDICTED' ? DANGER : WARN)
      .bold()
      .render(collision.tier)
    const who = `${collision.writerSession} ↔ ${(collision.affectedSessions || []).join(', ')}`
    const head = `${tier}  ${who}${symbols ? `  ${symbols}` : ''}`

    const body = explanation
      ? explanation
      : phase === 'explaining'
        ? `${this.spinner.view()} putting it into words…`
        : collision.detail

    const contractLine = contract
      ? `contract  ${contract.symbol}: ${contract.before} → ${contract.after}`
      : `${this.spinner.view()} the local model is drafting a contract…`
    const constraint = contract?.constraint ? `          ${contract.constraint}` : ''

    const keys =
      phase === 'ready'
        ? style()
            .foreground(ACCENT)
            .render('  [enter] send proposal   [r] redraft   [x] dismiss') +
          (generated ? '' : style().foreground(MUTED).render('   (deterministic draft)'))
        : phase === 'sending'
          ? `  ${this.spinner.view()} sending…`
          : phase === 'sent'
            ? style().foreground(OK).render('  sent')
            : style().foreground(MUTED).render('  drafting…')

    // Ordered most to least essential; _layout decides how many survive, and
    // the keys line is pinned last because a panel you cannot act on is worse
    // than one you cannot fully read.
    const rows = [
      rule(this.width),
      fit(head, this.width),
      fit(`  ${body}`, this.width),
      fit(`  ${contractLine}`, this.width),
      fit(constraint, this.width)
    ]
    return [...rows.slice(0, Math.max(PANEL_MIN_H - 1, this.panelRows - 1)), fit(keys, this.width)]
  }

  _footer() {
    const summary = this.state?.summary
    const counts = summary
      ? `${summary.activeSessions}/${summary.sessions} active · ${summary.openCollisions} open · ${summary.activeLeases} leases`
      : 'waiting for the daemon'
    return style().foreground(MUTED).render(fit(`  ${counts}   [q] quit`, this.width))
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

// Event types are long and the room pane is narrow; the first two segments
// carry the meaning (LEASE_DENIED -> LEASE·DEN).
function shortType(type) {
  if (!type) return '·'
  const parts = String(type).split('_')
  return parts.length === 1 ? parts[0].slice(0, 8) : `${parts[0]}·${parts[1].slice(0, 3)}`
}

function rule(width) {
  return style()
    .foreground(MUTED)
    .render('─'.repeat(Math.max(1, width)))
}

// Exactly `count` rows: pad short, drop long. The layout budget assumes it.
function take(rows, count) {
  const out = rows.slice(0, count)
  while (out.length < count) out.push('')
  return out
}

function pad(text, width) {
  const value = String(text || '')
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

// Truncate on the *visible* length. Styled strings carry ANSI escapes that the
// renderer does not count as columns, so measuring the raw string would clip
// short lines that merely look long.
function fit(text, width) {
  const value = String(text ?? '')
  const visible = value.replace(/\u001b\[[0-9;]*m/g, '')
  if (visible.length <= width) return value
  if (visible === value) return `${value.slice(0, Math.max(0, width - 1))}…`
  return value
}

module.exports = { App }
