/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        'border-soft': 'hsl(var(--border-soft))',
        'border-strong': 'hsl(var(--border-strong))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          border: 'hsl(var(--sidebar-border))',
        },
        chain: {
          raw: 'hsl(var(--chain-raw))',
          'raw-tint': 'hsl(var(--chain-raw-tint))',
          production: 'hsl(var(--chain-production))',
          'production-tint': 'hsl(var(--chain-production-tint))',
          supply: 'hsl(var(--chain-supply))',
          'supply-tint': 'hsl(var(--chain-supply-tint))',
          central: 'hsl(var(--chain-central))',
          'central-tint': 'hsl(var(--chain-central-tint))',
          store: 'hsl(var(--chain-store))',
          'store-tint': 'hsl(var(--chain-store-tint))',
        },
        surface: {
          0: 'hsl(var(--surface-0))',
          1: 'hsl(var(--surface-1))',
          2: 'hsl(var(--surface-2))',
          3: 'hsl(var(--surface-3))',
          4: 'hsl(var(--surface-4))',
        },
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
      },
      borderRadius: {
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        // Card elevation — barely-there drop + 1px inner top highlight that
        // reads as a lit edge on dark surfaces.
        card: '0 1px 2px 0 rgb(0 0 0 / 0.25), inset 0 1px 0 0 hsl(var(--highlight))',
        'card-hover':
          '0 6px 16px -6px rgb(0 0 0 / 0.35), inset 0 1px 0 0 hsl(var(--highlight))',
        // Floating layers — popovers, dialogs, dropdowns.
        pop: '0 16px 40px -12px rgb(0 0 0 / 0.5), 0 0 0 1px hsl(var(--border) / 0.6)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'badge-bump': {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.1)' },
          '100%': { transform: 'scale(1)' },
        },
        // A brief attention pulse on the «Ishlarim» header when a new task
        // arrives (useInboxAlert, research Rule 4) — a soft primary-tinted
        // glow that fades out, so a frontline worker notices the count rose
        // without staring at the screen. Honours prefers-reduced-motion via
        // the global reset in index.css.
        'inbox-flash': {
          '0%': { backgroundColor: 'hsl(var(--primary) / 0.18)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'badge-bump': 'badge-bump 0.15s ease-out',
        'inbox-flash': 'inbox-flash 1.1s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
