<script lang='ts'>
  import type { PluginInfo } from 'native'

  export let plugin: PluginInfo
</script>

<div class='bg-muted px-4 py-3 rounded-md flex flex-row space-x-3 justify-between w-full'>
  <div class='flex flex-col space-y-3 flex-1 min-w-0'>
    <div class='flex flex-row space-x-3'>
      <div class='flex flex-col min-w-0'>
        <div class='flex flex-row items-center gap-1 min-w-0'>
          <div class='text-md font-bold truncate min-w-0'>{plugin.name}</div>
        </div>
        <div class='text-xs text-muted-foreground truncate'>{plugin.id}</div>
      </div>
    </div>
    <div class='text-sm text-muted-foreground line-clamp-2'>{plugin.description}</div>
    <div class='flex-wrap-balance w-full justify-start gap-2 flex text-popover-foreground text-sm'>
      <div class='rounded px-3 py-0.5 font-bold bg-accent leading-snug text-nowrap'>{plugin.version}</div>
      {#each plugin.permissions as permission, i (i)}
        <div class='rounded px-3 py-0.5 font-bold bg-accent leading-snug text-nowrap capitalize'>{permission}</div>
      {/each}
    </div>
  </div>
  <slot />
</div>
