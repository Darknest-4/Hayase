// Everything the community surface and the development log need to have
// something in them on the first visit.
//
//   npm run seed:community --workspace @yume/api
//   docker compose --profile community run --rm community
//
// Idempotent, keyed on the slug or the version: run it after every deploy and
// it adds what is new without touching what people have written. It never
// deletes and never edits a row somebody could have changed by hand — a
// release that already exists is left exactly as it is, because the editor
// screen is allowed to win over this file.
//
// The release history is not invented. Each entry names work that is in the
// repository, and the versions group it the way the migrations do: the
// migration list under database/migrations is the project's real spine, and
// this is that spine written for people rather than for Postgres.

import { pool, query, queryOne, transaction } from '../src/infrastructure/database/index.ts'

import type pg from 'pg'

interface Forum { slug: string, name: string, description: string, position: number }
interface Room { slug: string, name: string, topic: string }
interface Release {
  version: string
  title: string
  summary: string
  status: 'planned' | 'in_progress' | 'released'
  releasedOn?: string
  entries: Array<[kind: 'added' | 'changed' | 'fixed' | 'removed' | 'security', body: string]>
}

const FORUMS: Forum[] = [
  { slug: 'bejelentesek', name: 'Bejelentések', description: 'Ami az oldallal történik. Írni csak a csapat tud, olvasni bárki.', position: 10 },
  { slug: 'altalanos', name: 'Általános', description: 'Bármi, ami nem fér bele a többi kategóriába.', position: 20 },
  { slug: 'ajanlok', name: 'Ajánlók', description: 'Mit érdemes megnézni, és miért.', position: 30 },
  { slug: 'evadok', name: 'Évadok', description: 'Az éppen futó szezon, hétről hétre.', position: 40 },
  { slug: 'segitseg', name: 'Segítség', description: 'Elakadtál valamiben? Kérdezz itt.', position: 50 },
  { slug: 'forditas', name: 'Fordítás', description: 'Magyar címek és leírások — javaslatok, hibák, viták.', position: 60 }
]

const ROOMS: Room[] = [
  { slug: 'fokocsma', name: 'Főkocsma', topic: 'A közös szoba. Mindenki ide esik be először.' },
  { slug: 'spoiler', name: 'Spoileres', topic: 'Itt szabad. Ha nem láttad, ne gyere be.' },
  { slug: 'segitseg-chat', name: 'Segítség', topic: 'Gyors kérdés, gyors válasz.' }
]

/**
 * The project's history, grouped the way the migrations group it.
 *
 * `position` is assigned from the order of this array, oldest first, so the
 * page can order by it without parsing version strings — "0.9.10" sorts before
 * "0.9.9" as text and there is no reason to teach SQL semver for a list
 * somebody curates by hand.
 */
const RELEASES: Release[] = [
  {
    version: '0.1.0',
    title: 'Alapok',
    status: 'released',
    releasedOn: '2026-07-14',
    summary: 'Fiókok, katalógus, lejátszás és könyvtár — a séma, amire minden más épül.',
    entries: [
      ['added', 'Fiókok, munkamenetek, eszközök és szerepkörök (0001)'],
      ['added', 'Anime katalógus: címek, epizódok, kapcsolatok, képek (0002)'],
      ['added', 'Lejátszás: videóforrások, felirat- és hangsávok, nézési haladás (0003)'],
      ['added', 'Közösségi séma: fórumok, témák, hozzászólások, chat (0004)'],
      ['added', 'Könyvtár, kedvencek, listák, értékelések és XP (0005)']
    ]
  },
  {
    version: '0.2.0',
    title: 'Üzemeltetés',
    status: 'released',
    releasedOn: '2026-07-28',
    summary: 'Ami ahhoz kell, hogy az oldal magától is elfusson.',
    entries: [
      ['added', 'Telemetria: oldalletöltések, keresések, hibacsoportok (0007)'],
      ['added', 'Munkasor Postgresen — külön üzenetsor nélkül (0008)'],
      ['added', 'Kimenő webhookok, aláírva és újrapróbálkozással (0009)'],
      ['added', 'Jogosultsági rendszer szerepkörökkel (0010, 0012)'],
      ['added', 'Adatbázisból vezérelt oldalbeállítások és funkciókapcsolók (0011)']
    ]
  },
  {
    version: '0.3.0',
    title: 'Katalógus és kereső',
    status: 'released',
    releasedOn: '2026-08-11',
    summary: 'A 25 000 importált címből kereshető, szerkeszthető katalógus.',
    entries: [
      ['added', 'Láthatóság címenként: publikus, listázatlan, rejtett (0013)'],
      ['added', 'Teljes szövegű keresés és metaadat-indexelés (0017)'],
      ['added', 'Szerkesztői közzététel és mezőzárolás (0020)'],
      ['added', 'AniList-párosítás, ütközések kezelése, külső azonosítók (0026–0028)'],
      ['added', 'Üzemeltető által regisztrált videóforrások (0029)']
    ]
  },
  {
    version: '0.4.0',
    title: 'Magyar felület',
    status: 'released',
    releasedOn: '2026-08-18',
    summary: 'Nem fordítás a felületre ragasztva, hanem végig magyar.',
    entries: [
      ['added', 'Magyar szövegkezelés és ékezetes keresés (0022)'],
      ['added', 'Katalógus-fordítások: magyar címek és leírások, szerkesztővel (0023)'],
      ['changed', 'A felület nyelve fiókbeállítás, nem böngészőtalálgatás'],
      ['fixed', 'A mobil menü a nyelvváltás után is a régi nyelven maradt']
    ]
  },
  {
    version: '0.5.0',
    title: 'Biztonság és felügyelet',
    status: 'released',
    releasedOn: '2026-08-25',
    summary: 'Mérés, riasztás, és a kapcsolók, amikkel baj esetén be lehet avatkozni.',
    entries: [
      ['added', 'VPS-metrikák és riasztási küszöbök (0015, 0016)'],
      ['added', 'Token-visszavonás és jelszó-helyreállítás (0018, 0019)'],
      ['added', 'Az első fiók automatikusan admin lesz, naplózva (0021)'],
      ['added', 'Szerepkör-kezelés az admin felületről (0032)'],
      ['added', 'Vészkapcsolók: csak olvasható mód, szinkron és webhookok leállítása (0034)'],
      ['security', 'A funkciókapcsolók a szerveren is érvényesülnek, nem csak a kliens útválasztásában']
    ]
  },
  {
    version: '0.6.0',
    title: 'Megjelenés',
    status: 'released',
    releasedOn: '2026-09-01',
    summary: 'Témák adatbázisból, hogy a kinézetet ne kelljen újratelepíteni.',
    entries: [
      ['added', 'Témák: beépített palettákkal, saját akcentussal (0030)'],
      ['removed', 'A kiegészítő-platform, a portál és a homokozó (0031)'],
      ['changed', 'A kereső Postgresen fut, nem külön keresőmotoron']
    ]
  },
  {
    version: '0.7.0',
    title: 'Egy fiók, egy profil',
    status: 'released',
    releasedOn: '2026-09-09',
    summary: 'A Netflix-szerű profilváltó kikerült a termékből.',
    entries: [
      ['removed', 'Profilválasztó képernyő, profilváltó és profilkezelés'],
      ['changed', 'Fiókonként pontosan egy profil, egyedi indexszel kikényszerítve (0035)'],
      ['changed', 'A profil neve és képe innentől fiókbeállítás'],
      ['fixed', 'A megjegyzések sosem töltődtek be az AniList-párosítás nélküli címeknél'],
      ['fixed', 'Az admin menü sorai 30 pixel magasak voltak telefonon'],
      ['added', 'Az első fiók a teljes katalógussal indul: minden cím megnézve, minden achievement feloldva']
    ]
  },
  {
    version: '0.8.0',
    title: 'Közösség',
    status: 'in_progress',
    summary: 'Fórum, élő chat és ez a napló — mind adatbázisból, jogosultsághoz kötve.',
    entries: [
      ['added', 'Fórum: bárki indíthat kategóriát, témákkal és hozzászólásokkal'],
      ['added', 'Élő chat nyilvános szobákkal, azonnal megjelenő üzenetekkel'],
      ['added', 'Fejlesztési napló verziószámokkal és tervezett kiadásokkal'],
      ['changed', 'A közösség oldal fülekre bomlik: hírfolyam, fórum, chat'],
      ['changed', 'A 0004 óta üresen álló fórumtáblák mögé végre került kód']
    ]
  },
  {
    version: '0.9.0',
    title: 'Külső szinkron',
    status: 'planned',
    summary: 'A haladás visszaírása AniListre és MAL-ra.',
    entries: [
      ['added', 'AniList OAuth és kétirányú haladás-szinkron'],
      ['added', 'MyAnimeList OAuth'],
      ['added', 'Lista importálása fájlból, ütközésfeloldással']
    ]
  },
  {
    version: '1.0.0',
    title: 'Első kiadás',
    status: 'planned',
    summary: 'Amikor már nem kell magyarázni, mi hiányzik.',
    entries: [
      ['added', 'Telepíthető alkalmazás offline móddal'],
      ['added', 'Értesítések: új rész, válasz, említés'],
      ['changed', 'Teljes akadálymentességi átvizsgálás']
    ]
  }
]

let added = 0
let skipped = 0

try {
  // ---- forums ----
  for (const forum of FORUMS) {
    const existing = await queryOne('SELECT 1 FROM forums WHERE slug = $1', [forum.slug])
    if (existing) { skipped++; continue }
    await query(
      'INSERT INTO forums (slug, name, description, position) VALUES ($1, $2, $3, $4)',
      [forum.slug, forum.name, forum.description, forum.position]
    )
    added++
    console.log(`forum    + ${forum.slug}`)
  }

  // ---- chat rooms ----
  for (const room of ROOMS) {
    const existing = await queryOne('SELECT 1 FROM chats WHERE slug = $1', [room.slug])
    if (existing) { skipped++; continue }
    await query(
      "INSERT INTO chats (kind, slug, name, topic) VALUES ('room', $1, $2, $3)",
      [room.slug, room.name, room.topic]
    )
    added++
    console.log(`room     + ${room.slug}`)
  }

  // ---- the development log ----
  for (const [index, release] of RELEASES.entries()) {
    const existing = await queryOne('SELECT 1 FROM releases WHERE version = $1', [release.version])
    if (existing) { skipped++; continue }
    await transaction(async (client: pg.PoolClient) => {
      const { rows } = await client.query(
        `INSERT INTO releases (version, title, summary, status, released_on, position)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [release.version, release.title, release.summary, release.status, release.releasedOn ?? null, (index + 1) * 10]
      )
      const id = rows[0]!.id
      for (const [position, [kind, body]] of release.entries.entries()) {
        await client.query(
          'INSERT INTO release_entries (release_id, kind, body, position) VALUES ($1, $2, $3, $4)',
          [id, kind, body, position]
        )
      }
    })
    added++
    console.log(`release  + ${release.version} — ${release.title} (${release.status}, ${release.entries.length} lines)`)
  }

  console.log(`\n${added} added, ${skipped} already there`)
} finally {
  await pool.end()
}
