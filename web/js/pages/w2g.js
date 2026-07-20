/* global window, document, U, YumeAPI, WebSocket */
// Watch Together — create/join rooms (Yume API) and watch in sync.
// Playback sync runs over the /ws socket; PageWatch picks up the ?w2g=
// param and relays play/pause/seek between room members.

const PageW2G = {
  // one live socket shared with the watch page
  socket: null,
  room: null,
  _listeners: new Set(),

  onMessage (fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  },

  send (msg) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg))
  },

  async connect (code) {
    if (this.room === code && this.socket?.readyState === WebSocket.OPEN) return
    this.disconnect()

    const tokens = YumeAPI._tokens()
    if (!tokens) throw new Error('Sign in to your Yume account first')

    const base = YumeAPI.base().replace(/^http/, 'ws')
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base}/ws?token=${tokens.accessToken}`)
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', channel: `w2g:${code}` }))
      }
      ws.onmessage = e => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'joined') { this.socket = ws; this.room = code; resolve() }
        if (msg.error) reject(new Error(msg.error))
        for (const fn of this._listeners) fn(msg)
      }
      ws.onerror = () => reject(new Error('Connection failed'))
      ws.onclose = () => { if (this.room === code) { this.socket = null; this.room = null } }
    })
  },

  disconnect () {
    this.socket?.close()
    this.socket = null
    this.room = null
    this._listeners.clear()
  },

  async render (root, params, arg) {
    root.append(window.C.spotlight('Watch Together', { subtitle: 'Synced rooms — play, pause and seeks stay together' }))
    const pad = U.el('div', { class: 'page-pad', style: 'max-width:44rem;' })
    root.append(pad)

    if (!await YumeAPI.available()) {
      pad.append(U.el('div', { class: 'callout', html: `Watch Together needs the Yume server. None reachable at <code>${YumeAPI.base()}</code> — start the backend or set it in <a href="#/settings" style="text-decoration:underline">Settings</a>.` }))
      return
    }
    if (!YumeAPI.user()) {
      pad.append(U.el('div', { class: 'callout', html: 'Sign in to your <a href="#/settings" style="text-decoration:underline">Yume account</a> to create or join rooms.' }))
      return
    }

    // deep link: #/w2g/<code>
    if (arg) return this.renderRoom(pad, arg)

    const codeInput = U.el('input', { class: 'input', placeholder: 'Room code (e.g. b7ce5ee3)', maxlength: '16', style: 'flex-grow:1;min-width:0;' })
    codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click() })
    const joinBtn = U.el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        const code = codeInput.value.trim().toLowerCase()
        if (code) window.location.hash = '#/w2g/' + code
      }
    }, [document.createTextNode('Join')])

    pad.append(
      U.el('div', { class: 'setting-card' }, [
        U.el('h3', { text: 'Join a room' }),
        U.el('p', { text: 'Got a code from a friend? Jump in and watch in sync.' }),
        U.el('div', { style: 'display:flex;gap:.6rem;' }, [codeInput, joinBtn])
      ]),
      U.el('div', { class: 'setting-card' }, [
        U.el('h3', { text: 'Create a room' }),
        U.el('p', { text: 'Start a room, share the code, then pick something to watch — play, pause and seeks stay in sync for everyone.' }),
        U.el('button', {
          class: 'btn btn-theme',
          onclick: async e => {
            try {
              e.target.disabled = true
              const room = await YumeAPI._request('/v1/w2g', { method: 'POST', auth: true, body: {} })
              window.location.hash = '#/w2g/' + room.code
            } catch (err) {
              U.toast(err.message, 'error')
              e.target.disabled = false
            }
          }
        }, [document.createTextNode('Create room')])
      ])
    )
  },

  async renderRoom (pad, code) {
    let room
    try {
      room = await YumeAPI._request('/v1/w2g/' + encodeURIComponent(code))
    } catch (e) {
      pad.append(U.el('div', { class: 'error-state', text: 'Room not found — it may have been closed.' }),
        U.el('div', { style: 'text-align:center;margin-top:1rem;' }, [
          U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/w2g' }, [document.createTextNode('Back')])
        ]))
      return
    }

    const viewers = U.el('b', { text: String(room.viewers) })
    const feed = U.el('div', { class: 'w2g-feed' })

    pad.append(U.el('div', { class: 'setting-card' }, [
      U.el('h3', {}, [document.createTextNode('Room '), U.el('code', { style: 'font-family:var(--font-mono);color:var(--accent);', text: room.code })]),
      U.el('p', {}, [
        document.createTextNode(`Hosted by ${room.host} • `),
        viewers,
        document.createTextNode(' watching now')
      ]),
      U.el('div', { style: 'display:flex;gap:.6rem;flex-wrap:wrap;' }, [
        U.el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: () => { navigator.clipboard?.writeText(room.code).then(() => U.toast('Code copied')) }
        }, [document.createTextNode('Copy code')]),
        U.el('a', { class: 'btn btn-primary btn-sm', href: `#/search` , onclick: () => { sessionStorage.setItem('w2g-pending', room.code); U.toast('Pick an anime — playback will sync to the room') } }, [document.createTextNode('Pick something to watch')]),
        U.el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => { this.disconnect(); window.location.hash = '#/w2g' }
        }, [document.createTextNode('Leave')])
      ]),
      feed
    ]))

    const log = text => {
      feed.append(U.el('div', { class: 'w2g-event', text }))
      while (feed.children.length > 8) feed.firstChild.remove()
    }

    try {
      await this.connect(code)
      this.onMessage(msg => {
        if (msg.type === 'presence') {
          viewers.textContent = String(msg.count)
          if (msg.joined) log(`${msg.joined} joined`)
          if (msg.left) log(`${msg.left} left`)
        }
        if (msg.type === 'w2g' && msg.action !== 'position') {
          log(`${msg.from} ${msg.action === 'seek' ? 'seeked to ' + U.fmtTime(msg.position) : msg.action + 'd'}`)
        }
      })
      log('Connected to the room')
    } catch (e) {
      pad.append(U.el('div', { class: 'error-state', text: e.message }))
    }
  }
}

window.PageW2G = PageW2G
