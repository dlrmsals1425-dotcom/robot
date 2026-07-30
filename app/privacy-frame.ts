export type PrivacyFrameMode = "sanitize" | "pixelate" | "opaque";

export type PrivacyDecisionReason =
  | "verified_single_person"
  | "verified_single_face"
  | "verified_object_head_fallback"
  | "source_mismatch"
  | "stale_result"
  | "mask_context_unavailable"
  | "count_mismatch"
  | "multiple_people"
  | "spatial_ambiguity"
  | "no_confident_person"
  | "stale_object_fallback"
  | "missing_object_fallback";

export type PrivacyDecisionInput = {
  sourceMatchesResult: boolean;
  resultIsFresh: boolean;
  sanitizedContextAvailable: boolean;
  posePersonCount: number;
  objectPersonCount?: number;
  faceMaskCount: number;
  poseFaceMaskCount: number;
  peopleSpatiallyAligned: boolean;
  objectUpdated: boolean;
  objectFallbackAvailable: boolean;
};

export type PrivacyFrameDecision = {
  mode: PrivacyFrameMode;
  reason: PrivacyDecisionReason;
  useObjectFallback: boolean;
};

/**
 * Fail-closed policy for frames that can leave the field device.
 *
 * Only one unambiguous person with a current face/head mask may use selective
 * redaction. Everything uncertain is reduced to a full-frame mosaic, while a
 * source/result mismatch never trusts the source and produces an opaque frame.
 */
export function decidePrivacyFrame(
  input: PrivacyDecisionInput,
): PrivacyFrameDecision {
  if (!input.sourceMatchesResult) {
    return {
      mode: "opaque",
      reason: "source_mismatch",
      useObjectFallback: false,
    };
  }
  if (!input.resultIsFresh) {
    return {
      mode: "pixelate",
      reason: "stale_result",
      useObjectFallback: false,
    };
  }
  if (!input.sanitizedContextAvailable) {
    return {
      mode: "opaque",
      reason: "mask_context_unavailable",
      useObjectFallback: false,
    };
  }

  const posePeople = Math.max(0, input.posePersonCount);
  const objectPeople =
    input.objectPersonCount === undefined
      ? undefined
      : Math.max(0, input.objectPersonCount);
  const faces = Math.max(0, input.faceMaskCount);
  const poseFaces = Math.max(0, input.poseFaceMaskCount);

  if (
    input.objectUpdated &&
    objectPeople !== undefined &&
    posePeople > 0 &&
    objectPeople > 0 &&
    posePeople !== objectPeople
  ) {
    return {
      mode: "pixelate",
      reason: "count_mismatch",
      useObjectFallback: false,
    };
  }

  const detectedPeople = Math.max(
    posePeople,
    input.objectUpdated ? (objectPeople ?? 0) : 0,
    faces,
  );
  if (
    detectedPeople > 1 ||
    faces > 1 ||
    posePeople > 1 ||
    (input.objectUpdated ? (objectPeople ?? 0) : 0) > 1
  ) {
    return {
      mode: "pixelate",
      reason: "multiple_people",
      useObjectFallback: false,
    };
  }

  if (!input.peopleSpatiallyAligned) {
    return {
      mode: "pixelate",
      reason: "spatial_ambiguity",
      useObjectFallback: false,
    };
  }

  if (faces === 1) {
    return {
      mode: "sanitize",
      reason: "verified_single_face",
      useObjectFallback: false,
    };
  }
  if (posePeople === 1 && poseFaces === 1) {
    return {
      mode: "sanitize",
      reason: "verified_single_person",
      useObjectFallback: false,
    };
  }

  const needsObjectFallback =
    (objectPeople ?? 0) === 1 &&
    faces === 0 &&
    poseFaces === 0;
  if (needsObjectFallback && !input.objectUpdated) {
    return {
      mode: "pixelate",
      reason: "stale_object_fallback",
      useObjectFallback: false,
    };
  }
  if (needsObjectFallback && !input.objectFallbackAvailable) {
    return {
      mode: "pixelate",
      reason: "missing_object_fallback",
      useObjectFallback: false,
    };
  }
  if (needsObjectFallback) {
    return {
      mode: "sanitize",
      reason: "verified_object_head_fallback",
      useObjectFallback: true,
    };
  }

  return {
    mode: "pixelate",
    reason: "no_confident_person",
    useObjectFallback: false,
  };
}

export function resolvePrivacyFrameMode(
  decision: PrivacyFrameDecision,
  selectiveMaskRendered: boolean,
): PrivacyFrameMode {
  if (decision.mode !== "sanitize") return decision.mode;
  return selectiveMaskRendered ? "sanitize" : "pixelate";
}
