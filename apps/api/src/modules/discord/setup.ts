/**
 * A DISCORD-SETUP — terv, végrehajtás, javítás, takarítás.
 *
 * HÁROM SZABÁLY TARTJA EGYBEN:
 *
 *   1. IDEMPOTENS. Ugyanaz a futás másodszor nem hoz létre semmit. A
 *      döntést a registry logikai kulcsa hozza, nem a Discord-objektum neve.
 *   2. AMIT NEM MI HOZTUNK LÉTRE, AHHOZ NEM NYÚLUNK. Egy azonos nevű, már
 *      létező csatornát ÖRÖKBE fogadunk (kezeljük), de sosem törlünk.
 *   3. EGY ELBUKOTT LÉPÉS NEM ÁLLÍTJA MEG A TÖBBIT. A setup tucatnyi
 *      lépésből áll; ha az első jogosultsági hiba félbeszakítaná, a
 *      felhasználó egy félkész szervert kapna anélkül, hogy tudná, mi maradt
 *      ki. Minden lépés külön eredményt ad, és a futás `partial` lesz.
 *
 * ELŐBB TERV, AZTÁN VÉGREHAJTÁS. A `plan()` semmit nem módosít: összeveti a
 * kívánt struktúrát a Discord VALÓS állapotával és a registryvel. Ugyanazt a
 * tervet mutatja meg az előnézet, amit a végrehajtás elvégez — nem két külön
 * kódút, ami idővel szétcsúszik.
 */

import { createHash, randomBytes } from 'node:crypto'

import { query, queryOne } from '../../infrastructure/database/index.ts'
import * as rest from './rest-client.ts'
import * as registry from './registry.ts'
import {
  CATEGORIES, CHANNEL_TYPE, PERM, PERSISTENT_MESSAGES, ROLES, VERSION,
  allChannels, permissionBits
} from './structure.ts'

import type { ChannelSpec, RoleSpec } from './structure.ts'

// ---------------------------------------------------------------- a terv

export type StepAction =
  /** Nincs meg, létrehozzuk. */
  | 'create'
  /** Létezik azonos néven, de nem a miénk — kezelésbe vesszük, NEM töröljük. */
  | 'adopt'
  /** A miénk, de eltér a leírástól. */
  | 'update'
  /** A miénk volt, de a Discordból eltűnt — újra létrehozzuk. */
  | 'recreate'
  /** Rendben van, nincs teendő. */
  | 'ok'
  /** Nem tudjuk elvégezni: jogosultság vagy rangsorrend. */
  | 'blocked'

export interface Step {
  type: registry.ObjectType
  key: string
  name: string
  action: StepAction
  /** Miért ez a művelet — emberi nyelven, a felületnek. */
  reason: string
  /** A meglévő Discord-objektum, ha van. */
  objectId?: string | null
  parentKey?: string | null
}

export interface Plan {
  guildId: string
  version: number
  steps: Step[]
  /** Amit a bot nem tud megtenni — a felület ezt külön mutatja. */
  missingPermissions: string[]
  /** A bot legmagasabb rangjának pozíciója; efölé nem nyúlhat. */
  botRolePosition: number | null
  /** Van-e olyan lépés, amit nem lehet elvégezni. */
  blocked: boolean
}

/** A bot guild-szintű jogosultságai és rangsorrendje. */
async function botKepessegek (guildId: string): Promise<{
  bits: bigint
  position: number | null
  roles: Array<{ id: string, name: string, position: number, permissions: string }>
}> {
  const [tag, rangok] = await Promise.all([rest.botMember(guildId), rest.fetchRoles(guildId)])
  if (!tag || !rangok) return { bits: 0n, position: null, roles: rangok ?? [] }

  let bits = 0n
  let position = 0
  for (const r of rangok) {
    if (!tag.roles.includes(r.id)) continue
    bits |= BigInt(r.permissions)
    if (r.position > position) position = r.position
  }
  /*
   * AZ `@everyone` IS SZÁMÍT. A guild alapértelmezett rangja mindenkire
   * vonatkozik, a botra is — a jogosultságai hozzáadódnak. Enélkül egy
   * olyan szerveren, ahol az `@everyone` kapta meg a jogokat, a bot azt
   * hinné, hogy semmit nem tehet.
   */
  const everyone = rangok.find(r => r.id === guildId)
  if (everyone) bits |= BigInt(everyone.permissions)

  return { bits, position, roles: rangok }
}

const ADMINISTRATOR = 1n << 3n
const MANAGE_CHANNELS = 1n << 4n
const MANAGE_ROLES = 1n << 28n

function van (bits: bigint, jog: bigint): boolean {
  // AZ ADMINISTRATOR MINDENT FELÜLÍR — a Discord így működik, és ha ezt nem
  // néznénk, egy adminjogú botnál minden lépés „blokkolt" lenne.
  return (bits & ADMINISTRATOR) !== 0n || (bits & jog) !== 0n
}

/**
 * A TERV ELKÉSZÍTÉSE. Semmit nem módosít.
 *
 * Három forrást vet össze: a kívánt struktúrát (`structure.ts`), a Discord
 * VALÓS állapotát (REST) és a registryt. A három közül bármelyik kettő
 * egyezése kevés — a registry mondja meg, mi a miénk, a Discord azt, hogy
 * létezik-e még.
 */
export async function plan (guildId: string): Promise<Plan> {
  const [csatornak, kepesseg, sorok] = await Promise.all([
    rest.fetchChannels(guildId),
    botKepessegek(guildId),
    registry.list(guildId)
  ])

  const hianyzoJogok: string[] = []
  if (!van(kepesseg.bits, MANAGE_CHANNELS)) hianyzoJogok.push('Csatornák kezelése')
  if (!van(kepesseg.bits, MANAGE_ROLES)) hianyzoJogok.push('Szerepkörök kezelése')

  const elerhetetlen = csatornak === null
  const eloCsatornak = csatornak ?? []
  const eloRangok = kepesseg.roles

  const regByKey = new Map(sorok.map(s => [`${s.object_type}:${s.logical_key}`, s]))
  const csatornaById = new Map(eloCsatornak.map(c => [c.id, c]))
  const rangById = new Map(eloRangok.map(r => [r.id, r]))

  const steps: Step[] = []

  /** A közös döntési lánc: registry → él → név. */
  const dontes = (
    type: registry.ObjectType,
    key: string,
    nev: string,
    elo: { id: string } | undefined,
    azonosNevu: { id: string } | undefined,
    eltero: boolean,
    parentKey: string | null,
    jogaVan: boolean
  ): Step => {
    const sor = regByKey.get(`${type}:${key}`)

    if (sor?.discord_object_id && elo) {
      return eltero
        ? { type, key, name: nev, action: jogaVan ? 'update' : 'blocked', reason: jogaVan ? 'eltér a leírástól' : 'nincs jogosultság a módosításhoz', objectId: elo.id, parentKey }
        : { type, key, name: nev, action: 'ok', reason: 'rendben', objectId: elo.id, parentKey }
    }
    if (sor?.discord_object_id && !elo) {
      // A MIÉNK VOLT, ÉS ELTŰNT. Ez a leggyakoribb javítási eset: valaki
      // kézzel törölte a Discordban.
      return { type, key, name: nev, action: jogaVan ? 'recreate' : 'blocked', reason: jogaVan ? 'a Discordból eltűnt' : 'eltűnt, de nincs jogosultság újra létrehozni', objectId: null, parentKey }
    }
    if (azonosNevu) {
      /*
       * AZONOS NEVŰ, DE NEM A MIÉNK. Nem hozunk létre másodikat — az
       * duplikáció volna —, és nem is töröljük: kezelésbe vesszük.
       * A registryben `created_by_yume = false` lesz, és a takarítás ezt
       * soha nem fogja törölni.
       */
      return { type, key, name: nev, action: 'adopt', reason: 'már létezik ilyen néven — kezelésbe vesszük, de nem a miénk', objectId: azonosNevu.id, parentKey }
    }
    return { type, key, name: nev, action: jogaVan ? 'create' : 'blocked', reason: jogaVan ? 'hiányzik' : 'hiányzik, de nincs jogosultság létrehozni', objectId: null, parentKey }
  }

  // ---- kategóriák ----
  for (const kat of CATEGORIES) {
    const sor = regByKey.get(`category:${kat.key}`)
    const elo = sor?.discord_object_id ? csatornaById.get(sor.discord_object_id) : undefined
    const azonosNevu = eloCsatornak.find(c => c.type === CHANNEL_TYPE.CATEGORY && c.name === kat.name)
    steps.push(dontes('category', kat.key, kat.name, elo, azonosNevu, elo ? elo.name !== kat.name : false,
      null, van(kepesseg.bits, MANAGE_CHANNELS)))
  }

  // ---- csatornák ----
  for (const cs of allChannels()) {
    const sor = regByKey.get(`channel:${cs.key}`)
    const elo = sor?.discord_object_id ? csatornaById.get(sor.discord_object_id) : undefined
    const azonosNevu = eloCsatornak.find(c => c.type !== CHANNEL_TYPE.CATEGORY && c.name === cs.name)
    steps.push(dontes('channel', cs.key, cs.name, elo, azonosNevu, elo ? elo.name !== cs.name : false,
      cs.parentKey, van(kepesseg.bits, MANAGE_CHANNELS)))
  }

  // ---- rangok ----
  for (const rang of ROLES) {
    const sor = regByKey.get(`role:${rang.key}`)
    const elo = sor?.discord_object_id ? rangById.get(sor.discord_object_id) : undefined
    const azonosNevu = eloRangok.find(r => r.name === rang.name)

    /*
     * A RANGSORREND KEMÉNY KORLÁT. A Discord nem engedi, hogy a bot olyan
     * rangot kezeljen, ami a sajátja FÖLÖTT van — és ezt előre megnézzük,
     * mert különben a hiba egy „hiányzó jogosultság" üzenet lenne, amiből
     * senki nem találná ki, hogy a sorrenden múlik.
     */
    const cel = elo ?? azonosNevu
    const felette = cel && kepesseg.position !== null &&
      (rangById.get(cel.id)?.position ?? 0) >= kepesseg.position
    if (felette) {
      steps.push({
        type: 'role', key: rang.key, name: rang.name, action: 'blocked',
        reason: 'ez a rang a bot legmagasabb rangja fölött van — a Discord nem engedi módosítani',
        objectId: cel.id
      })
      continue
    }

    const elter = elo ? (elo.name !== rang.name || elo.permissions !== permissionBits(rang)) : false
    steps.push(dontes('role', rang.key, rang.name, elo, azonosNevu, elter, null,
      van(kepesseg.bits, MANAGE_ROLES)))
  }

  // ---- tartós üzenetek ----
  const pmSorok = await query<{ id: string, message_type: string, channel_id: string }>(
    'SELECT id, message_type, channel_id FROM persistent_messages WHERE guild_id = $1', [guildId])

  for (const pm of PERSISTENT_MESSAGES) {
    const megvan = pmSorok.find(p => p.message_type === pm.messageType)

    /*
     * A LÉTEZÉS KEVÉS — A HELY IS SZÁMÍT.
     *
     * Egy már meglévő üzenet ülhet egy RÉGI csatornában, amit a setup előtt
     * hoztak létre kézzel. A leírás viszont megmondja, hova tartozik. Ha ezt
     * nem néznénk, a setup után a szerveren ott állna az új
     * `📊・statisztika` csatorna — üresen —, a statisztika pedig
     * változatlanul a régi helyen frissülne. „Rendben"-nek jelentve.
     *
     * A csatornacsere a motor szabályai szerint ÚJ üzenetet jelent: a régi
     * azonosító a régi csatornára mutat, és ott már nem módosítható.
     */
    const celCsatorna = regByKey.get(`channel:${pm.channelKey}`)?.discord_object_id ?? null

    if (megvan && celCsatorna && megvan.channel_id !== celCsatorna) {
      steps.push({
        type: 'persistent_message',
        key: pm.key,
        name: pm.messageType,
        action: 'update',
        reason: 'másik csatornában van, mint amit a leírás mond',
        objectId: megvan.id,
        parentKey: pm.channelKey
      })
      continue
    }

    steps.push({
      type: 'persistent_message',
      key: pm.key,
      name: pm.messageType,
      action: megvan ? 'ok' : 'create',
      reason: megvan ? 'rendben' : 'hiányzik',
      objectId: megvan?.id ?? null,
      parentKey: pm.channelKey
    })
  }

  if (elerhetetlen) {
    // A BOT NEM ÉRI EL A SZERVERT. Ilyenkor minden lépés blokkolt — nem
    // azért, mert hiányzik, hanem mert nem tudjuk megnézni.
    for (const s of steps) {
      s.action = 'blocked'
      s.reason = 'a bot nem éri el ezt a szervert'
    }
    hianyzoJogok.push('a bot nem tagja a szervernek, vagy nincs bot token')
  }

  return {
    guildId,
    version: VERSION,
    steps,
    missingPermissions: hianyzoJogok,
    botRolePosition: kepesseg.position,
    blocked: steps.some(s => s.action === 'blocked')
  }
}

// ---------------------------------------------------------------- végrehajtás

export interface StepResult extends Step {
  outcome: 'created' | 'adopted' | 'updated' | 'recreated' | 'skipped' | 'failed' | 'blocked'
  detail?: string
}

export interface ApplyResult {
  runId: string
  status: 'ok' | 'partial' | 'failed'
  results: StepResult[]
  counts: Record<string, number>
}

/** A csatorna jogosultsági felülbírálatai a leírás alapján. */
function felulbiralatok (guildId: string, spec: ChannelSpec): rest.PermissionOverwrite[] {
  if (spec.everyoneCanSend !== false) return []
  /*
   * AZ `@everyone` AZONOSÍTÓJA A GUILD AZONOSÍTÓJA. Nem elgépelés: a Discord
   * így adja. A csatornát LÁTJA mindenki, csak nem ír bele — egy
   * bejelentéscsatorna, amit senki nem lát, nem bejelentés.
   */
  return [{
    id: guildId,
    type: 0,
    allow: (PERM.VIEW_CHANNEL | PERM.READ_HISTORY | PERM.ADD_REACTIONS).toString(),
    deny: PERM.SEND_MESSAGES.toString()
  }]
}

export async function apply (
  guildId: string,
  mode: 'setup' | 'repair',
  actorId: string | null
): Promise<ApplyResult> {
  const runId = await registry.startRun(guildId, mode, actorId)
  const terv = await plan(guildId)
  const results: StepResult[] = []
  const indok = `YUME ${mode === 'repair' ? 'javítás' : 'setup'} (v${VERSION})`

  /** A logikai kulcsról a most érvényes Discord-azonosítóra. */
  const azonosito = new Map<string, string>()
  for (const sor of await registry.list(guildId)) {
    if (sor.discord_object_id) azonosito.set(`${sor.object_type}:${sor.logical_key}`, sor.discord_object_id)
  }

  const jegyez = async (s: Step, outcome: StepResult['outcome'], detail?: string) => {
    results.push({ ...s, outcome, ...(detail ? { detail } : {}) })
    await registry.event({
      guildId,
      objectType: s.type,
      logicalKey: s.key,
      discordObjectId: s.objectId ?? null,
      action: outcome === 'created'
        ? 'created'
        : outcome === 'adopted'
          ? 'adopted'
          : outcome === 'updated' || outcome === 'recreated'
            ? 'updated'
            : outcome === 'failed' ? 'failed' : 'skipped',
      detail: detail ?? s.reason,
      actorId,
      runId
    })
  }

  // A SORREND KÖTÖTT: kategória → csatorna → rang → üzenet. Egy csatorna nem
  // kerülhet olyan kategóriába, ami még nem létezik.
  const sorrend: registry.ObjectType[] = ['category', 'channel', 'role', 'persistent_message']

  for (const tipus of sorrend) {
    for (const lepes of terv.steps.filter(s => s.type === tipus)) {
      if (lepes.action === 'blocked') { await jegyez(lepes, 'blocked'); continue }
      if (lepes.action === 'ok') { await jegyez(lepes, 'skipped', 'már rendben van'); continue }

      try {
        if (tipus === 'category' || tipus === 'channel') {
          const spec = tipus === 'channel' ? allChannels().find(c => c.key === lepes.key) : undefined
          const parentId = lepes.parentKey ? azonosito.get(`category:${lepes.parentKey}`) ?? null : null

          if (lepes.action === 'adopt') {
            await registry.upsert({
              guildId, objectType: tipus, logicalKey: lepes.key,
              discordObjectId: lepes.objectId!, parentKey: lepes.parentKey ?? null,
              createdByYume: false, version: VERSION
            })
            azonosito.set(`${tipus}:${lepes.key}`, lepes.objectId!)
            await jegyez(lepes, 'adopted', 'meglévő objektum kezelésbe véve — törölni nem fogjuk')
            continue
          }

          if (lepes.action === 'update' && lepes.objectId) {
            const ok = await rest.editChannel(lepes.objectId, {
              name: lepes.name,
              ...(spec?.topic ? { topic: spec.topic } : {}),
              ...(parentId ? { parentId } : {})
            }, indok)
            await jegyez(lepes, ok ? 'updated' : 'failed', ok ? undefined : rest.lastError() ?? 'ismeretlen hiba')
            continue
          }

          // create vagy recreate
          const uj = await rest.createChannel(guildId, {
            name: lepes.name,
            type: tipus === 'category' ? CHANNEL_TYPE.CATEGORY : CHANNEL_TYPE.TEXT,
            parentId,
            ...(spec?.topic ? { topic: spec.topic } : {}),
            ...(spec ? { overwrites: felulbiralatok(guildId, spec) } : {})
          }, indok)

          if (!uj) { await jegyez(lepes, 'failed', rest.lastError() ?? 'a létrehozás nem sikerült'); continue }

          await registry.upsert({
            guildId, objectType: tipus, logicalKey: lepes.key,
            discordObjectId: uj.id, parentKey: lepes.parentKey ?? null,
            createdByYume: true, version: VERSION
          })
          azonosito.set(`${tipus}:${lepes.key}`, uj.id)
          await jegyez({ ...lepes, objectId: uj.id }, lepes.action === 'recreate' ? 'recreated' : 'created')
          continue
        }

        if (tipus === 'role') {
          const spec = ROLES.find(r => r.key === lepes.key) as RoleSpec

          if (lepes.action === 'adopt') {
            await registry.upsert({
              guildId, objectType: 'role', logicalKey: lepes.key,
              discordObjectId: lepes.objectId!, createdByYume: false, version: VERSION
            })
            azonosito.set(`role:${lepes.key}`, lepes.objectId!)
            await jegyez(lepes, 'adopted', 'meglévő rang kezelésbe véve — törölni nem fogjuk')
            continue
          }

          if (lepes.action === 'update' && lepes.objectId) {
            const ok = await rest.editRole(guildId, lepes.objectId, {
              name: spec.name, color: spec.color, hoist: spec.hoist,
              mentionable: spec.mentionable, permissions: permissionBits(spec)
            }, indok)
            await jegyez(lepes, ok ? 'updated' : 'failed', ok ? undefined : rest.lastError() ?? 'ismeretlen hiba')
            continue
          }

          const uj = await rest.createRole(guildId, {
            name: spec.name, color: spec.color, hoist: spec.hoist,
            mentionable: spec.mentionable, permissions: permissionBits(spec)
          }, indok)
          if (!uj) { await jegyez(lepes, 'failed', rest.lastError() ?? 'a létrehozás nem sikerült'); continue }

          await registry.upsert({
            guildId, objectType: 'role', logicalKey: lepes.key,
            discordObjectId: uj.id, createdByYume: true, version: VERSION
          })
          azonosito.set(`role:${lepes.key}`, uj.id)
          await jegyez({ ...lepes, objectId: uj.id }, lepes.action === 'recreate' ? 'recreated' : 'created')
          continue
        }

        // ---- tartós üzenet ----
        const pm = PERSISTENT_MESSAGES.find(p => p.key === lepes.key)!
        const csatornaId = azonosito.get(`channel:${pm.channelKey}`)
        if (!csatornaId) {
          await jegyez(lepes, 'failed', 'a célcsatorna nem jött létre')
          continue
        }

        if (lepes.action === 'update' && lepes.objectId) {
          /*
           * ÁTHELYEZÉS. A `message_id` NULLÁZÓDIK, mert a régi azonosító a
           * RÉGI csatornára mutat, és ott már nem módosítható — a következő
           * kör az új csatornába küldi ki. A régi üzenet ottmarad; azt az
           * üzemeltető törli, ha akarja.
           */
          await query(
            `UPDATE persistent_messages
                SET channel_id = $3, message_id = NULL, last_rendered_hash = NULL,
                    failure_count = 0, last_error = NULL, updated_at = now()
              WHERE id = $1 AND guild_id = $2`,
            [lepes.objectId, guildId, csatornaId])
          await registry.upsert({
            guildId, objectType: 'persistent_message', logicalKey: lepes.key,
            discordObjectId: lepes.objectId, parentKey: pm.channelKey,
            createdByYume: true, version: VERSION
          })
          await jegyez(lepes, 'updated', 'áthelyezve a leírás szerinti csatornába')
          continue
        }

        /*
         * AZ ÜTKÖZÉST AZ ADATBÁZIS DÖNTI EL. Egy guildben egy típusból egy
         * AKTÍV üzenet lehet; a `DO NOTHING` azt jelenti, hogy egy
         * újrafuttatás nem hoz létre másodikat.
         */
        const letre = await queryOne<{ id: string }>(
          `INSERT INTO persistent_messages (guild_id, channel_id, message_type, configuration, enabled)
           VALUES ($1, $2, $3, '{}'::jsonb, true)
           ON CONFLICT DO NOTHING RETURNING id`,
          [guildId, csatornaId, pm.messageType])
        if (!letre) { await jegyez(lepes, 'skipped', 'már létezik'); continue }

        await registry.upsert({
          guildId, objectType: 'persistent_message', logicalKey: lepes.key,
          discordObjectId: letre.id, parentKey: pm.channelKey,
          createdByYume: true, version: VERSION
        })
        await jegyez({ ...lepes, objectId: letre.id }, 'created')
      } catch (error) {
        await jegyez(lepes, 'failed', String((error as Error)?.message ?? error).slice(0, 200))
      }
    }
  }

  const counts: Record<string, number> = {}
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1

  /*
   * A SIKER SZIGORÚ. Egyetlen `failed` vagy `blocked` lépés elég ahhoz, hogy
   * a futás ne legyen `ok` — egy zöld pipa egy félbehagyott szerver fölött
   * rosszabb, mint egy piros.
   */
  const status = (counts.failed ?? 0) > 0 || (counts.blocked ?? 0) > 0
    ? ((counts.created ?? 0) + (counts.updated ?? 0) + (counts.adopted ?? 0) + (counts.recreated ?? 0) > 0 ? 'partial' : 'failed')
    : 'ok'

  await registry.finishRun(runId, status, { counts, results })
  return { runId, status, results, counts }
}

// ---------------------------------------------------------------- takarítás

export interface ResetTarget {
  type: registry.ObjectType
  key: string
  objectId: string | null
  createdByYume: boolean
}

/**
 * MIT TÖRÖLNE A GYÁRI VISSZAÁLLÍTÁS.
 *
 * KIZÁRÓLAG A REGISTRYBŐL, és onnan is csak azt, amit MI hoztunk létre. Ami
 * örökbe fogadott (`created_by_yume = false`), az kimarad: egy évek óta
 * használt `#altalanos`, amit csak kezelünk, nem a mi tulajdonunk.
 *
 * Név alapján itt SEMMI nem kerül a listára. Ez a különbség egy takarítás és
 * egy katasztrófa között.
 */
export async function resetTargets (guildId: string): Promise<{
  deletable: ResetTarget[]
  protected: ResetTarget[]
}> {
  const sorok = await registry.list(guildId)
  const deletable: ResetTarget[] = []
  const protectedList: ResetTarget[] = []
  for (const s of sorok) {
    const t: ResetTarget = {
      type: s.object_type, key: s.logical_key,
      objectId: s.discord_object_id, createdByYume: s.created_by_yume
    }
    if (s.created_by_yume) deletable.push(t)
    else protectedList.push(t)
  }
  return { deletable, protected: protectedList }
}

/**
 * A TÖRLENDŐK UJJLENYOMATA — a megerősítő jegyhez.
 *
 * Ez köti meg, hogy amit megerősítettek, az ugyanaz, mint amit
 * végrehajtanak. Ha az előnézet óta változott a lista — mert közben valaki
 * lefuttatta a setupot —, a jegy nem érvényes, és a törlés megáll.
 */
export function targetsHash (targets: ResetTarget[]): string {
  const rendezett = [...targets]
    .map(t => `${t.type}:${t.key}:${t.objectId ?? '-'}`)
    .sort()
    .join('|')
  return createHash('sha256').update(rendezett).digest('hex')
}

export const CONFIRM_TTL_MS = Number(process.env.DISCORD_CONFIRM_TTL_MS ?? 5 * 60_000)

/** Megerősítő jegy kiadása. A nyers jegyet csak a hívó kapja meg. */
export async function issueConfirmation (
  guildId: string, userId: string, action: string, payloadHash: string
): Promise<string> {
  const jegy = randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO discord_confirmations (token_hash, guild_id, user_id, action, payload_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::int || ' milliseconds')::interval)`,
    [createHash('sha256').update(jegy).digest('hex'), guildId, userId, action, payloadHash, CONFIRM_TTL_MS])
  return jegy
}

/**
 * A jegy beváltása — EGYSZER.
 *
 * `DELETE … RETURNING`, nem „megnézem, majd törlöm": két egyidejű kérés a
 * második mintával mindkettőnek azt mondaná, hogy érvényes.
 */
export async function consumeConfirmation (
  token: string, guildId: string, userId: string, action: string, payloadHash: string
): Promise<boolean> {
  if (typeof token !== 'string' || token.length < 20) return false
  const sor = await queryOne<{ payload_hash: string }>(
    `DELETE FROM discord_confirmations
      WHERE token_hash = $1 AND guild_id = $2 AND user_id = $3
        AND action = $4 AND expires_at > now()
      RETURNING payload_hash`,
    [createHash('sha256').update(token).digest('hex'), guildId, userId, action])
  if (!sor) return false
  // A LISTA IS EGYEZZEN. Lásd `targetsHash`.
  return sor.payload_hash === payloadHash
}

export async function pruneConfirmations (): Promise<number> {
  const sorok = await query<{ n: number }>(
    `WITH d AS (DELETE FROM discord_confirmations WHERE expires_at < now() RETURNING 1)
     SELECT count(*)::int AS n FROM d`)
  return sorok[0]?.n ?? 0
}

/**
 * GYÁRI VISSZAÁLLÍTÁS — csak a sajátunkra.
 *
 * A sorrend fordított, mint a létrehozásé: előbb az üzenetek, aztán a
 * csatornák, végül a kategóriák és a rangok. Egy kategória törlése a benne
 * lévő csatornákat is elviszi; ha fordítva mennénk, a registry sorai
 * árván maradnának.
 */
export async function factoryReset (
  guildId: string, actorId: string | null
): Promise<ApplyResult> {
  const runId = await registry.startRun(guildId, 'factory_reset', actorId)
  const { deletable, protected: vedett } = await resetTargets(guildId)
  const results: StepResult[] = []
  const indok = 'YUME gyári visszaállítás'

  for (const t of vedett) {
    results.push({
      type: t.type, key: t.key, name: t.key, action: 'ok',
      reason: 'nem a YUME hozta létre — védett', outcome: 'skipped',
      detail: 'örökbe fogadott objektum, nem töröljük'
    })
  }

  const sorrend: registry.ObjectType[] = ['persistent_message', 'channel', 'category', 'role']
  for (const tipus of sorrend) {
    for (const t of deletable.filter(x => x.type === tipus)) {
      let sikeres = false
      let reszlet: string | undefined

      if (!t.objectId) {
        sikeres = true
        reszlet = 'nem volt Discord-objektuma'
      } else if (tipus === 'persistent_message') {
        // A NYILVÁNTARTÁST TÖRÖLJÜK, a kint lévő üzenetet nem: azt az
        // üzemeltető törli, ha akarja. Ugyanaz a szabály, mint a felületen.
        await query('DELETE FROM persistent_messages WHERE id = $1 AND guild_id = $2', [t.objectId, guildId])
        sikeres = true
      } else if (tipus === 'role') {
        sikeres = await rest.deleteRole(guildId, t.objectId, indok)
        if (!sikeres) reszlet = rest.lastError() ?? 'a törlés nem sikerült'
      } else {
        sikeres = await rest.deleteChannel(t.objectId, indok)
        if (!sikeres) reszlet = rest.lastError() ?? 'a törlés nem sikerült'
      }

      if (sikeres) {
        const sor = await registry.get(guildId, tipus, t.key)
        if (sor) await registry.close(sor.id)
      }

      results.push({
        type: tipus, key: t.key, name: t.key, action: 'ok',
        reason: 'a YUME hozta létre',
        outcome: sikeres ? 'updated' : 'failed',
        ...(reszlet ? { detail: reszlet } : {})
      })
      await registry.event({
        guildId, objectType: tipus, logicalKey: t.key, discordObjectId: t.objectId,
        action: sikeres ? 'deleted' : 'failed', detail: reszlet ?? null, actorId, runId
      })
    }
  }

  const counts: Record<string, number> = {}
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
  const status = (counts.failed ?? 0) > 0 ? ((counts.updated ?? 0) > 0 ? 'partial' : 'failed') : 'ok'
  await registry.finishRun(runId, status, { counts, results })
  return { runId, status, results, counts }
}

/**
 * ÚJRASZINKRONIZÁLÁS — a Discordból kézzel törölt objektumok felismerése.
 *
 * A registry azt hiszi, hogy az objektum megvan; a Discord szerint nincs. A
 * sor NEM törlődik — a `discord_object_id` üresre áll, és a következő
 * javítás újra létrehozza. Így marad meg az, hogy ez a MI objektumunk volt.
 */
export async function resync (guildId: string, actorId: string | null): Promise<{
  orphaned: string[]
  checked: number
}> {
  const [csatornak, rangok, sorok] = await Promise.all([
    rest.fetchChannels(guildId), rest.fetchRoles(guildId), registry.list(guildId)
  ])
  if (csatornak === null || rangok === null) return { orphaned: [], checked: 0 }

  const eloIds = new Set<string>([...csatornak.map(c => c.id), ...rangok.map(r => r.id)])
  const orphaned: string[] = []

  for (const sor of sorok) {
    if (sor.object_type === 'persistent_message') continue
    if (!sor.discord_object_id) continue
    if (eloIds.has(sor.discord_object_id)) continue

    await registry.orphan(sor.id)
    orphaned.push(sor.logical_key)
    await registry.event({
      guildId, objectType: sor.object_type, logicalKey: sor.logical_key,
      discordObjectId: sor.discord_object_id, action: 'orphaned',
      detail: 'a Discordból eltűnt — a javítás újra létrehozza', actorId
    })
  }

  return { orphaned, checked: sorok.length }
}
