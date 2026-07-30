import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeFallPose,
  createVerificationProgress,
  updateVerificationProgress,
} from "../app/fall-detection.ts";

function emptyPose() {
  return Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 0,
  }));
}

function setPoint(pose, index, x, y, visibility = 0.9) {
  pose[index] = { x, y, z: 0, visibility };
}

function makeStandingPose() {
  const pose = emptyPose();
  setPoint(pose, 11, 0.44, 0.22);
  setPoint(pose, 12, 0.56, 0.22);
  setPoint(pose, 23, 0.45, 0.48);
  setPoint(pose, 24, 0.55, 0.48);
  setPoint(pose, 25, 0.45, 0.69);
  setPoint(pose, 26, 0.55, 0.69);
  setPoint(pose, 27, 0.44, 0.9);
  setPoint(pose, 28, 0.56, 0.9);
  setPoint(pose, 29, 0.43, 0.92);
  setPoint(pose, 30, 0.57, 0.92);
  setPoint(pose, 31, 0.42, 0.93);
  setPoint(pose, 32, 0.58, 0.93);
  return pose;
}

function makeLyingPose(y = 0.7) {
  const pose = emptyPose();
  setPoint(pose, 11, 0.22, y - 0.02);
  setPoint(pose, 12, 0.28, y - 0.02);
  setPoint(pose, 23, 0.48, y);
  setPoint(pose, 24, 0.54, y);
  setPoint(pose, 25, 0.66, y + 0.01);
  setPoint(pose, 26, 0.68, y + 0.02);
  setPoint(pose, 27, 0.84, y + 0.02);
  setPoint(pose, 28, 0.86, y + 0.03);
  setPoint(pose, 29, 0.85, y + 0.03);
  setPoint(pose, 30, 0.87, y + 0.04);
  setPoint(pose, 31, 0.88, y + 0.03);
  setPoint(pose, 32, 0.9, y + 0.04);
  return pose;
}

test("accepts a complete horizontal body near the ground", () => {
  const result = analyzeFallPose(makeLyingPose());
  assert.equal(result.isLying, true);
  assert.equal(result.isUpright, false);
  assert.ok(result.confidence >= 0.7);

  const noisyOppositeLeg = makeLyingPose();
  setPoint(noisyOppositeLeg, 26, 1.4, 0.1);
  setPoint(noisyOppositeLeg, 28, 1.6, 0.05);
  assert.equal(analyzeFallPose(noisyOppositeLeg).isLying, true);
});

test("rejects standing, seated, partial, high, and clipped poses", () => {
  const seated = makeStandingPose();
  setPoint(seated, 11, 0.4, 0.32);
  setPoint(seated, 12, 0.52, 0.32);
  setPoint(seated, 23, 0.43, 0.53);
  setPoint(seated, 24, 0.55, 0.53);
  setPoint(seated, 25, 0.34, 0.59);
  setPoint(seated, 26, 0.64, 0.59);
  setPoint(seated, 27, 0.34, 0.78);
  setPoint(seated, 28, 0.64, 0.78);

  const partial = makeLyingPose();
  for (const index of [25, 26, 27, 28, 29, 30, 31, 32]) {
    partial[index].visibility = 0.2;
  }

  const clipped = makeLyingPose();
  for (const index of [11, 12]) {
    clipped[index].x = -0.08;
  }

  const standing = analyzeFallPose(makeStandingPose());
  assert.equal(standing.isLying, false);
  assert.equal(standing.isUpright, true);
  assert.equal(analyzeFallPose(seated).isLying, false);
  assert.equal(analyzeFallPose(partial).isLying, false);
  assert.equal(analyzeFallPose(partial).isUpright, false);
  assert.equal(analyzeFallPose(makeLyingPose(0.36)).isLying, false);
  assert.equal(analyzeFallPose(clipped).isLying, false);
});

test("counts a continuous positive sequence to ten seconds", () => {
  let progress = createVerificationProgress(0);
  for (let now = 250; now <= 10_000; now += 250) {
    progress = updateVerificationProgress(progress, now, true);
  }
  assert.equal(progress.confirmedMs, 10_000);
});

test("does not accumulate repeated short false-positive bursts", () => {
  let progress = createVerificationProgress(0);
  let now = 0;

  for (let cycle = 0; cycle < 80; cycle += 1) {
    now += 250;
    progress = updateVerificationProgress(progress, now, true);
    now += 250;
    progress = updateVerificationProgress(progress, now, false);
    now += 250;
    progress = updateVerificationProgress(progress, now, true);
  }

  assert.ok(progress.confirmedMs < 2_000);
});

test("tolerates one brief tracking gap without counting the gap", () => {
  let progress = createVerificationProgress(0);
  progress = updateVerificationProgress(progress, 500, true);
  progress = updateVerificationProgress(progress, 1_000, true);
  progress = updateVerificationProgress(progress, 1_100, false);
  progress = updateVerificationProgress(progress, 1_350, true);
  progress = updateVerificationProgress(progress, 1_850, true);

  assert.equal(progress.confirmedMs, 1_500);
  assert.equal(progress.negativeBudgetMs, 250);
});
