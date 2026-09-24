// Confirmed from the operator's camera calibration. Screen lane 1 is the
// left-most mainline lane; excluded IDs are shoulders or auxiliary lanes.
export const CAMERA_LANE_MAPPINGS = Object.freeze({
  "CCTV-N3-S-27.900-M": { mainLaneCount: 3, screenToVdLaneIds: ["0", "1", "2"] },
  "CCTV-N3-S-32.940-M": { mainLaneCount: 3, screenToVdLaneIds: ["0", "1", "2"] },
  "CCTV-N3-S-35.900-M": { mainLaneCount: 3, screenToVdLaneIds: ["0", "1", "2"] },
  "CCTV-N3-S-40.980-M": { mainLaneCount: 4, screenToVdLaneIds: ["0", "1", "2", "3"] },
  "CCTV-N3-S-46.470-M": { mainLaneCount: 4, screenToVdLaneIds: ["0", "1", "2", "3"] },
  "CCTV-N3-S-49.730-M": { mainLaneCount: 4, screenToVdLaneIds: ["0", "1", "2", "3"] },
  "CCTV-N3-S-54.400-M": { mainLaneCount: 3, screenToVdLaneIds: ["0", "1", "2"] },
  "CCTV-N3-S-60.500-M": { mainLaneCount: 4, screenToVdLaneIds: ["0", "1", "2", "3"] },
  "CCTV-N3-S-65.450-M": { mainLaneCount: 3, screenToVdLaneIds: ["0", "1", "2"], excludedVdLaneIds: ["3"], excludedReason: "shoulder" },
  "CCTV-N3-S-70.300-M": { mainLaneCount: 3, screenToVdLaneIds: ["0", "1", "2"], excludedVdLaneIds: ["3"], excludedReason: "auxiliary_lane" },
});

export function getCameraLaneMapping(cameraId) {
  const mapping = CAMERA_LANE_MAPPINGS[String(cameraId || "")];
  if (!mapping) return null;
  return {
    ...mapping,
    state: "confirmed",
    basis: "user_confirmed_visual_left_to_right",
  };
}

export function buildScreenLaneReference(lanes, mapping) {
  if (!mapping?.screenToVdLaneIds?.length) return null;
  const byVdLaneId = new Map(lanes.map((lane) => [String(lane.laneId), lane]));
  const screenLanes = mapping.screenToVdLaneIds.map((vdLaneId, index) => {
    const lane = byVdLaneId.get(vdLaneId);
    return lane ? { ...lane, displayNumber: index + 1, vdLaneId } : null;
  });

  if (screenLanes.some((lane) => !lane || !Number.isFinite(Number(lane.speedKph)))) {
    return { state: "incomplete", lanes: screenLanes.filter(Boolean) };
  }

  const scored = [...screenLanes].sort((left, right) => Number(right.speedKph) - Number(left.speedKph));
  const [best, next] = scored;
  const speedGap = Number(best.speedKph) - Number(next.speedKph);
  const flowReference = speedGap >= 5
    ? {
        state: "reference",
        bestLaneId: best.laneId,
        bestDisplayNumber: best.displayNumber,
        detail: `官方 VD 顯示第 ${best.displayNumber} 車道 ${Math.round(best.speedKph)} km/h，較下一車道快 ${Math.round(speedGap)} km/h。僅供路況參考，不構成變換車道指令。`,
      }
    : {
        state: "similar",
        detail: "官方 VD 資料顯示各主線車道速度差異未達 5 km/h，維持目前車道較合適。",
      };

  return { state: "confirmed", lanes: screenLanes, flowReference };
}
