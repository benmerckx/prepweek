// Inter for text, Nunito for titles (both SIL OFL, licenses in public/fonts),
// Latin subsets only. Registered at runtime rather than via @font-face in CSS
// so the bundler doesn't inline ~200 KB of base64 into the stylesheet; the
// files are served from /fonts with long-lived caching and load only when
// glyphs need them.

const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT =
  'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

const faces = [
  { family: 'Inter Variable', file: 'inter-latin-wght-normal.woff2', weight: '100 900', range: LATIN },
  { family: 'Inter Variable', file: 'inter-latin-ext-wght-normal.woff2', weight: '100 900', range: LATIN_EXT },
  { family: 'Nunito Variable', file: 'nunito-latin-wght-normal.woff2', weight: '200 1000', range: LATIN },
  { family: 'Nunito Variable', file: 'nunito-latin-ext-wght-normal.woff2', weight: '200 1000', range: LATIN_EXT },
];

export const loadFonts = () => {
  if (!('fonts' in document) || typeof FontFace === 'undefined') return;
  for (const f of faces) {
    const face = new FontFace(f.family, `url(/fonts/${f.file}) format('woff2')`, {
      weight: f.weight,
      style: 'normal',
      display: 'swap',
      unicodeRange: f.range,
    });
    document.fonts.add(face);
  }
};
