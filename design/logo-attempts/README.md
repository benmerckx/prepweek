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
| 09 | Packed + drag | 04 and 06 together: a teammate's cursor drops the last block into its slot, bottom right. The wordmark is tight, and its e's sit in front of their neighbors, cutting a thin gap out of them: in "prep" the e covers the p; in "week" the first e covers the w and the second e, which covers the k. `-logo-duo` sets "week" in indigo | Rubik ExtraBold |

The wordmarks are outlined, so the files look the same without the fonts
installed. All of these typefaces are free under the SIL Open Font License.
