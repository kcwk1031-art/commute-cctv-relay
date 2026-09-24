import assert from "node:assert/strict";
import test from "node:test";
import { buildScreenLaneReference, getCameraLaneMapping } from "../camera-lane-mapping.mjs";

const lane = (laneId, speedKph) => ({ laneId: String(laneId), speedKph, laneType: 1 });

test("uses confirmed screen left-to-right lane order for the 27K+900 camera", () => {
  const result = buildScreenLaneReference([lane(0, 26), lane(1, 44), lane(2, 35)], getCameraLaneMapping("CCTV-N3-S-27.900-M"));
  assert.equal(result.state, "confirmed");
  assert.deepEqual(result.lanes.map((item) => item.displayNumber), [1, 2, 3]);
  assert.deepEqual(result.lanes.map((item) => item.laneId), ["0", "1", "2"]);
  assert.equal(result.flowReference.bestDisplayNumber, 2);
});

test("excludes the confirmed shoulder lane from the 65K+450 camera", () => {
  const mapping = getCameraLaneMapping("CCTV-N3-S-65.450-M");
  const result = buildScreenLaneReference([lane(0, 58), lane(1, 70), lane(2, 61), lane(3, 95)], mapping);
  assert.equal(mapping.excludedReason, "shoulder");
  assert.deepEqual(result.lanes.map((item) => item.laneId), ["0", "1", "2"]);
  assert.equal(result.flowReference.bestLaneId, "1");
});
