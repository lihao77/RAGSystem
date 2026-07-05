import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  // 项目主题逻辑：:root 默认 dark，[data-theme="light"] 为 light
  // dark: 变体在「非 light」时触发（即 dark 默认生效）
  darkMode: ['selector', ':root:not([data-theme="light"])'],
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        // shadcn 语义别名（指向现有 Linear token，dark/light 切换由 :root 控制）
        border: 'var(--color-border)',
        input: 'var(--color-border)',
        ring: 'var(--color-brand-accent)',
        background: 'var(--color-bg-primary)',
        foreground: 'var(--color-text-primary)',
        primary: {
          DEFAULT: 'var(--color-brand-accent)',
          foreground: 'var(--color-on-accent)',
        },
        secondary: {
          DEFAULT: 'var(--color-bg-secondary)',
          foreground: 'var(--color-text-primary)',
        },
        destructive: {
          DEFAULT: 'var(--color-error)',
          foreground: 'var(--color-on-color)',
        },
        muted: {
          DEFAULT: 'var(--color-bg-tertiary)',
          foreground: 'var(--color-text-muted)',
        },
        accent: {
          DEFAULT: 'var(--color-active-bg)',
          foreground: 'var(--color-text-primary)',
        },
        popover: {
          DEFAULT: 'var(--color-bg-elevated)',
          foreground: 'var(--color-text-primary)',
        },
        card: {
          DEFAULT: 'var(--color-bg-secondary)',
          foreground: 'var(--color-text-primary)',
        },
        // 现有 Linear token 直映射（新组件可直接 bg-brand-accent / text-text-primary 等）
        'brand-accent': 'var(--color-brand-accent)',
        'brand-accent-light': 'var(--color-brand-accent-light)',
        'bg-app': 'var(--color-bg-app)',
        'bg-primary': 'var(--color-bg-primary)',
        'bg-secondary': 'var(--color-bg-secondary)',
        'bg-tertiary': 'var(--color-bg-tertiary)',
        'bg-elevated': 'var(--color-bg-elevated)',
        'text-primary': 'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
        'text-muted': 'var(--color-text-muted)',
        'on-accent': 'var(--color-on-accent)',
        'on-color': 'var(--color-on-color)',
        'hover-overlay': 'var(--color-hover-overlay)',
        'hover-overlay-md': 'var(--color-hover-overlay-md)',
        success: {
          DEFAULT: 'var(--color-success)',
          foreground: 'var(--color-on-color)',
          bg: 'var(--color-success-bg)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
          foreground: 'var(--color-on-color)',
          bg: 'var(--color-warning-bg)',
        },
        error: {
          DEFAULT: 'var(--color-error)',
          bg: 'var(--color-error-bg)',
        },
        danger: 'var(--color-danger)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        full: 'var(--radius-full)',
        control: 'var(--control-radius)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        xs: ['var(--font-size-xs)', { lineHeight: '1.4' }],
        sm: ['var(--font-size-sm)', { lineHeight: '1.5' }],
        base: ['var(--font-size-base)', { lineHeight: '1.6' }],
        md: ['var(--font-size-md)', { lineHeight: '1.5' }],
        lg: ['var(--font-size-lg)', { lineHeight: '1.5' }],
        xl: ['var(--font-size-xl)', { lineHeight: '1.4' }],
        '2xl': ['var(--font-size-2xl)', { lineHeight: '1.3' }],
        '3xl': ['var(--font-size-3xl)', { lineHeight: '1.2' }],
        '4xl': ['var(--font-size-4xl)', { lineHeight: '1.1' }],
      },
      height: {
        'control-sm': 'var(--control-height-sm)',
        'control-compact': 'var(--control-height-compact)',
        'control-md': 'var(--control-height-md)',
        'control-lg': 'var(--control-height-lg)',
        'icon-sm': 'var(--icon-button-size-sm)',
        'icon-md': 'var(--icon-button-size-md)',
      },
      width: {
        'icon-sm': 'var(--icon-button-size-sm)',
        'icon-md': 'var(--icon-button-size-md)',
      },
      zIndex: {
        base: 'var(--z-base)',
        sticky: 'var(--z-sticky)',
        sidebar: 'var(--z-sidebar)',
        floating: 'var(--z-floating)',
        dropdown: 'var(--z-dropdown)',
        overlay: 'var(--z-overlay)',
        modal: 'var(--z-modal)',
        toast: 'var(--z-toast)',
        dialog: 'var(--z-dialog)',
      },
      transitionDuration: {
        instant: 'var(--duration-instant)',
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
        stage: 'var(--duration-stage)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        elevated: 'var(--shadow-elevated)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--reka-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--reka-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
