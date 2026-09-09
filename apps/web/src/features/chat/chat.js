/* global window, document, WebSocket */
// Live chat: a list of rooms, and one room open at a time.
//
// The socket carries messages both ways, but a message you sent is drawn the
// moment you press enter rather than when the server echoes it back. That is
// the difference between a chat and a form: on a slow connection the echo is
// half a second away, and half a second of nothing after pressing enter reads
// as "it did not send".
//
// The optimistic line is replaced by the real one when the echo arrives, so
// nothing is drawn twice and a message the server refused disappears instead
// of sitting there looking sent.

import { C } from '../../shared/ui/components.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'

/** How long an unacknowledged message waits before it is marked as failed. */
const ACK_TIMEOUT_MS = 8000

export const Chat = {
  socket: null,
  roomId: null,
  _pending: new Map(),
  /** Bumped by every connect, so an older one can tell it has been superseded. */
  _generation: 0,

  async render (root, params, perms = []) {
    const slug = params.get('r')
    const wrap = U.el('div', { class: 'chat' })
    root.append(wrap)

    let rooms
    try { ({ data: rooms } = await YumeAPI.chat.rooms()) } catch (e) {
      wrap.append(C.errorState(e, () => this.render(root, params, perms)))
      return
    }

    if (!rooms.length) {
      wrap.append(U.el('div', { class: 'empty-state', text: T('No chat rooms yet.') }))
      return
    }

    const active = rooms.find(room => room.slug === slug) ?? rooms[0]

    // The room rail. On a phone it becomes a scrolling strip above the
    // messages rather than a column beside them — see the stylesheet.
    const rail = U.el('nav', { class: 'chat-rooms' })
    for (const room of rooms) {
      rail.append(U.el('a', {
        class: 'chat-room' + (room.slug === active.slug ? ' active' : ''),
        href: `#/community?tab=chat&r=${encodeURIComponent(room.slug)}`
      }, [
        U.el('span', { class: 'chat-room-name', text: room.name }),
        room.today > 0 ? U.el('span', { class: 'chat-room-today', text: String(room.today) }) : null
      ]))
    }

    const panel = U.el('section', { class: 'chat-panel' })
    wrap.append(rail, panel)
    await this._room(panel, active, perms)
  },

  async _room (panel, room, perms) {
    panel.replaceChildren(
      U.el('header', { class: 'chat-head' }, [
        U.el('h2', { class: 'chat-title', text: room.name }),
        room.topic ? U.el('p', { class: 'chat-topic', text: room.topic }) : null
      ])
    )

    const log = U.el('div', { class: 'chat-log' }, [U.el('div', { class: 'spinner' })])
    panel.append(log)

    let messages = []
    try { ({ data: messages } = await YumeAPI.chat.messages(room.slug)) } catch (e) {
      log.replaceChildren(U.el('div', { class: 'error-state', text: T('Could not load the history: ') + e.message }))
    }

    log.replaceChildren()
    // The endpoint answers newest-first, because that is the page a room opens
    // on; reading order is the other way round.
    for (const message of messages.slice().reverse()) log.append(this._line(message, perms))
    this._toBottom(log)

    const me = YumeAPI.user()
    if (!me) {
      panel.append(U.el('div', { class: 'callout', text: T('Sign in to join the conversation.') }))
      return
    }

    const input = U.el('input', {
      class: 'input chat-input',
      placeholder: T('Write a message…'),
      maxlength: '4000',
      autocomplete: 'off'
    })
    const send = U.el('button', { class: 'btn btn-primary btn-sm', text: T('Send') })
    panel.append(U.el('form', {
      class: 'chat-compose',
      onsubmit: event => { event.preventDefault(); this._send(log, input, me, perms) }
    }, [input, send]))

    await this._connect(room, log, perms)
    input.focus()
  },

  /**
   * Join the room and open the socket.
   *
   * Joining first is what makes the socket accept the channel: the server
   * refuses `join` for a channel you are not a member of, and membership is
   * what the REST call creates.
   */
  async _connect (room, log, perms) {
    this.close()
    // Which attempt this is. Two renders overlapping — a navigation while the
    // first is still opening its socket — used to end with both of them
    // attaching a listener to whichever socket happened to be in `this.socket`
    // by then. One socket, two listeners: every message was handled twice, so
    // the echo adopted the pending line *and* appended a copy of it. Every
    // step below gives up if a newer attempt has started.
    const attempt = ++this._generation

    let channel
    try {
      ({ channel } = await YumeAPI.chat.join(room.slug))
    } catch (e) {
      if (attempt !== this._generation) return
      log.append(U.el('div', { class: 'chat-status', text: T('Could not join the room: ') + e.message }))
      return
    }
    if (attempt !== this._generation) return

    let socket
    try {
      socket = await YumeAPI.openSocket()
    } catch (e) {
      if (attempt !== this._generation) return
      log.append(U.el('div', { class: 'chat-status', text: T('Live updates are unavailable — reload to see new messages.') }))
      return
    }
    if (attempt !== this._generation) { socket.close(); return }

    this.roomId = channel.slice('chat:'.length)
    this.socket = socket

    // `socket`, not `this.socket`: the listeners belong to the connection this
    // call opened, whatever the field points at by the time they fire.
    // openSocket resolves on the handshake, so the join is not a race either.
    socket.send(JSON.stringify({ type: 'join', channel }))
    socket.addEventListener('message', event => {
      if (attempt !== this._generation) return
      let payload
      try { payload = JSON.parse(event.data) } catch { return }
      if (payload.type !== 'chat') return
      this._settle(log, payload, perms)
    })
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        log.append(U.el('div', { class: 'chat-status', text: T('Disconnected. Reload to reconnect.') }))
      }
    })
  },

  _send (log, input, me, perms) {
    const body = input.value.trim()
    if (!body) return
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return U.toast(T('Not connected — reload the page.'), 'error')
    }
    input.value = ''

    // Drawn now, keyed by a local id, and reconciled when the echo arrives.
    const key = 'local-' + Date.now() + Math.random().toString(36).slice(2)
    const line = this._line({ id: key, body, author: me.username, created_at: new Date().toISOString() }, perms)
    line.classList.add('chat-line-pending')
    log.append(line)
    this._toBottom(log)
    this._pending.set(body, { key, line, at: Date.now() })

    this.socket.send(JSON.stringify({ type: 'chat', chatId: this.roomId, body }))

    window.setTimeout(() => {
      const pending = this._pending.get(body)
      if (pending?.key !== key) return
      this._pending.delete(body)
      pending.line.classList.remove('chat-line-pending')
      pending.line.classList.add('chat-line-failed')
      pending.line.title = T('The server never confirmed this message.')
    }, ACK_TIMEOUT_MS)
  },

  /**
   * A message arrived. If it is the echo of one we drew already, adopt it;
   * otherwise it is somebody else's and goes at the end.
   *
   * Matching on the body rather than on an id we sent, because the protocol
   * carries no client id — and it is matched only against *our own* pending
   * lines, so two people typing the same word cannot collide.
   */
  _settle (log, payload, perms) {
    const pending = this._pending.get(payload.body)
    const me = YumeAPI.user()
    if (pending && payload.author === me?.username) {
      this._pending.delete(payload.body)
      pending.line.classList.remove('chat-line-pending')
      pending.line.dataset.id = payload.id
      return
    }
    log.append(this._line(payload, perms))
    this._toBottom(log)
  },

  _line (message, perms) {
    const created = message.created_at ? new Date(message.created_at) : new Date()
    return U.el('div', { class: 'chat-line', dataset: { id: String(message.id) } }, [
      U.el('span', { class: 'chat-line-author', text: message.author }),
      U.el('span', { class: 'chat-line-body', text: message.body }),
      U.el('time', { class: 'chat-line-when', text: created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
      perms.includes('chat.moderate') && !String(message.id).startsWith('local-')
        ? U.el('button', {
          class: 'icon-btn chat-line-remove',
          title: T('Remove this message'),
          onclick: async event => {
            try {
              await YumeAPI.chat.removeMessage(message.id)
              event.target.closest('.chat-line').remove()
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode('×')])
        : null
    ])
  },

  /** Only follow the tail when the reader is already at it. */
  _toBottom (log) {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120
    if (atBottom) log.scrollTop = log.scrollHeight
  },

  /** Leaving the tab must not leave a socket open behind it. */
  close () {
    this._generation++
    const socket = this.socket
    this.socket = null
    this._pending.clear()
    try { socket?.close() } catch (e) { /* already gone */ }
  }
}
