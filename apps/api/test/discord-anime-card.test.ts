// AZ ANIMEKÁRTYA — a bot kimeneteinek közös adatlapja (anime-card.ts), és
// ahol megjelenik: /anime info|search, /watchlist add|list, /next, /profile,
// az epizód-bejelentés (és vele a DM).
//
// VALÓDI ADATBÁZISSAL, SAJÁT PRÓBACÍMEKKEL: egy teljes (borító a tükörben,
// banner, három név, két műfaj, stúdió, előzetes, három nyilvános rész), egy
// felnőtt és egy „nincs kép" helyőrzős. A részek ÖT NAPJA kerültek be: így
// a párhuzamosan futó hírfolyam- és DM-tesztek 48 órás ablakába nem esnek
// bele. Ami a „legfrissebb" / „következő" sorrendtől függ, az a
// `discord-anime-lists.exclusive.ts`-ben fut, egyedül.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-anime-card-secret-long-enough-0123456789'

let card: typeof import('../src/modules/discord/anime-card.ts')
let commands: typeof import('../src/modules/discord/commands.ts')
let feed: typeof import('../src/modules/discord/episode-feed.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const jel = randomBytes(4).toString('hex')
const CIM_TELJES = `Kártyateszt Teljes ${jel}`
const CIM_FELNOTT = `Kártyateszt Felnőtt ${jel}`
const CIM_KEPTELEN = `Kártyateszt Képtelen ${jel}`
const TUKOR = `media/cover/aa/kartyateszt-${jel}.jpg`
const BANNER = `https://s4.anilist.co/file/anilistcdn/media/anime/banner/kartyateszt-${jel}.jpg`
const EP2_KEP = `https://artworks.thetvdb.com/banners/kartyateszt-${jel}-2.jpg`
const discordId = '6' + String(Date.now()).padEnd(17, '0').slice(0, 17)

let teljes = ''
let felnott = ''
let keptelen = ''
let studio = ''
let studioMasolat = ''
let userId = ''
let profileId = ''
const reszek: string[] = []
const felnottReszek: string[] = []

type Embed = {
  title?: string, url?: string, description?: string, color?: number,
  thumbnail?: { url: string }, image?: { url: string }, author?: { name: string },
  fields?: Array<{ name: string, value: string, inline: boolean }>, timestamp?: string
}
type Valasz = {
  type: number
  data: {
    content?: string, embeds?: Embed[],
    components?: Array<{ components: Array<{ label?: string, url?: string, custom_id?: string, style: number }> }>
  }
}

function interakcio (extra: Record<string, unknown> = {}): never {
  return {
    id: '500000000000000012', token: 'kartya-token', applicationId: '500000000000000013', type: 2,
    guildId: '400000000000000777', channelId: '600000000000000012', userId: discordId, username: 'kartya',
    permissions: '0', memberRoles: [], command: 'help', sub: null, options: {}, focused: null,
    customId: null, locale: null, guildLocale: null, ...extra
  } as never
}

async function parancs (extra: Record<string, unknown>): Promise<Valasz> {
  commands.resetCooldowns()
  const e = await commands.handle(interakcio(extra))
  assert.equal(e.outcome, 'ok', JSON.stringify(e.response))
  return e.response as Valasz
}

const mezok = (e: Embed | undefined): Map<string, string> =>
  new Map((e?.fields ?? []).map(f => [f.name, f.value]))

describe('az animekártya', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    card = await import('../src/modules/discord/anime-card.ts')
    commands = await import('../src/modules/discord/commands.ts')
    feed = await import('../src/modules/discord/episode-feed.ts')
    db = await import('../src/infrastructure/database/index.ts')

    const uj = async (cim: string, extra: string, ertekek: unknown[] = []): Promise<string> =>
      (await db.queryOne<{ id: string }>(
        `INSERT INTO anime (canonical_title, format, status, season, season_year, start_date, episode_count,
                            episode_duration, synopsis, average_score, popularity, next_airing_at, next_airing_ep,
                            source_material, is_adult, visibility)
         VALUES ($1, 'TV', 'RELEASING', 'FALL', 2024, '2024-10-05', 24, 24, ${extra}, 82.4, 123456,
                 now() + interval '2 days', 5, 'MANGA', $2, 'public') RETURNING id`, [cim, ...ertekek]))!.id

    teljes = await uj(CIM_TELJES,
      "'Egy <i>teszt</i> leírás &mdash; ~!titok!~ és *csillag* &#12300;idézet&#12301;.<br>Második sor.'", [false])
    felnott = await uj(CIM_FELNOTT, "'Titkos felnőtt leírás.'", [true])
    keptelen = await uj(CIM_KEPTELEN, 'NULL', [false])

    await db.query(
      `INSERT INTO anime_titles (anime_id, kind, title) VALUES
         ($1, 'native', '完全テスト'), ($1, 'english', $2), ($1, 'romaji', $3)`,
      [teljes, `Card Test Full ${jel}`, `Kaado Tesuto ${jel}`])
    await db.query(
      `INSERT INTO anime_images (anime_id, kind, object_key, mirror_key, dominant_color, is_primary) VALUES
         ($1, 'cover', 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/kt.jpg', $2, '#e4ae50', true),
         ($1, 'banner', $3, NULL, NULL, true),
         ($4, 'cover', 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/kf.jpg', 'media/cover/bb/kf.jpg', '#112233', true),
         ($4, 'banner', 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/kf.jpg', NULL, NULL, true),
         ($5, 'cover', 'https://raw.githubusercontent.com/manami-project/anime-offline-database/master/pics/no_pic.png',
              'media/cover/f5/no-pic.png', NULL, true)`,
      [teljes, TUKOR, BANNER, felnott, keptelen])
    await db.query(
      `INSERT INTO genres (slug, name) VALUES ('action', 'Action'), ('drama', 'Drama'), ('comedy', 'Comedy')
       ON CONFLICT (slug) DO NOTHING`)
    await db.query(
      `INSERT INTO anime_genres (anime_id, genre_id)
       SELECT $1, id FROM genres WHERE slug IN ('action', 'drama')`, [teljes])
    studio = (await db.queryOne<{ id: string }>(
      "INSERT INTO companies (name, country) VALUES ($1, 'JP') RETURNING id", [`Tesztstúdió ${jel}`]))!.id
    // UGYANAZ A STÚDIÓ MÁSODSZOR, más írásmóddal és ország nélkül — élesben
    // így áll a cégtáblában, és a kártyán kétszer jelent meg.
    studioMasolat = (await db.queryOne<{ id: string }>(
      'INSERT INTO companies (name, country) VALUES ($1, NULL) RETURNING id', [`TESZTSTÚDIÓ ${jel}`]))!.id
    await db.query(
      `INSERT INTO anime_companies (anime_id, company_id, role, is_main)
       VALUES ($1, $2, 'studio', true), ($1, $3, 'studio', false)`, [teljes, studio, studioMasolat])
    // A tárolt hivatkozás nem egységes (élesben mérve) — ez a `…&t=1s` alak.
    await db.query(
      "INSERT INTO anime_videos (anime_id, kind, provider, ref) VALUES ($1, 'trailer', 'youtube', 'PaOFxvxRj9w&t=1s')", [teljes])

    for (const [n, cim, kep] of [[1, 'Az első', null], [2, 'Második rész címe', EP2_KEP], [3, null, null]] as const) {
      reszek.push((await db.queryOne<{ id: string }>(
        `INSERT INTO episodes (anime_id, number, title, synopsis, thumbnail_key, duration, visibility, created_at)
         VALUES ($1, $2, $3, $4, $5, 24, 'public', now() - interval '5 days') RETURNING id`,
        [teljes, n, cim, `A(z) ${n}. rész leírása.`, kep]))!.id)
    }
    for (const n of [1, 2]) {
      felnottReszek.push((await db.queryOne<{ id: string }>(
        `INSERT INTO episodes (anime_id, number, synopsis, thumbnail_key, duration, visibility, created_at)
         VALUES ($1, $2, 'Titkos rész.', 'https://artworks.thetvdb.com/banners/kf.jpg', 24, 'public', now() - interval '5 days')
         RETURNING id`, [felnott, n]))!.id)
    }

    userId = (await db.queryOne<{ id: string }>(
      'INSERT INTO users (email, username) VALUES ($1, $2) RETURNING id',
      [`kartya${jel}@example.com`, `kartya${jel}`]))!.id
    profileId = (await db.queryOne<{ id: string }>(
      "INSERT INTO user_profiles (user_id, display_name, is_default) VALUES ($1, 'Kártya', true) RETURNING id",
      [userId]))!.id
    await db.query('INSERT INTO discord_links (user_id, discord_user_id) VALUES ($1, $2)', [userId, discordId])
  })

  beforeEach(async () => {
    await db.query('DELETE FROM library_entries WHERE profile_id = $1', [profileId])
    await db.query('DELETE FROM watch_progress WHERE profile_id = $1', [profileId])
  })

  after(async () => {
    await db?.query('DELETE FROM users WHERE id = $1', [userId || null])
    await db?.query('DELETE FROM anime WHERE id = ANY($1::uuid[])', [[teljes, felnott, keptelen].filter(Boolean)])
    await db?.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[studio, studioMasolat].filter(Boolean)])
  })

  // ---- szöveg, képcím, azonosító: adat nélkül is mérhető ----

  it('a katalógus HTML-jét és entitásait olvasható szöveggé alakítja', () => {
    assert.equal(card.tisztaSzoveg('Egy <i>dőlt</i> &mdash; &#12300;x&#12301; &amp; &#x41;<br>új sor'),
      'Egy dőlt — 「x」 & A\núj sor')
    // Ismeretlen entitás és érvénytelen kódpont marad, ahogy volt — nem tűnik el csendben.
    assert.equal(card.tisztaSzoveg('&nincsilyen; &#0;'), '&nincsilyen; &#0;')
  })

  it('a katalógusszöveg nem formázhat: jelölés, említés, hivatkozás ki van kapcsolva', () => {
    assert.equal(card.md('*a* _b_ ~c~ `d` |e| <@123> [x](https://y)'),
      '\\*a\\* \\_b\\_ \\~c\\~ \\`d\\` \\|e\\| \\<@123> \\[x](https://y)')
    assert.equal(card.md('# fejléc\n> idézet\n- lista'), '\\# fejléc\n\\> idézet\n\\- lista')
  })

  it('az AniList-spoiler Discord-spoiler lesz, a vágás szóhatáron történik', () => {
    assert.equal(card.leirasDiscordra('Előtte ~!a *titok*!~ utána', 100), 'Előtte ||a \\*titok\\*|| utána')
    const hosszu = card.leirasDiscordra('szó '.repeat(100), 50)
    assert.ok(hosszu.length <= 50 && hosszu.endsWith('…'), hosszu)
    // A vágás a jelölés-kikapcsolás ELŐTT: egy `\*` nem vágódhat ketté.
    assert.ok(!card.leirasDiscordra('a'.repeat(9) + '*'.repeat(20), 12).includes('\\…'))
  })

  it('a YouTube-azonosítót a tárolt változatokból kiveszi, a hibásat eldobja', () => {
    for (const ref of ['eimOB2r6kuw', 'IuMnw95IU6s ', 'PaOFxvxRj9w&t=1s', '6T_mxtyPjDQ/0.jpg',
      'https://www.youtube.com/watch?v=JD83zaNV4ug&list=PL1', 'https://youtu.be/JD83zaNV4ug']) {
      assert.match(String(card.youtubeId(ref)), /^[A-Za-z0-9_-]{11}$/, ref)
    }
    for (const ref of ['rJ2s4VnOxU', 'abcdefghijklm', '', null, 'javascript:alert(1)']) {
      assert.equal(card.youtubeId(ref), null, String(ref))
    }
  })

  it('képcím csak abszolút lehet; a relatív a nyilvános címhez kötődik', () => {
    assert.equal(card.abszolutKep('https://cdn.example/x.jpg'), 'https://cdn.example/x.jpg')
    assert.match(String(card.abszolutKep('/media/x.jpg')), /^https?:\/\/[^/]+\/media\/x\.jpg$/)
    for (const rossz of ['//idegen.example/x.jpg', 'javascript:alert(1)', 'x.jpg', '', null]) {
      assert.equal(card.abszolutKep(rossz), null, String(rossz))
    }
  })

  it('a szín a borítóé, ha érvényes; a pontszám egész százalék', () => {
    assert.equal(card.kartyaSzin('#e4ae50'), 0xE4AE50)
    assert.equal(card.kartyaSzin('rossz'), 0xE41E63)
    assert.equal(card.pontSzoveg(82.4), '82%')
    assert.equal(card.pontSzoveg(null), null)
  })

  // ---- a betöltés ----

  it('a teljes adatlapot egy lekérdezésben tölti be — a borító a TÜKÖRBŐL, abszolút címmel', async () => {
    const [k] = await card.animeCards([teljes])
    assert.ok(k)
    assert.match(String(k.borito), new RegExp(`^https?://.+/${TUKOR.replace(/[.]/g, '\\.')}$`))
    assert.equal(k.banner, BANNER)
    assert.deepEqual(k.mufajok, ['Action', 'Drama'])
    // A kétszer tárolt stúdió EGYSZER, a fő stúdió írásmódjával.
    assert.deepEqual(k.studiok, [`Tesztstúdió ${jel}`])
    assert.equal(k.elozetes, 'PaOFxvxRj9w')
    assert.equal(k.elerheto, 3)
    assert.equal(k.elsoResz, reszek[0])
    assert.equal(k.pontszam, 82.4)
    assert.equal(k.native, '完全テスト')
  })

  it('felnőtt címnél nincs kép (a tárolt képek ellenére), a helyőrző nem kép', async () => {
    const [a, b] = await card.animeCards([felnott, keptelen])
    assert.equal(a?.felnott, true)
    assert.equal(a?.borito, null)
    assert.equal(a?.banner, null)
    assert.equal(b?.borito, null, 'a no_pic.png helyőrző borítóként ment ki')
  })

  it('a sorrend a kérésé, a nem nyilvános és a hibás azonosító kimarad', async () => {
    const lista = await card.animeCards([keptelen, 'nem-uuid', teljes])
    assert.deepEqual(lista.map(k => k.id), [keptelen, teljes])
  })

  // ---- /anime info ----

  it('az /anime info a teljes adatlapot adja: borító, banner, leírás, minden adat, gombok', async () => {
    const v = await parancs({ command: 'anime', sub: 'info', options: { cim: teljes } })
    const e = v.data.embeds![0]!
    assert.equal(e.title, CIM_TELJES)
    assert.equal(e.color, 0xE4AE50)
    assert.match(String(e.thumbnail?.url), new RegExp(`/${TUKOR.replace(/[.]/g, '\\.')}$`))
    assert.equal(e.image?.url, BANNER)

    const d = String(e.description)
    assert.ok(d.includes(`*完全テスト · Card Test Full ${jel} · Kaado Tesuto ${jel}*`), d)
    for (const resz of ['teszt leírás —', '||titok||', '\\*csillag\\*', '「idézet」', 'Második sor']) {
      assert.ok(d.includes(resz), `hiányzik: ${resz}\n${d}`)
    }
    assert.ok(!/<i>|&mdash;|&#12300;/.test(d), 'nyers HTML/entitás maradt a leírásban')

    const m = mezok(e)
    assert.equal(m.get('📺 Formátum'), 'TV · 24 perc/rész')
    assert.equal(m.get('📡 Állapot'), '🟢 Adásban')
    assert.equal(m.get('🗓️ Szezon'), 'Ősz 2024')
    assert.equal(m.get('🎬 Epizódok'), '3 / 24 elérhető')
    assert.equal(m.get('⭐ Pontszám'), '82%')
    assert.match(String(m.get('👥 Népszerűség')), /^123\s456$/)
    assert.equal(m.get('🏢 Stúdió'), `Tesztstúdió ${jel}`)
    assert.equal(m.get('📖 Forrás'), 'Manga')
    assert.equal(m.get('📅 Vetítés'), '2024. okt. 5. óta')
    assert.equal(m.get('🏷️ Műfajok'), 'Akció · Dráma')
    assert.match(String(m.get('⏭️ Következő rész')), /^\*\*5\. rész\*\* · <t:\d+:F> \(<t:\d+:R>\)$/)

    const gombok = v.data.components![0]!.components
    assert.deepEqual(gombok.map(g => g.label), ['Megnézem', 'Adatlap', 'Előzetes'])
    assert.ok(gombok.every(g => g.style === 5), 'nem hivatkozásgomb')
    assert.match(String(gombok[0]!.url), new RegExp(`#/watch/${reszek[0]}$`))
    assert.match(String(gombok[1]!.url), new RegExp(`#/anime/${teljes}$`))
    assert.equal(gombok[2]!.url, 'https://www.youtube.com/watch?v=PaOFxvxRj9w')
  })

  it('angol kliensnek angol feliratokkal', async () => {
    const m = mezok((await parancs({ command: 'anime', sub: 'info', options: { cim: teljes }, locale: 'en-US' })).data.embeds![0])
    assert.equal(m.get('📺 Format'), 'TV · 24 min/ep')
    assert.equal(m.get('📡 Status'), '🟢 Airing')
    assert.equal(m.get('🗓️ Season'), 'Fall 2024')
    assert.equal(m.get('🏷️ Genres'), 'Action · Drama')
    assert.equal(m.get('📅 Aired'), 'since 5 Oct 2024')
    assert.match(String(m.get('⏭️ Next episode')), /^\*\*Episode 5\*\* · /)
  })

  it('hiányzó adatból nincs mező és nincs kép — nem „—", nem üres', async () => {
    const e = (await parancs({ command: 'anime', sub: 'info', options: { cim: keptelen } })).data.embeds![0]!
    assert.equal(e.thumbnail, undefined)
    assert.equal(e.image, undefined)
    for (const f of e.fields ?? []) assert.ok(f.value && f.value !== '—' && f.value !== 'null', `${f.name}: ${f.value}`)
    assert.ok(!mezok(e).has('🏢 Stúdió') && !mezok(e).has('🏷️ Műfajok'))
  })

  // ---- felnőtt cím ----

  it('felnőtt cím nincs a találatok, a javaslatok és az adatlapok között', async () => {
    const info = await parancs({ command: 'anime', sub: 'info', options: { cim: felnott } })
    assert.match(String(info.data.content), /Nincs találat/)

    const kereses = await parancs({ command: 'anime', sub: 'search', options: { cim: jel } })
    const cimek = (kereses.data.embeds ?? []).map(e => e.title)
    assert.deepEqual([...cimek].sort(), [CIM_KEPTELEN, CIM_TELJES].sort())

    const javaslat = await commands.autocomplete(interakcio({ type: 4, command: 'anime', sub: 'info', focused: 'cim', options: { cim: jel } })) as {
      data: { choices: Array<{ value: string }> }
    }
    const ertekek = javaslat.data.choices.map(c => c.value)
    assert.ok(ertekek.includes(teljes) && !ertekek.includes(felnott), JSON.stringify(ertekek))

    const hozzaad = await parancs({ command: 'watchlist', sub: 'add', options: { cim: felnott } })
    assert.match(String(hozzaad.data.content), /Nincs találat/)
  })

  it('felnőtt cím kártyáján nincs kép és leírás, csak a jelzés', async () => {
    const k = (await card.animeCard(felnott))!
    const e = card.animeEmbed(k, 'hu', { banner: true }) as Embed
    assert.equal(e.thumbnail, undefined)
    assert.equal(e.image, undefined)
    assert.ok(String(e.description).includes('🔞'))
    assert.ok(!String(e.description).includes('Titkos'), 'a felnőtt leírás kiment')
  })

  // ---- /anime search ----

  it('az /anime search kis kártyákat ad: borító, egy sor tény, rövid leírás', async () => {
    const v = await parancs({ command: 'anime', sub: 'search', options: { cim: jel } })
    assert.match(String(v.data.content), new RegExp(`Találatok erre: \\*\\*${jel}\\*\\* — 2 cím`))
    const e = v.data.embeds!.find(x => x.title === CIM_TELJES)!
    assert.match(String(e.thumbnail?.url), /kartyateszt-/)
    assert.match(String(e.description), /📺 TV · 🗓️ Ősz 2024 · 🎬 3 \/ 24 elérhető · ⭐ 82%/)
    assert.ok(String(e.description).length < 600)
  })

  // ---- /watchlist ----

  it('a /watchlist add a teljes adatlapot mutatja a két gombbal és a hivatkozásokkal', async () => {
    const v = await parancs({ command: 'watchlist', sub: 'add', options: { cim: teljes } })
    const e = v.data.embeds![0]!
    assert.ok(String(e.description).startsWith('**Hozzáadjam a könyvtáradhoz?**'))
    assert.ok(e.thumbnail?.url)
    assert.deepEqual(v.data.components![0]!.components.map(c => c.custom_id), [`wl:add:${teljes}`, 'wl:cancel'])
    assert.deepEqual(v.data.components![1]!.components.map(c => c.label), ['Megnézem', 'Adatlap', 'Előzetes'])
  })

  it('a /watchlist list haladást, pontszámot, összesítőt ad — a borító sosem a felnőtt címé', async () => {
    await db.query(
      `INSERT INTO library_entries (profile_id, anime_id, status, progress, score, updated_at) VALUES
         ($1, $2, 'WATCHING', 1, 8.5, now() - interval '1 hour'),
         ($1, $3, 'PLANNING', 0, NULL, now())`, [profileId, teljes, felnott])
    const e = (await parancs({ command: 'watchlist', sub: 'list' })).data.embeds![0]!
    assert.equal(e.title, '📚 A könyvtárad (2)')
    const sorok = String(e.description).split('\n')
    assert.equal(sorok[0], `📝 **${CIM_FELNOTT}** · tervezem · 0 / 24 rész`)
    assert.equal(sorok[1], `👀 **${CIM_TELJES}** · nézem · 1 / 24 rész · ⭐ 8.5/10`)
    assert.match(String(e.thumbnail?.url), new RegExp(`/${TUKOR.replace(/[.]/g, '\\.')}$`), 'a borító nem a legutóbbi nem-felnőtt címé')
    assert.match(String(mezok(e).get('Állapotonként')), /👀 nézem: \*\*1\*\* · 📝 tervezem: \*\*1\*\*/)
  })

  // ---- /next ----

  it('a /next a rész kártyáját adja: kép, cím, leírás, hol tartasz, haladásjelző', async () => {
    await db.query(
      `INSERT INTO watch_progress (profile_id, episode_id, anime_id, position_sec, duration_sec)
       VALUES ($1, $2, $3, 754, 1420)`, [profileId, reszek[1], teljes])
    const v = await parancs({ command: 'next' })
    const e = v.data.embeds![0]!
    assert.equal(e.title, `▶️ Folytasd: ${CIM_TELJES} — 2. rész`)
    assert.match(String(e.url), new RegExp(`#/watch/${reszek[1]}$`))
    const d = String(e.description)
    assert.ok(d.includes('Ott folytatod, ahol abbahagytad: 12:34 / 23:40'), d)
    assert.ok(d.includes('▰▰▰▰▰▱▱▱▱▱ 53%'), d)
    assert.ok(d.includes('*Második rész címe*') && d.includes('A(z) 2. rész leírása.'), d)
    assert.equal(e.image?.url, EP2_KEP)
    assert.match(String(e.thumbnail?.url), /kartyateszt-/)
    assert.equal(mezok(e).get('🎬 Epizód'), '**2. rész** / 24')
    assert.deepEqual(v.data.components![0]!.components.map(c => c.label), ['Megnézem', 'Adatlap', 'Előzetes'])
  })

  it('a /next felnőtt címnél képet és leírást nem mutat', async () => {
    await db.query(
      `INSERT INTO watch_progress (profile_id, episode_id, anime_id, position_sec, duration_sec)
       VALUES ($1, $2, $3, 60, 1420)`, [profileId, felnottReszek[0], felnott])
    const e = (await parancs({ command: 'next' })).data.embeds![0]!
    assert.equal(e.thumbnail, undefined)
    assert.equal(e.image, undefined)
    assert.ok(String(e.description).includes('🔞') && !String(e.description).includes('Titkos'))
  })

  it('ha a következő rész még nincs kint, a menetrendből megmondja, mikor várható', async () => {
    await db.query("INSERT INTO library_entries (profile_id, anime_id, status, progress) VALUES ($1, $2, 'WATCHING', 4)",
      [profileId, teljes])
    const v = await parancs({ command: 'next' })
    assert.match(String(v.data.content), /5\. rész még nem jelent meg\.\n⏭️ Várható: <t:\d+:F> \(<t:\d+:R>\)$/)
  })

  // ---- /profile ----

  it('a /profile a YUME saját számait adja: szint, idő, részek, műfajok, legutóbbi cím', async () => {
    await db.query(
      `INSERT INTO profile_stats (profile_id, xp_total, level, minutes_watched, episodes_watched, anime_completed,
                                  mean_score, genre_breakdown)
       VALUES ($1, 12345, 12, 725, 30, 4, 7.4, '{"Action": 300, "Drama": 200, "Comedy": 50}')
       ON CONFLICT (profile_id) DO UPDATE SET xp_total = excluded.xp_total, level = excluded.level,
         minutes_watched = excluded.minutes_watched, episodes_watched = excluded.episodes_watched,
         anime_completed = excluded.anime_completed, mean_score = excluded.mean_score,
         genre_breakdown = excluded.genre_breakdown`, [profileId])
    await db.query("INSERT INTO favorites (profile_id, subject_type, subject_id) VALUES ($1, 'anime', $2) ON CONFLICT DO NOTHING",
      [profileId, teljes])
    await db.query("INSERT INTO library_entries (profile_id, anime_id, status) VALUES ($1, $2, 'WATCHING')", [profileId, teljes])
    await db.query(
      `INSERT INTO watch_progress (profile_id, episode_id, anime_id, position_sec, duration_sec, completed)
       VALUES ($1, $2, $3, 1420, 1420, true)`, [profileId, reszek[0], teljes])

    const e = (await parancs({ command: 'profile' })).data.embeds![0]!
    assert.equal(e.title, `kartya${jel}`)
    const m = mezok(e)
    assert.match(String(m.get('🏅 Szint')), /^\*\*12\*\* · 12\s345 XP$/)
    assert.equal(m.get('⏱️ Nézési idő'), '**12 óra 5 perc**')
    assert.equal(m.get('🎬 Megnézett részek'), '**30**')
    assert.equal(m.get('✅ Befejezett címek'), '**4**')
    assert.equal(m.get('⭐ Átlagpontszámod'), '**7.4** / 10')
    assert.equal(m.get('Kedvencek'), '**1**')
    assert.equal(m.get('Könyvtár (1)'), '👀 nézem: **1**')
    assert.equal(m.get('🏷️ Kedvenc műfajaid'), 'Akció · Dráma · Vígjáték')
    assert.match(String(m.get('📺 Legutóbb nézted')), new RegExp(`^\\*\\*${CIM_TELJES}\\*\\* · <t:\\d+:R>$`))
    assert.match(String(m.get('🗓️ Tag óta')), /^<t:\d+:D>$/)
    assert.match(String(e.thumbnail?.url), /kartyateszt-/)
    assert.ok(e.timestamp && !Number.isNaN(Date.parse(e.timestamp)))
  })

  it('statisztika nélkül a /profile nem talál ki számokat', async () => {
    await db.query('DELETE FROM profile_stats WHERE profile_id = $1', [profileId])
    await db.query('DELETE FROM favorites WHERE profile_id = $1', [profileId])
    const m = mezok((await parancs({ command: 'profile' })).data.embeds![0])
    for (const nincs of ['🏅 Szint', '⏱️ Nézési idő', '🎬 Megnézett részek', '⭐ Átlagpontszámod', '🏷️ Kedvenc műfajaid']) {
      assert.ok(!m.has(nincs), `kitalált mező: ${nincs}`)
    }
    assert.equal(m.get('Kedvencek'), '**0**')
    assert.equal(m.get('Könyvtár (0)'), 'A könyvtárad üres. Hozzáadni: /watchlist add')
  })

  // ---- az epizód-bejelentés (és a DM, ami ugyanezt küldi) ----

  it('a bejelentés: pontszám százalékban, állapot a szerver nyelvén, műfaj, stúdió, a rész képe', async () => {
    const p = await feed.preview(reszek[1]!) as { embeds: Embed[], components: Valasz['data']['components'] }
    const e = p.embeds[0]!
    assert.equal(e.title, `${CIM_TELJES} — Második rész címe`)
    const m = mezok(e)
    assert.equal(m.get('⭐ Pontszám'), '**82%**', 'a pontszám nem egész százalék')
    assert.equal(m.get('📡 Állapot'), '🟢 Adásban')
    assert.equal(m.get('📺 Formátum'), 'TV · Ősz 2024')
    assert.equal(m.get('🏷️ Műfajok'), 'Akció · Dráma')
    assert.equal(m.get('🏢 Stúdió'), `Tesztstúdió ${jel}`)
    assert.equal(m.get('📝 Erről a részről'), 'A(z) 2. rész leírása.')
    assert.equal(e.image?.url, EP2_KEP)
    assert.match(String(e.thumbnail?.url), /kartyateszt-/)
    assert.equal(e.color, 0xE4AE50)
    // A vezérlőpult gombja kimaradt (egy tagnak zsákutca); helyette az előzetes.
    assert.deepEqual(p.components![0]!.components.map(c => c.label), ['Megnézem', 'Adatlap', 'Előzetes'])

    const angol = feed.buildEpisodeEmbed((await feed.episodeDetails(reszek[1]!))!, 'en') as { embeds: Embed[] }
    assert.equal(mezok(angol.embeds[0]).get('⭐ Score'), '**82%**')
    assert.equal(mezok(angol.embeds[0]).get('📡 Status'), '🟢 Airing')
  })

  it('kép nélküli résznél a banner a nagy kép', async () => {
    const p = await feed.preview(reszek[0]!) as { embeds: Embed[] }
    assert.equal(p.embeds[0]!.image?.url, BANNER)
  })

  it('felnőtt cím részének bejelentése (DM) kép és leírás nélkül', async () => {
    const r = await feed.episodeDetails(felnottReszek[0]!)
    const e = (feed.buildEpisodeEmbed(r!, 'hu') as { embeds: Embed[] }).embeds[0]!
    assert.equal(e.thumbnail, undefined)
    assert.equal(e.image, undefined)
    assert.ok(!mezok(e).has('📝 Erről a részről'))
    assert.ok(String(e.description).includes('🔞') && !String(e.description).includes('Titkos'))
  })
})
