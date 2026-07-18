import { redirect } from '@sveltejs/kit'

import { extensionInstalURL } from '$lib/components/ui/extensions/ExtensionInstallPrompt.svelte'
import { sanitizeExtensionUrl } from '$lib/modules/extensions/storage'

export function load ({ params, url }) {
  const installUrl = sanitizeExtensionUrl(url.searchParams.get('url') ?? params.url ?? '')

  extensionInstalURL.set(installUrl)

  return redirect(307, '/')
}
