import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 data-[active]:bg-accent data-[active]:text-accent-foreground",
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
      // 高度全部对齐 --control-height-* token（28/34/36/44）；按钮内图标尺寸由 size 变体统一：
      // 34/36 档 16(size-4)，44 档 20(size-5)；28 档分两用：icon-xs 走 14(size-3.5，密集
      // 列表行，也是 bare 变体 1em 覆盖的基准)，icon-toolbar 走 16（顶栏/工具栏，与 rw-collapse 同款）。
      // action-* 变体保留 14(size-3.5)。调用点不再各自传 :size。
      // 图标按钮用 size-[var(...)] 而非 w-/h- 组合：tailwind-merge 才能识别它与调用点
      // 传入的 size-5 等尺寸类是同一冲突组（w-control-* 命名类它不认识，会两边都保留）。
      size: {
        "default": "h-control-md px-4 py-2 [&_svg]:size-4",
        "xs": "h-control-sm rounded px-2 [&_svg]:size-4",
        "sm": "h-control-compact rounded-md px-3 text-xs [&_svg]:size-4",
        "action": "h-control-sm px-2.5 text-xs gap-1 [&_svg]:size-3.5",
        "lg": "h-control-lg rounded-md px-8 [&_svg]:size-5",
        "icon": "size-[var(--control-height-md)] [&_svg]:size-4",
        "icon-sm": "size-[var(--control-height-compact)] btn-icon-sm [&_svg]:size-4",
        "icon-xs": "size-[var(--control-height-sm)] btn-icon-xs [&_svg]:size-3.5",
        // 顶栏/工具栏图标按钮：28px 框 + 16px 图标（与运行工作台 rw-collapse 同款）
        "icon-toolbar": "size-[var(--control-height-sm)] btn-icon-xs [&_svg]:size-4",
        "icon-lg": "size-[var(--control-height-lg)] [&_svg]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>
