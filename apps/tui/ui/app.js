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
const SPEAKING = '#5BC8FF'

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

// ── speech button glyphs ──────────────────────────────────────────────────
const SPEECH_IDLE = '[♪]'
const SPEECH_PLAYING = '[▶]'
const SPEECH_MUTED = '[×]'
const SPEECH_UNAVAILABLE = '[!]'
const SPEECH_BTN_WIDTH = 3 // visible characters for the bracket+glyph+bracket

class App {
  constructor({ inference, room, speech, model, version, roomId, localSession } = {}) {
    this.inference = inference || null
    this.room = room || null
    /** Speech controller from Part 2. May be null while unavailable. */
    this.speech = speech || null
    this.model = model || 'local model'
    this.version = version || '0.0.0'
    this.roomId = roomId || 'room'
    /** The session name of this laptop's agent. Set after the first room.state. */
    this.localSession = localSession || null

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

    // ── speech state ──────────────────────────────────────────────────────
    /**
     * Per-session mute map. true = muted, false/absent = enabled.
     * Local agent starts enabled; all others start muted.
     */
    this.speechMuted = new Map()
    /** The sessionId whose line is currently being spoken. */
    this.speakingSession = null
    /**
     * Whether the Speech controller has errored out irrecoverably.
     * A single model error sets this; messaging continues unaffected.
     */
    this.speechUnavailable = false

    // ── keyboard selection ────────────────────────────────────────────────
    /** Index of the selected agent row (for keyboard 's' toggle). */
    this.selectedAgent = 0

    // ── hitboxes ──────────────────────────────────────────────────────────
    /**
     * Array of { sessionId, col, row } for each rendered speech button,
     * populated by _agents() during view generation and used by mouse handler.
     */
    this._speechHitboxes = []
    /** Absolute terminal row at which the first agent line is rendered. */
    this._agentRowStart = HEADER_H
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
        // Seed the local session from the room state if not already known.
        if (!this.localSession && msg.state?.sessionId) {
          this.localSession = msg.state.sessionId
        }
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

      // ── speech controller events ──────────────────────────────────────────
      // These come from Part 2's Speech controller forwarded through bin.mjs.
      // The UI only updates visual state — it never calls TTS APIs itself.

      case 'speech.progress':
        // Model download progress; no visual change needed in the agent rows.
        return [this, null]

      case 'speech.ready':
        this.speechUnavailable = false
        this._layout()
        return [this, null]

      case 'speech.queued':
        // A line is waiting; no special indicator needed.
        return [this, null]

      case 'speech.started':
        // msg.sessionId: whose voice is now playing.
        this.speakingSession = msg.sessionId || null
        this._layout()
        return [this, null]

      case 'speech.finished':
        if (this.speakingSession === (msg.sessionId || null)) {
          this.speakingSession = null
        }
        this._layout()
        return [this, null]

      case 'speech.muted':
        // The controller confirmed a mute change; sync our map.
        if (msg.sessionId) {
          this.speechMuted.set(msg.sessionId, !!msg.muted)
        }
        this._layout()
        return [this, null]

      case 'speech.error':
        this._note(`speech error: ${msg.message}`)
        this.speechUnavailable = true
        this.speakingSession = null
        this._layout()
        return [this, null]

      // ── input ─────────────────────────────────────────────────────────────

      case 'mouse':
        return this._mouse(msg)

      case 'key':
        return this._key(msg)

      default:
        return [this, null]
    }
  }

  _mouse(msg) {
    if (msg.action === 'wheel') {
      if (msg.button === 'wheelup') this.body.scrollUp(3)
      else this.body.scrollDown(3)
      this.follow = this.body.atBottom
      return [this, null]
    }

    if (msg.action !== 'click' && msg.action !== 'release') return [this, null]
    if (msg.action === 'release') return [this, null]

    // Check whether the click landed on a speech button hitbox.
    for (const hb of this._speechHitboxes) {
      if (msg.y === hb.row && msg.x >= hb.col && msg.x < hb.col + SPEECH_BTN_WIDTH) {
        return this._toggleSpeech(hb.sessionId)
      }
    }
    return [this, null]
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

    // ── speech keyboard controls ───────────────────────────────────────────
    const agents = this.state?.agents || []
    if (pressed === 'up' || pressed === 'k') {
      this.selectedAgent = Math.max(0, this.selectedAgent - 1)
      this._layout()
      return [this, null]
    }
    if (pressed === 'down' || pressed === 'j') {
      this.selectedAgent = Math.min(Math.max(0, agents.length - 1), this.selectedAgent + 1)
      this._layout()
      return [this, null]
    }
    if (pressed === 's') {
      const agent = agents[this.selectedAgent]
      if (agent) return this._toggleSpeech(agent.sessionId)
    }

    return [this, null]
  }

  // ── speech helpers ────────────────────────────────────────────────────────

  /**
   * Toggle the mute state for a session and tell the speech controller.
   * Local agent defaults to enabled (unmuted); remote agents to muted.
   */
  _toggleSpeech(sessionId) {
    const currentlyMuted = this._isMuted(sessionId)
    this.speechMuted.set(sessionId, !currentlyMuted)
    this._layout()
    // Forward to the Part 2 speech controller if available.
    if (this.speech) {
      return [
        this,
        async () => {
          try {
            await this.speech.mute(sessionId, !currentlyMuted)
          } catch (_) {
            // Speech errors must not break messaging.
          }
          return null
        }
      ]
    }
    return [this, null]
  }

  /**
   * Whether a session's speech is currently muted.
   * Local agent defaults to unmuted; everyone else defaults to muted.
   */
  _isMuted(sessionId) {
    if (this.speechMuted.has(sessionId)) return this.speechMuted.get(sessionId)
    // Default: local agent enabled, remote agents muted.
    return sessionId !== this.localSession
  }

  /**
   * Render the speech button for a given session.
   * Returns { text, col } where col is the visible column offset from the
   * start of the row (used by hitbox registration in _agents()).
   */
  _speechButton(sessionId) {
    if (this.speechUnavailable) {
      return style().foreground(DANGER).render(SPEECH_UNAVAILABLE)
    }
    if (this.speakingSession === sessionId) {
      return style().foreground(SPEAKING).render(SPEECH_PLAYING)
    }
    if (this._isMuted(sessionId)) {
      return style().foreground(MUTED).render(SPEECH_MUTED)
    }
    return style().foreground(OK).render(SPEECH_IDLE)
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
    // Reset hitboxes on every render so stale rows are not clicked.
    this._speechHitboxes = []
    this._agentRowStart = HEADER_H

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

  /**
   * Render agent rows and register speech button hitboxes.
   *
   * Row format (per the plan): `  session · host/model · [btn] · current work`
   * - No circle prefix.
   * - Speech button is `[♪]`, `[▶]`, `[×]` or `[!]`.
   * - Color is secondary: cyan for speaking, OK for enabled, muted grey, red fail.
   * - At narrow widths the button is preserved; host/activity text truncates first.
   */
  _agents() {
    const agents = (this.state?.agents || []).slice(0, this.agentRows)
    if (agents.length === 0) {
      return [style().foreground(MUTED).render(fit('  no agents in the room yet', this.width))]
    }
    const leases = this.state?.leases || []
    const activity = this.state?.activity || {}
    const presence = this.state?.presence || {}

    return agents.map((agent, idx) => {
      const held = leases.filter((lease) => lease.sessionId === agent.sessionId).length
      // A laptop that was closed never sends SessionEnd; no heartbeat is how
      // you know it is gone rather than thinking.
      const here = presence[agent.sessionId] || 'live'
      const busy = here === 'live' ? activity[agent.sessionId] : undefined

      // ── fixed-width columns ───────────────────────────────────────────────
      const sessionCol = pad(agent.sessionId, 12)
      const hostLabel = agent.host || ''
      // At very narrow widths, truncate the host label rather than the button.
      const actualHostWidth = Math.min(12, Math.max(0, this.width - 2 - 12 - 1 - SPEECH_BTN_WIDTH - 1 - 4))
      const hostCol = pad(hostLabel.slice(0, actualHostWidth), actualHostWidth)

      // ── fixed-column budget (visible characters) ───────────────────────────
      // indent(2) + session(12) + space(1) + host(actualHostWidth) + space(1) + btn(3) + space(1)
      const fixedWidth = 2 + 12 + 1 + actualHostWidth + 1 + SPEECH_BTN_WIDTH + 1
      const doingBudget = Math.max(4, this.width - fixedWidth)

      // ── current work ──────────────────────────────────────────────────────
      const doingRaw =
        agent.status === 'ended'
          ? 'left'
          : here === 'stale'
            ? 'offline'
            : busy
              ? busy.what
              : 'idle'
      // Truncate activity text to fit, then re-apply style.
      const doingTruncated = doingRaw.length > doingBudget
        ? `${doingRaw.slice(0, doingBudget - 1)}…`
        : doingRaw
      const doingStyled =
        agent.status === 'ended'
          ? style().foreground(MUTED).render(doingTruncated)
          : here === 'stale'
            ? style().foreground(MUTED).render(doingTruncated)
            : busy
              ? doingTruncated
              : style().foreground(MUTED).render(doingTruncated)

      const lock = held ? style().foreground(WARN).render(` 🔒${held}`) : ''

      // ── speech button ─────────────────────────────────────────────────────
      const btn = this._speechButton(agent.sessionId)
      // Selection highlight: when keyboard-navigated, mark the selected row.
      const selected = idx === this.selectedAgent

      // Register hitbox: absolute terminal row = header (2 rows) + idx.
      // Column = 2 (indent) + session(12) + space(1) + host(actualHostWidth) + space(1)
      const btnCol = 2 + 12 + 1 + actualHostWidth + 1
      this._speechHitboxes.push({
        sessionId: agent.sessionId,
        row: HEADER_H + idx, // 0-indexed terminal row
        col: btnCol
      })

      // ── assemble the row ──────────────────────────────────────────────────
      // Format: `  <session> <host> <btn> <doing><lock>`
      const prefix = selected
        ? style().bold().render(`  ${sessionCol} ${hostCol} `)
        : `  ${sessionCol} ${hostCol} `
      const raw = `${prefix}${btn} ${doingStyled}${lock}`
      return fit(raw, this.width)
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
    return style()
      .foreground(MUTED)
      .render(fit(`  ${counts}   [q] quit   [s] voice`, this.width))
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
