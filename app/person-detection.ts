export type PersonPosePoint = {
  x: number;
  y: number;
  visibility?: number;
};

export type PersonBoundingBox = {
  originX: number;
  originY: number;
  width: number;
  height: number;
};

export type ObjectDetectionLike = {
  categoryName: string;
  score: number;
  boundingBox?: PersonBoundingBox;
};

export type PosePersonCandidate = {
  poseIndex: number;
  pose: readonly PersonPosePoint[];
  box: PersonBoundingBox;
  quality: number;
};

export type PoseHumanEvidence = {
  isPlausible: boolean;
  isStrong: boolean;
  visibleLandmarks: number;
  headLandmarks: number;
  completeArms: number;
  completeLegs: number;
  torsoScale: number;
  score: number;
};

export type ConfirmedPersonPoseInput = {
  poses: readonly (readonly PersonPosePoint[])[];
  objects: readonly ObjectDetectionLike[];
  faces: readonly ObjectDetectionLike[];
  frameWidth: number;
  frameHeight: number;
  minObjectScore?: number;
  minFaceScore?: number;
};

export type ConfirmedPersonPoseCandidate = PosePersonCandidate & {
  humanEvidence: PoseHumanEvidence;
  confirmedByObject: boolean;
  confirmedByFace: boolean;
  strongPoseOnly: boolean;
};

export type ObjectPersonCandidate = {
  detectionIndex: number;
  detection: ObjectDetectionLike;
  box: PersonBoundingBox;
  score: number;
};

export type UniquePersonRegion = {
  box: PersonBoundingBox;
  poseIndexes: number[];
  objectDetectionIndexes: number[];
  poseQuality: number | null;
  objectScore: number | null;
};

export type UniquePeopleResult = {
  people: UniquePersonRegion[];
  currentPeople: number;
  poses: PosePersonCandidate[];
  currentObjects: ObjectPersonCandidate[];
};

export type PersonCountTrack = {
  count: number;
  confirmedAt: number;
};

export type PersonCountTrackUpdate = {
  currentCount: number;
  objectUpdated: boolean;
  now: number;
  holdMs: number;
};

export type PoseDeduplicationOptions = {
  minPointVisibility?: number;
  minVisiblePoints?: number;
  duplicateIouThreshold?: number;
  duplicateCenterDistanceRatio?: number;
  duplicateLandmarkDistanceRatio?: number;
};

export type ObjectNmsOptions = {
  minScore?: number;
  iouThreshold?: number;
};

export type FusePersonDetectionsInput = {
  poses: readonly (readonly PersonPosePoint[])[];
  objects: readonly ObjectDetectionLike[];
  objectUpdated: boolean;
  frameWidth: number;
  frameHeight: number;
  poseOptions?: PoseDeduplicationOptions;
  objectOptions?: ObjectNmsOptions;
};

const DEFAULT_MIN_POINT_VISIBILITY = 0.45;
const DEFAULT_MIN_VISIBLE_POINTS = 6;
const EXPECTED_POSE_LANDMARKS = 33;
const CORE_POSE_LANDMARKS = [0, 7, 8, 11, 12, 23, 24, 25, 26, 27, 28];
const TORSO_LANDMARKS = [11, 12, 23, 24] as const;
const HEAD_LANDMARKS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const LEFT_ARM = [11, 13, 15] as const;
const RIGHT_ARM = [12, 14, 16] as const;
const LEFT_LEG = [23, 25, 27] as const;
const RIGHT_LEG = [24, 26, 28] as const;
const OPERATOR_POINT_VISIBILITY = 0.55;
const OPERATOR_CORE_VISIBILITY = 0.62;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pointIsFinite(point: PersonPosePoint | undefined) {
  return Boolean(
    point && Number.isFinite(point.x) && Number.isFinite(point.y),
  );
}

function pointIsVisible(
  point: PersonPosePoint | undefined,
  minVisibility: number,
) {
  return Boolean(
    pointIsFinite(point) &&
      (point?.visibility ?? 1) >= minVisibility &&
      point!.x >= 0 &&
      point!.x <= 1 &&
      point!.y >= 0 &&
      point!.y <= 1,
  );
}

function boxIsUsable(
  box: PersonBoundingBox | undefined,
  frameWidth: number,
  frameHeight: number,
) {
  if (!box || frameWidth <= 0 || frameHeight <= 0) return false;
  return (
    [box.originX, box.originY, box.width, box.height].every(Number.isFinite) &&
    box.width >= 4 &&
    box.height >= 4 &&
    box.originX < frameWidth &&
    box.originY < frameHeight &&
    box.originX + box.width > 0 &&
    box.originY + box.height > 0
  );
}

function clippedBox(
  box: PersonBoundingBox,
  frameWidth: number,
  frameHeight: number,
): PersonBoundingBox {
  const left = clamp(box.originX, 0, frameWidth);
  const top = clamp(box.originY, 0, frameHeight);
  const right = clamp(box.originX + box.width, 0, frameWidth);
  const bottom = clamp(box.originY + box.height, 0, frameHeight);
  return {
    originX: left,
    originY: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function boxArea(box: PersonBoundingBox) {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function intersectionArea(
  first: PersonBoundingBox,
  second: PersonBoundingBox,
) {
  const left = Math.max(first.originX, second.originX);
  const top = Math.max(first.originY, second.originY);
  const right = Math.min(
    first.originX + first.width,
    second.originX + second.width,
  );
  const bottom = Math.min(
    first.originY + first.height,
    second.originY + second.height,
  );
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export function personBoxIou(
  first: PersonBoundingBox,
  second: PersonBoundingBox,
) {
  const intersection = intersectionArea(first, second);
  const union = boxArea(first) + boxArea(second) - intersection;
  return union > 0 ? intersection / union : 0;
}

function boxContainment(
  first: PersonBoundingBox,
  second: PersonBoundingBox,
) {
  const smallerArea = Math.min(boxArea(first), boxArea(second));
  return smallerArea > 0
    ? intersectionArea(first, second) / smallerArea
    : 0;
}

function boxCenter(box: PersonBoundingBox) {
  return {
    x: box.originX + box.width / 2,
    y: box.originY + box.height / 2,
  };
}

function boxDiagonal(box: PersonBoundingBox) {
  return Math.hypot(box.width, box.height);
}

function pixelDistance(
  first: PersonPosePoint,
  second: PersonPosePoint,
  frameWidth: number,
  frameHeight: number,
) {
  return Math.hypot(
    (first.x - second.x) * frameWidth,
    (first.y - second.y) * frameHeight,
  );
}

function chainIsPlausible(
  pose: readonly PersonPosePoint[],
  indexes: readonly number[],
  torsoLength: number,
  frameWidth: number,
  frameHeight: number,
) {
  if (
    torsoLength <= 0 ||
    !indexes.every((index) =>
      pointIsVisible(pose[index], OPERATOR_POINT_VISIBILITY),
    )
  ) {
    return false;
  }

  const firstSegment = pixelDistance(
    pose[indexes[0]],
    pose[indexes[1]],
    frameWidth,
    frameHeight,
  );
  const secondSegment = pixelDistance(
    pose[indexes[1]],
    pose[indexes[2]],
    frameWidth,
    frameHeight,
  );
  const firstRatio = firstSegment / torsoLength;
  const secondRatio = secondSegment / torsoLength;
  const segmentBalance =
    Math.max(firstSegment, secondSegment) /
    Math.max(1, Math.min(firstSegment, secondSegment));
  return (
    firstRatio >= 0.18 &&
    firstRatio <= 2.8 &&
    secondRatio >= 0.18 &&
    secondRatio <= 2.8 &&
    segmentBalance <= 3.2
  );
}

function pairAlignment(
  pose: readonly PersonPosePoint[],
  firstPair: readonly [number, number],
  secondPair: readonly [number, number],
  frameWidth: number,
  frameHeight: number,
) {
  if (
    ![...firstPair, ...secondPair].every((index) =>
      pointIsVisible(pose[index], OPERATOR_POINT_VISIBILITY),
    )
  ) {
    return 1;
  }
  const firstX = (pose[firstPair[1]].x - pose[firstPair[0]].x) * frameWidth;
  const firstY = (pose[firstPair[1]].y - pose[firstPair[0]].y) * frameHeight;
  const secondX = (pose[secondPair[1]].x - pose[secondPair[0]].x) * frameWidth;
  const secondY = (pose[secondPair[1]].y - pose[secondPair[0]].y) * frameHeight;
  const denominator =
    Math.hypot(firstX, firstY) * Math.hypot(secondX, secondY);
  return denominator > 0
    ? (firstX * secondX + firstY * secondY) / denominator
    : -1;
}

function centerDistanceRatio(
  first: PersonBoundingBox,
  second: PersonBoundingBox,
) {
  const firstCenter = boxCenter(first);
  const secondCenter = boxCenter(second);
  const referenceDiagonal = Math.max(
    1,
    Math.min(boxDiagonal(first), boxDiagonal(second)),
  );
  return (
    Math.hypot(
      firstCenter.x - secondCenter.x,
      firstCenter.y - secondCenter.y,
    ) / referenceDiagonal
  );
}

function unionBox(
  first: PersonBoundingBox,
  second: PersonBoundingBox,
): PersonBoundingBox {
  const left = Math.min(first.originX, second.originX);
  const top = Math.min(first.originY, second.originY);
  const right = Math.max(
    first.originX + first.width,
    second.originX + second.width,
  );
  const bottom = Math.max(
    first.originY + first.height,
    second.originY + second.height,
  );
  return {
    originX: left,
    originY: top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Produces a 0..1 pose quality score from landmark coverage, visibility, and
 * coverage of core face/torso/leg landmarks. It is a ranking signal, not a
 * probability that the subject is a person.
 */
export function calculatePoseQuality(
  pose: readonly PersonPosePoint[],
  minPointVisibility = DEFAULT_MIN_POINT_VISIBILITY,
) {
  if (pose.length === 0) return 0;

  const finitePoints = pose.filter(pointIsFinite);
  if (finitePoints.length === 0) return 0;

  const visiblePoints = finitePoints.filter(
    (point) =>
      (point.visibility ?? 1) >= minPointVisibility &&
      point.x >= 0 &&
      point.x <= 1 &&
      point.y >= 0 &&
      point.y <= 1,
  );
  const visibility =
    finitePoints.reduce(
      (sum, point) => sum + clamp(point.visibility ?? 1, 0, 1),
      0,
    ) / finitePoints.length;
  const expectedLandmarks = Math.max(
    1,
    Math.min(EXPECTED_POSE_LANDMARKS, pose.length),
  );
  const coverage = clamp(visiblePoints.length / expectedLandmarks, 0, 1);
  const coreCoverage =
    CORE_POSE_LANDMARKS.filter((index) =>
      pointIsVisible(pose[index], minPointVisibility),
    ).length / CORE_POSE_LANDMARKS.length;

  return clamp(visibility * 0.45 + coverage * 0.35 + coreCoverage * 0.2, 0, 1);
}

export function calculatePoseBodyBox(
  pose: readonly PersonPosePoint[],
  frameWidth: number,
  frameHeight: number,
  options: Pick<
    PoseDeduplicationOptions,
    "minPointVisibility" | "minVisiblePoints"
  > = {},
): PersonBoundingBox | null {
  if (frameWidth <= 0 || frameHeight <= 0) return null;
  const minVisibility =
    options.minPointVisibility ?? DEFAULT_MIN_POINT_VISIBILITY;
  const minVisiblePoints =
    options.minVisiblePoints ?? DEFAULT_MIN_VISIBLE_POINTS;
  const visiblePoints = pose.filter((point) =>
    pointIsVisible(point, minVisibility),
  );
  if (visiblePoints.length < minVisiblePoints) return null;

  const xs = visiblePoints.map((point) => point.x * frameWidth);
  const ys = visiblePoints.map((point) => point.y * frameHeight);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const box = {
    originX: left,
    originY: top,
    width: Math.max(4, Math.max(...xs) - left),
    height: Math.max(4, Math.max(...ys) - top),
  };
  return boxIsUsable(box, frameWidth, frameHeight)
    ? clippedBox(box, frameWidth, frameHeight)
    : null;
}

/**
 * Estimates a deliberately generous head mask from the torso direction when
 * direct face landmarks are unavailable. Returns null instead of guessing when
 * both shoulders and hips are not reliable.
 */
export function calculatePoseHeadFallbackBox(
  pose: readonly PersonPosePoint[],
  frameWidth: number,
  frameHeight: number,
): PersonBoundingBox | null {
  if (frameWidth <= 0 || frameHeight <= 0) return null;
  if (![11, 12, 23, 24].every((index) => pointIsVisible(pose[index], 0.5))) {
    return null;
  }

  const leftShoulder = pose[11];
  const rightShoulder = pose[12];
  const leftHip = pose[23];
  const rightHip = pose[24];
  const shoulder = {
    x: ((leftShoulder.x + rightShoulder.x) / 2) * frameWidth,
    y: ((leftShoulder.y + rightShoulder.y) / 2) * frameHeight,
  };
  const hip = {
    x: ((leftHip.x + rightHip.x) / 2) * frameWidth,
    y: ((leftHip.y + rightHip.y) / 2) * frameHeight,
  };
  const directionX = shoulder.x - hip.x;
  const directionY = shoulder.y - hip.y;
  const torsoLength = Math.hypot(directionX, directionY);
  if (torsoLength < Math.min(frameWidth, frameHeight) * 0.045) return null;

  const shoulderSpan = Math.hypot(
    (leftShoulder.x - rightShoulder.x) * frameWidth,
    (leftShoulder.y - rightShoulder.y) * frameHeight,
  );
  const offset = Math.max(torsoLength * 0.36, shoulderSpan * 0.28);
  const centerX = shoulder.x + (directionX / torsoLength) * offset;
  const centerY = shoulder.y + (directionY / torsoLength) * offset;
  const size = clamp(
    Math.max(42, torsoLength * 0.5, shoulderSpan * 0.92),
    42,
    Math.min(frameWidth, frameHeight) * 0.32,
  );
  const box = clippedBox(
    {
      originX: centerX - size / 2,
      originY: centerY - size / 2,
      width: size,
      height: size,
    },
    frameWidth,
    frameHeight,
  );
  return boxIsUsable(box, frameWidth, frameHeight) ? box : null;
}

/**
 * Checks whether a pose has enough mutually consistent anatomy to be shown to
 * an operator. MediaPipe intentionally returns a best-effort skeleton even on
 * some textured objects, so landmark visibility alone is not human evidence.
 */
export function analyzePoseHumanEvidence(
  pose: readonly PersonPosePoint[],
  frameWidth: number,
  frameHeight: number,
): PoseHumanEvidence {
  const empty: PoseHumanEvidence = {
    isPlausible: false,
    isStrong: false,
    visibleLandmarks: 0,
    headLandmarks: 0,
    completeArms: 0,
    completeLegs: 0,
    torsoScale: 0,
    score: 0,
  };
  if (frameWidth <= 0 || frameHeight <= 0 || pose.length < 29) return empty;

  const visibleIndexes = pose
    .map((point, index) =>
      pointIsVisible(point, OPERATOR_POINT_VISIBILITY) ? index : -1,
    )
    .filter((index) => index >= 0);
  const visibleLandmarks = visibleIndexes.length;
  const headLandmarks = HEAD_LANDMARKS.filter((index) =>
    pointIsVisible(pose[index], OPERATOR_POINT_VISIBILITY),
  ).length;
  const hasReliableTorso = TORSO_LANDMARKS.every((index) =>
    pointIsVisible(pose[index], OPERATOR_CORE_VISIBILITY),
  );
  if (!hasReliableTorso) {
    return { ...empty, visibleLandmarks, headLandmarks };
  }

  const leftShoulder = pose[11];
  const rightShoulder = pose[12];
  const leftHip = pose[23];
  const rightHip = pose[24];
  const shoulder = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const hip = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };
  const torsoLength = Math.hypot(
    (shoulder.x - hip.x) * frameWidth,
    (shoulder.y - hip.y) * frameHeight,
  );
  const torsoScale = torsoLength / Math.min(frameWidth, frameHeight);
  const shoulderSpan = pixelDistance(
    leftShoulder,
    rightShoulder,
    frameWidth,
    frameHeight,
  );
  const hipSpan = pixelDistance(
    leftHip,
    rightHip,
    frameWidth,
    frameHeight,
  );
  const shoulderRatio = shoulderSpan / Math.max(1, torsoLength);
  const hipRatio = hipSpan / Math.max(1, torsoLength);
  const torsoSideBalance =
    Math.max(
      pixelDistance(
        leftShoulder,
        leftHip,
        frameWidth,
        frameHeight,
      ),
      pixelDistance(
        rightShoulder,
        rightHip,
        frameWidth,
        frameHeight,
      ),
    ) /
    Math.max(
      1,
      Math.min(
        pixelDistance(
          leftShoulder,
          leftHip,
          frameWidth,
          frameHeight,
        ),
        pixelDistance(
          rightShoulder,
          rightHip,
          frameWidth,
          frameHeight,
        ),
      ),
    );

  const armChains = [LEFT_ARM, RIGHT_ARM].filter((chain) =>
    chainIsPlausible(
      pose,
      chain,
      torsoLength,
      frameWidth,
      frameHeight,
    ),
  ).length;
  const legChains = [LEFT_LEG, RIGHT_LEG].filter((chain) =>
    chainIsPlausible(
      pose,
      chain,
      torsoLength,
      frameWidth,
      frameHeight,
    ),
  ).length;
  const hasLowerEvidenceOnBothSides = [LEFT_LEG, RIGHT_LEG].every((chain) =>
    chain.slice(1).some((index) =>
      pointIsVisible(pose[index], OPERATOR_POINT_VISIBILITY),
    ),
  );
  const pairGeometryIsConsistent =
    pairAlignment(pose, [11, 12], [23, 24], frameWidth, frameHeight) > -0.1 &&
    pairAlignment(pose, [11, 12], [25, 26], frameWidth, frameHeight) > -0.2 &&
    pairAlignment(pose, [11, 12], [27, 28], frameWidth, frameHeight) > -0.2;
  const ratiosArePlausible =
    torsoScale >= 0.045 &&
    torsoScale <= 0.85 &&
    shoulderRatio >= 0.1 &&
    shoulderRatio <= 2.1 &&
    hipRatio >= 0.08 &&
    hipRatio <= 1.9 &&
    torsoSideBalance <= 3.2;
  const isPlausible =
    visibleLandmarks >= 8 &&
    legChains >= 1 &&
    ratiosArePlausible &&
    pairGeometryIsConsistent;

  const visibleAverage =
    visibleIndexes.reduce(
      (sum, index) => sum + clamp(pose[index].visibility ?? 1, 0, 1),
      0,
    ) / Math.max(1, visibleLandmarks);
  const limbCoverage = clamp((armChains + legChains) / 4, 0, 1);
  const score = clamp(
    visibleAverage * 0.3 +
      clamp(visibleLandmarks / 18, 0, 1) * 0.25 +
      limbCoverage * 0.25 +
      clamp(headLandmarks / 4, 0, 1) * 0.12 +
      (pairGeometryIsConsistent ? 0.08 : 0),
    0,
    1,
  );
  const hasStrongBodyCoverage =
    (headLandmarks >= 2 && armChains >= 1 && legChains >= 1) ||
    (armChains === 2 && legChains === 2);
  const isStrong =
    isPlausible &&
    visibleLandmarks >= 12 &&
    hasLowerEvidenceOnBothSides &&
    hasStrongBodyCoverage &&
    score >= 0.7;

  return {
    isPlausible,
    isStrong,
    visibleLandmarks,
    headLandmarks,
    completeArms: armChains,
    completeLegs: legChains,
    torsoScale,
    score,
  };
}

function faceMatchesPoseHead(
  pose: readonly PersonPosePoint[],
  faceBox: PersonBoundingBox,
  frameWidth: number,
  frameHeight: number,
) {
  const headBox = calculatePoseHeadFallbackBox(
    pose,
    frameWidth,
    frameHeight,
  );
  if (!headBox) return false;
  return (
    boxContainment(faceBox, headBox) >= 0.35 ||
    (personBoxIou(faceBox, headBox) >= 0.08 &&
      centerDistanceRatio(faceBox, headBox) <= 0.65)
  );
}

/**
 * Returns only poses suitable for counts, red overlays, and fall decisions.
 * Privacy masking deliberately continues to use the broader raw pose set.
 */
export function selectConfirmedPersonPoses(
  input: ConfirmedPersonPoseInput,
): ConfirmedPersonPoseCandidate[] {
  const candidates = deduplicatePoseDetections(
    input.poses,
    input.frameWidth,
    input.frameHeight,
  );
  const objectPeople = nonMaximumSuppressObjectPeople(
    input.objects,
    input.frameWidth,
    input.frameHeight,
    { minScore: input.minObjectScore ?? 0.62 },
  );
  const faceBoxes = input.faces
    .filter(
      (face) =>
        Number.isFinite(face.score) &&
        face.score >= (input.minFaceScore ?? 0.65) &&
        boxIsUsable(face.boundingBox, input.frameWidth, input.frameHeight),
    )
    .map((face) =>
      clippedBox(face.boundingBox!, input.frameWidth, input.frameHeight),
    );

  return candidates.flatMap((candidate) => {
    const evidence = analyzePoseHumanEvidence(
      candidate.pose,
      input.frameWidth,
      input.frameHeight,
    );
    const hasObjectEvidence = objectPeople.some(
      (object) => poseObjectMatchScore(candidate.box, object.box) !== null,
    );
    const hasFaceEvidence = faceBoxes.some((faceBox) =>
      faceMatchesPoseHead(
        candidate.pose,
        faceBox,
        input.frameWidth,
        input.frameHeight,
      ),
    );
    const hasCorroboratingEvidence = hasObjectEvidence || hasFaceEvidence;
    if (
      !evidence.isStrong &&
      !(evidence.isPlausible && hasCorroboratingEvidence)
    ) {
      return [];
    }
    return [
      {
        ...candidate,
        humanEvidence: evidence,
        confirmedByObject: hasObjectEvidence,
        confirmedByFace: hasFaceEvidence,
        strongPoseOnly: evidence.isStrong && !hasCorroboratingEvidence,
      },
    ];
  });
}

function sharedLandmarkDistanceRatio(
  first: PosePersonCandidate,
  second: PosePersonCandidate,
  minVisibility: number,
  frameWidth: number,
  frameHeight: number,
) {
  const limit = Math.min(first.pose.length, second.pose.length);
  let distanceSum = 0;
  let sharedPoints = 0;

  for (let index = 0; index < limit; index += 1) {
    const firstPoint = first.pose[index];
    const secondPoint = second.pose[index];
    if (
      !pointIsVisible(firstPoint, minVisibility) ||
      !pointIsVisible(secondPoint, minVisibility)
    ) {
      continue;
    }
    const xDistance = (firstPoint.x - secondPoint.x) * frameWidth;
    const yDistance = (firstPoint.y - secondPoint.y) * frameHeight;
    distanceSum += Math.hypot(xDistance, yDistance);
    sharedPoints += 1;
  }

  if (sharedPoints < DEFAULT_MIN_VISIBLE_POINTS) {
    return Number.POSITIVE_INFINITY;
  }
  const referenceDiagonal = Math.max(
    1,
    Math.min(boxDiagonal(first.box), boxDiagonal(second.box)),
  );
  return distanceSum / sharedPoints / referenceDiagonal;
}

function posesAreDuplicates(
  first: PosePersonCandidate,
  second: PosePersonCandidate,
  options: PoseDeduplicationOptions,
  frameWidth: number,
  frameHeight: number,
) {
  const iouThreshold = options.duplicateIouThreshold ?? 0.62;
  const centerThreshold = options.duplicateCenterDistanceRatio ?? 0.08;
  const landmarkThreshold = options.duplicateLandmarkDistanceRatio ?? 0.035;
  if (personBoxIou(first.box, second.box) < iouThreshold) return false;
  if (centerDistanceRatio(first.box, second.box) > centerThreshold) return false;

  return (
    sharedLandmarkDistanceRatio(
      first,
      second,
      options.minPointVisibility ?? DEFAULT_MIN_POINT_VISIBILITY,
      frameWidth,
      frameHeight,
    ) <= landmarkThreshold
  );
}

/**
 * Conservatively removes duplicate pose hypotheses. High box overlap alone is
 * not sufficient: centers and corresponding landmarks must also be nearly
 * identical, which preserves nearby people whose body boxes happen to overlap.
 */
export function deduplicatePoseDetections(
  poses: readonly (readonly PersonPosePoint[])[],
  frameWidth: number,
  frameHeight: number,
  options: PoseDeduplicationOptions = {},
) {
  const candidates = poses
    .map((pose, poseIndex): PosePersonCandidate | null => {
      const box = calculatePoseBodyBox(pose, frameWidth, frameHeight, options);
      if (!box) return null;
      return {
        poseIndex,
        pose,
        box,
        quality: calculatePoseQuality(
          pose,
          options.minPointVisibility ?? DEFAULT_MIN_POINT_VISIBILITY,
        ),
      };
    })
    .filter(
      (candidate): candidate is PosePersonCandidate => candidate !== null,
    )
    .sort(
      (first, second) =>
        second.quality - first.quality || first.poseIndex - second.poseIndex,
    );

  const kept: PosePersonCandidate[] = [];
  for (const candidate of candidates) {
    if (
      kept.some((existing) =>
        posesAreDuplicates(
          existing,
          candidate,
          options,
          frameWidth,
          frameHeight,
        ),
      )
    ) {
      continue;
    }
    kept.push(candidate);
  }
  return kept.sort((first, second) => first.poseIndex - second.poseIndex);
}

export function nonMaximumSuppressObjectPeople(
  detections: readonly ObjectDetectionLike[],
  frameWidth: number,
  frameHeight: number,
  options: ObjectNmsOptions = {},
) {
  const minScore = options.minScore ?? 0.45;
  const iouThreshold = options.iouThreshold ?? 0.75;
  const candidates = detections
    .map((detection, detectionIndex): ObjectPersonCandidate | null => {
      if (
        detection.categoryName !== "person" ||
        !Number.isFinite(detection.score) ||
        detection.score < minScore ||
        !boxIsUsable(detection.boundingBox, frameWidth, frameHeight)
      ) {
        return null;
      }
      return {
        detectionIndex,
        detection,
        box: clippedBox(detection.boundingBox!, frameWidth, frameHeight),
        score: clamp(detection.score, 0, 1),
      };
    })
    .filter(
      (candidate): candidate is ObjectPersonCandidate => candidate !== null,
    )
    .sort(
      (first, second) =>
        second.score - first.score ||
        first.detectionIndex - second.detectionIndex,
    );

  const kept: ObjectPersonCandidate[] = [];
  for (const candidate of candidates) {
    if (
      kept.some(
        (existing) => personBoxIou(existing.box, candidate.box) >= iouThreshold,
      )
    ) {
      continue;
    }
    kept.push(candidate);
  }
  return kept.sort(
    (first, second) => first.detectionIndex - second.detectionIndex,
  );
}

function poseObjectMatchScore(
  poseBox: PersonBoundingBox,
  objectBox: PersonBoundingBox,
) {
  const iou = personBoxIou(poseBox, objectBox);
  const containment = boxContainment(poseBox, objectBox);
  const distance = centerDistanceRatio(poseBox, objectBox);
  const isMatch =
    iou >= 0.12 ||
    containment >= 0.55 ||
    (containment >= 0.35 && distance <= 0.35);
  if (!isMatch) return null;
  return iou * 0.5 + containment * 0.35 + Math.max(0, 1 - distance) * 0.15;
}

/**
 * Fuses deduplicated pose regions with object-person evidence from the exact
 * current frame. Cached object results are intentionally excluded from the
 * current count, so they cannot invent an additional person beside a live pose.
 */
export function fusePersonDetections(
  input: FusePersonDetectionsInput,
): UniquePeopleResult {
  const poses = deduplicatePoseDetections(
    input.poses,
    input.frameWidth,
    input.frameHeight,
    input.poseOptions,
  );
  const currentObjects = input.objectUpdated
    ? nonMaximumSuppressObjectPeople(
        input.objects,
        input.frameWidth,
        input.frameHeight,
        input.objectOptions,
      )
    : [];

  const people: UniquePersonRegion[] = poses.map((pose) => ({
    box: pose.box,
    poseIndexes: [pose.poseIndex],
    objectDetectionIndexes: [],
    poseQuality: pose.quality,
    objectScore: null,
  }));

  for (const object of currentObjects) {
    let matchingIndex = -1;
    let bestScore = -Infinity;
    for (let index = 0; index < people.length; index += 1) {
      if (people[index].objectDetectionIndexes.length > 0) continue;
      const score = poseObjectMatchScore(people[index].box, object.box);
      if (score !== null && score > bestScore) {
        matchingIndex = index;
        bestScore = score;
      }
    }

    if (matchingIndex >= 0) {
      const matching = people[matchingIndex];
      matching.box = unionBox(matching.box, object.box);
      matching.objectDetectionIndexes.push(object.detectionIndex);
      matching.objectScore = object.score;
      continue;
    }

    people.push({
      box: object.box,
      poseIndexes: [],
      objectDetectionIndexes: [object.detectionIndex],
      poseQuality: null,
      objectScore: object.score,
    });
  }

  return {
    people,
    currentPeople: people.length,
    poses,
    currentObjects,
  };
}

/**
 * Smooths short gaps between exact object-detector frames without allowing a
 * cached object box to add another person beside a current pose. A current
 * positive result replaces the track immediately; an exact current zero clears
 * it immediately.
 */
export function updatePersonCountTrack(
  previous: PersonCountTrack | null,
  update: PersonCountTrackUpdate,
): PersonCountTrack {
  const currentCount = Number.isSafeInteger(update.currentCount)
    ? Math.max(0, update.currentCount)
    : 0;
  const now = Number.isFinite(update.now) ? update.now : 0;
  const holdMs = Number.isFinite(update.holdMs)
    ? Math.max(0, update.holdMs)
    : 0;

  if (currentCount > 0 || update.objectUpdated) {
    return { count: currentCount, confirmedAt: now };
  }
  if (
    previous &&
    previous.count > 0 &&
    now >= previous.confirmedAt &&
    now - previous.confirmedAt <= holdMs
  ) {
    return previous;
  }
  return { count: 0, confirmedAt: now };
}
