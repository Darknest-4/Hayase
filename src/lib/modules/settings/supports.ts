const isAndroid = typeof navigator !== 'undefined' && navigator.userAgent.includes('Android')
const isIOS = typeof navigator !== 'undefined' && /applewebkit\/[\d.]+ \(khtml, like gecko\)(?!.*chrome\/)(?!.*safari\/)/i.test(navigator.userAgent)
const isIPad = typeof navigator !== 'undefined' && (
  navigator.userAgent.includes('iPad') ||
  (navigator.userAgent.includes('Macintosh') && !navigator.userAgent.includes('Chrome') && navigator.maxTouchPoints > 0)
)

export default {
  isAndroid,
  isAndroidTV: typeof navigator !== 'undefined' && navigator.userAgent.includes('AndroidTV'),
  isIOS,
  isIPad,
  isMobile: isAndroid || isIOS || isIPad,
  // @ts-expect-error yeah
  // 32 bit, <4GB of RAM, or any Android TV
  isUnderPowered: typeof navigator !== 'undefined' && (navigator.platform === 'Linux armv8l' || navigator.deviceMemory < 4 || navigator.userAgent.includes('AndroidTV'))
}
