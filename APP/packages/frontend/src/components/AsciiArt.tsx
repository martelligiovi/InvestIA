/**
 * Decorative cross-stitch motifs drawn with literal ASCII characters.
 * Sources use "." for empty cells; quadrants are mirrored so every motif stays symmetrical.
 * Rendered text is never reading content: it is always aria-hidden.
 */
export type AsciiMotif = "rosette" | "tree" | "band" | "lozenge";

const mirrorHorizontally = (rows: readonly string[]) => rows.map((row) => row + [...row].reverse().slice(1).join(""));
const mirrorVertically = (rows: readonly string[]) => [...rows, ...rows.slice(0, -1).reverse()];

const ROSETTE_QUADRANT = [
  "..........x",
  ".......x..x",
  "........x.+",
  "....x...x++",
  ".....x.x+.x",
  "..x...x+.x+",
  "...x.x+.x+x",
  "....x+.x+xo",
  ".x.x+.x+o.+",
  "..x++x+.+.x",
  "xx+.x+x+x+*",
];

const TREE_HALF = [
  ".........x",
  "........x+",
  ".....x..x+",
  "......x.x+",
  "..x....x++",
  "...x..x.+o",
  "....x.x.+x",
  ".x...xx.++",
  "..x..x..+o",
  "...xx...+x",
  "....x..x++",
  "......x.+o",
  ".....x..+x",
  "........++",
  ".......xxx",
  ".....xx+++",
];

const BAND_TILE = ["..x...", ".x+x..", "x+o+x.", ".x+x..", "..x..."];
const LOZENGE_TILE = ["...x...x...", "..x+x.x+x..", ".x+o+x+o+x.", "..x+x.x+x..", "...x...x..."];

/** Wide enough for any viewport; CSS clips the overflow. */
const REPEATS = 40;

export const ASCII_MOTIFS: Readonly<Record<AsciiMotif, readonly string[]>> = {
  rosette: mirrorVertically(mirrorHorizontally(ROSETTE_QUADRANT)),
  tree: mirrorHorizontally(TREE_HALF),
  band: BAND_TILE.map((row) => row.repeat(REPEATS)),
  lozenge: LOZENGE_TILE.map((row) => row.repeat(REPEATS)),
};

const THREAD_CLASS: Readonly<Record<string, string>> = {
  x: "ascii-art__thread",
  "+": "ascii-art__stitch",
  o: "ascii-art__knot",
  "*": "ascii-art__thread",
};

/** Groups equal-colored characters so each row renders as a few spans instead of one per cell. */
function renderRow(row: string, rowIndex: number) {
  const runs: { className: string | undefined; text: string }[] = [];
  for (const character of row) {
    const cell = character === "." ? " " : character;
    const className = THREAD_CLASS[cell];
    const last = runs.at(-1);
    if (last !== undefined && last.className === className) last.text += cell;
    else runs.push({ className, text: cell });
  }
  return runs.map((run, index) => run.className === undefined
    ? <span key={`${rowIndex}:${index}`}>{run.text}</span>
    : <span key={`${rowIndex}:${index}`} className={run.className}>{run.text}</span>);
}

export function AsciiArt({ motif, className }: { readonly motif: AsciiMotif; readonly className?: string }) {
  const rows = ASCII_MOTIFS[motif];
  return (
    <pre className={`ascii-art ascii-art--${motif}${className === undefined ? "" : ` ${className}`}`} aria-hidden="true">
      {rows.map((row, index) => (
        <span key={index} className="ascii-art__row">{renderRow(row, index)}{index < rows.length - 1 ? "\n" : ""}</span>
      ))}
    </pre>
  );
}
