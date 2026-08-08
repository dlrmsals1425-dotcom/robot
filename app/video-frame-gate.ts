export type VideoFrameGateState = {
  lastFrameSequence: number | null;
  lastFrameAt: number | null;
  stalled: boolean;
};

export type VideoFrameGateResult = {
  state: VideoFrameGateState;
  shouldAnalyze: boolean;
  justStalled: boolean;
  justResumed: boolean;
};

export function createVideoFrameGateState(): VideoFrameGateState {
  return {
    lastFrameSequence: null,
    lastFrameAt: null,
    stalled: false,
  };
}

/**
 * Prevents a frozen remote frame from being analyzed repeatedly. The caller
 * must supply a counter backed by requestVideoFrameCallback, totalVideoFrames,
 * or another decoded-frame signal — never the media playback clock.
 */
export function updateVideoFrameGate(
  previous: VideoFrameGateState,
  input: {
    frameSequence: number;
    now: number;
    stallAfterMs: number;
  },
): VideoFrameGateResult {
  const frameSequence = Number.isFinite(input.frameSequence)
    ? Math.max(0, Math.floor(input.frameSequence))
    : previous.lastFrameSequence;
  const firstFrame = previous.lastFrameSequence === null;
  const decodedNewFrame =
    firstFrame ||
    (frameSequence !== null &&
      previous.lastFrameSequence !== null &&
      frameSequence > previous.lastFrameSequence);

  if (decodedNewFrame && frameSequence !== null) {
    return {
      state: {
        lastFrameSequence: frameSequence,
        lastFrameAt: input.now,
        stalled: false,
      },
      shouldAnalyze: true,
      justStalled: false,
      justResumed: previous.stalled,
    };
  }

  const stalled =
    previous.lastFrameAt !== null &&
    input.now - previous.lastFrameAt >= input.stallAfterMs;
  return {
    state: {
      ...previous,
      stalled: previous.stalled || stalled,
    },
    shouldAnalyze: false,
    justStalled: stalled && !previous.stalled,
    justResumed: false,
  };
}
