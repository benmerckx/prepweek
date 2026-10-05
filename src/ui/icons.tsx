// Small stroke icons (16px grid, currentColor) so the UI doesn't depend on
// font glyphs that render differently per platform.

import type { SVGProps } from 'react';

const Svg = ({ children, size = 16, ...p }: SVGProps<SVGSVGElement> & { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...p}
  >
    {children}
  </svg>
);

export const ChevronLeft = () => (
  <Svg>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Svg>
);
export const ChevronRight = () => (
  <Svg>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
);
export const Undo = () => (
  <Svg>
    <path d="M5.5 3.5 2.5 6.5l3 3" />
    <path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7" />
  </Svg>
);
export const Redo = () => (
  <Svg>
    <path d="m10.5 3.5 3 3-3 3" />
    <path d="M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9" />
  </Svg>
);
export const Minus = () => (
  <Svg>
    <path d="M3.5 8h9" />
  </Svg>
);
export const Plus = () => (
  <Svg>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);
export const Search = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Svg>
);
export const People = () => (
  <Svg>
    <circle cx="6" cy="5.5" r="2.5" />
    <path d="M1.75 13.25c.5-2.3 2.1-3.5 4.25-3.5s3.75 1.2 4.25 3.5" />
    <path d="M10.75 3.1a2.4 2.4 0 0 1 0 4.8M12 9.9c1.2.5 2 1.6 2.25 3.35" />
  </Svg>
);
export const More = () => (
  <Svg strokeWidth={2.2}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </Svg>
);
export const Upload = () => (
  <Svg>
    <path d="M8 10.5V2.75M5 5.5l3-3 3 3" />
    <path d="M2.75 10v1.75c0 .8.65 1.5 1.5 1.5h7.5c.85 0 1.5-.7 1.5-1.5V10" />
  </Svg>
);
export const Close = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);
export const Check = ({ size = 16 }: { size?: number }) => (
  <Svg size={size} strokeWidth={2.2}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);
export const Calendar = () => (
  <Svg>
    <rect x="2.5" y="3.25" width="11" height="10.25" rx="2" />
    <path d="M2.5 6.5h11M5.5 1.75v2.5M10.5 1.75v2.5" />
  </Svg>
);
export const Trash = () => (
  <Svg>
    <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.6 8.5c.05.8.7 1.5 1.5 1.5h3.8c.8 0 1.45-.7 1.5-1.5l.6-8.5" />
  </Svg>
);
export const Target = () => (
  <Svg>
    <circle cx="8" cy="8" r="5.25" />
    <circle cx="8" cy="8" r="1.75" />
  </Svg>
);

/** The brand mark: a little week of blocks. */
export const Logo = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect width="24" height="24" rx="6.5" fill="var(--accent)" />
    <rect x="5" y="6.5" width="9" height="3.2" rx="1.6" fill="#fff" />
    <rect x="9" y="10.8" width="10" height="3.2" rx="1.6" fill="#fff" opacity=".8" />
    <rect x="5" y="15.1" width="6.5" height="3.2" rx="1.6" fill="#fff" opacity=".6" />
  </svg>
);

export const Paperclip = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="m13 7.25-5.4 5.4a3.25 3.25 0 0 1-4.6-4.6l5.6-5.6a2.15 2.15 0 0 1 3.05 3.05L6.1 11.05a1.07 1.07 0 0 1-1.5-1.5L9.75 4.4" />
  </Svg>
);
export const LinkIcon = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2.1-2.1a2.75 2.75 0 0 0-3.9-3.9l-.6.6" />
    <path d="M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2.1 2.1a2.75 2.75 0 0 0 3.9 3.9l.6-.6" />
  </Svg>
);
export const Flag = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3.5 14V2.5" />
    <path d="M3.5 2.75h8.25l-1.75 2.875L11.75 8.5H3.5" fill="currentColor" fillOpacity=".25" />
  </Svg>
);
export const FileIcon = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M9 1.75H4.75c-.85 0-1.5.65-1.5 1.5v9.5c0 .85.65 1.5 1.5 1.5h6.5c.85 0 1.5-.65 1.5-1.5V5.5Z" />
    <path d="M9 1.75V5.5h3.75" />
  </Svg>
);
export const ImageIcon = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
    <circle cx="5.75" cy="6.25" r="1.1" />
    <path d="m13.5 10.25-3-3-6.75 6" />
  </Svg>
);
export const Notes = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </Svg>
);
export const External = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    <path d="M11.5 9.5v2.75c0 .7-.55 1.25-1.25 1.25h-6.5c-.7 0-1.25-.55-1.25-1.25v-6.5c0-.7.55-1.25 1.25-1.25H6.5" />
  </Svg>
);
