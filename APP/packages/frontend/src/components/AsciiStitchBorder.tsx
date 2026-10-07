const flower = [
  "      x      ",
  "  x   x   x  ",
  "   xx x xx   ",
  "    xxxxx    ",
  "xxxxxx+xxxxxx",
  "    xxxxx    ",
  "   xx x xx   ",
  "  x   x   x  ",
  "      x      ",
].join("\n");

const diamond = [
  "      x      ",
  "     x x     ",
  "    x + x    ",
  "     x x     ",
  "      x      ",
].join("\n");

/** Literal ASCII thread patterns, never exposed as reading content. */
export function AsciiStitchBorder({ variant = "rule" }: { readonly variant?: "rule" | "floral" }) {
  const pattern = variant === "rule"
    ? "x xx x + x xx x   ".repeat(8)
    : [flower, diamond, flower].join("\n\n");
  return <pre className={`ascii-stitch ascii-stitch--${variant}`} aria-hidden="true">{pattern}</pre>;
}
