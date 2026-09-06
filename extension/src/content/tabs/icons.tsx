/**
 * Dieselben Icons wie im DOM-Panel, als Komponenten - Pfade, Maße und
 * Strichstärken sind unverändert übernommen, damit sich am Erscheinungsbild
 * nichts ändert.
 */
type P = { size?: number };

const s = (size: number, width: number, caps = true) => ({
  viewBox: '0 0 24 24',
  width: size,
  height: size,
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: width,
  ...(caps ? { strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const } : {})
});

export const ChevronDown = ({ size = 14 }: P) => (
  <svg {...s(size, 2.2)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const CheckIcon = ({ size = 13 }: P) => (
  <svg {...s(size, 3)}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export const SearchIcon = ({ size = 14 }: P) => (
  <svg {...s(size, 2.2)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);

export const AlertIcon = ({ size = 14 }: P) => (
  <svg {...s(size, 2.1)}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none" />
  </svg>
);

export const WrenchIcon = ({ size = 14 }: P) => (
  <svg {...s(size, 2)}>
    <path d="M15.5 3.5a5 5 0 0 0-6.3 6.3L3.6 15.4a2 2 0 1 0 2.8 2.8l5.6-5.6a5 5 0 0 0 6.3-6.3l-2.9 2.9-2.1-2.1z" />
  </svg>
);

export const TagIcon = ({ size = 14 }: P) => (
  <svg {...s(size, 2)}>
    <path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z" />
    <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);

export const ExternalIcon = ({ size = 10 }: P) => (
  <svg {...s(size, 2.4)}>
    <path d="M14 5h5v5" />
    <path d="M19 5l-7.5 7.5" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </svg>
);

export const EyeIcon = ({ size = 13 }: P) => (
  <svg {...s(size, 1.9)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);

export const CalcIcon = ({ size = 14 }: P) => (
  <svg {...s(size, 1.9)}>
    <rect x="5" y="3" width="14" height="18" rx="2.5" />
    <path d="M8.5 7.5h7" />
    <path d="M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01" />
  </svg>
);

export const TireIcon = ({ size = 14 }: P) => (
  <svg {...s(size, 1.9, false)}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>
);

export const QuestionIcon = ({ size = 20 }: P) => (
  <svg {...s(size, 2.2)}>
    <path d="M9.2 9.2a2.9 2.9 0 1 1 3.9 2.7c-.8.3-1.1 1-1.1 1.8v.4" />
    <circle cx="12" cy="17.6" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const ThumbIcon = ({ size = 15 }: P) => (
  <svg {...s(size, 2)}>
    <path d="M7 10v10H4V10zM7 10l4-7a2 2 0 0 1 3 1.8V9h4.5a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.2 19H7z" />
  </svg>
);

export const StarIcon = ({ size = 14 }: P) => (
  <svg {...s(size, 1.9)}>
    <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" />
  </svg>
);

export const CheckBig = ({ size = 26 }: P) => (
  <svg {...s(size, 2)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </svg>
);

export function VerdictIcon({ name }: { name: string }) {
  if (name === 'alert') return <AlertIcon size={15} />;
  if (name === 'tag') return <TagIcon size={15} />;
  if (name === 'question') return <QuestionIcon size={15} />;
  return <ThumbIcon size={15} />;
}
