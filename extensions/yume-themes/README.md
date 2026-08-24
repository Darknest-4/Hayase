# Yume Theme Pack

Extra colour themes for **Settings → Appearance**.

## The smallest useful extension there is

A theme is pure data: a base (`dark` or `light`), an accent colour, and a name.
So this package declares **no permissions at all** — it reaches no network,
reads no ids, and stores nothing. It cannot do anything except answer a
question, which makes it both a safe thing to install and the right reference
to copy when writing your own pack.

The engine derives hover and soft variants from the accent with `color-mix`,
which is why each theme needs one colour rather than a palette.

## Writing your own

```js
export default {
  async test () { return true },
  async theme () {
    return [
      { kind: 'theme', slug: 'mine', name: 'Mine', base: 'dark', accent: 'hsl(200 90% 55%)' }
    ]
  }
}
```

`kind: 'theme'` is required — metadata records carry a discriminator so the
consumer knows what it received. `base` must be `dark` or `light`: the engine
sets `data-theme` from it, and a value the stylesheet has no rules for renders
an unstyled page with no error to explain it.

## About the colours

Every accent sits in the lightness band the interface was designed around —
bright enough to read on a near-black ground, dark enough to stay legible on a
light one. A colour outside that band still "works" in the sense that nothing
breaks, and looks wrong.

Light-base themes carry darker accents than their dark-base counterparts for
exactly that reason: the same hue at the same lightness that reads well on
black is washed out on white. The test suite asserts the two bands stay apart.

## How they appear

Under their own **From extensions** heading, after the built-ins — so a viewer
can tell which themes came from where, and an extension cannot shadow a
built-in by reusing its slug. Loading is best-effort and happens after the page
is drawn: a slow or broken pack delays nothing and removes nothing.

## Tests

```sh
node --experimental-strip-types --test web/test/extension-themes.test.mjs
```
