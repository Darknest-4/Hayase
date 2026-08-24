/* global window, document, U, C, T, I18n, Prefs */
// First-run wizard: three short steps, then it never appears again.
//
// ---------------------------------------------------------------------------
// The rules that keep it from being annoying
// ---------------------------------------------------------------------------
//
//   * It triggers on "this profile has no language preference", NOT on "this
//     account just registered". Those differ exactly where it matters: an
//     account created before this feature shipped, and a registration finished
//     on another device, both need the wizard and neither is a fresh sign-up.
//
//   * The language step arrives pre-selected from the browser's own language.
//     For a Hungarian browser the first step is a confirmation, not a
//     question — one click.
//
//   * It can always be dismissed. "Later" writes the defaults and closes.
//     A dialog that cannot be closed poisons the first minute of the site.
//     The skip is recorded so settings can offer it again gently, rather than
//     the wizard reappearing on its own.
//
//   * One save at the end, not one per step. A wizard abandoned halfway must
//     not leave a profile half-configured in ways the viewer never chose.
//
//   * Three steps. Past that people start clicking through, and answers given
//     to get rid of a dialog are worse than no answers.
//
// On a phone it renders as a bottom sheet rather than a centred dialog — see
// .onboard-card in style.css.

const Onboarding = {
  /** Built from the preference spec, so a new onboarding question is one
   *  `onboarding: true` in lib/preferences.ts plus a step entry here. */
  STEPS: [
    {
      id: 'language',
      title: 'Welcome to Yume',
      lead: 'Two quick questions and you are set. You can change all of this later in Settings.',
      keys: ['language.ui']
    },
    {
      id: 'content',
      title: 'What should we show you?',
      lead: 'How titles are written, and whether adult titles appear at all.',
      keys: ['language.titles', 'content.adult']
    },
    {
      id: 'playback',
      title: 'How do you watch?',
      lead: 'Which version starts first when a source offers both.',
      keys: ['playback.variant', 'notifications.episodes']
    }
  ],

  /** Human labels for enum values. The spec carries keys, not prose. */
  CHOICES: {
    'language.ui': [
      { value: 'hu', label: 'Magyar', hint: 'Hungarian interface' },
      { value: 'en', label: 'English', hint: 'English interface' }
    ],
    'language.titles': [
      { value: 'romaji', label: 'Romaji', hint: 'Shingeki no Kyojin' },
      { value: 'english', label: 'English', hint: 'Attack on Titan' },
      { value: 'hungarian', label: 'Magyar', hint: 'Titles where a Hungarian one exists' },
      { value: 'native', label: '日本語', hint: '進撃の巨人' }
    ],
    'playback.variant': [
      { value: 'sub', label: 'Subtitled', hint: 'Original audio with subtitles' },
      { value: 'dub', label: 'Dubbed', hint: 'Dubbed audio when there is one' },
      { value: 'any', label: 'No preference', hint: 'Whatever plays best' }
    ]
  },

  _open: false,

  // ---------------------------------------------------------------- trigger

  /** Should the wizard run? Called once after boot. */
  due () {
    if (this._open) return false
    if (!window.Prefs) return false
    return !Prefs.onboarded()
  },

  /** Run it if it is due. Safe to call unconditionally. */
  maybeOpen () {
    if (this.due()) this.open()
  },

  // ---------------------------------------------------------------- render

  open () {
    this._open = true

    // Answers live here until the final save. Pre-seeded from the browser for
    // language and from the defaults for everything else.
    const answers = { ...Prefs.all(), 'language.ui': Prefs.guessLanguage() }
    let step = 0
    let finished = false

    // Open in the language we are about to suggest, not in the site default:
    // an English browser reading a Hungarian dialog that offers it English is
    // asking the question in the one language it just told us it does not
    // want. Dismissing keeps this guess rather than reverting it, because a
    // dismissal accepts the defaults and the guess is the default.
    I18n.setLanguage(answers['language.ui'])

    const body = U.el('div', { class: 'onboard-body' })
    const dots = U.el('div', { class: 'onboard-dots' })
    const backBtn = U.el('button', { class: 'btn btn-ghost btn-sm' }, [document.createTextNode(T('Back'))])
    const nextBtn = U.el('button', { class: 'btn btn-primary' })
    const skipBtn = U.el('button', { class: 'onboard-skip' }, [document.createTextNode(T('Later'))])

    const card = U.el('div', { class: 'onboard-card' }, [
      body,
      U.el('div', { class: 'onboard-foot' }, [dots, U.el('div', { class: 'onboard-actions' }, [backBtn, nextBtn])]),
      skipBtn
    ])

    const backdrop = U.el('div', {
      class: 'modal-backdrop onboard-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': T('Welcome to Yume')
      // Deliberately no click-outside close: the two clicks it takes to answer
      // are worth protecting from a stray click on the page behind. Escape and
      // "Later" both still close it, so it is never a trap.
    }, [card])

    document.body.append(backdrop)

    // Declared before draw() because the step handlers close over it, but the
    // trap is armed further down — focus has to land on rendered content, and
    // at this point the card is still empty.
    let close = () => backdrop.remove()

    // ---- one step ----
    const draw = () => {
      const spec = this.STEPS[step]
      body.replaceChildren(
        U.el('h2', { class: 'onboard-title', text: T(spec.title) }),
        U.el('p', { class: 'onboard-lead', text: T(spec.lead) }),
        ...spec.keys.map(key => this._field(key, answers, value => {
          answers[key] = value
          // The language step applies immediately, so the rest of the wizard
          // is already in the language just chosen. Local only — the server
          // write still happens once, at the end.
          if (key === 'language.ui') {
            Prefs.set({ 'language.ui': value }, { sync: false })
            I18n.setLanguage(value)
            draw()
            paint()
          }
        }))
      )
    }

    const paint = () => {
      dots.replaceChildren(...this.STEPS.map((_, i) =>
        U.el('span', { class: 'onboard-dot' + (i === step ? ' active' : '') })
      ))
      backBtn.style.visibility = step === 0 ? 'hidden' : 'visible'
      backBtn.textContent = T('Back')
      nextBtn.textContent = step === this.STEPS.length - 1 ? T('Done') : T('Continue')
      skipBtn.textContent = T('Later')
      backdrop.setAttribute('aria-label', T(this.STEPS[step].title))
    }

    const finish = skipped => {
      if (finished) return
      finished = true
      // Single write. `sync: false` then one push, so the server sees one
      // request carrying the whole set rather than four racing patches.
      Prefs.set(answers, { sync: false })
      Prefs.markOnboarded()
      Prefs.push(answers, { done: true, skipped }).catch(() => {})
      I18n.setLanguage(answers['language.ui'])
      close()
      window.App?.applyNavLabels?.()
      window.App?.navigate?.()
      if (!skipped) U.toast(T('Saved — you can change these in Settings'))
    }

    nextBtn.addEventListener('click', () => {
      if (step < this.STEPS.length - 1) { step++; draw(); paint() } else finish(false)
    })
    backBtn.addEventListener('click', () => { if (step > 0) { step--; draw(); paint() } })
    skipBtn.addEventListener('click', () => finish(true))

    draw()
    paint()

    // Now that the step is rendered, arm the trap. It focuses the first
    // interactive element, which is a real choice rather than the Back button
    // that step 0 keeps hidden.
    close = C.trapModal(backdrop, {
      onClose: () => {
        this._open = false
        // Escape reached the trap directly. Treat it exactly like "Later":
        // store the defaults and stop asking, rather than leaving the profile
        // unconfigured and the interface in a language nobody saved. Without
        // this the preview language above would outlive a dismissal.
        // "Later" stores the defaults, and the guessed language IS the
        // default here — an English browser that dismisses should keep
        // English rather than being handed Hungarian for not answering.
        if (!finished) finish(true)
      }
    })
    return backdrop
  },

  /** One preference, rendered as choice cards or a switch. */
  _field (key, answers, onPick) {
    const choices = this.CHOICES[key]
    const spec = (Prefs.spec ?? []).find(s => s.key === key)
    const label = spec ? T(spec.label) : key
    const description = spec?.description ? T(spec.description) : null

    if (!choices) {
      // Boolean: a labelled switch rather than a pair of cards, because
      // "on/off" as two equal-weight cards reads as a real decision when it
      // is not one.
      const input = U.el('input', { type: 'checkbox', checked: answers[key] === true })
      input.addEventListener('change', () => onPick(input.checked))
      return U.el('label', { class: 'onboard-switch' }, [
        U.el('span', {}, [
          U.el('span', { class: 'onboard-switch-label', text: label }),
          description ? U.el('span', { class: 'onboard-switch-hint', text: description }) : null
        ]),
        input
      ])
    }

    return U.el('div', { class: 'onboard-group' }, [
      U.el('div', { class: 'onboard-group-label', text: label }),
      U.el('div', { class: 'onboard-choices' }, choices.map(choice => {
        const active = answers[key] === choice.value
        const btn = U.el('button', {
          class: 'onboard-choice' + (active ? ' active' : ''),
          'aria-pressed': active ? 'true' : 'false'
        }, [
          U.el('span', { class: 'onboard-choice-label', text: T(choice.label) }),
          U.el('span', { class: 'onboard-choice-hint', text: T(choice.hint) })
        ])
        btn.addEventListener('click', () => {
          onPick(choice.value)
          for (const sibling of btn.parentNode.children) {
            const on = sibling === btn
            sibling.classList.toggle('active', on)
            sibling.setAttribute('aria-pressed', on ? 'true' : 'false')
          }
        })
        return btn
      }))
    ])
  }
}

if (typeof window !== 'undefined') window.Onboarding = Onboarding
if (typeof module !== 'undefined' && module.exports) module.exports = Onboarding
