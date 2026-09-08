// The client's GraphQL queries, parsed and checked.
//
// The web client builds AniList queries as template strings, so nothing ever
// looked at them until AniList did — and AniList's answer to a malformed one
// is to reject the whole request. That is how a detail page came to show
// "Failed to load anime" for every title that fell back to AniList:
//
//   Fields "relations" conflict because subfields "edges" conflict because
//   subfields "relationType" conflict because they have differing arguments.
//
// The media query spread the shared fragment (which selected `relationType`
// with no argument) and then selected `relations` again with
// `relationType(version: 2)`. GraphQL merges two selections of one response
// name only when their arguments are identical, so the query was invalid
// before it ran.
//
// This checks the property directly rather than the one instance of it: for
// every query the client sends, no two selections of the same response name
// within one selection set may carry different arguments. Fragment spreads are
// followed, because that is where the conflict hid.
//
// The server already depends on `graphql`, so this is a real parse, not a
// regex over a string.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse, print, Kind } from 'graphql'

import type { DocumentNode, FieldNode, FragmentDefinitionNode, SelectionSetNode } from 'graphql'

const here = dirname(fileURLToPath(import.meta.url))
const API_JS = readFileSync(join(here, '../../web/js/api.js'), 'utf8')

/**
 * Pull the GraphQL documents out of the client.
 *
 * They are template literals, and the ones that matter are marked with a
 * `/* GraphQL *\/` tag or assigned to a *_FRAGMENT / *_QUERY constant. Rather
 * than guess, this takes every template literal that parses as GraphQL and
 * contains a query or fragment definition.
 */
function extractDocuments (source: string): Array<{ text: string, at: number }> {
  const found: Array<{ text: string, at: number }> = []
  // Template literals, non-greedy, allowing ${...} interpolation inside.
  const literals = source.matchAll(/`([^`\\]*(?:\\.[^`\\]*)*)`/g)
  for (const match of literals) {
    const raw = match[1] ?? ''
    if (!/\b(query|fragment|mutation)\s/.test(raw)) continue
    // Interpolations are fragment injections; replace them with nothing and
    // splice the fragments back in below.
    const text = raw.replace(/\$\{[^}]*\}/g, '')
    found.push({ text, at: match.index ?? 0 })
  }
  return found
}

/** Every fragment the client defines, by name. */
function collectFragments (docs: Array<{ text: string }>): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const doc of docs) {
    let parsed: DocumentNode
    try { parsed = parse(doc.text) } catch { continue }
    for (const def of parsed.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def)
    }
  }
  return fragments
}

/**
 * Walk a selection set, following fragment spreads, and report any response
 * name selected twice with different arguments.
 *
 * This is the same property graphql-js enforces as OverlappingFieldsCanBeMerged,
 * reimplemented for the argument half only — the full rule needs a schema to
 * compare return types, and we do not have AniList's.
 */
function findArgumentConflicts (
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  path = 'Media',
  seenFragments = new Set<string>()
): string[] {
  const conflicts: string[] = []
  const byResponseName = new Map<string, { args: string, path: string }>()
  const children: Array<{ name: string, set: SelectionSetNode }> = []

  const visit = (set: SelectionSetNode, viaFragment: string | null): void => {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const field = selection as FieldNode
        const responseName = field.alias?.value ?? field.name.value
        // Arguments printed and sorted: order is not significance.
        const args = [...(field.arguments ?? [])]
          .map(a => print(a))
          .sort()
          .join(',')
        const previous = byResponseName.get(responseName)
        if (previous && previous.args !== args) {
          conflicts.push(
            `${path}.${responseName}: selected with \`${previous.args || '(no arguments)'}\` ` +
            `in ${previous.path} and \`${args || '(no arguments)'}\` in ${viaFragment ?? 'the query'}`
          )
        } else if (!previous) {
          byResponseName.set(responseName, { args, path: viaFragment ?? 'the query' })
        }
        if (field.selectionSet) children.push({ name: responseName, set: field.selectionSet })
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value
        // A fragment may legitimately be spread inside itself one level deep
        // (relations.node { ...med }); guard the walk, not the query.
        if (seenFragments.has(name)) continue
        const fragment = fragments.get(name)
        if (!fragment) continue
        seenFragments.add(name)
        visit(fragment.selectionSet, `fragment ${name}`)
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        visit(selection.selectionSet, viaFragment)
      }
    }
  }

  visit(selectionSet, null)

  // Merge the sub-selections of one response name and recurse into them
  // together, which is where the reported conflict actually lived.
  const merged = new Map<string, SelectionSetNode>()
  for (const child of children) {
    const existing = merged.get(child.name)
    merged.set(child.name, existing
      ? { ...existing, selections: [...existing.selections, ...child.set.selections] }
      : child.set)
  }
  for (const [name, set] of merged) {
    conflicts.push(...findArgumentConflicts(set, fragments, `${path}.${name}`, new Set(seenFragments)))
  }
  return conflicts
}

describe('client GraphQL documents', () => {
  const docs = extractDocuments(API_JS)
  const fragments = collectFragments(docs)

  it('finds the documents at all', () => {
    // If the extraction silently matches nothing, every test below passes
    // while checking nothing — the failure mode this whole file exists to
    // prevent, one level up.
    assert.ok(docs.length >= 3, `expected several documents, found ${docs.length}`)
    assert.ok(fragments.has('med'), 'the shared Media fragment must be found')
  })

  it('every document parses', () => {
    for (const doc of docs) {
      assert.doesNotThrow(() => parse(doc.text), `document at offset ${doc.at} does not parse`)
    }
  })

  it('no field is selected twice with differing arguments', () => {
    // The regression: `relationType` had no argument in the fragment and
    // `(version: 2)` in the media query, so AniList rejected the request and
    // the detail page showed "Failed to load anime".
    const problems: string[] = []
    for (const doc of docs) {
      let parsed: DocumentNode
      try { parsed = parse(doc.text) } catch { continue }
      for (const def of parsed.definitions) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue
        problems.push(...findArgumentConflicts(def.selectionSet, fragments, def.name?.value ?? 'query'))
      }
    }
    assert.deepEqual(problems, [], 'conflicting selections:\n  ' + problems.join('\n  '))
  })

  it('catches the conflict it was written for', () => {
    // The detector has to be able to fail, or it is decoration.
    const broken = parse(`
      query { Media(id: 1) { ...med relations { edges { relationType(version: 2) } } } }
    `)
    const brokenFragments = new Map([['med', (parse(`
      fragment med on Media { relations { edges { relationType } } }
    `).definitions[0]) as FragmentDefinitionNode]])
    const op = broken.definitions[0]
    assert.equal(op?.kind, Kind.OPERATION_DEFINITION)
    const found = findArgumentConflicts((op as { selectionSet: SelectionSetNode }).selectionSet, brokenFragments)
    assert.ok(found.length > 0, 'the detector must report the conflict it was written for')
    assert.match(found.join(' '), /relationType/)
  })
})
