import { analyzePoseHumanEvidence } from "./person-detection.ts";

export type PosePoint = {
  x: number;
  y: number;
  z: number;
  visibility: number;
};

export type PoseCenter = {
  x: number;
  y: number;
};

export type FallAnalysis = {
  isLying: boolean;
  isUpright: boolean;
  confidence: number;
  center: PoseCenter | null;
};

export type FallAnalysisOptions = {
  hasCorroboratingHumanEvidence?: boolean;
};

export type VerificationProgress = {
  confirmedMs: number;
  negativeBudgetMs: number;
  negativeStartedAt: number | null;
  lastPositiveAt: number | null;
};

export const FALL_MAX_POSITIVE_GAP_MS = 850;
export const FALL_NEGATIVE_RESET_MS = 500;
export const FALL_NEGATIVE_BUDGET_MS = 650;

const CORE_LANDMARKS = [11, 12, 23, 24] as const;
const LEFT_LEG = [23, 25, 27] as const;
const RIGHT_LEG = [24, 26, 28] as const;
const BODY_LANDMARKS = [
  0,
  7,
  8,
  11,
  12,
  13,
  14,
  15,
  16,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isReliablePoint(point: PosePoint | undefined, minVisibility: number) {
  return Boolean(
    point &&
      point.visibility >= minVisibility &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y),
  );
}

function getBodyBounds(
  pose: readonly PosePoint[],
  landmarkIndexes: readonly number[],
  frameWidth: number,
  frameHeight: number,
) {
  const visible = landmarkIndexes.map((index) => pose[index]).filter(
    (point): point is PosePoint => isReliablePoint(point, 0.55),
  );

  if (visible.length < 6) return null;

  const xs = visible.map((point) => point.x * frameWidth);
  const ys = visible.map((point) => point.y * frameHeight);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

export function poseCenterDistance(
  first: PoseCenter | null,
  second: PoseCenter | null,
) {
  if (!first || !second) return Number.POSITIVE_INFINITY;
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function createVerificationProgress(
  lastPositiveAt: number | null = null,
): VerificationProgress {
  return {
    confirmedMs: 0,
    negativeBudgetMs: 0,
    negativeStartedAt: null,
    lastPositiveAt,
  };
}

export function updateVerificationProgress(
  progress: VerificationProgress,
  now: number,
  isPositive: boolean,
): VerificationProgress {
  if (isPositive) {
    if (progress.negativeStartedAt !== null) {
      const negativeMs = Math.max(0, now - progress.negativeStartedAt);
      const exceedsNegativeTolerance =
        negativeMs > FALL_NEGATIVE_RESET_MS ||
        progress.negativeBudgetMs + negativeMs >
          FALL_NEGATIVE_BUDGET_MS;
      return {
        confirmedMs: exceedsNegativeTolerance ? 0 : progress.confirmedMs,
        negativeBudgetMs: exceedsNegativeTolerance
          ? 0
          : progress.negativeBudgetMs + negativeMs,
        negativeStartedAt: null,
        lastPositiveAt: now,
      };
    }

    if (progress.lastPositiveAt === null) {
      return { ...progress, lastPositiveAt: now };
    }

    const positiveMs = Math.max(0, now - progress.lastPositiveAt);
    if (positiveMs > FALL_MAX_POSITIVE_GAP_MS) {
      return createVerificationProgress(now);
    }

    return {
      ...progress,
      confirmedMs: progress.confirmedMs + positiveMs,
      lastPositiveAt: now,
    };
  }

  const negativeStartedAt = progress.negativeStartedAt ?? now;
  const negativeMs = Math.max(0, now - negativeStartedAt);
  return {
    confirmedMs:
      negativeMs > FALL_NEGATIVE_RESET_MS ? 0 : progress.confirmedMs,
    negativeBudgetMs:
      negativeMs > FALL_NEGATIVE_RESET_MS ? 0 : progress.negativeBudgetMs,
    negativeStartedAt,
    lastPositiveAt: null,
  };
}

export function analyzeFallPose(
  pose: readonly PosePoint[],
  frameWidth: number,
  frameHeight: number,
  options: FallAnalysisOptions = {},
): FallAnalysis {
  if (
    !CORE_LANDMARKS.every((index) => isReliablePoint(pose[index], 0.65))
  ) {
    return {
      isLying: false,
      isUpright: false,
      confidence: 0,
      center: null,
    };
  }

  const [leftShoulder, rightShoulder, leftHip, rightHip] =
    CORE_LANDMARKS.map((index) => pose[index]);
  const shoulder = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const hip = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };

  const hasCompleteLeftLeg = LEFT_LEG.every((index) =>
    isReliablePoint(pose[index], 0.55),
  );
  const hasCompleteRightLeg = RIGHT_LEG.every((index) =>
    isReliablePoint(pose[index], 0.55),
  );
  const completeLeg = hasCompleteLeftLeg
    ? LEFT_LEG
    : hasCompleteRightLeg
      ? RIGHT_LEG
      : null;
  if (!completeLeg) {
    return {
      isLying: false,
      isUpright: false,
      confidence: 0,
      center: hip,
    };
  }

  if (frameWidth <= 0 || frameHeight <= 0) {
    return {
      isLying: false,
      isUpright: false,
      confidence: 0,
      center: hip,
    };
  }

  const torsoLength = Math.hypot(
    (hip.x - shoulder.x) * frameWidth,
    (hip.y - shoulder.y) * frameHeight,
  );
  if (torsoLength < Math.min(frameWidth, frameHeight) * 0.045) {
    return {
      isLying: false,
      isUpright: false,
      confidence: 0,
      center: hip,
    };
  }

  const bodyLandmarks = [...new Set([...BODY_LANDMARKS, ...completeLeg])];
  const bounds = getBodyBounds(
    pose,
    bodyLandmarks,
    frameWidth,
    frameHeight,
  );
  if (!bounds) {
    return {
      isLying: false,
      isUpright: false,
      confidence: 0,
      center: hip,
    };
  }

  const width = Math.max(bounds.maxX - bounds.minX, 0.001);
  const height = Math.max(bounds.maxY - bounds.minY, 0.001);
  const aspectRatio = width / height;
  const dx = Math.abs(hip.x - shoulder.x) * frameWidth;
  const dy = Math.abs(hip.y - shoulder.y) * frameHeight;
  const angleFromHorizontal =
    (Math.atan2(dy, Math.max(dx, 0.0001)) * 180) / Math.PI;
  const averageCoreVisibility =
    CORE_LANDMARKS.reduce(
      (sum, index) => sum + pose[index].visibility,
      0,
    ) / CORE_LANDMARKS.length;

  const humanEvidence = analyzePoseHumanEvidence(
    pose,
    frameWidth,
    frameHeight,
  );
  const humanIsConfirmed =
    humanEvidence.isStrong ||
    (Boolean(options.hasCorroboratingHumanEvidence) &&
      humanEvidence.isPlausible);
  const horizontalScore = clamp((38 - angleFromHorizontal) / 25, 0, 1);
  const aspectScore = clamp((aspectRatio - 1.15) / 1.1, 0, 1);
  const lowerFrameScore = clamp((hip.y - 0.48) / 0.28, 0, 1);
  const qualityScore = clamp((averageCoreVisibility - 0.62) / 0.32, 0, 1);
  const rawConfidence = clamp(
    horizontalScore * 0.3 +
      aspectScore * 0.22 +
      lowerFrameScore * 0.16 +
      qualityScore * 0.1 +
      humanEvidence.score * 0.22,
    0,
    1,
  );
  const confidence = humanIsConfirmed
    ? rawConfidence
    : Math.min(rawConfidence, 0.55);

  const bodyIsClipped = bodyLandmarks.some(
    (index) =>
      isReliablePoint(pose[index], 0.55) &&
      (pose[index].x < -0.04 ||
        pose[index].x > 1.04 ||
        pose[index].y < -0.04 ||
        pose[index].y > 1.04),
  );
  const isLying =
    !bodyIsClipped &&
    humanIsConfirmed &&
    angleFromHorizontal < 28 &&
    aspectRatio > 1.35 &&
    hip.y > 0.52 &&
    bounds.maxY / frameHeight > 0.62 &&
    confidence >= 0.78;
  const isUpright =
    !bodyIsClipped &&
    humanEvidence.isPlausible &&
    angleFromHorizontal > 58 &&
    aspectRatio < 0.95 &&
    height / frameHeight > 0.18;

  return {
    isLying,
    isUpright,
    confidence,
    center: hip,
  };
}
