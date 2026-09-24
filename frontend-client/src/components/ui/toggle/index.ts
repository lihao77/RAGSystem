import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Toggle } from "./Toggle.vue"

export const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground",
        // segment:胶囊分段控件的项;轨道/圆角由父容器 .segmented-track 提供,
        // 项只负责文字弱化与选中浮起(bg-primary)。
        segment:
          "rounded-full bg-transparent text-muted-foreground hover:bg-transparent hover:text-secondary-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-sm",
      },
      size: {
        default: "h-control-md px-2 min-w-control-md",
        sm: "h-control-compact px-1.5 min-w-control-compact",
        lg: "h-control-lg px-2.5 min-w-control-lg",
        segment: "h-control-sm px-2 min-w-0 gap-1 text-xs [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type ToggleVariants = VariantProps<typeof toggleVariants>
