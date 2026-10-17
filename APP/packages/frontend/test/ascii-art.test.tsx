import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ASCII_MOTIFS, AsciiArt, type AsciiMotif } from "../src/components/AsciiArt";

const PRINTABLE_ASCII = /^[\x20-\x7e\n]+$/u;
const reversed = (row: string) => [...row].reverse().join("");

describe("ASCII cross-stitch motifs", () => {
  it("keeps the rosette symmetrical on both axes and the tree symmetrical left to right", () => {
    const rosette = ASCII_MOTIFS.rosette;
    expect(rosette).toHaveLength(21);
    for (const row of rosette) expect(row).toBe(reversed(row));
    expect([...rosette].reverse()).toEqual(rosette);
    for (const row of ASCII_MOTIFS.tree) expect(row).toBe(reversed(row));
  });

  it("builds every motif from rows of equal width", () => {
    for (const rows of Object.values(ASCII_MOTIFS)) {
      const widths = new Set(rows.map((row) => row.length));
      expect(widths.size).toBe(1);
    }
  });

  it.each(["rosette", "tree", "band", "lozenge"] satisfies AsciiMotif[])("renders %s as hidden, literal, whitespace-preserving ASCII", (motif) => {
    const { container } = render(<AsciiArt motif={motif} className="extra" />);
    const art = container.querySelector("pre")!;
    expect(art).toHaveAttribute("aria-hidden", "true");
    expect(art).toHaveClass("ascii-art", `ascii-art--${motif}`, "extra");
    expect(art.textContent).toMatch(PRINTABLE_ASCII);
    expect(art.textContent!.split("\n")).toEqual(ASCII_MOTIFS[motif].map((row) => row.replaceAll(".", " ")));
    expect(art.querySelector(".ascii-art__thread")).not.toBeNull();
  });
});
