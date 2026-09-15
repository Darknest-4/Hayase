// Az a fajta védelem, amiből egy példány hiányozni fog.
//
// A mai IDOR (SEC-01) nem attól lett, hogy valaki elfelejtett ellenőrizni.
// A helyes, tulajdonost ellenőrző feloldó *létezett* — háromszor, karakterre
// ugyanazzal a tizennégy sorral: a könyvtárban, a beállításokban és a GraphQL
// kontextusában. A hírek útvonalán nem.
//
// Egy megismételt biztonsági ellenőrzés az az ellenőrzés, ami előbb-utóbb
// háromból kettő helyen lesz meg. És a hiányzó negyediket semmi nem jelzi:
// a kód lefordul, a tesztek zöldek, az útvonal válaszol.
//
// A kliensnek van erre szabálya (`layering.test.mjs`: a rétegek iránya
// kikényszerítve). A szervernek nem volt. Ez a fájl az.
//
// A minta, amit véd: egy kérésből származó *azonosító*, ami valakinek a
// tulajdona. Az ilyet egy helyen kell feloldani, és az a hely a
// `middleware/profile.ts`.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Minden TypeScript forrás a szerveren, tartalommal. */
const files = (function collect (dir: string, out: Array<{ path: string, text: string }> = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (full.endsWith('.ts')) out.push({ path: relative(SRC, full).replaceAll('\\', '/'), text: readFileSync(full, 'utf8') })
  }
  return out
})(SRC)

describe('security checks live in one place', () => {
  it('finds the source tree at all', () => {
    // E nélkül minden alábbi állítás úgy menne át, hogy semmit nem keresett.
    assert.ok(files.length > 50, `only ${files.length} server files found`)
    assert.ok(files.some(f => f.path === 'middleware/profile.ts'), 'the resolver itself is missing')
  })

  it('reads the profile header in exactly one module', () => {
    /*
     * Ez a fejléc egy *tulajdonos* azonosítóját hordozza. Aki közvetlenül
     * olvassa, az maga dönt a tulajdonlásról — és pontosan ez ment félre.
     *
     * Két kivétel, mindkettő nevesítve:
     *   middleware/profile.ts  — ő maga a feloldó;
     *   app.ts                 — a GraphQL kontextusa, ahol nincs
     *                            FastifyRequest.user, tehát más a bemenet.
     *                            A tulajdonosi ellenőrzés ott is megvan.
     */
    const allowed = new Set(['middleware/profile.ts', 'app.ts'])
    const offenders = files
      .filter(f => !allowed.has(f.path))
      .filter(f => /headers\[['"]x-profile-id['"]\]/i.test(f.text))
      .map(f => f.path)

    assert.deepEqual(offenders, [],
      'these read the profile header directly instead of going through middleware/profile.ts:\n  ' +
      offenders.join('\n  '))
  })

  it('checks profile ownership in exactly one module', () => {
    /*
     * A tulajdonlás kérdése egyetlen alakban jelenik meg: „ez a *beérkezett*
     * azonosító ezé a fióké?" — vagyis `WHERE id = $n AND user_id = $m`.
     *
     * Ez más, mint a fiók saját profiljának kikeresése (`WHERE user_id = $1`),
     * amiből több is van, és ami eleve biztonságos: ott nincs beérkező
     * azonosító, amit el lehetne hinni. Az első kísérletem mindkettőt
     * ugyanannak nézte, és öt ártatlan helyet jelentett.
     */
    const allowed = new Set(['middleware/profile.ts', 'app.ts'])
    const ownership = /FROM user_profiles\s+WHERE\s+id\s*=\s*\$\d[\s\S]{0,60}user_id\s*=\s*\$\d/i
    const offenders = files
      .filter(f => !allowed.has(f.path))
      .filter(f => ownership.test(f.text))
      .map(f => f.path)

    assert.deepEqual(offenders, [],
      'ownership is re-implemented here instead of in middleware/profile.ts:\n  ' + offenders.join('\n  '))
  })

  it('mints a token in exactly one module', () => {
    // Ugyanaz a gondolat a hitelesítésre: aki tokent ír alá, az hitelesít.
    const allowed = new Set(['modules/auth/routes.ts', 'modules/auth/tokens.ts', 'middleware/auth.ts', 'app.ts'])
    const offenders = files
      .filter(f => !allowed.has(f.path))
      .filter(f => /\.jwt\.sign\(|jwtSign\(/.test(f.text))
      .map(f => f.path)

    assert.deepEqual(offenders, [], 'these sign tokens outside the auth module:\n  ' + offenders.join('\n  '))
  })

  it('never builds SQL by concatenating a request value', () => {
    /*
     * A paraméteres lekérdezés itt szabály, nem szokás. A rendezési oszlop és
     * irány zárt listából jön, nem a kérésből — ezt az `adversarial.test.ts`
     * viselkedésben is vizsgálja; itt a forma van kikötve.
     *
     * Amit keresünk: egy sablonliterálba illesztett `request.` érték egy SQL
     * kulcsszó közelében.
     */
    const offenders: string[] = []
    for (const file of files) {
      const sql = /`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{[^}]*\brequest\.[^}]*\}[^`]*`/i
      if (sql.test(file.text)) offenders.push(file.path)
    }
    assert.deepEqual(offenders, [], 'a request value is interpolated into SQL here:\n  ' + offenders.join('\n  '))
  })
})
