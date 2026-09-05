/** Kleine Bausteine, die sich die Ansichten teilen. */
type P = { size?: number };

export const FileTextIcon = ({ size = 14 }: P) => (
  <svg
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.9}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </svg>
);

export const Spinner = ({ size = 13 }: P) => (
  <span
    className="inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent opacity-70"
    style={{ width: size, height: size }}
  />
);

export const BoltIcon = ({ size = 13 }: P) => (
  <svg
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
  </svg>
);

export const DownloadIcon = ({ size = 13 }: P) => (
  <svg
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
    width={size}
  >
    <path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M4 19h16" />
  </svg>
);

export const CopyIcon = ({ size = 13 }: P) => (
  <svg
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.9}
    viewBox="0 0 24 24"
    width={size}
  >
    <rect height="13" rx="2" width="13" x="8" y="8" />
    <path d="M5 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2" />
  </svg>
);
