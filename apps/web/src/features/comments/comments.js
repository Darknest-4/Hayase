/* global document, window */
// Hozzászólások: egy anime szála (adatlap, lejátszó), a hozzászólás törzse (a
// közösségi hírfolyam is ezt rajzolja) és a jelentés párbeszédablaka.
//
// 2026-09-ig a közös komponensek (`shared/ui/components.js`) része volt, tehát
// minden látogató minden oldalon letöltötte — a belépőlapon és a keresőben
// is, ahol hozzászólás nincs. Most az a képernyő hozza, amelyik rajzolja.

import { C } from '../../shared/ui/components.js'
import { featureOn, permissionsHeld } from '../../shared/lib/site-config.js'
import { T } from '../../shared/i18n/i18n.js'
import { P } from '../../shared/ui/primitives.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'
import { loadStylesheet } from '../../shared/lib/stylesheet.js'

export const Comments = {
  // ---- a hozzászólás törzse (spoilerre figyel, sima szöveg) ----
  body (comment) {
    const body = U.el('div', { class: 'comment-body', text: comment.body })
    if (!comment.spoiler) return body
    const shield = U.el('div', {
      class: 'comment-spoiler',
      text: T('Spoiler — click to reveal'),
      onclick: e => { e.stopPropagation(); shield.replaceWith(body) }
    })
    return shield
  },

  // ---- egy anime hozzászólás-szála (adatlap, lejátszó) ----
  section (media) {
    /*
     * OSZTÁLYNÉV, hogy az elrendezés meg tudja fogni.
     *
     * Osztály nélkül a szakaszt CSS-ből nem lehetett megcélozni, és emiatt
     * telefonon nem lehetett a helyére tenni: a lejátszóoldalon az
     * epizódlista a lejátszó FÖLÉ került, mert a hozzászólásokat nem lehetett
     * a lista mögé rendezni. Mérve: a videó a hajtás alá csúszott.
     */
    const wrap = U.el('div', { class: 'comments-section' })
    // The switch is enforced on the server too now — routes/comments.ts refuses
    // every endpoint when the flag is off — so this says so rather than
    // drawing a thread whose requests would 404.
    if (!featureOn('comments')) {
      return U.el('div', { class: 'empty-state', style: 'max-width:none;', text: T('Comments are turned off.') })
    }
    const list = U.el('div', {}, [P.spinner()])

    const load = async () => {
      const yumeId = await YumeAPI.yumeAnimeId(media)
      list.replaceChildren()

      if (yumeId) {
        try {
          const { data } = await YumeAPI.comments('anime', yumeId)
          if (!data.length) {
            list.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-5);', text: T('No comments yet.') }))
          }
          const byParent = new Map()
          for (const c of data) {
            const key = c.parent_id ?? 'root'
            if (!byParent.has(key)) byParent.set(key, [])
            byParent.get(key).push(c)
          }
          const viewer = YumeAPI.user()
          const canModerate = permissionsHeld().includes('comment.moderate') ||
            permissionsHeld().includes('community.moderate')

          const renderThread = (comment, depth) => {
            /*
             * A SÍRKŐ a szál alakját tartja, nem tartalmat.
             *
             * Egy szálindító törlésekor a sor megmarad — különben a
             * `parent_id` cascade-je MÁSOK válaszait is elvinné —, de a
             * törzse elveszett. Ilyenkor nincs mit lájkolni, jelenteni vagy
             * újra törölni; csak a hely marad meg, ahová a válaszok
             * kapcsolódnak.
             */
            const deleted = Boolean(comment.deleted_at)
            /*
             * A GOMB ELREJTÉSE NEM VÉDELEM. A kiszolgáló a szerzőt és a
             * jogosultságot maga nézi meg, és idegen kommentre 404-gyel felel.
             * Ez csak annyi, hogy ne kínáljunk olyat, ami úgysem sikerülne.
             */
            const mayDelete = !deleted && Boolean(viewer) &&
              (comment.author_id === viewer.id || canModerate)

            const node = U.el('div', { class: deleted ? 'comment comment-deleted' : 'comment', style: depth ? `margin-left:${Math.min(depth, 4) * 1.5}rem;` : null }, [
              U.el('div', { class: 'comment-head' }, [
                C.avatar(comment),
                U.el('span', { class: 'comment-author', text: comment.author }),
                U.el('span', { class: 'comment-time', text: U.relTime(new Date(comment.created_at)) })
              ]),
              deleted
                ? U.el('p', { class: 'comment-body comment-body-deleted', text: T('This comment was deleted.') })
                : this.body(comment),
              deleted
                ? null
                : U.el('div', { class: 'comment-actions' }, [
                  U.el('button', {
                    class: 'comment-action',
                    text: `♥ ${comment.like_count}`,
                    onclick: async e => {
                      try {
                        const { liked } = await YumeAPI.likeComment(comment.id)
                        comment.like_count += liked ? 1 : -1
                        e.target.textContent = `♥ ${comment.like_count}`
                      } catch (err) { U.toast(err.message, 'error') }
                    }
                  }),
                  U.el('button', {
                    class: 'comment-action',
                    text: T('Reply'),
                    onclick: () => {
                      if (node.querySelector('.comment-form')) return
                      node.append(form(comment.id, () => load()))
                    }
                  }),
                  U.el('button', {
                    class: 'comment-action',
                    text: T('Report'),
                    onclick: () => this.report('comment', comment.id)
                  }),
                  /*
                 * A TÖRLÉS MEGERŐSÍTÉST KÉR. Visszavonhatatlan, és a
                 * „Válasz" meg a „Jelentés" mellett egy ujjnyira van.
                 *
                 * Sikeres törlés után a szálat ÚJRAOLVASSUK, nem a helyi
                 * másolatot igazgatjuk: a kiszolgáló dönti el, hogy a sor
                 * eltűnt-e vagy sírkő lett belőle, és a szülő
                 * válaszszámlálója is ott változott meg. Egy kézzel
                 * összerakott helyi állapot ettől csendben eltérne.
                 */
                  mayDelete
                    ? U.el('button', {
                      class: 'comment-action comment-action-danger',
                      text: T('Delete'),
                      onclick: async e => {
                        const button = e.currentTarget
                        const ok = await C.confirm({
                          title: T('Delete comment?'),
                          message: T('Delete this comment? This cannot be undone.'),
                          confirmLabel: T('Delete'),
                          danger: true
                        })
                        if (!ok) return
                        button.disabled = true
                        try {
                          await YumeAPI.deleteComment(comment.id)
                          U.toast(T('Comment deleted'))
                          await load()
                        } catch (err) {
                          button.disabled = false
                          U.toast(err.message, 'error')
                        }
                      }
                    })
                    : null
                ])
            ].filter(Boolean))
            list.append(node)
            for (const child of byParent.get(comment.id) ?? []) renderThread(child, depth + 1)
          }
          for (const comment of byParent.get('root') ?? []) renderThread(comment, 0)
        } catch (e) {
          list.append(P.errorState(T('Failed to load comments: ') + e.message))
        }
      } else {
        list.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-5);', text: T('No comments yet.') }))
      }

      // composer / auth prompt
      if (YumeAPI.user()) {
        if (!list.querySelector('.comment-form-root')) list.append(form(null, () => load(), true))
      } else {
        const here = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0]
        list.append(U.el('div', { class: 'callout callout-info comment-signin' }, [
          U.el('p', { text: T('Sign in to join the discussion.') }),
          U.el('a', { class: 'btn btn-secondary btn-sm', href: `#/login${here ? `?next=${encodeURIComponent(here)}` : ''}`, text: T('Sign in') })
        ]))
      }
    }

    const form = (parentId, done, root = false) => {
      const textarea = U.el('textarea', {
        class: 'textarea comment-input',
        rows: '3',
        maxlength: '5000',
        'aria-label': parentId ? T('Write a reply…') : T('Share your thoughts… (mark spoilers!)'),
        placeholder: parentId ? T('Write a reply…') : T('Share your thoughts… (mark spoilers!)')
      })
      // A raw 13x13 checkbox with no name: the word "Spoiler" sits in a
      // sibling span outside the label, so the control announced as nothing
      // and was under the 24px target floor.
      const spoiler = U.el('input', { type: 'checkbox', class: 'comment-spoiler', 'aria-label': T('Spoiler') })
      const submit = U.el('button', { class: 'btn btn-primary btn-sm', text: T('Post') })
      submit.addEventListener('click', async () => {
        const body = textarea.value.trim()
        if (!body) return
        try {
          submit.disabled = true
          const yumeId = await YumeAPI.yumeAnimeId(media, { create: true })
          await YumeAPI.postComment('anime', yumeId, body, { parentId, spoiler: spoiler.checked })
          U.toast(T('Comment posted'))
          done()
        } catch (e) {
          U.toast(e.message, 'error')
        } finally {
          submit.disabled = false
        }
      })
      return U.el('div', { class: 'comment-form' + (root ? ' comment-form-root' : '') }, [
        textarea,
        U.el('div', { style: 'display:flex;gap:var(--space-3);align-items:center;margin-top:var(--space-2);' }, [
          submit,
          U.el('label', { style: 'display:flex;gap:var(--space-2);align-items:center;font-size:var(--text-xs);color:var(--fg-faint);cursor:pointer;' }, [spoiler, document.createTextNode(T('Spoiler'))])
        ])
      ])
    }

    // A szál stíluslapja a szállal jön: kikapcsolt hozzászólásnál vagy háttér
    // nélkül le sem töltődik.
    Promise.all([YumeAPI.available(), loadStylesheet('features/comments.css')]).then(([ok]) => {
      if (!ok) {
        wrap.remove() // no backend → no comment section at all, no dead UI
        return
      }
      wrap.append(U.el('h2', { class: 'detail-section-title', text: T('Comments') }), list)
      load()
    })

    return wrap
  },

  /**
   * Jelentés egy hozzászólásról (vagy más tartalomról): ok a kiszolgáló zárt
   * listájából, és egy nem kötelező megjegyzés. Eddig egy `window.prompt`
   * kérte be szabad szövegként, angolul — és ami nem egyezett a listával,
   * az csendben „egyéb" lett.
   */
  report (subjectType, subjectId) {
    const REASONS = [
      ['spam', T('Spam or advertising')],
      ['harassment', T('Harassment or hate')],
      ['spoiler', T('Unmarked spoiler')],
      ['nsfw', T('Adult content')],
      ['illegal', T('Illegal content')],
      ['other', T('Something else')]
    ]
    const reason = P.select(REASONS, { value: 'spam', name: 'reason' })
    const details = P.textarea({ name: 'details', maxlength: '2000', rows: '3', placeholder: T('What is wrong with it? (optional)') })
    const error = U.el('p', { class: 'field-error', role: 'alert', hidden: true })
    const submit = P.button(T('Send report'), { variant: 'primary', type: 'submit' })
    const form = U.el('form', { class: 'dialog-form', id: 'report-' + Math.random().toString(36).slice(2, 8) }, [
      P.field(T('Reason'), reason),
      P.field(T('Details'), details),
      error
    ])
    submit.setAttribute('form', form.id)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      error.hidden = true
      submit.disabled = true
      submit.dataset.loading = '1'
      try {
        const answer = await YumeAPI.report(subjectType, subjectId, reason.value, details.value.trim() || undefined)
        dialog.close()
        // A kiszolgáló egy ismételt jelentést nem vesz fel újra, és ezt meg is mondja.
        U.toast(answer?.status === 'already_reported' ? T('You have already reported this.') : T('Report submitted — thank you'), 'success')
      } catch (err) {
        error.textContent = err?.message ?? T('Something went wrong. Please try again.')
        error.hidden = false
      } finally {
        submit.disabled = false
        delete submit.dataset.loading
      }
    })
    const dialog = C.openDialog({
      title: T('Report'),
      body: [form],
      actions: [P.button(T('Cancel'), { variant: 'ghost', onclick: () => dialog.close() }), submit],
      initialFocus: reason
    })
  }
}
