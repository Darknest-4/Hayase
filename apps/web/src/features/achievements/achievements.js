/* global document */
// Achievements & Badges.
//
// Signed in, the server decides: it measures the profile against its own
// watch history, library and favourites, and the grants are recorded there.
// Nothing is reported by this screen, so nothing here can be forged.
//
// Signed out — or offline — the same catalogue is evaluated locally against
// browser storage, which is what this screen always did. The definitions below
// are a copy of the server's, and apps/web/test/achievements.test.mjs fails if the
// two drift apart.

import { I18n, T } from '../../shared/i18n/i18n.js'
import { LibrarySync } from '../library-sync/library-sync.js'
import { U } from '../../shared/lib/dom.js'
import { AchievementCatalog } from './catalog.js'
import { YumeAPI } from '../../shared/api/yume.js'
import { ProfileStats } from '../watch-history/profile-stats.js'
import { estimateXp, levelFor } from '../../shared/lib/level.js'

export const PageAchievements = {
  // A katalógus és a helyi kiértékelés a `catalog.js`-ben él: a keret
  // értesítésjelvénye is abból számol, ez a képernyő csak rajzol belőle.
  CATALOG: AchievementCatalog.CATALOG,

  body (pad) {
    // Local first so the screen is never blank, then the account's own answer
    // if there is one. It replaces rather than merges: a grant is a fact the
    // server recorded, and a local near-miss must not un-unlock it.
    this._draw(pad, this._evaluateLocally(), this._context())

    this._fromServer().then(server => {
      if (!server || !pad.isConnected) return
      pad.replaceChildren()
      this._draw(pad, server.list, server.context)
    })
  },

  /** Ask the server for the catalogue and this profile's progress. */
  async _fromServer () {
    if (!YumeAPI?.user?.() || !LibrarySync?.enabled?.()) return null
    try {
      const { data, context } = await LibrarySync._req('/v1/me/achievements')
      if (!Array.isArray(data) || !data.length) return null
      return {
        context: context ?? {},
        list: data.map(a => ({
          slug: a.slug,
          name: a.name,
          desc: a.description,
          icon: a.icon,
          tier: a.tier,
          target: a.target,
          current: Math.min(Number(a.current) || 0, a.target),
          unlocked: a.unlocked === true,
          pct: Math.min(100, Math.round((Number(a.current) || 0) / a.target * 100))
        }))
      }
    } catch (e) {
      return null
    }
  },

  _evaluateLocally () {
    return AchievementCatalog.evaluate()
  },

  _draw (pad, evaluated, ctx) {
    const unlockedCount = evaluated.filter(a => a.unlocked).length

    // Level from XP. The same shape as the server's ledger, computed from
    // whichever context this render was given — the server's measurements
    // when signed in, the browser's when not.
    // A kiszolgáló XP-je az irányadó (ugyanaz a szám áll a profil fejlécében);
    // nélküle a helyi becslés. A görbe mindkettőnél a kiszolgálóé.
    const server = ProfileStats.cached()
    const xp = server?.xp > 0 ? server.xp : estimateXp({ episodes: ctx.episodes })
    const { level, into, needed } = levelFor(xp)
    const levelCeil = xp - into + needed
    const levelPct = Math.round(into / needed * 100)

    // ---- level + summary banner ----
    pad.append(U.el('div', { class: 'ach-banner' }, [
      U.el('div', { class: 'ach-level-badge', text: String(level) }),
      U.el('div', { style: 'flex-grow:1;min-width:12rem;' }, [
        U.el('div', { class: 'ach-level-title', text: `${T('Level')} ${level}` }),
        U.el('div', { class: 'ach-level-xp', text: `${xp.toLocaleString(I18n.locale())} XP · ${I18n.f(T('{n} XP to the next level'), { n: (levelCeil - xp).toLocaleString(I18n.locale()) })}` }),
        U.el('div', { class: 'ach-level-track' }, [U.el('div', { class: 'ach-level-fill', style: `width:${levelPct}%;` })])
      ]),
      U.el('div', { class: 'ach-count' }, [
        U.el('b', { text: `${unlockedCount}/${this.CATALOG.length}` }),
        U.el('span', { text: T('unlocked') })
      ])
    ]))

    // ---- grid ----
    const grid = U.el('div', { class: 'ach-grid' })
    pad.append(grid)

    // unlocked first, then by progress
    evaluated.sort((a, b) => (b.unlocked - a.unlocked) || (b.pct - a.pct))

    for (const a of evaluated) {
      grid.append(U.el('div', { class: 'ach-card' + (a.unlocked ? ' unlocked' : '') + ` tier-${a.tier}` }, [
        U.el('div', { class: 'ach-icon', text: a.icon }),
        U.el('div', { class: 'ach-body' }, [
          U.el('div', { class: 'ach-name' }, [
            document.createTextNode(T(a.name)),
            U.el('span', { class: `ach-tier tier-${a.tier}`, text: T(a.tier) })
          ]),
          U.el('div', { class: 'ach-desc', text: T(a.desc) }),
          a.unlocked
            ? U.el('div', { class: 'ach-done', text: T('✓ Unlocked') })
            : U.el('div', { class: 'ach-progress-wrap' }, [
              U.el('div', { class: 'ach-progress-track' }, [U.el('div', { class: 'ach-progress-fill', style: `width:${a.pct}%;` })]),
              U.el('span', { class: 'ach-progress-text', text: `${a.current.toLocaleString(I18n.locale())} / ${a.target.toLocaleString(I18n.locale())}` })
            ])
        ])
      ]))
    }
  },

  // slugs currently unlocked for the active profile (used by notifications)
  unlockedSlugs () {
    return AchievementCatalog.unlockedSlugs()
  },

  meta (slug) {
    return AchievementCatalog.meta(slug)
  },

  _context () {
    return AchievementCatalog.context()
  }
}
