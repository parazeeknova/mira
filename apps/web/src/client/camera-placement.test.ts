import { describe, expect, test } from "bun:test";

import { detailCardRect, placeFloatCard, shortMiddle } from "./camera";
import type { FloatRect } from "./camera";

const layoutOf = (cardWidth: number, cardHeight: number) => ({
  cardHeight,
  cardWidth,
  chipLabel: "chip",
  chipWidth: 100,
  labelWidth: 10,
  rowHeight: 20,
  valueOffset: 30,
});

const overlaps = (a: FloatRect, b: FloatRect): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const inside = (
  rect: FloatRect,
  stage: { height: number; width: number },
  pad = 8
): boolean =>
  rect.x >= pad &&
  rect.y >= pad &&
  rect.x + rect.width <= stage.width - pad &&
  rect.y + rect.height <= stage.height - pad;

describe("detailCardRect", () => {
  test("prefers the right side of the face box", () => {
    const rect = detailCardRect(
      { height: 100, width: 100, x: 50, y: 60 },
      layoutOf(176, 58),
      800
    );
    expect(rect).toEqual({ height: 58, width: 176, x: 162, y: 60 });
  });

  test("flips to the left when the right side does not fit", () => {
    const rect = detailCardRect(
      { height: 100, width: 100, x: 650, y: 60 },
      layoutOf(176, 58),
      800
    );
    expect(rect).toEqual({ height: 58, width: 176, x: 462, y: 60 });
  });

  test("returns null when there is no detail card to draw", () => {
    expect(
      detailCardRect(
        { height: 100, width: 100, x: 50, y: 60 },
        layoutOf(0, 0),
        800
      )
    ).toBeNull();
  });
});

describe("placeFloatCard", () => {
  const stage = { height: 600, width: 800 };
  const card = { height: 120, width: 228 };
  const box: FloatRect = { height: 100, width: 100, x: 300, y: 200 };

  test("sits right of the face without covering it", () => {
    const placed = placeFloatCard(box, card, stage, null);
    expect(placed.x).toBe(410);
    expect(placed.y).toBe(200);
    expect(overlaps(placed, box)).toBe(false);
  });

  test("drops below the detail card when right-top is occupied", () => {
    const avoid: FloatRect = { height: 200, width: 176, x: 410, y: 200 };
    const placed = placeFloatCard(box, card, stage, avoid);
    expect(placed.x).toBe(410);
    expect(placed.y).toBe(410);
    expect(overlaps(placed, box)).toBe(false);
    expect(overlaps(placed, avoid)).toBe(false);
  });

  test("flips left when the face is near the right edge", () => {
    const rightBox: FloatRect = { height: 100, width: 100, x: 660, y: 200 };
    const placed = placeFloatCard(rightBox, card, stage, null);
    expect(placed.x).toBe(660 - 228 - 10);
    expect(overlaps(placed, rightBox)).toBe(false);
  });

  test("goes below a wide close-up face instead of overlapping it", () => {
    const wideBox: FloatRect = { height: 300, width: 700, x: 50, y: 100 };
    const placed = placeFloatCard(wideBox, card, stage, null);
    expect(overlaps(placed, wideBox)).toBe(false);
    expect(inside(placed, stage)).toBe(true);
  });

  test("always stays inside the stage as a last resort", () => {
    const huge: FloatRect = { height: 590, width: 790, x: 5, y: 5 };
    const placed = placeFloatCard(huge, card, stage, null);
    expect(inside(placed, stage)).toBe(true);
  });
});

describe("shortMiddle", () => {
  test("truncates long hashes in the middle", () => {
    expect(shortMiddle(`0x${"ab".repeat(32)}`)).toBe("0xabababa…babab");
  });

  test("leaves short values alone", () => {
    expect(shortMiddle("0x1234")).toBe("0x1234");
    expect(shortMiddle("prev record")).toBe("prev record");
  });
});
