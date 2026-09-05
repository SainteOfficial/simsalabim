/** @type {import('tailwindcss').Config} */
export default {
  // Das Panel lebt in einem Shadow-DOM. Preflight wuerde dort auf html/body
  // zielen und ins Leere laufen - die Basiswerte setzt stattdessen .vms-app.
  corePlugins: { preflight: false },
  content: ['./extension/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: 'var(--vms-bg)',
          card: 'var(--vms-card)',
          line: 'var(--vms-line)',
          text: 'var(--vms-text)',
          dim: 'var(--vms-text-dim)',
          accent: 'var(--vms-accent)',
          crit: 'var(--vms-crit)',
          warn: 'var(--vms-warn)',
          good: 'var(--vms-good)'
        }
      }
    }
  },
  plugins: []
};
