// Emberi státuszoldal — HTML, nem JSON.
//
// A böngésző címsorába beírt cím mögül egy `{"type":"about:blank",...}` nem
// hibaüzenet, hanem egy elrontott oldal látszata. Aki gépnek ír, az JSON-t
// kér; aki böngészővel jön, annak oldal jár.
//
// KÖZÖS RÉTEG, mert két helyről kell: a sebességkorlát 429-ese és a
// karbantartási mód 503-asa ugyanaz a helyzet — az oldal átmenetileg nem
// szolgál ki, és a nézőnek meg kell értenie, mi történik és mikor jöhet
// vissza.
//
// EGYETLEN FÁJL, KÜLSŐ KÉRÉS NÉLKÜL. Egy státuszoldal, ami stíluslapot vagy
// betűkészletet tölt le, pont akkor hasal el, amikor a kiszolgáló bajban van.
// A színek a `tokens.css` értékei, kézzel átemelve — ez az egyetlen hely, ahol
// a másolás helyes: a token a kliensé, ez a válasz a szerveré, és a kettő
// között nincs futásidejű kapcsolat.

/** A YUME sötét palettája, a `tokens.css` szerint. */
const PALETTE = {
  bg: '#0a0a0c',
  raised: '#141418',
  border: '#26262e',
  fg: '#f4f4f6',
  muted: '#a1a1ac',
  accent: '#e8a33d'
}

export interface StatusPage {
  /** HTTP-státusz. */
  status: number
  /** A nagy cím. */
  title: string
  /** Egy-két mondat, amit a látogató olvas. */
  message: string
  /** Mikor érdemes visszatérni, másodpercben. `null`, ha nem tudjuk. */
  retryAfter?: number | null
  /** A kérés azonosítója — ezt idézheti, ha ír nekünk. */
  requestId?: string | null
  /** Automatikus újrapróbálás. Alapból be, de sosem agresszívan. */
  autoRetry?: boolean
  /**
   * Háttérvideó, ha van.
   *
   * NÉMÁN, ISMÉTELVE, `playsinline`-nal — ez az egyetlen alak, amit a
   * böngészők gesztus nélkül elindítanak. Ha mégsem indul el, a poszter marad
   * ott, és az oldal ugyanúgy teljes: a videó DÍSZ, nem tartalom.
   */
  video?: { url: string, type: string, poster?: string | null } | null
}

/**
 * Kér-e a hívó HTML-t.
 *
 * A böngésző navigációja `text/html`-t kér ELŐBB, egy `fetch` általában
 * `application/json`-t vagy semmit. A `*\/*` önmagában NEM elég: azt egy
 * `curl` és minden programkönyvtár is küldi, és azoknak a JSON a helyes
 * válasz.
 */
export function wantsHtml (accept: string | undefined): boolean {
  if (typeof accept !== 'string' || !accept) return false
  const html = accept.indexOf('text/html')
  if (html === -1) return false
  const json = accept.indexOf('application/json')
  // Ha mindkettőt kéri, az nyer, amelyik ELŐRÉBB van — ez a `fetch`-el
  // küldött `application/json, text/html` esetet küldi a JSON ágra.
  return json === -1 || html < json
}

function escape (value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}

/** Másodperc → „2 perc", „1 óra 5 perc". Kerekítve, mert a másodperc itt zaj. */
export function humanDelay (seconds: number | null | undefined): string | null {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total <= 0) return null
  if (total < 60) return `${Math.ceil(total)} másodperc`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${minutes} perc`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} óra ${rest} perc` : `${hours} óra`
}

/**
 * A teljes oldal.
 *
 * Minden beágyazva: stílus, betűtípus-tartalék, logó. Egyetlen kérés, és
 * működik akkor is, ha a statikus kiszolgálás épp nem elérhető.
 */
export function renderStatusPage (page: StatusPage): string {
  const delay = humanDelay(page.retryAfter)
  const retrySeconds = Number.isFinite(Number(page.retryAfter)) && Number(page.retryAfter) > 0
    ? Math.min(3600, Math.ceil(Number(page.retryAfter)))
    : null
  const autoRetry = page.autoRetry !== false && retrySeconds !== null

  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(page.title)} — YUME</title>
<style>
  :root {
    color-scheme: dark;
    --bg: ${PALETTE.bg}; --raised: ${PALETTE.raised}; --border: ${PALETTE.border};
    --fg: ${PALETTE.fg}; --muted: ${PALETTE.muted}; --accent: ${PALETTE.accent};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100svh;
    display: grid; place-items: center;
    padding: 24px;
    background: var(--bg); color: var(--fg);
    font: 16px/1.55 'Nunito', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    text-align: center;
  }
  /* A háttérfény a YUME hangulatából, de MOZGÁS NÉLKÜL: egy hibaoldal nem
     a hely, ahol animálni kell. */
  body::before {
    content: ''; position: fixed; inset: -20%;
    background: radial-gradient(60% 50% at 50% 0%, rgba(232,163,61,.13), transparent 70%);
    pointer-events: none;
  }
  main { position: relative; max-width: 34rem; width: 100%; }
  /* A HÁTTÉRVIDEÓ nem tartalom: elsötétítve, a szöveg mögött, és a
     felolvasó elől elrejtve. Ha nem indul el, semmi nem hiányzik. */
  .bg {
    position: fixed; inset: 0; width: 100%; height: 100%;
    object-fit: cover; opacity: .22; filter: saturate(.75);
    pointer-events: none; z-index: 0;
  }
  /* Mozgásmentes módban EGYÁLTALÁN NEM jelenik meg. A 19. pont kéri, és egy
     hurokban futó háttérvideó pont az, amitől valakinek rosszul lehet. */
  @media (prefers-reduced-motion: reduce) { .bg { display: none; } }
  .logo {
    font-size: clamp(1.6rem, 6vw, 2.2rem); font-weight: 900;
    letter-spacing: .24em; margin: 0 0 28px; color: var(--fg);
  }
  h1 { font-size: clamp(1.4rem, 5vw, 2rem); margin: 0 0 12px; line-height: 1.25; }
  p { margin: 0 0 20px; color: var(--muted); }
  .card {
    background: var(--raised); border: 1px solid var(--border);
    border-radius: 16px; padding: clamp(20px, 5vw, 32px);
  }
  .when {
    display: inline-block; margin-bottom: 20px; padding: 6px 14px;
    border: 1px solid var(--border); border-radius: 999px;
    font-size: .92rem; color: var(--fg);
  }
  .when b { color: var(--accent); font-weight: 700; }
  button {
    font: inherit; font-weight: 700; cursor: pointer;
    padding: 12px 28px; min-height: 44px;
    color: #1a1206; background: var(--accent);
    border: 0; border-radius: 999px;
  }
  button:hover { filter: brightness(1.08); }
  button:focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; }
  .rid {
    margin: 22px 0 0; font-size: .78rem; color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all;
  }
  a { color: var(--accent); }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
${page.video
  ? `<video class="bg" autoplay muted loop playsinline preload="metadata" aria-hidden="true" tabindex="-1"${
      page.video.poster ? ` poster="${escape(page.video.poster)}"` : ''
    }><source src="${escape(page.video.url)}" type="${escape(page.video.type)}"></video>`
  : ''}
<main>
  <p class="logo">YUME</p>
  <div class="card">
    <h1>${escape(page.title)}</h1>
    <p>${escape(page.message)}</p>
    ${delay ? `<p class="when">Próbáld újra <b id="when">${escape(delay)}</b> múlva</p>` : ''}
    <p><button id="retry" type="button">Újratöltés</button></p>
    ${page.requestId ? `<p class="rid">Kérésazonosító: ${escape(page.requestId)}</p>` : ''}
  </div>
</main>
<script>
(function () {
  var button = document.getElementById('retry')
  button.addEventListener('click', function () { location.reload() })
  var left = ${retrySeconds === null ? 'null' : String(retrySeconds)}
  var when = document.getElementById('when')
  if (left === null) return
  /*
   * VISSZASZÁMLÁLÁS, NEM PÖRGETÉS. Egy oldal, ami másodpercenként újratölti
   * magát, pont azt a kiszolgálót veri tovább, amelyik már most sem bírja —
   * és a sebességkorlát ablakát is folyamatosan újraindítaná.
   *
   * Egyetlen automatikus újratöltés van, a megadott idő UTÁN. A gomb
   * bármikor elérhető, ha a látogató hamarabb próbálkozna.
   */
  var tick = setInterval(function () {
    left -= 1
    if (left <= 0) { clearInterval(tick); ${autoRetry ? 'location.reload()' : 'if (when) when.textContent = "most"'}; return }
    if (!when) return
    when.textContent = left < 60 ? left + ' másodperc' : Math.round(left / 60) + ' perc'
  }, 1000)
})()
</script>
</body>
</html>`
}
