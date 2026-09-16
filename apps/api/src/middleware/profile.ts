// Melyik profil nevében beszél ez a kérés.
//
// A választ eddig három helyen számolta ki ugyanaz a kód — a könyvtárban, a
// beállításokban és a GraphQL kontextusában —, egy negyedik helyen pedig
// senki: a hírek útvonala a fejlécet ellenőrzés nélkül vette át. Onnantól egy
// bejelentkezett látogató bármelyik ismert profil azonosítójával elvethetett
// egy hírt, és megtudhatta, hogy más elvetette-e. A tárgy jelentéktelen, a
// hiba fajtája nem: idegen sorba írni annyi, mint idegen sorba írni.
//
// Ami ezt észrevehetetlenné tette: a helyes ellenőrzés *létezett*, csak nem
// egy helyen. Egy megismételt védelem az a védelem, amiből egy példány
// hiányozni fog.
//
// A szerződés szándékosan szigorú marad, ahogy a könyvtárban volt:
//
//   nincs fejléc          400 — a kérésnek meg kell neveznie a profilt
//   idegen profil         403 — elutasítás, nem néma kiszolgálás
//   saját profil          az azonosító
//
// A néma kiszolgálás azért rosszabb, mint az elutasítás, mert a hívó azt hiszi,
// arról a profilról kapott választ, amit kért.

import { queryOne } from '../infrastructure/database/index.ts'

import type { FastifyReply, FastifyRequest } from 'fastify'

/** A fejlécben megnevezett profil, ha a hívóé. Semmi mást nem ad vissza. */
async function owned (request: FastifyRequest): Promise<string | undefined> {
  const sub = request.user?.sub
  const header = request.headers['x-profile-id']
  if (!sub || typeof header !== 'string' || !header) return undefined
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM user_profiles WHERE id = $1 AND user_id = $2', [header, sub])
  return row?.id
}

/**
 * A hívó profilja, vagy `undefined`.
 *
 * Olvasási útvonalakra, ahol a profil hiánya nem hiba: egy kijelentkezett
 * látogatónak nincs profilja, és egy hírnek tőle nincs „elvetve" állapota.
 * Idegen azonosítóra is `undefined` — sosem más profilja.
 */
export async function profileOf (request: FastifyRequest): Promise<string | undefined> {
  return await owned(request)
}

/**
 * Ugyanaz, de a hívó helyett válaszol, ha nincs profil.
 *
 * Ott való, ahol profil nélkül nincs mit csinálni: a könyvtár egy profilé,
 * nem egy fióké.
 */
export async function requireProfile (request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const header = request.headers['x-profile-id']
  if (typeof header !== 'string' || !header) {
    await reply.code(400).send({
      type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Missing X-Profile-Id header'
    })
    return undefined
  }
  const id = await owned(request)
  if (!id) {
    await reply.code(403).send({
      type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Profile does not belong to this account'
    })
    return undefined
  }
  return id
}
