import assert from "node:assert/strict";
import test from "node:test";

import {
  decidePrivacyFrame,
  resolvePrivacyFrameMode,
} from "../app/privacy-frame.ts";

const safeSinglePerson = {
  sourceMatchesResult: true,
  resultIsFresh: true,
  sanitizedContextAvailable: true,
  posePersonCount: 1,
  objectPersonCount: 1,
  faceMaskCount: 1,
  poseFaceMaskCount: 1,
  peopleSpatiallyAligned: true,
  objectUpdated: true,
  objectFallbackAvailable: true,
};

test("selectively masks only one spatially consistent person", () => {
  assert.deepEqual(decidePrivacyFrame(safeSinglePerson), {
    mode: "sanitize",
    reason: "verified_single_face",
    useObjectFallback: false,
  });
});

test("fully pixelates two people and person-count mismatches", () => {
  assert.equal(
    decidePrivacyFrame({
      ...safeSinglePerson,
      posePersonCount: 2,
      objectPersonCount: 2,
      faceMaskCount: 2,
      poseFaceMaskCount: 2,
    }).mode,
    "pixelate",
  );

  const mismatch = decidePrivacyFrame({
    ...safeSinglePerson,
    posePersonCount: 2,
    objectPersonCount: 1,
    faceMaskCount: 1,
    poseFaceMaskCount: 2,
  });
  assert.equal(mismatch.mode, "pixelate");
  assert.equal(mismatch.reason, "count_mismatch");
});

test("uses an opaque frame for a source/result mismatch and mosaic for stale analysis", () => {
  assert.deepEqual(
    decidePrivacyFrame({
      ...safeSinglePerson,
      sourceMatchesResult: false,
    }),
    {
      mode: "opaque",
      reason: "source_mismatch",
      useObjectFallback: false,
    },
  );
  assert.equal(
    decidePrivacyFrame({
      ...safeSinglePerson,
      resultIsFresh: false,
    }).mode,
    "pixelate",
  );
});

test("rejects a stale object result when the object head is the only fallback", () => {
  const decision = decidePrivacyFrame({
    ...safeSinglePerson,
    posePersonCount: 0,
    objectPersonCount: 1,
    faceMaskCount: 0,
    poseFaceMaskCount: 0,
    objectUpdated: false,
  });
  assert.equal(decision.mode, "pixelate");
  assert.equal(decision.reason, "stale_object_fallback");
});

test("fails closed when mask context or spatial validation fails", () => {
  assert.equal(
    decidePrivacyFrame({
      ...safeSinglePerson,
      sanitizedContextAvailable: false,
    }).mode,
    "opaque",
  );
  assert.equal(
    decidePrivacyFrame({
      ...safeSinglePerson,
      peopleSpatiallyAligned: false,
    }).mode,
    "pixelate",
  );
  assert.equal(
    resolvePrivacyFrameMode(
      decidePrivacyFrame(safeSinglePerson),
      false,
    ),
    "pixelate",
  );
});
