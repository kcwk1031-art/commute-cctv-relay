export function selectNearbyVd(candidates, { expectedMainLaneCount = null, maxDistanceKm = 3 } = {}) {
  const ordered = [...candidates].sort((left, right) => left.distanceKm - right.distanceKm);
  if (!ordered.length) return { candidate: null, mode: "none" };

  const expected = Number(expectedMainLaneCount);
  if (Number.isInteger(expected) && expected > 0) {
    const matching = ordered.filter((candidate) => candidate.mainLaneCount === expected && candidate.distanceKm <= maxDistanceKm);
    if (matching.length) return { candidate: matching[0], mode: "lane_count_match" };
  }

  return { candidate: ordered[0], mode: "nearest" };
}
