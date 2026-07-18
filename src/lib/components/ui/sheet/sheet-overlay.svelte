<script lang='ts'>
  import { Dialog as SheetPrimitive } from 'bits-ui'
  import { fade } from 'svelte/transition'

  import SUPPORTS from '$lib/modules/settings/supports'
  import { cn } from '$lib/utils.js'

  type $$Props = SheetPrimitive.OverlayProps

  let className: $$Props['class'] = undefined
  export { className as class }
  export let transition: $$Props['transition'] = fade
  export let transitionConfig: $$Props['transitionConfig'] = {
    duration: 150
  }
</script>

<SheetPrimitive.Overlay
  {transition}
  {transitionConfig}
  class={cn('custom-bg absolute inset-0 z-50', !SUPPORTS.isUnderPowered && 'backdrop-blur-sm', className)}
  {...$$restProps}
/>
