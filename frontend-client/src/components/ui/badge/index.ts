import { cva } from 'class-variance-authority';

export { default as Badge } from './Badge.vue';

export const badgeVariants = cva('inline-flex items-center rounded-full border px-2 py-px text-xs font-medium leading-4', {
  variants: {
    variant: {
      default: 'border-transparent bg-hover-overlay-md text-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'border-border text-muted-foreground',
      success: 'border-transparent bg-success-bg text-success',
      warning: 'border-transparent bg-warning-bg text-warning',
      // accent 在本主题是中性灰阶,文字必须用 accent-foreground(主文本色)才能保证对比度
      info: 'border-border bg-accent text-accent-foreground',
      destructive: 'border-transparent bg-error-bg text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});
