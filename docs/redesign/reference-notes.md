# Reference screenshots — running notes

Source: onianime.hu, photographed by the owner as the target for Yume's
redesign. 92 screenshots, arriving in batches of 5. This file is the record so
nothing is lost between batches; it is notes, not a plan.

---

## Batch 1 — first-visit gate and onboarding (images 1–5)

### 1. Entry gate (`/`, signed out)
- Blurred anime artwork behind everything, near-black wash over it.
- Centred column: mark (fox-mask silhouette, white), then `Üdvözöl az OniAnime!`
  as a heavy display heading, then one muted line of subtitle.
- Consent checkbox inline with linked ÁSZF / Adatvédelmi nyilatkozat.
- Two stacked full-width actions: **Discord** (blurple `#5865F2`, brand icon)
  and `Elfogadom és folytatom →` (dark, secondary).
- Nothing else on the screen. No nav, no footer.

### 2–5. Onboarding wizard, 5 steps
Sticky header on every step: mark, step name, `N / 5 lépés`, and a percentage
pill on the right (20% / 40% / 60%). Under it a **segmented progress bar** —
five separate tracks, filled ones white.

Sticky footer on every step: `‹ Vissza` (dark) and `Következő ›` (white,
primary) — thumb-reachable, always visible.

Body pattern, repeated:
- Section header = small icon + label, then a hairline rule.
- Setting row = bold title, muted description under it, control on the right.
- Toggles are large and pill-shaped; **on = white track, black knob**.

**Step 1 `Fiók`** — Fiók és biztonság: Hozzászólások, Felnőtt tartalom, Privát
böngészés. Then `Korhatár szűrő`: a two-option segmented control
(`Kizárás` / `Csak ezeket`, active = white) above rating chips in a 2-up grid,
each chip carrying a leading dot: G, PG, PG-13, R (17+, erőszak), R+ (enyhe
meztelenség), Rx (Hentai).

**Step 2 `Megjelenés`** — Vizuális beállítások: Betöltési logó, Kijelölés,
Animációk csökkentése, Részletes kártyák, Partnerek mutatása, AI figyelmeztetés,
Tippek. Then two **EN/JP switches** (Címek nyelve, Anime logó) — a toggle with
a label inside the knob, not a plain on/off. Then two **sliders with tick
labels**: Oldal nagyítása (80–120, step 5, value pill `100%`) and Képernyővédő
(Ki, 1–10 perc, value pill `2 perc`).

**Step 3 `Spoiler`** — Spoiler védelem, one explanatory line, then five toggles:
Epizód cím, Leírás, Kép, Pontszám, Globális értékelés.

### Design language to carry over
- Near-black ground, blurred artwork behind, no borders on cards — separation
  by space and hairlines instead.
- Heavy display type for headings, muted secondary line under everything.
- One accent per surface; the only saturated colour on the gate is Discord's.
- Controls are large: toggles, chips and buttons are all comfortably
  thumb-sized. Nothing is small text on mobile.
- Sticky header + sticky footer, content scrolls between them.

### Features implied (not yet built in Yume)
- [ ] Entry gate with ToS consent + Discord auth
- [ ] 5-step onboarding wizard with progress
- [ ] Age-rating filter (exclude / only-these) with per-rating chips
- [ ] Private browsing (no history, no resume points)
- [ ] Reduce animations, detailed cards, partners, AI warning, tips toggles
- [ ] Title/logo language switch (EN ↔ JP), separate from UI language
- [ ] Page zoom 80–120%
- [ ] Screensaver after N minutes idle
- [ ] Per-field spoiler protection

---

## Batch 2 — wizard tail, news modal, landing page (images 6–10)

### 6. Step 5/5 `Lejátszó` (100%)
Player defaults: **Hangerő** slider (value pill `100%`), **Lejátszási sebesség**
slider (`1.00x`), **Preferált minőség** slider with three *named* stops
(`Auto` / `720p` / `1080p`) labelled under the track, **Tekerési ugrás** as a
number + unit field (`15` `mp`), **Megállítva felület** toggle (show the anime's
art, data and description when the player is paused).

Final action is `Befejezés` with a sparkle glyph — the last step's button is
visibly the end of something, not another Next.

### 7. Step 4/5 `Személyre szabás` (80%)
Toggles: Automatikus lejátszás, Intro átugrása, Outro átugrása, Filler
jelölése, Képernyő sötétülés (dark overlay on mouse move), Pozíció mentése.
Then two **icon segmented controls**: `Platform preferálás` (AniList / MAL, the
real brand tiles, active one in AniList blue) and `Pontszám preferálás`
(★ vs %).

### 8. News / announcement modal  ← the "hírek popup" asked for
- Title block: heavy heading + one muted line (`Az új oldal: onianime.eu`).
- A **highlighted callout**: tinted panel with a blue-ish border for the lede.
- Then **feature rows**: a rounded, tinted icon tile (cyan clock, pink speaker)
  with bold title + muted body. One colour per row, low saturation fill.
- Sticky action stack at the bottom: primary white with an external-link glyph,
  Discord blurple, then a plain `Rendben` dismiss.

### 9. Landing page hero  ← the landing page asked for
- Enormous display heading, ~4 lines on a phone, with a **light-to-grey
  gradient on the first word** only.
- Muted paragraph under it, centred, generous measure.
- Two buttons side by side: `Böngészés` (white, primary) and `Discord` (dark).
- Behind everything, a huge **outlined wordmark** watermark, barely visible.
- No top navigation at all.

### 10. Landing page, scrolled
- `Miért jobb ez mint a többi?` — a **product screenshot with a play button**
  overlaid, i.e. a video/demo embed.
- Then `Anime streaming, egyszerűen.` — another display heading + muted body.
  Sections alternate heading/body/visual down the page.
- **Scroll-to-top FAB**, circular, bottom right.

### Navigation — the pattern to copy
A **floating pill bottom bar**, not a sidebar: `Főoldal · Kereső · Közösség ·
Opciók` then a divider and `Több …`. Labels under icons when expanded; a
chevron tab sits on top of the pill and **collapses it to icons only**. It
floats above the content with a dark translucent fill, inset from the edges.

### Features implied (running list)
- [ ] Landing page for signed-out visitors: hero, demo video, feature sections
- [ ] Floating collapsible bottom nav, labelled
- [ ] News/announcement modal, admin-authored, with callout + feature rows
- [ ] Player defaults in onboarding: volume, speed, quality, seek step
- [ ] Paused-screen overlay with the anime's data
- [ ] Skip intro / skip outro / filler marking
- [ ] Platform preference (AniList / MAL) and score format (★ / %)
- [ ] Scroll-to-top FAB

---

## Batch 3 — landing page body and SEO tail (images 11–15)

### Section rhythm on the landing page
Repeating unit, top to bottom:
1. **Eyebrow**: all-caps, wide letter-spacing (~.2em), muted, centred —
   `MINDEN, AMIRE SZÜKSÉGED VAN`.
2. Centred muted paragraph, narrow measure.
3. **Feature blocks**, left-aligned: outline icon (rocket, link, wrench) beside
   a bold heading, muted body under the pair. Large vertical gaps between them —
   one block per thumb-scroll, not a dense grid.
4. Occasionally a full-width **display heading** as a punctuation mark
   (`Prémium érzés, ingyenes nézés!`, `Ez már alapból tudja.`), then a hairline.

Headings repeatedly use a **light-to-grey gradient on the first word or two**
(`Ez` in `Ez már alapból tudja.`), the rest solid white.

### Episode card — the component to copy for Yume's episode lists
Horizontal card, thumbnail left:
- duration chip (`24 perc`) inset bottom-left of the thumbnail;
- a **progress bar along the bottom edge of the thumbnail** (blue fill) for a
  partly-watched episode;
- play overlay on the hovered/active one, which also gains a light border;
- body: `1. Tragédia` bold, one muted description line, then a muted relative
  date (`12 évvel ezelőtt`);
- **capability icons** right-aligned: a CC/subtitle glyph, and a mic glyph when
  a dub exists. Sub vs dub is shown per episode, as icons, not as words.

### `Elérhető máshol is.` — platform availability
Centred heading, muted two-line body, then three large **outline platform
glyphs** in a row: Windows, Android, TV. No labels, no buttons — just the marks.

### SEO article tail
Below the marketing sections the landing page carries long-form copy:
all-caps bold section heading, numbered sub-headings (`2. Mitől az OniAnime…`),
body paragraphs, and lists whose bullet is a literal **`/`** with a bold
lead-in term (`Biztonság:`, `Tartalmi könyvtár:`, `Minőség és Felbontás:`).

### Open question — the accent colour
OniAnime's accent reads **blue/indigo**, not rose: the callout border, the
episode progress bar and the AniList tile are all blue, and Discord blurple is
the only other saturated colour. Yume's accent today is rose
(`hsl(346.6 79% 51%)`). Whether the redesign keeps rose or moves to blue is a
decision for the owner, recorded here rather than assumed.

### Features implied (running list, cont.)
- [ ] Per-episode sub/dub capability icons
- [ ] Episode watch-progress bar on the thumbnail
- [ ] Landing page long-form SEO section
- [ ] Platform availability row (desktop / Android / TV apps)

---

## Batch 4 — testimonials, footer, and the real home page (images 16–20)

### Testimonials — `Mások mit mondanak…`
Stacked cards, generous gaps, no borders — separated by a fill one step lighter
than the page. Each: circular avatar (the member's anime art) + bold display
name + muted `@handle` on the line under it, then muted body text **clamped
with an ellipsis**. Nothing else: no date, no rating, no link.

### Footer — a full closing screen, not a strip
Top to bottom:
1. Giant condensed **`ONIANIME` wordmark** in caps.
2. Two muted centred lines, then a white `Felfedezés` button. A second CTA at
   the bottom of the page, not just at the top.
3. A wide piece of **anime artwork**, full-bleed inside the container.
4. The logo lockup, then a legal disclaimer paragraph — the host-nothing,
   third-party-content notice.
5. **Two link columns**: `Felfedezés` (Kereső, Közösség, Zene, Letöltés) and
   `Erőforrások` (Feltételek, Adatvédelem, Kapcsolat, GY.I.K).
6. A **partner/affiliate banner**.
7. Copyright line: `© 2024–2025 OniAnime | Készítette: OniAnime csapat`.

Note two nav items Yume has no equivalent for: **Zene** and **Letöltés**.

### The home page itself (image 20) — this is the layout to beat
- **Ad slot at the very top**: a wide banner, with a muted italic caption under
  it, `Te is szeretnél hirdetni? Katt.` — the slot sells itself when empty.
- Then titled rails, one per row, horizontally scrolling:
  - `Legújabb feltöltések` — **portrait cover cards**. Under each cover a
    single meta row with the format on the left (`TV`, `ONA`) and a status tag
    on the right (`FUT`), then the title clamped to two lines. The meta sits
    *outside* the image, not over it.
  - `Műfaj: Psychological` — the same rail shape but with **landscape banner
    cards**, so a genre row reads differently from a catalogue row at a glance.
- Rails bleed off the right edge deliberately: the next card is half-visible,
  which is what says "scrollable" without a control.

### Bottom nav, active state
The active item gets a **filled white pill behind its icon**; the others stay
plain outline glyphs. In the collapsed state only the icons show, and the
active pill is the only thing carrying colour.

### Features implied (running list, cont.)
- [ ] Testimonials section, member-authored
- [ ] Footer: large wordmark, second CTA, legal disclaimer, link columns,
      partner banner
- [ ] Advertising slot with a self-serve "advertise here" link
- [ ] Home rails mixing portrait-cover rows and landscape-banner genre rows
- [ ] Format + airing-status tags under every cover
- [ ] Music section, downloads section

---

## Batch 5 — home hero and the rail system (images 21–25)

### Hero carousel — the first thing on the home page
Full-bleed banner artwork, no card, no border, bleeding under the status bar.
Overlaid bottom-left:
- **Title in a warm gradient** (gold → tan), not flat white — the only place
  type is coloured.
- One **meta row** of three items: airing status in green (`ÉPPEN FUT`), then a
  calendar glyph + `Ősz 1999`, then an episodes glyph + `Ep 1177`. Icons, not
  labels.
- Actions: white `▶ Megtekintés` primary, and a **circular ghost `ⓘ`** beside
  it — watch, or read about it. Two choices, no more.
- **Carousel position as short bars**, five segments, the active one white.
  The same segmented-progress idiom as the onboarding wizard.

Directly under the hero sits the ad banner, then the rails begin.

### The rail system — two card shapes, alternating on purpose
**Portrait cover rails** — `Legújabb feltöltések`, `Nyár 2026`,
`Ne maradj le az előző szezonról – Tavasz 2026`:
- cover, then *outside* the image a meta row with format left (`TV`, `ONA`) and
  status right (`FUT`, `BEFEJEZETT`), both small caps and muted;
- then the title, clamped to two lines.

**Landscape banner rails** — every `Műfaj: …` row:
- a 16:9 banner with the series' own logo artwork;
- the title sits in a **bottom gradient scrim** on the image itself;
- one card is roughly a screen wide, so a genre row reads as a feature strip
  rather than a list.

Alternating the two shapes is what stops a page of eight rails looking like one
long grid. Genre rows are visibly a different kind of thing from catalogue rows.

### Section titles carry their own grammar
`Legújabb feltöltések` · `Műfaj: Psychological` · `Nyár 2026` ·
`Ne maradj le az előző szezonról – Tavasz 2026` · `Legnézettebb`.
A prefix (`Műfaj:`) or a full sentence, not just a noun — the rail explains why
it is there.

### Status vocabulary
`ÉPPEN FUT` (green, hero) / `FUT` (rail tag) / `BEFEJEZETT`. Airing state is
carried by a word plus colour in the hero, by a word alone in the rails.

### Features implied (running list, cont.)
- [ ] Home hero carousel with segmented position indicator
- [ ] Watch + info split as the hero's two actions
- [ ] Season rails driven by season/year, genre rails by genre
- [ ] Format and airing-status tags on every portrait card

---

## Batch 6 — the rest of the home rails (images 26–30)

Mostly confirmation, and it confirms the most useful thing: the alternation is
a **rule, not a coincidence**. Every genre banner rail sits between two
portrait rails, all the way down.

Full rail order observed, top to bottom:

```
  hero carousel
  ad banner
  Legújabb feltöltések              portrait
  Műfaj: Psychological              banner
  Nyár 2026                         portrait
  Műfaj: Drama                      banner
  Ne maradj le az előző szezonról – Tavasz 2026   portrait
  Műfaj: Sports                     banner
  Legnézettebb                      portrait
  Műfaj: Mecha                      banner
  Ma népszerű                       portrait
  Műfaj: Slice of Life              banner
  Legnézettebb Filmek               portrait
  Legutóbbi epizódok                (episode cards)
```

Twelve-plus rails on one page, and it does not read as a wall because the
shape changes every other row.

### Rail kinds, by what feeds them
- **Recency** — `Legújabb feltöltések`, `Legutóbbi epizódok`
- **Season** — `Nyár 2026`, `Ne maradj le az előző szezonról – Tavasz 2026`
- **Popularity** — `Legnézettebb`, `Ma népszerű`, `Legnézettebb Filmek`
- **Genre** — one banner rail per genre, repeated for as many genres as wanted

The genre rails are the cheap, endless ones: same query, different genre, and
each is visually a feature strip. That is how the page gets long without
needing more kinds of content.

### Format tag values seen
`TV` · `ONA` · `FILM` — the tag is the format, and films get their own
popularity rail (`Legnézettebb Filmek`) rather than being mixed into the series
rails.

### Confirmed: the banner card's title
Always in a **bottom gradient scrim on the image**. It looked "below the image"
on Re:ZERO only because that artwork is already black at the bottom.

---

## Batch 7 — episode grid, forum, comments, filters, community (images 31–35)

### `Legutóbbi epizódok` — a grid, not a rail
The last home section breaks the rail pattern deliberately: **two columns of
episode cards** on a phone. Each card:
- 16:9 still from the episode, with a **CC/subtitle badge top-left** (dark
  rounded square) and an **`Ep 10` badge bottom-right**;
- the **Hungarian episode title**, bold, two lines;
- under it the **series' original title**, muted bold — two titles, two roles;
- a muted two-line synopsis;
- relative time (`14 órája`).

Ending the page on a grid says "that's the end of the rails" without a divider.

### Forum block on the home page
Rows, each: bold thread title (truncated to one line), a **category chip on the
right** (`OFF-TOPIC`, `ÁLTALÁNOS`, `HIBÁK`) and a comment count with a bubble
glyph. Under the title, a small circular avatar + author + relative time.
A `Több betöltése` button sits above the block.

### `Komment` block — recent comments, with a distinctive card
Left side: series title + episode (`4. rsz`), then reply count and like count
as glyph+number pairs. Then the comment body, then avatar + author + time.
Right side: the series artwork **clipped with a diagonal edge**, bleeding to
the card's corner. That slant is the one piece of visual flourish on the page
and it is what makes the card recognisable.

### Search — the filter panel is far richer than Yume's
Header `Szűrők` with a filter glyph and a **clear-all trash button**. Then a
**two-column grid of labelled selects**, twelve of them:

```
  Műfaj        Kulcsszavak
  Formátum     Év
  Szezon       Állapot
  Rendezés     Stúdió
  Hang         Eredet
  Korhatár     Animelista
```

Then a full-width search field (`Keress animére, filmre…`) *below* the filters,
and the results grid under that. Yume has seven filters in one wrapping row;
this has twelve in a stable two-column grid, and it stays readable because each
one is labelled above its control rather than beside it.

New filter axes Yume has no equivalent for: **Kulcsszavak, Stúdió, Hang
(sub/dub), Eredet, Korhatár, Animelista**.

### Community — three tabs, and a real chat
Top segmented control: `Csevegő` · `Fórum` · `W2G`, the active one a **white
pill with its icon**.

The chat is Discord-shaped: channel header (`# globalis-csevego` + one muted
line of purpose), then messages as avatar + name + date + body. The important
part is **role presentation**: the username is *coloured by role* and followed
by a **role chip** — `ADMIN` in red, `TÁMOGATÓ` in magenta. Ordinary members are
plain white with no chip.

A floating pill appears when scrolled up: `Régebbi üzeneteket látsz` with an
`Ugrás a jelenhez` button.

### Features implied (running list, cont.)
- [ ] Episode grid with sub/dub badge, episode badge, HU + original title
- [ ] Forum thread list with category chips and counts
- [ ] Recent-comments block with diagonal artwork
- [ ] Twelve-axis filter panel incl. studio, keywords, audio, source, rating
- [ ] Chat with role colours and role chips (admin, supporter)
- [ ] "You are viewing older messages → jump to present" affordance

---

## Batch 8 — the settings surface (images 36–40)

*(Image 36 repeats the `Legutóbbi epizódok` grid already recorded.)*

### Settings navigation
A **vertical list of sections**, each an icon + label, with the active one as a
**full-width white pill**. Sections seen:

```
  Fiók · Megjelenés · Spoiler · Személyre szabás · Felirat · Lejátszó · Rólunk
```

`Felirat` — subtitle appearance — is its own section and has no Yume
equivalent. The list and the section body live on the same scrolling page: the
nav is at the top, the chosen section's content directly below it.

### `Fiók`
Privát mód, Felnőtt tartalom, Hozzászólások. Then `Korhatár szűrő` with the
mode as a **select** (`Kizárás (elrejtés)`) and the rating chips below, wrapping
full-width. Then two **integration rows** — MyAnimeList and AniList — each with
a `Belépés` button carrying the service's own mark.

Then a destructive block: `Sütik és helyi adatok törlése`, a long plain
explanation of exactly what will and will not be lost, and a **red button on a
red-tinted fill**. The explanation is longer than the control, which is the
right ratio for a destructive action.

### Two inconsistencies in the reference itself, worth deciding rather than copying
1. **Toggle on-state colour.** In onboarding an enabled toggle is **white**; in
   settings it is **green**. Same control, two meanings of "on". Yume should
   pick one.
2. **Rating-filter mode control.** Onboarding uses a two-option segmented
   control (`Kizárás` / `Csak ezeket`); settings uses a `<select>` for the same
   choice.

Copying both would import the inconsistency. Recording them here so the choice
is deliberate.

### `Megjelenés` (settings version)
Same switches as the onboarding step, plus `Mozgás csökkentése`, and the same
EN/JP knob toggles and zoom slider. Note the onboarding step and the settings
section are **the same settings twice** — onboarding is a first-run pass over a
subset of the settings page, not a separate store.

### Features implied (running list, cont.)
- [ ] Settings as sectioned page with a vertical section nav
- [ ] Subtitle appearance settings (`Felirat`)
- [ ] MAL / AniList account linking
- [ ] "Clear local data" escape hatch with an explicit scope explanation
- [ ] Onboarding writes the same preference store the settings page edits

---

## Batch 9 — anime detail tail, episode picker, watch page, player (images 41–45)

### Relations and recommendations — `Kapcsolódó` / `Hasonló Anime`
Full-width rows, not a rail. Each row: a small portrait cover at the left, then
a **relation-type eyebrow in caps** (`MELLÉKTÖRTÉNET`, `AJÁNLÁS`) with the title
under it — and the related title's **banner art faded into the row's
background**. The row is a link that looks like the thing it points at.
A `Mutass Többet` button closes the block.

A donation card sits above them: title, muted description, chevron.

### Episode picker — the part Yume most obviously lacks
Above the number grid, a control row:
- a **range select** (`1-25`),
- a **search field** (`Keresés…`),
- three icon buttons: an eye (watched filter), a grid (layout), sort arrows.

Then a **grid of episode-number buttons**, six across, the current one
outlined. For a 1000-episode series this is how you reach episode 743 — Yume's
rail can only be scrolled.

### Comments
Avatar, `@username`, relative time, and **the episode the comment is about in
muted italic** (`1175. rész`). Then the body, then thumbs-up / thumbs-down
counts and `Válasz`. Replies are collapsed behind `1 válasz megjelenítése`.
Paginated with `‹ 1 2 ›`.

### A second accent: amber
`2 válasz megjelenítése` and the **active pagination square** are amber/orange,
not blue. So the reference has two accents — blue for state and progress, amber
for "there is more here, open it". Worth deciding deliberately rather than
inheriting.

### Watch page, below the player
1. Eyebrow `ÉPPEN A KÖVETKEZŐT…`, the episode title, a muted synopsis.
2. **Action chips** in a wrapping row: `Jelentés`, `Letöltés`, `W2G`,
   `Gyorsbillentyűk`, `Megosztás` — icon + label, dark pills.
3. **Track selector**: two large side-by-side cards, `Felirat` (active, white
   fill, CC icon tile, and **the fansub group's name underneath** — `karks`)
   and `Szinkron / Nem elérhető` (dimmed, disabled). Availability is shown, not
   hidden.
4. A **red warning banner**: report it if the wrong episode plays.
5. A **live countdown to the next episode**: `1179. rész: szept. 20.` then
   `6 n. 2 ó. 30 p. 39 mp.` ticking.
6. Comment controls: an `Ez a rész` scope toggle, sort selects, then the input.

### Player settings — a tabbed bottom sheet
Titled `BEÁLLÍTÁSOK` with a close X. **Horizontally scrolling tabs**:
`MINŐSÉG · FELIRATOK · SEBESSÉG · BEÁLLÍTÁSOK`, with a chevron showing more.
Options listed below with a check on the active one (`240p / 480p / 1080p`).

### Features implied (running list, cont.)
- [ ] Relation rows with type eyebrow and background art
- [ ] Episode picker: range select, search, watched filter, number grid
- [ ] Comment threads with replies, votes, per-episode scoping and pagination
- [ ] Sub/dub track cards naming the release group
- [ ] Countdown to the next episode
- [ ] "Wrong episode" report affordance
- [ ] Download, W2G, share, keyboard-shortcuts actions on the watch page
- [ ] Player settings sheet with quality / subtitles / speed tabs
- [ ] Donation card

---

## Batch 10 — remaining settings sections (images 46–50)

*(Image 46 repeats the Spoiler section.)*

### `Személyre szabás`
Automatikus lejátszás, Intro átugrása, Outro átugrása, Filler jelölése,
Képernyő sötétülés, Lejátszási pozíció mentése — then Platform preferálás
(AniList / MAL brand tiles) and Pontszám preferálás (★ / %). Same set as the
onboarding step 4, confirming onboarding is a subset of settings.

### `Felirat` — subtitle appearance, the best component in the whole reference
- A **live preview** at the top: a real anime still with an `ELŐNÉZET` badge,
  and the subtitle drawn on it exactly as configured, sample text and all. Every
  control below changes the picture immediately.
- Controls: `Szöveg mérete`, `Szöveg színe`, `Háttér színe`,
  `Háttér átlátszósága`.
- Size is a slider with a `100%` value pill.
- Colour is a **row of round swatches** — white, yellow, cyan, magenta, green,
  plus a multicolour "custom" swatch. Background colour is a second row of
  **square** swatches (black, greys, blue-greys), the selected one ringed.
- Opacity is a slider (`40%`).

Round swatches for text, square for background: the shape says which one you
are editing without reading the label.

### `Lejátszó`
Hangerő, Lejátszási sebesség, Preferált minőség, Tekerési ugrás időtartama
(number + unit), Megállítva felület. Same as onboarding step 5.

### `Rólunk`
Prose with **underlined emphasis** on the phrases that matter:
*stored locally in your browser*, *not synced or transmitted*,
*Legal notice:*, *does not host or store video*, *beta version*.

One product decision stated there and worth noting: **every preference in this
panel is local to the browser and is never synced**. Yume stores preferences
server-side per profile. That is a real difference, not a style one — a decision
to make, not to copy.

### Features implied (running list, cont.)
- [ ] Subtitle appearance settings with a live preview and swatch pickers
- [ ] About section stating storage and legal position plainly

---

## Batch 11 — profile, profile customisation, schedule, speed test (images 51–55)

### Profile
Large circular avatar with **two floating circular buttons sitting on it**
(share, edit). Then username, a muted bio line (`Nincs információ.` when empty),
then inline stats: `3 Karma` · `0 Barát`.

**Segmented tabs**: `Lista` (active white pill) · `Kedvencek` · `Aktivitás`,
horizontally scrolling.

The library is a **table**, not a grid: column headers `CÍM / HALADÁS / MŰVELET`,
and each row is a cover thumb + title + **status in muted caps**
(`MOST NÉZEM`, `MEGNÉZTEM`) + genres, then the progress number, then **per-row
edit and delete icon buttons**. Above it a toolbar: search field, sort button,
clear button.

Yume shows the library as a cover grid with no per-row actions and no progress
column. This is a denser, more list-like treatment — and it is the natural
place for the `.table-stack` primitive already built.

### `Profil testreszabása` modal
Tabs: `Kép` · `Banner` · **`Keret`** (frame — a decorative ring around the
avatar; Yume has no equivalent). Content is a list of **collapsible groups, one
per series, each prefixed with its item count** (`23 Demon Slayer`,
`16 7th Time Loop`, `12 Custom`). Footer: `Mentés` (white) / `Mégse`.

### Schedule — `Vetítési Naptár`
- Hero: **amber eyebrow** `KÖVETKEZŐ EPIZÓD · 11. rész`, the title, then a live
  countdown `16p 34mp · 13:57-kor`.
- Below: heading, muted explanation, and the **timezone and live clock stated
  explicitly**: `(GMT+02:00) 2026. 09. 14. 13:40:26`.
- A `Csak a saját listám` checkbox filters to the viewer's library.
- **Day tabs** scrolling horizontally: weekday abbreviation over the date,
  active day a white card.
- Then a **timeline with a left time gutter** (`04:00`, `13:57`, `15:00`) and a
  vertical rule; each entry is a thumbnail + title + `158. rész leadva 04:00-kor`
  + availability line. The next one to air carries an amber **`Következik!`**
  badge.
- Availability (`Az anime elérhető az oldalon.`) is **red text** — used as
  emphasis here rather than as an error.

### Speed test page
Tabs `Főoldal` / `Könyvtár`, then three measurements with coloured icons —
`Letöltés` (green), `Feltöltés` (blue), `Ping` (amber) — each showing a
**skeleton bar while measuring**. A footnote with a spinner explains it only
talks to the app's own API with tiny payloads.

Good example of the skeleton rule: the placeholder is the shape of the value
that will replace it.

### Features implied (running list, cont.)
- [ ] Profile with karma, friends, tabs (list / favourites / activity)
- [ ] Library as a sortable table with per-row edit and delete
- [ ] Avatar / banner / **frame** customisation from per-series catalogues
- [ ] Schedule: next-episode countdown, timezone, my-list filter, day tabs,
      time-gutter timeline, "up next" badge
- [ ] Connection speed test

---

## Batch 12 — torrent library, music, changelog (images 56–60)

### Torrent search — `Keress a könyvtárban`
Search field, then **source tabs** (`Nyaa.si` active / `AnimeTosho.org`).
Each result: the raw release title, a **violet category chip**
(`Literature - Raw`, `Anime - Non-English-translated`), then a row of muted
meta pills — `Méret: 986.4 MiB`, **`S: 11` with the seeder count in green**,
and the date. Then two actions: `Mágnes` (dark, copy glyph) and `Letöltés`
(white). Seeder count is the one number coloured, because it is the one that
decides whether the row is worth anything.

### Music — three tabs: `Főoldal` · `Rádió` · `Zenék`
- **Főoldal**: hero art, a sparkle eyebrow `ÜDVÖZÖL AZ ONIANIME`, then a
  heading and muted body — OSTs, openings, endings, trailers.
- **Rádió**: large portrait album art, then a **player bar** (circular white
  play button, `Zene: HAPPY BANG!`, volume glyph), then the track title large
  with `白上フブキ - OniAnime Rádió` muted under it.
- **Zenék**: a search field over an empty list.

### `Frissítések` — the changelog, and this one is a direct requirement
The owner asked for the development log to come from the database, with
non-public entries excluded. This is the shape to build:

```
  Frissítések                                    ← heading
  Új frissítések és fejlesztések a(z) …          ← muted description
  A naplózást 2025. december 31.-től vezetjük.   ← when logging began
  Az új oldal LEGELSŐ béta verziója …            ← when the rewrite started
  ─────────────────────────────────────────────
  v1.0.47-AB        Szeptember 11, 2026          ← version + date
  [Weboldal Frissítések] [Weboldal]              ← category chips
  │ ✓  Komment kiemelés a lejátszóban            ← green tick + bold title
  │    Ha a főoldalon vagy az oldal bármely …    ← muted body paragraph
  │ ✓  Megosztás és időbélyeg
  │    Bekerült a megosztás funkció …
  ─────────────────────────────────────────────
  v1.0.46-AB        Szeptember 11, 2026
```

Points that matter for the Yume implementation:
- **A version tag per release** (`v1.0.47-AB`), with the date beside it muted.
- **Category chips per release**, so entries can be filtered by area.
- Items hang off a **left vertical rule**, each with a status glyph. A green
  tick is "done"; the glyph slot implies other states are possible
  (in progress, fixed, removed).
- Each item is **a bold title plus a real paragraph**, not a one-line bullet.
  These are written for viewers, not for developers.
- The preamble states plainly when logging started and that the site is a
  rewrite — the owner asked for exactly this ("teljesen újraírásra került,
  Hayase-ből indultunk").

### Features implied (running list, cont.)
- [ ] Torrent search across sources with magnet / download actions
- [ ] Music section: radio stream, track library, OST/OP/ED browse
- [ ] Database-backed changelog with versions, dates, category chips, per-item
      status glyphs and prose bodies — **public/non-public flag per entry**

---

## Batch 13 — team page and the desktop-app landing (images 61–65)

### `Csapattagok` — the team page
Heading, muted description, then **role groups**, each with its own heading and
a muted line explaining what the role does (`Tulajdonosok` — "a projekt alapítói
és technikai vezetői"; `Szerkesztővezetők` — "a tartalomgyártásért … felelős
vezetők").

Each member is a card: square-rounded avatar, name, then two chips on the right
— a profile chip and a **Discord chip carrying their handle** (blurple mark +
name). Under that, an **italic bio paragraph** written in the third person.
Some cards carry a **red `Veterán` badge** in the corner.

This is how the owner's "who did what" is presented — worth copying for the
rewrite story they asked to be recorded.

### Desktop-app landing page
A second marketing page, same grammar as the web landing but selling the app:
display heading with a gradient first word, muted body with the last sentence
bolded, then a stack of **feature cards** — each a dark rounded panel with a
centred heading, a centred muted line, and **a real product screenshot inside
it**:

```
  Bármi, amit csak szeretnél     → catalogue grid screenshot
  Fedezz fel bármit              → home rails screenshot
  Nézd mi következik             → schedule screenshot
  Ne maradj le semmiről          → anime detail screenshot
  Teljes felirat integráció      → subtitle settings screenshot
```

Between the cards, full-width display headings act as chapter breaks
(`Irányíts minden képkockát a nézési élményedben.`).

### A third accent, and the palette question is now real
The screenshots inside those cards show the **desktop app using green** as its
accent — the `Lejátszás` button and the active `Kapcsolatok` tab are green. So
across the reference there are now three accents in play:

```
  blue    web: progress bars, callouts, AniList tile, card dots
  amber   web: active pagination, "show replies", schedule "Következik!"
  green   desktop app: primary actions, active tab
```

None of them is rose, which is Yume's accent today. **This needs one decision
before any redesign work starts** — it is the single choice that touches every
screen. Recorded, not assumed.

### Card design in the desktop screenshots
Portrait cards there carry a **coloured dot before the title** and a meta row
of `TV` + a `CC` glyph + the episode count (`TV [CC] 1154`) — denser than the
web's `TV … FUT` row, and it puts subtitle availability on the card.

### Features implied (running list, cont.)
- [ ] Team page with role groups, Discord handles, bios, veteran badges
- [ ] Desktop-app landing page with screenshot feature cards
- [ ] Episode count and subtitle availability on catalogue cards

---

## Batch 14 — W2G, account settings, and the feature manifest (images 66–70)

### `Nézd barátokkal` — Watch Together
The screenshot shows the lobby: tabs `Chat` · `Epizódok` · `Tagok`, then
`Tagok (2)`. The **host's row is highlighted gold** — gold border, gold tint, a
**crown on the avatar** and a `FŐNÖK` badge — while a guest row is plain dark.
Yume's W2G has no visible host marking.

### Account settings seen in the `Fájdalmasan egyszerű` screenshot
Two columns: the `Fiók` preferences on the left (private mode, adult content,
comments, MAL/AniList integration — AniList showing `Fiók csatlakoztatva`), and
**account actions** on the right:

```
  Profil láthatósága      Alapvető információk    Jelszó megváltoztatása
  Biztonsági kódok        Watchlist importálása   Fiók törlése (red)
```

`Biztonsági kódok` (recovery codes) and `Watchlist importálása` have no Yume
equivalent. `Fiók törlése` in red is the same destructive-action treatment as
the clear-data block.

### The feature manifest — a checklist worth keeping
A long marketing list, headed **`🏆 Minimális Funkciólista`** in gold, then
emoji-prefixed sections with bullets. Transcribed because it is the clearest
statement of what the owner considers the baseline:

**⌨️ Anime Kezelés**
- list management across AniList, MAL and local storage
- automatic watched-episode tracking
- see what you fell behind on, and discover missed sequels
- stay current with upcoming episodes via the schedule
- edit list entries (score, progress, status, favourite)
- search by name, genre, year, season and more
- trailers, OP/ED themes, detailed episode lists with images and descriptions

**🧡 Közösség & Társaság**
- see which friends are following an anime or episode
- view friends' profiles and watch progress
- join episode discussions and forums, even offline
- global application chat
- Discord rich presence (desktop app)
- start or join Watch Together lobbies with synced playback and chat

**🎥 Videó Élmény**
- full subtitle support: embedded and manually added; VTT, SSA, ASS, SRT;
  subtitles rendered in **picture-in-picture**
- picture-in-picture mode
- video compression-artefact removal

Section headings use emoji as the icon, and the top-level heading is gold —
the same amber family as the pagination and the schedule badge.

---

## Batch 15 — the support page (images 71–75)

*(Image 71 repeats the feature manifest tail and the footer.)*

### Hero
A **deep magenta wash** bleeding from the top — the only page with a coloured
ground. Huge display heading (`Ha szeretnéd, támogathatsz minket.`) with the
gradient on the first word, then a muted paragraph that **bolds the
disclaimers, not the pitch**: *egyszeri, önkéntes* … *nem előfizetés* … *nem
jár vele* semmilyen extra funkció. Two buttons: `Támogatás Revoluton ↗`
(white, external-link glyph) and `Discord` (dark).

### Three promise cards
`Egyszeri támogatás` · `Semmi extra előny` · `Támogató rang` — each a bold
title and one muted line. The middle card exists to say you get **nothing**,
which is unusual and sets the tone for the whole page.

### Supporter identity card
Circular avatar, **username in magenta**, a magenta `Támogató` pill, then the
muted `@handle`. Then `Megjegyzés a támogatáshoz:` in italic and a
**magenta-tinted callout**: put your Discord name and site name on the
transfer, or we cannot tell who you are.

Then two icon cards with magenta tinted tiles — `Mit kapsz?` (sparkle) and
`Mit nem kapsz?` (shield) — and a white CTA `Megnyitás: revolut.me/… ↗`.

### Stats grid
Four tiles, 2×2: `70 000+ Epizód az oldalon`, `100 000+ Regisztrált
felhasználó`, `40 000+ Napi látogató`, `89.9% Üzemelési idő` — the last with a
red aside `(ez ne érdekeljen XD)`. Big number, muted label under it.

### Cost transparency — the best component on this page
```
  Havonta                                    ← eyebrow
  Kb. 112 333 Ft tartja életben az OniAnimét ← heading
  Saját zsebből fedezve. …                   ← muted explanation
  ▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒░░░░▓▓▓│                   ← one stacked bar, 5 segments
  ● Proxy IP-k  ● Internet  ● Cloudflare Pro ← legend, coloured dots
  ● Áram        ● Domainek
  ─────────────────────────────────────────
  ● Proxy IP-k        65 000 Ft / hó         ← itemised rows, dot matches
    Forrás scrapelés, biztonság                 the legend colour
  ● Internet          20 000 Ft / hó
    Otthoni szerver internetkapcsolat
```
A single stacked bar, a legend, and the same colours repeated on the itemised
rows — the reader can move between the bar and the line item without counting.

### A fourth accent context
Magenta is the supporter/donation colour: the page wash, the username, the
`Támogató` badge, the callout, the icon tiles. It also matched the `TÁMOGATÓ`
chat badge seen earlier. So the reference's colour system is really:

```
  blue     progress / state
  amber    "there is more" / up-next / the gold feature heading
  green    desktop-app primary actions, enabled toggles
  magenta  supporters
  red      destructive actions, warnings, availability emphasis
  blurple  Discord only
```

That is a semantic palette with **no single brand accent** — which is exactly
the decision Yume has to make, since it has one today.

### Features implied (running list, cont.)
- [ ] Support page: promise cards, supporter identity, transfer instructions
- [ ] Supporter rank with badge on profile and in chat
- [ ] Public stats tiles
- [ ] Monthly running-cost breakdown with stacked bar and itemised rows

---

## Batch 16 — cost tail, and the anime detail page (images 76–80)

### Cost breakdown, finished
Itemised rows, then a **total row** on a slightly lighter fill
(`Összesen — 112 333 Ft / hó`), then a **2-column grid of domain chips** (8 of
them), then a closing line: donations only soften these costs, *and the site
will keep running if nobody gives anything*. The disclaimer-first tone again.

### Anime detail page — the layout to beat
1. **Full-bleed banner artwork** filling the first screen, no chrome over it.
2. A **portrait cover card floating centred** over the banner's lower half.
3. Under it: the original title small and muted, then the display title large
   and bold — two titles, two weights, same as the episode cards.
4. **Description, justified**, clipped with a gradient fade and an
   `Olvass többet` button sitting *on* the fade, centred. The fade is the
   affordance; the button is on top of it.
5. **Action row**: one primary `▶ Lejátszás` button and five circular icon
   buttons — add to list, favourite, notify, share, trailer.
6. **Metadata as a two-column label/value grid**:
   `Formátum / Sorozat`, `Állapot / Éppen fut`, `Évad / Ősz 1999`,
   `Epizódok / 1177`, `Értékelés / 62%`, `Hang / Feliratos`.
   The lower rows are **faded out** with a `Mutass többet ⌄` toggle — the same
   progressive-disclosure idiom as the description.
7. **Tabs**: `Epizódok` (active) · `Karakterek` · `Zenék` · `Műalkotások` ·
   `Kapcsolatok`. Two of those have no Yume equivalent: a per-title **music**
   tab (OP/ED/OST) and an **artworks** tab.
8. Then the episode number grid.

Compare Yume's detail page: chips repeating the side panel, tabs of
Episodes/Relations/Comments/Recommendations, no cover floating over the banner,
no progressive disclosure on either the description or the metadata.

### The accent is probably per-title, and Yume already has the data
On this page the accent is **amber**: the `Lejátszás` button and the active tab
underline. In the desktop-app screenshot of the *Frieren* detail page the same
elements were **green**. One Piece's key art is orange-gold; Frieren's is green.

So the earlier "three accents" reading is likely wrong: the reference appears
to **derive the accent from the title's dominant colour**, and the fixed
semantic colours (red destructive, magenta supporter, blurple Discord) sit
alongside it.

This matters because Yume already has the pieces:
- `anime.dominant_color` is in the catalogue table and already populated;
- `style.css` already uses `var(--custom, var(--accent))` in several places —
  the detail page's icon buttons and the episode range chips.

So per-title theming is a smaller change here than it looks. Still a decision
to put to the owner, not an assumption — but the evidence is now specific
rather than a guess.

### Features implied (running list, cont.)
- [ ] Detail hero: full-bleed banner + floating cover + dual title
- [ ] Description and metadata with fade + "show more" progressive disclosure
- [ ] Action row: play + add / favourite / notify / share / trailer
- [ ] Per-title `Zenék` and `Műalkotások` tabs
- [ ] Accent derived from the title's dominant colour

---

## Batch 17 — detail-page tabs and the watch page (images 81–85)

### `Kapcsolatok` — a relationship **graph**, not a list
The standout component of the whole reference. A pan/zoom node graph: each
node is a card (title + relation type), and the edges are **coloured dashed
lines carrying their own labels** — `Karakter` violet, `Melléktörténet` amber,
`Manga` orange, `Egyéb` green, `Alternatív`. Floating zoom controls
(`+` / `−` / fit) bottom-left.

For a franchise like One Piece — a dozen films, specials, summaries and
manga — a flat "Related" list cannot show that *Film: Z* is a side story while
*Loguetown-hen* is the manga. The graph can. Yume renders relations as flat
rows grouped by franchise.

### `Műalkotások` — artwork browser
**Filter pills carrying counts**: `Hátterek 100` (active, amber fill) ·
`Poszterek 111` · `Bannerek 24`. Then full-width images, each with a
**resolution badge** (`1920×1080`) inset bottom-right. It is a wallpaper
gallery, and the resolution is the thing you pick by.

### `Karakterek` — character and voice actor in one row
Each row is **two-sided**: character art and name with the role
(`Főszereplő`) on the left, and the **seiyuu's photo and name on the right**.
One row, two people, mirrored. Yume shows characters and staff as separate
lists.

### `Zenék`
Empty for this title, and the empty state is one muted line — then the
`Ajánlott` rail follows, so an empty tab is never a dead screen.

### Metadata expansion
`Mutass többet` reveals further rows including `Szinonimák` (`OP`,
`ONE PIECE`) and collapses with `Mutass kevesebbet ^`.

### Watch page
Player with its own controls (play, next, `00:00 / 24:38`, gear, fullscreen)
and a **cast glyph** top-right. Then two **red banners** framing the content:
- above: a Discord offer — be active for 50M XP and watch ad-free, with the
  literal command `!adfree`;
- below: report it if the wrong episode plays.

Between them the `ÉPPEN A KÖVETKEZŐT NÉZED` block and the action chips.

Red is used here as **attention**, not error — twice on one screen. Worth
deciding whether Yume follows that or keeps red for failure only.

### The per-title accent hypothesis holds
On this One Piece page every accent surface is amber: the `Lejátszás` button,
the active tab underline, the active artwork filter pill. Consistent with the
dominant-colour theory from the last batch.

### Features implied (running list, cont.)
- [ ] Relationship graph with typed, coloured, labelled edges and zoom
- [ ] Artwork gallery with category counts and resolution badges
- [ ] Character rows pairing character with voice actor
- [ ] Cast-to-device support
- [ ] Site-wide announcement banners on the watch page

---

## Batch 18 — repeats (images 86–88)

The cost-breakdown rows, total and domain grid again. Already recorded under
batch 15. No new information.
