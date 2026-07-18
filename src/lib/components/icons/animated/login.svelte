<script lang='ts'>
  import { cn } from '$lib/utils'

  export let color = 'currentColor'
  export let size = 24
  export let strokeWidth = 2
  let className = ''

  export { className as class }
</script>

<svg
  xmlns='http://www.w3.org/2000/svg'
  width={size}
  height={size}
  viewBox='0 0 24 24'
  fill='none'
  stroke={color}
  stroke-width={strokeWidth}
  stroke-linecap='round'
  stroke-linejoin='round'
  class={cn(className, 'overflow-visible -rotate-90')}
  {...$$restProps}
>
  <path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' />
  <g>
    <polyline points='7 10 12 15 17 10' class='target-animated-icon' />
    <line x1='12' x2='12' y1='15' y2='3' class='target-animated-icon' />
  </g>
</svg>

<style>
  .target-animated-icon {
    transform: translateY(2px);
    transition: transform 0.3s cubic-bezier(0.68, -0.6, 0.32, 1.6);
  }
</style>
