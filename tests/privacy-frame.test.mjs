import assert from "node:assert/strict";
import test from "node:test";

import {
  decidePrivacyFrame,
  emptySceneVerificationIsFresh,
  resolvePrivacyFrameMode,
  updateEmptySceneVerification,
} from "../app/privacy-frame.ts";

const protectedCurrentFrame = {
  sourceMatchesResult: true,
  resultIsFresh: true,
  sanitizedContextAvailable: true,
  currentPersonRegionCount: 1,
  protectedPersonRegionCount: 1,
  peopleSpatiallyAligned: true,
  emptySceneVerified: true,
};

test("sanitizes multiple people when every current region is protected", () => {
  assert.deepEqual(
    decidePrivacyFrame({
      ...protectedCurrentFrame,
      currentPersonRegionCount: 3,
      protectedPersonRegionCount: 3,
    }),
    {
      mode: "sanitize",
      reason: "verified_people_protected",
    },
  );
});

test("treats one conservative per-person fallback as protected", () => {
  assert.deepEqual(decidePrivacyFrame(protectedCurrentFrame), {
    mode: "sanitize",
    reason: "verified_people_protected",
  });
});

test("holds the last safe frame for stale analysis", () => {
  assert.deepEqual(
    decidePrivacyFrame({
      ...protectedCurrentFrame,
      resultIsFresh: false,
    }),
    {
      mode: "hold",
      reason: "stale_result",
    },
  );
});

test("uses an opaque frame for a source/result mismatch", () => {
  assert.deepEqual(
    decidePrivacyFrame({
      ...protectedCurrentFrame,
      sourceMatchesResult: false,
    }),
    {
      mode: "opaque",
      reason: "source_mismatch",
    },
  );
});

test("sanitizes an exactly verified empty scene", () => {
  assert.deepEqual(
    decidePrivacyFrame({
      ...protectedCurrentFrame,
      currentPersonRegionCount: 0,
      protectedPersonRegionCount: 0,
      emptySceneVerified: true,
    }),
    {
      mode: "sanitize",
      reason: "verified_empty_scene",
    },
  );
});

test("holds while the exact-frame object result needed for an empty scene is pending", () => {
  assert.deepEqual(
    decidePrivacyFrame({
      ...protectedCurrentFrame,
      currentPersonRegionCount: 0,
      protectedPersonRegionCount: 0,
      emptySceneVerified: false,
    }),
    {
      mode: "hold",
      reason: "object_result_pending",
    },
  );
});

test("holds for transient region mismatch or an unprotected person", () => {
  assert.deepEqual(
    decidePrivacyFrame({
      ...protectedCurrentFrame,
      currentPersonRegionCount: 2,
      protectedPersonRegionCount: 2,
      peopleSpatiallyAligned: false,
    }),
    {
      mode: "hold",
      reason: "person_region_mismatch",
    },
  );

  assert.deepEqual(
    decidePrivacyFrame({
      ...protectedCurrentFrame,
      currentPersonRegionCount: 2,
      protectedPersonRegionCount: 1,
    }),
    {
      mode: "hold",
      reason: "unprotected_person_region",
    },
  );
});

test("uses an opaque frame when the initial sanitizer context is unavailable", () => {
  assert.deepEqual(
    decidePrivacyFrame({
      ...protectedCurrentFrame,
      sanitizedContextAvailable: false,
    }),
    {
      mode: "opaque",
      reason: "mask_context_unavailable",
    },
  );
});

test("holds after a selective mask or fallback rendering failure", () => {
  const decision = decidePrivacyFrame(protectedCurrentFrame);
  assert.equal(resolvePrivacyFrameMode(decision, false), "hold");
  assert.equal(resolvePrivacyFrameMode(decision, true), "sanitize");

  const fatalDecision = decidePrivacyFrame({
    ...protectedCurrentFrame,
    sourceMatchesResult: false,
  });
  assert.equal(resolvePrivacyFrameMode(fatalDecision, true), "opaque");
});

test("keeps a recent exact empty verification between object scans", () => {
  let verification = {
    consecutiveEmptyObjectScans: 0,
    verifiedAt: null,
  };
  verification = updateEmptySceneVerification(verification, {
    now: 0,
    sceneEligible: true,
    objectUpdated: true,
    requiredScans: 2,
  });
  assert.equal(emptySceneVerificationIsFresh(verification, 100, 500), false);

  verification = updateEmptySceneVerification(verification, {
    now: 400,
    sceneEligible: true,
    objectUpdated: true,
    requiredScans: 2,
  });
  assert.equal(emptySceneVerificationIsFresh(verification, 850, 500), true);
  assert.equal(emptySceneVerificationIsFresh(verification, 901, 500), false);
});

test("immediately clears empty-scene trust when a person region appears", () => {
  const verification = updateEmptySceneVerification(
    { consecutiveEmptyObjectScans: 2, verifiedAt: 400 },
    {
      now: 450,
      sceneEligible: false,
      objectUpdated: false,
      requiredScans: 2,
    },
  );
  assert.deepEqual(verification, {
    consecutiveEmptyObjectScans: 0,
    verifiedAt: null,
  });
  assert.equal(emptySceneVerificationIsFresh(verification, 450, 500), false);
});
