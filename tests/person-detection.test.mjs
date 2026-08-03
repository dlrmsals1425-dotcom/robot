import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePoseHumanEvidence,
  calculatePoseBodyBox,
  calculatePoseHeadFallbackBox,
  calculatePoseQuality,
  deduplicatePoseDetections,
  fusePersonDetections,
  nonMaximumSuppressObjectPeople,
  selectConfirmedPersonPoses,
  updatePersonCountTrack,
} from "../app/person-detection.ts";

function emptyPose() {
  return Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    visibility: 0,
  }));
}

function setPoint(pose, index, x, y, visibility = 0.95) {
  pose[index] = { x, y, visibility };
}

function makeStandingPose(centerX = 0.5, visibility = 0.95) {
  const pose = emptyPose();
  const points = {
    0: [centerX, 0.15],
    7: [centerX - 0.035, 0.17],
    8: [centerX + 0.035, 0.17],
    11: [centerX - 0.09, 0.28],
    12: [centerX + 0.09, 0.28],
    13: [centerX - 0.13, 0.44],
    14: [centerX + 0.13, 0.44],
    15: [centerX - 0.15, 0.59],
    16: [centerX + 0.15, 0.59],
    23: [centerX - 0.07, 0.55],
    24: [centerX + 0.07, 0.55],
    25: [centerX - 0.065, 0.73],
    26: [centerX + 0.065, 0.73],
    27: [centerX - 0.06, 0.91],
    28: [centerX + 0.06, 0.91],
  };
  for (const [index, [x, y]] of Object.entries(points)) {
    setPoint(pose, Number(index), x, y, visibility);
  }
  return pose;
}

function makeTabletopFalsePose() {
  const pose = emptyPose();
  setPoint(pose, 11, 0.18, 0.56, 0.94);
  setPoint(pose, 12, 0.36, 0.55, 0.91);
  setPoint(pose, 23, 0.46, 0.58, 0.93);
  setPoint(pose, 24, 0.63, 0.57, 0.9);
  setPoint(pose, 25, 0.58, 0.61, 0.88);
  setPoint(pose, 27, 0.82, 0.63, 0.86);
  return pose;
}

function makeDenseTabletopFalsePose() {
  const pose = makeStandingPose();
  // Pose models can hallucinate many high-confidence points on a textured
  // object. Reverse the left/right lower-body topology to mimic the crossed
  // skeleton visible in the reported tabletop false positive.
  setPoint(pose, 23, 0.6, 0.55, 0.97);
  setPoint(pose, 24, 0.4, 0.55, 0.97);
  setPoint(pose, 25, 0.63, 0.72, 0.96);
  setPoint(pose, 26, 0.37, 0.72, 0.96);
  setPoint(pose, 27, 0.65, 0.9, 0.95);
  setPoint(pose, 28, 0.35, 0.9, 0.95);
  return pose;
}

function shiftedPose(pose, xShift, yShift, visibility) {
  return pose.map((point) =>
    point.visibility > 0
      ? {
          ...point,
          x: point.x + xShift,
          y: point.y + yShift,
          visibility: visibility ?? point.visibility,
        }
      : point,
  );
}

function personObject(originX, originY, width, height, score = 0.8) {
  return {
    categoryName: "person",
    score,
    boundingBox: { originX, originY, width, height },
  };
}

test("calculates pose quality and a usable body bounding box", () => {
  const pose = makeStandingPose();
  const quality = calculatePoseQuality(pose);
  const box = calculatePoseBodyBox(pose, 640, 480);

  assert.ok(quality > 0.5 && quality <= 1);
  assert.ok(box);
  assert.ok(box.width > 100);
  assert.ok(box.height > 300);
});

test("keeps a broad pose for privacy but rejects tabletop geometry for operators", () => {
  const tabletopPose = makeTabletopFalsePose();
  assert.ok(calculatePoseBodyBox(tabletopPose, 640, 480));
  assert.equal(
    analyzePoseHumanEvidence(tabletopPose, 640, 480).isStrong,
    false,
  );

  const confirmed = selectConfirmedPersonPoses({
    poses: [tabletopPose],
    objects: [
      {
        categoryName: "sports ball",
        score: 0.92,
        boundingBox: { originX: 100, originY: 250, width: 430, height: 70 },
      },
    ],
    faces: [],
    frameWidth: 640,
    frameHeight: 480,
  });
  assert.equal(confirmed.length, 0);
});

test("rejects a dense crossed tabletop skeleton even beside a false person box", () => {
  const pose = makeDenseTabletopFalsePose();
  const evidence = analyzePoseHumanEvidence(pose, 640, 480);
  assert.ok(evidence.visibleLandmarks >= 12);
  assert.equal(evidence.isPlausible, false);
  assert.equal(evidence.isStrong, false);

  const confirmed = selectConfirmedPersonPoses({
    poses: [pose],
    objects: [personObject(205, 60, 230, 390, 0.99)],
    faces: [],
    frameWidth: 640,
    frameHeight: 480,
  });
  assert.equal(confirmed.length, 0);
});

test("accepts a complete anatomical pose without requiring network evidence", () => {
  const pose = makeStandingPose();
  const evidence = analyzePoseHumanEvidence(pose, 640, 480);
  assert.equal(evidence.isPlausible, true);
  assert.equal(evidence.isStrong, true);

  const confirmed = selectConfirmedPersonPoses({
    poses: [pose],
    objects: [],
    faces: [],
    frameWidth: 640,
    frameHeight: 480,
  });
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].strongPoseOnly, true);
});

test("uses a matching person object to confirm a partially occluded pose", () => {
  const pose = makeStandingPose();
  for (const index of [0, 7, 8, 14, 16, 26, 28]) {
    pose[index].visibility = 0.2;
  }
  const evidence = analyzePoseHumanEvidence(pose, 640, 480);
  assert.equal(evidence.isPlausible, true);
  assert.equal(evidence.isStrong, false);

  const withoutObject = selectConfirmedPersonPoses({
    poses: [pose],
    objects: [],
    faces: [],
    frameWidth: 640,
    frameHeight: 480,
  });
  const withObject = selectConfirmedPersonPoses({
    poses: [pose],
    objects: [personObject(215, 65, 210, 385, 0.78)],
    faces: [],
    frameWidth: 640,
    frameHeight: 480,
  });
  assert.equal(withoutObject.length, 0);
  assert.equal(withObject.length, 1);
  assert.equal(withObject[0].confirmedByObject, true);
});

test("does not let an unrelated face turn a weak pose into a person", () => {
  const confirmed = selectConfirmedPersonPoses({
    poses: [makeTabletopFalsePose()],
    objects: [],
    faces: [
      {
        categoryName: "face",
        score: 0.97,
        boundingBox: { originX: 560, originY: 20, width: 55, height: 55 },
      },
    ],
    frameWidth: 640,
    frameHeight: 480,
  });
  assert.equal(confirmed.length, 0);
});

test("estimates a head mask above standing shoulders and along a lying torso", () => {
  const standing = makeStandingPose();
  const standingHead = calculatePoseHeadFallbackBox(standing, 640, 480);
  assert.ok(standingHead);
  assert.ok(standingHead.originY + standingHead.height / 2 < 0.28 * 480);

  const lying = emptyPose();
  setPoint(lying, 11, 0.3, 0.55);
  setPoint(lying, 12, 0.3, 0.65);
  setPoint(lying, 23, 0.55, 0.55);
  setPoint(lying, 24, 0.55, 0.65);
  const lyingHead = calculatePoseHeadFallbackBox(lying, 640, 480);
  assert.ok(lyingHead);
  assert.ok(lyingHead.originX + lyingHead.width / 2 < 0.3 * 640);

  assert.equal(
    calculatePoseHeadFallbackBox(emptyPose(), 640, 480),
    null,
  );
});

test("deduplicates two overlapping hypotheses for the same person", () => {
  const primary = makeStandingPose(0.5, 0.96);
  const duplicate = shiftedPose(primary, 0.003, -0.002, 0.76);
  const result = deduplicatePoseDetections(
    [primary, duplicate],
    640,
    480,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].poseIndex, 0);
});

test("preserves two nearby but spatially distinct people", () => {
  // Their body boxes overlap heavily, but corresponding landmarks are offset
  // enough to represent two subjects rather than duplicate model hypotheses.
  const first = makeStandingPose(0.48);
  const second = makeStandingPose(0.52);
  const result = deduplicatePoseDetections([first, second], 640, 480);

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((candidate) => candidate.poseIndex),
    [0, 1],
  );
});

test("merges current pose and object evidence for the same person", () => {
  const result = fusePersonDetections({
    poses: [makeStandingPose()],
    objects: [personObject(215, 65, 210, 385)],
    objectUpdated: true,
    frameWidth: 640,
    frameHeight: 480,
  });

  assert.equal(result.currentPeople, 1);
  assert.deepEqual(result.people[0].poseIndexes, [0]);
  assert.deepEqual(result.people[0].objectDetectionIndexes, [0]);
});

test("does not add a stale cached object beside a current pose", () => {
  const result = fusePersonDetections({
    poses: [makeStandingPose(0.3)],
    objects: [personObject(470, 60, 130, 360)],
    objectUpdated: false,
    frameWidth: 640,
    frameHeight: 480,
  });

  assert.equal(result.currentPeople, 1);
  assert.equal(result.currentObjects.length, 0);
  assert.deepEqual(result.people[0].poseIndexes, [0]);

  const staleOnly = fusePersonDetections({
    poses: [],
    objects: [personObject(470, 60, 130, 360)],
    objectUpdated: false,
    frameWidth: 640,
    frameHeight: 480,
  });
  assert.equal(staleOnly.currentPeople, 0);
});

test("counts a current object-only person", () => {
  const result = fusePersonDetections({
    poses: [],
    objects: [personObject(210, 50, 190, 390, 0.88)],
    objectUpdated: true,
    frameWidth: 640,
    frameHeight: 480,
  });

  assert.equal(result.currentPeople, 1);
  assert.deepEqual(result.people[0].poseIndexes, []);
  assert.deepEqual(result.people[0].objectDetectionIndexes, [0]);
});

test("suppresses duplicate current object-person boxes", () => {
  const result = nonMaximumSuppressObjectPeople(
    [
      personObject(200, 40, 200, 400, 0.9),
      personObject(204, 44, 198, 395, 0.7),
    ],
    640,
    480,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].detectionIndex, 0);
});

test("holds an object-only count between exact frames and clears on current zero", () => {
  const detected = updatePersonCountTrack(null, {
    currentCount: 1,
    objectUpdated: true,
    now: 1_000,
    holdMs: 1_000,
  });
  const betweenObjectFrames = updatePersonCountTrack(detected, {
    currentCount: 0,
    objectUpdated: false,
    now: 1_700,
    holdMs: 1_000,
  });
  const currentZero = updatePersonCountTrack(betweenObjectFrames, {
    currentCount: 0,
    objectUpdated: true,
    now: 1_850,
    holdMs: 1_000,
  });

  assert.equal(betweenObjectFrames.count, 1);
  assert.equal(currentZero.count, 0);
});
