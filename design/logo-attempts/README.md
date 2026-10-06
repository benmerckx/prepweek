# Logo attempts

Eight directions for a more colorful PrepWeek logo, drawn from the app's own
block palette (`PALETTE` in `src/data/store.ts`) and the brand indigo. Nothing
here ships: `public/icons` and the `Logo` component are unchanged.

Each concept comes as:

- `NN-name-icon.svg`: the app icon and favicon
- `NN-name-logo.svg`: mark and wordmark, for light backgrounds
- `NN-name-logo-dark.svg`: the same, for dark backgrounds
- `NN-name-mark.svg`: the mark on its own (`-mark-dark.svg` where it changes on dark)

| | Concept | Idea | Wordmark typeface |
| --- | --- | --- | --- |
| 01 | Stack | Today's mark, each block in its own color | Inter Bold, the app's font |
| 02 | Sunrise | A sun whose lower half is task blocks, one nudged along | Bricolage Grotesque |
| 03 | P block | A P made of two overlapping blocks | Plus Jakarta Sans ExtraBold |
| 04 | Packed | A week packed into lanes, the last block dropping in | Sora Bold |
| 05 | Zigzag W | A W of four see-through blocks | Gabarito ExtraBold |
| 06 | Drag | A block picked up by a teammate's cursor | Rubik Bold |
| 07 | Happy week | A calendar page that's pleased with its week | Nunito Black |
| 08 | Name blocks | The name itself as two blocks; one logo for both backgrounds | Outfit Bold |
| 09 | Packed + drag | 04 and 06 together: a teammate's cursor drops the last block into its slot, bottom right. `-logo-duo` sets "Week" in indigo | Rubik ExtraBold |
| 10 | Drop | Where 09 led: three blocks, the empty slot striped like the app's block pattern, and the block lifted clear of it by a teammate's cursor | Rubik ExtraBold |

The wordmarks are outlined, so the files look the same without the fonts
installed. All of these typefaces are free under the SIL Open Font License.

## From 09 to 10

`exploration/` holds the steps in between:

- `reduce-N-*`: 09 with N blocks, from 6 down to 2, in color and in black
- `direction-*`: six styles on the three-block mark (blocks, pills, outline,
  clean, stripes, still), each in color, color on dark, black and white

10 is the one-color-ready version: wherever shapes overlap, the one in front
cuts a gap out of the one behind instead of having a white outline, so the
black and white files are the same drawing in one color. Its colors are the
brand indigo and the app's current block palette (cyan `#0fc2d8`, orange
`#ff7b1c`, hot pink `#f72585`); 01–09 and `exploration/` keep the palette from
before. Its files:

- `-mark`, `-mark-dark` (gray stripes lightened for dark backgrounds),
  `-mark-black`, `-mark-white`, and `-mark-orange-stripes`, an alternative
  with the slot striped in the lifted block's orange
- `-icon` (on the dark tile), `-icon-light`, `-icon-black`, `-icon-white`
- `-favicon`: no cursor, which turns into a speck at 16 px
- `-logo`, `-logo-dark`, `-logo-black`, `-logo-white`
- `-construction`: the 64-unit grid, the lanes, the slot and the lifted
  block's pivot
