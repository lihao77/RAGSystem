import { cva } from 'class-variance-authority';

export { default as Badge } from './Badge.vue';

export const badgeVariants = cva('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'text-foreground',
      success: 'border-transparent bg-success-bg text-success',
      warning: 'border-transparent bg-warning-bg text-warning',
      destructive: 'border-transparent bg-error-bg text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});
