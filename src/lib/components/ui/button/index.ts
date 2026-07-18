import { type VariantProps, tv } from 'tailwind-variants'

import Root from './button.svelte'

import type { Button as ButtonPrimitive } from 'bits-ui'

const buttonVariants = tv({
  base: 'bg-transparent focus-visible:ring-ring inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50',
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground select:bg-primary/60 shadow',
      destructive: 'bg-destructive text-destructive-foreground select:bg-destructive/90 shadow-sm',
      outline: 'border-input bg-muted select:bg-accent select:text-accent-foreground border shadow-sm',
      secondary: 'bg-secondary text-secondary-foreground select:bg-secondary/60 shadow-sm',
      ghost: 'select:bg-secondary-foreground/20 select:text-accent-foreground',
      link: 'text-primary underline-offset-4 select:underline'
    },
    size: {
      default: 'h-9 px-4 py-2',
      sm: 'h-8 rounded-md px-3 text-xs',
      xs: 'h-[1.6rem] rounded-sm px-2 text-xs',
      lg: 'h-10 rounded-md px-8',
      icon: 'size-9',
      'icon-sm': 'size-[1.6rem] rounded-sm text-xs',
      'icon-lg': '!size-12 rounded-md px-8'
    }
  },
  defaultVariants: {
    variant: 'default',
    size: 'default'
  }
})

const iconSizes = {
  xs: '0.6rem',
  sm: '0.7rem',
  default: '0.8rem',
  lg: '1.2rem',
  icon: '1rem',
  'icon-sm': '0.7rem',
  'icon-lg': '1rem'
}

type Variant = VariantProps<typeof buttonVariants>['variant']
type Size = VariantProps<typeof buttonVariants>['size']

type Props = ButtonPrimitive.Props & {
  variant?: Variant
  size?: Size
}

type Events = ButtonPrimitive.Events

export {
  Root,
  type Props,
  type Events,
  Root as Button,
  type Props as ButtonProps,
  type Events as ButtonEvents,
  buttonVariants,
  iconSizes
}
