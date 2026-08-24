# AniList Extras

Fills the **Characters** and **Recommendations** tabs on the anime detail page.

Those tabs say "No character data." and "No recommendations yet." for anything
served from the local catalogue, and always have — `people`, `characters`,
`anime_characters`, `anime_staff` and `anime_recommendations` are tables with no
code path. This is what puts something in them.

## One request, three answers

Cast, staff and recommendations all hang off the same AniList Media node, so
they come back in a single query rather than three. AniList rate-limits by
**request count**, not response size, so asking once for everything is strictly
cheaper than asking three times for a third each.

Results are cached for a day. A detail page is re-opened constantly and none of
this changes hour to hour; a request per visit would spend the budget on
nothing. An empty result is deliberately *not* cached — that would hide data
that appears later.

## It will not guess

Needs an **AniList id** on the title. Anything without one is skipped rather
than searched for by name: a title search would return a different show's cast,
which looks entirely plausible on screen and is entirely wrong.

## Options

| Option | What it does |
|---|---|
| `characters` | Fetch the cast. |
| `staff` | Fetch staff credits. |
| `recommendations` | Fetch recommended titles. |
| `limit` | How many of each. Clamped to 50 — it is a tab most people scroll past. |

## Where it appears

- **Cast** fills the Characters tab, with the Japanese voice actor where AniList
  has one.
- **Staff** appears as a second section under the cast. It has no tab of its
  own: adding one would push the tab row past what fits on a phone, and this is
  where a viewer would look for it anyway.
- **Recommendations** are mapped back into the shape the normal card grid draws,
  so they are the same cards as everywhere else rather than a second kind that
  looks almost right.

Records arrive flat — only primitives cross the sandbox boundary — so the voice
actor travels as `voiceActor` and `voiceActorImage` rather than a nested object.

## Tests

```sh
node --experimental-strip-types --test web/test/extension-anilist-meta.test.mjs
```
