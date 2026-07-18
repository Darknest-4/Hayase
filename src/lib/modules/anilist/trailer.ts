import { readable } from 'svelte/store'

const cache = new Map<string, number>()

export function minutes (videoId?: string | null) {
  return readable<number>(0, (set) => {
    if (!videoId) return
    const cached = cache.get(videoId)
    if (cached) {
      set(cached)
      return
    }

    const ctrl = new AbortController()

    const iframe = document.createElement('iframe')
    iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&autoplay=0&controls=0&disablekb=1`
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;display:none;'
    // @ts-expect-error new property
    iframe.credentialless = true
    document.body.appendChild(iframe)

    let loadtimeout: ReturnType<typeof setInterval>

    function ytMessage (e: MessageEvent) {
      if (e.origin !== 'https://www.youtube-nocookie.com') return
      clearTimeout(loadtimeout)
      try {
        const json = JSON.parse(e.data as string) as { event: string, info?: { duration?: number, videoData?: { video_id: string} } }
        if (json.event === 'initialDelivery' && typeof json.info?.duration === 'number' && json.info.videoData?.video_id === videoId) {
          cache.set(videoId!, Math.ceil(json.info.duration / 60))
          set(Math.round(json.info.duration / 60))
          ctrl.abort()
        }
      } catch {}
    }

    const timeout = setTimeout(() => ctrl.abort(), 15000)

    ctrl.signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      clearInterval(loadtimeout)
      iframe.remove()
    })

    iframe.addEventListener('load', () => {
      loadtimeout = setInterval(() => {
        iframe.contentWindow?.postMessage('{"event":"listening","id":1,"channel":"widget"}', '*')
      }, 100)
      iframe.contentWindow?.postMessage('{"event":"listening","id":1,"channel":"widget"}', '*')
    }, ctrl)

    window.addEventListener('message', ytMessage, ctrl)

    return () => ctrl.abort()
  })
}
