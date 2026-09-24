import assert from "node:assert/strict";
import test from "node:test";
import { selectNearbyVd } from "../vd-selection.mjs";

const candidate = (id, distanceKm, mainLaneCount) => ({ id, distanceKm, mainLaneCount });

test("prefers a same-lane-count VD within the mainline matching radius", () => {
  const result = selectNearbyVd([
    candidate("near-one-lane", 0.08, 1),
    candidate("mainline-four-lane", 0.46, 4),
  ], { expectedMainLaneCount: 4 });
  assert.equal(result.candidate.id, "mainline-four-lane");
  assert.equal(result.mode, "lane_count_match");
});

test("retains the nearest VD when no same-lane-count candidate is available", () => {
  const result = selectNearbyVd([
    candidate("near-two-lane", 0.08, 2),
    candidate("far-four-lane", 3.4, 4),
  ], { expectedMainLaneCount: 4 });
  assert.equal(result.candidate.id, "near-two-lane");
  assert.equal(result.mode, "nearest");
});
