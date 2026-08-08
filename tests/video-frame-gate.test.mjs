import assert from "node:assert/strict";
import test from "node:test";

import {
  createVideoFrameGateState,
  updateVideoFrameGate,
} from "../app/video-frame-gate.ts";

test("analyzes only newly decoded frame sequences", () => {
  let state = createVideoFrameGateState();
  let result = updateVideoFrameGate(state, {
    frameSequence: 1,
    now: 100,
    stallAfterMs: 1_500,
  });
  assert.equal(result.shouldAnalyze, true);
  state = result.state;

  result = updateVideoFrameGate(state, {
    frameSequence: 1,
    now: 300,
    stallAfterMs: 1_500,
  });
  assert.equal(result.shouldAnalyze, false);
  assert.equal(result.justStalled, false);
  state = result.state;

  result = updateVideoFrameGate(state, {
    frameSequence: 2,
    now: 340,
    stallAfterMs: 1_500,
  });
  assert.equal(result.shouldAnalyze, true);
  assert.equal(result.justResumed, false);
});

test("marks a frozen frame stalled once and resumes on a new frame", () => {
  let result = updateVideoFrameGate(createVideoFrameGateState(), {
    frameSequence: 8,
    now: 1_000,
    stallAfterMs: 1_500,
  });
  let state = result.state;

  result = updateVideoFrameGate(state, {
    frameSequence: 8,
    now: 2_500,
    stallAfterMs: 1_500,
  });
  assert.equal(result.justStalled, true);
  assert.equal(result.state.stalled, true);
  state = result.state;

  result = updateVideoFrameGate(state, {
    frameSequence: 8,
    now: 3_000,
    stallAfterMs: 1_500,
  });
  assert.equal(result.justStalled, false);
  state = result.state;

  result = updateVideoFrameGate(state, {
    frameSequence: 9,
    now: 3_033,
    stallAfterMs: 1_500,
  });
  assert.equal(result.shouldAnalyze, true);
  assert.equal(result.justResumed, true);
  assert.equal(result.state.stalled, false);
});
