import { type VariantProps, tv } from 'tailwind-variants'

import Root from './toggle.svelte'

export const toggleVariants = tv({
  base: 'hover:bg-muted hover:text-muted-foreground focus-visible:ring-ring data-[state=on]:bg-accent data-[state=on]:text-accent-foreground inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50',
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground select:bg-primary/70 shadow',
      destructive: 'bg-destructive text-destructive-foreground select:bg-destructive/90 shadow-sm',
      outline: 'border-input bg-background select:bg-accent select:text-accent-foreground border shadow-sm',
      secondary: 'bg-secondary text-secondary-foreground select:bg-secondary/70 shadow-sm',
      ghost: 'select:bg-secondary-foreground/30 select:text-accent-foreground',
      link: 'text-primary underline-offset-4 select:underline'
    },
    size: {
      default: 'h-9 px-4 py-2',
      sm: 'h-8 rounded-md px-3 text-xs',
      xs: 'h-[1.6rem] rounded-sm px-2 text-xs',
      lg: 'h-10 rounded-md px-8',
      icon: 'h-9 w-9',
      'icon-sm': 'h-[1.6rem] w-[1.6rem] rounded-sm text-xs'
    }
  },
  defaultVariants: {
    variant: 'default',
    size: 'default'
  }
})

export type Variant = VariantProps<typeof toggleVariants>['variant']
export type Size = VariantProps<typeof toggleVariants>['size']

export {
  Root,
  //
  Root as Toggle
}
