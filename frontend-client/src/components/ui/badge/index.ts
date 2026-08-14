import { cva } from 'class-variance-authority';

export { default as Badge } from './Badge.vue';

export const badgeVariants = cva('inline-flex items-center rounded-full border px-2 py-px text-xs font-medium leading-4', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'border-border text-muted-foreground',
      success: 'border-transparent bg-success-bg text-success',
      warning: 'border-transparent bg-warning-bg text-warning',
      info: 'border-transparent bg-accent text-brand-accent',
      destructive: 'border-transparent bg-error-bg text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});
