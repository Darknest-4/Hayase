// Szint az XP-ből — ugyanaz a görbe, mint a kiszolgálón.
//
// A kiszolgáló (apps/api/src/modules/library/founder.ts, `levelFor`) így
// számol: 100 XP a 2. szintig, utána minden szint 15%-kal drágább az
// előzőnél. A megjegyzése szerint „ugyanaz a görbe, mint amit a kliens
// rajzol" — a kliens viszont két helyen is (profil, eredmények) egy
// négyzetgyökös képletet használt, így ugyanazon a lapon két különböző szint
// állt: a fejlécben a kiszolgálóé, az eredmények fülön a kliensé.
//
// A kiszolgáló számai (ProfileStats: `xp`, `level`) az irányadók; ez a modul
// ugyanazt a görbét adja, hogy a kliens becslése és a haladásjelző is azzal
// egyezzen. A level.test.mjs a kettőt összeveti.

/** XP egy befejezett részért — a kiszolgáló `EPISODE_XP`-je (library/progress.ts). */
export const EPISODE_XP = 10

/**
 * @param {number} xp
 * @returns {{ level: number, into: number, needed: number }}
 *   `into`: ennyi XP gyűlt a szinten belül, `needed`: ennyi kell a következőhöz
 */
export function levelFor (xp) {
  let level = 1
  let needed = 100
  let remaining = Math.max(0, Math.floor(Number(xp) || 0))
  while (remaining >= needed && level < 999) {
    remaining -= needed
    level += 1
    needed = Math.round(needed * 1.15)
  }
  return { level, into: remaining, needed }
}

/**
 * A kliens becslése, amikor nincs kiszolgálói szám (kijelentkezve, vagy még
 * nem futott a statisztika): a megnézett részek, ugyanazzal az egységárral,
 * amivel a kiszolgáló jóváír.
 */
export function estimateXp ({ episodes = 0 } = {}) {
  return Math.max(0, Math.floor(Number(episodes) || 0)) * EPISODE_XP
}
