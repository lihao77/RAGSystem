import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 data-[active]:bg-accent data-[active]:text-accent-foreground",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-[var(--shadow-glow)] transition-[box-shadow,background-color]",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        success:
          "bg-success text-success-foreground hover:bg-success/90",
        warning:
          "bg-warning text-warning-foreground hover:bg-warning/90",
        outline:
          "border border-input bg-transparent hover:bg-hover-overlay hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-hover-overlay hover:text-accent-foreground",
        // bare:无 hover 背景的纯文字/图标按钮(折叠头、行内触发器);
        // 仍走 Button 以保留图标尺寸管控(行内图标=1em 跟字号),避免裸换原生 button 图标失控。
        bare: "rounded-none bg-transparent hover:bg-transparent text-muted-foreground [&_svg]:size-[1em]",
        link: "text-primary underline-offset-4 hover:underline",
        "action-neutral": "[&_svg]:size-3.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        "action-success": "[&_svg]:size-3.5 text-muted-foreground hover:bg-success-bg hover:text-success",
        "action-warning": "[&_svg]:size-3.5 text-muted-foreground hover:bg-warning-bg hover:text-warning",
        "action-danger": "[&_svg]:size-3.5 text-muted-foreground hover:bg-error-bg hover:text-destructive",
      },
      size: {
        "default": "h-9 px-4 py-2",
        "xs": "h-7 rounded px-2",
        "sm": "h-8 rounded-md px-3 text-xs",
        "action": "h-7 px-2.5 text-xs gap-1",
        "lg": "h-10 rounded-md px-8",
        "icon": "h-9 w-9",
        "icon-sm": "size-8 btn-icon-sm",
        "icon-xs": "size-7 btn-icon-xs",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>
