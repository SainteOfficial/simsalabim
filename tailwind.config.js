/**
 * Die Farbtokens sind dieselben, die panel.css auf .vms-root setzt. Dadurch
 * gelten Themenwechsel für die React-Teile automatisch mit, ohne dass eine
 * zweite Palette gepflegt werden muss.
 *
 * Sie stehen als Funktion da, damit auch die Opazitäts-Schreibweise greift
 * (bg-panel-accent/12). Bei einer nackten var()-Farbe kann Tailwind keinen
 * Alphakanal einrechnen und lässt den Modifier sonst stillschweigend fallen -
 * die Fläche bleibt dann farblos. color-mix löst das; Chrome 116 ist ohnehin
 * die Untergrenze im Manifest.
 */
const token = (name) => ({ opacityValue }) =>
  opacityValue === undefined
    ? `var(${name})`
    : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  // Das Panel lebt in einem Shadow-DOM. Preflight würde dort auf html/body
  // zielen und ins Leere laufen - die Basiswerte setzt stattdessen .vms-app.
  corePlugins: { preflight: false },
  content: ['./extension/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: token('--bg'),
          soft: token('--bg-soft'),
          line: token('--border'),
          text: token('--text'),
          dim: token('--text-dim'),
          accent: token('--accent'),
          'on-accent': token('--on-accent'),
          crit: token('--crit'),
          warn: token('--warn'),
          low: token('--low'),
          good: token('--ok')
        }
      },
      transitionTimingFunction: {
        panel: 'cubic-bezier(0.22, 0.8, 0.28, 1)'
      }
    }
  },
  plugins: []
};
