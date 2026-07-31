export type PrivacyFrameMode = "sanitize" | "hold" | "opaque";

export type PrivacyDecisionReason =
  | "verified_people_protected"
  | "verified_empty_scene"
  | "source_mismatch"
  | "stale_result"
  | "mask_context_unavailable"
  | "person_region_mismatch"
  | "object_result_pending"
  | "unprotected_person_region";

export type PrivacyDecisionInput = {
  /**
   * Whether the pixels available to the sanitizer are the exact pixels that
   * produced this result. A mismatch is fatal because neither frame is safe to
   * trust.
   */
  sourceMatchesResult: boolean;
  resultIsFresh: boolean;
  sanitizedContextAvailable: boolean;
  /**
   * Number of unique people regions in the current frame after pose, face and
   * current object boxes have been spatially merged.
   */
  currentPersonRegionCount: number;
  /**
   * Number of unique current people regions for which the caller can render a
   * face/head mask or a conservative per-person fallback.
   */
  protectedPersonRegionCount: number;
  /**
   * False when current detectors temporarily disagree about region count or
   * position. Cached object results must not be treated as current regions.
   */
  peopleSpatiallyAligned: boolean;
  /**
   * A zero-person frame is verified only when the slower object detector also
   * ran on this exact frame. Protected people can be published without waiting
   * for an object refresh.
   */
  objectUpdated: boolean;
};

export type PrivacyFrameDecision = {
  mode: PrivacyFrameMode;
  reason: PrivacyDecisionReason;
};

function isValidRegionCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Fail-closed policy for frames that can leave the field device.
 *
 * Fatal source/context failures produce an opaque frame. Transient inference
 * uncertainty holds the last completed safe frame. A current frame is
 * publishable when every localized person region has a protection operation,
 * regardless of how many people are present, or when all current detectors
 * have verified an empty scene.
 */
export function decidePrivacyFrame(
  input: PrivacyDecisionInput,
): PrivacyFrameDecision {
  if (!input.sourceMatchesResult) {
    return {
      mode: "opaque",
      reason: "source_mismatch",
    };
  }
  if (!input.sanitizedContextAvailable) {
    return {
      mode: "opaque",
      reason: "mask_context_unavailable",
    };
  }
  if (!input.resultIsFresh) {
    return {
      mode: "hold",
      reason: "stale_result",
    };
  }

  if (
    !isValidRegionCount(input.currentPersonRegionCount) ||
    !isValidRegionCount(input.protectedPersonRegionCount) ||
    !input.peopleSpatiallyAligned
  ) {
    return {
      mode: "hold",
      reason: "person_region_mismatch",
    };
  }

  const currentRegions = input.currentPersonRegionCount;
  const protectedRegions = input.protectedPersonRegionCount;

  if (currentRegions === 0) {
    if (protectedRegions !== 0) {
      return {
        mode: "hold",
        reason: "person_region_mismatch",
      };
    }
    if (!input.objectUpdated) {
      return {
        mode: "hold",
        reason: "object_result_pending",
      };
    }
    return {
      mode: "sanitize",
      reason: "verified_empty_scene",
    };
  }

  if (protectedRegions !== currentRegions) {
    return {
      mode: "hold",
      reason:
        protectedRegions < currentRegions
          ? "unprotected_person_region"
          : "person_region_mismatch",
    };
  }

  return {
    mode: "sanitize",
    reason: "verified_people_protected",
  };
}

/**
 * Converts a planned sanitization into the final publish mode. Mask or
 * per-person fallback rendering failure is transient: keep the previous safe
 * frame rather than replacing it with raw pixels or a full-frame mosaic.
 */
export function resolvePrivacyFrameMode(
  decision: PrivacyFrameDecision,
  sanitizedFrameRendered: boolean,
): PrivacyFrameMode {
  if (decision.mode !== "sanitize") return decision.mode;
  return sanitizedFrameRendered ? "sanitize" : "hold";
}
