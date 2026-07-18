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
  class={cn(className, 'overflow-visible [transform-origin:center]')}
  {...$$restProps}
>
  <g class='target-animated-icon'>
    <path d='M3 6h18' />
    <path d='M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' />
  </g>
  <path d='M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8' class='target-animated-icon' />
</svg>

<style>
  g.target-animated-icon {
    transform: translateY(-1px);
    transition: transform 0.2s ease-in;
  }
  path.target-animated-icon {
    transform: translateY(1px);
    transition: transform 0.2s ease-in;
  }
</style>
