import assert from "node:assert/strict";
import test from "node:test";

import { RoomEvent, Track } from "livekit-client";

import { FmsLiveKitVideoSource } from "../app/fms-livekit-source.ts";

class FakeMediaStream {
  constructor(id) {
    this.id = id;
  }

  getTracks() {
    return [];
  }
}

class FakeTrack {
  constructor(kind, id) {
    this.kind = kind;
    this.stream = new FakeMediaStream(id);
    this.attachCalls = [];
    this.detachCalls = [];
  }

  attach(element) {
    this.attachCalls.push(element);
    element.srcObject = this.stream;
    return element;
  }

  detach(element) {
    this.detachCalls.push(element);
    if (element?.srcObject === this.stream) element.srcObject = null;
    return element ? element : [];
  }
}

class FakePublication {
  constructor({ sid, name, kind, source, track }) {
    this.trackSid = sid;
    this.trackName = name;
    this.kind = kind;
    this.source = source;
    this.track = track;
    this.isSubscribed = false;
    this.subscriptionCalls = [];
  }

  setSubscribed(subscribed) {
    this.subscriptionCalls.push(subscribed);
    this.isSubscribed = subscribed;
  }
}

class FakeParticipant {
  constructor(identity, publications, name = "Robot 107") {
    this.identity = identity;
    this.name = name;
    this.trackPublications = new Map(
      publications.map((publication) => [publication.trackSid, publication]),
    );
  }
}

class FakeRoom {
  constructor(participants = []) {
    this.remoteParticipants = new Map(
      participants.map((participant) => [participant.identity, participant]),
    );
    this.listeners = new Map();
    this.connectCalls = [];
    this.disconnectCalls = 0;
    this.startVideoCalls = 0;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  async connect(url, token, options) {
    this.connectCalls.push({ url, token, options });
  }

  async disconnect() {
    this.disconnectCalls += 1;
  }

  async startVideo() {
    this.startVideoCalls += 1;
  }

  listenerCount() {
    return [...this.listeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
  }
}

function fakeVideo() {
  return {
    muted: false,
    playsInline: false,
    srcObject: null,
    playCalls: 0,
    pauseCalls: 0,
    async play() {
      this.playCalls += 1;
    },
    pause() {
      this.pauseCalls += 1;
    },
  };
}

function videoPublication(sid, name) {
  return new FakePublication({
    sid,
    name,
    kind: Track.Kind.Video,
    source: Track.Source.Camera,
    track: new FakeTrack(Track.Kind.Video, `${sid}-stream`),
  });
}

function audioPublication(sid = "audio-1") {
  return new FakePublication({
    sid,
    name: "microphone",
    kind: Track.Kind.Audio,
    source: Track.Source.Microphone,
    track: new FakeTrack(Track.Kind.Audio, `${sid}-stream`),
  });
}

async function harness(publications) {
  const participant = new FakeParticipant("robot-107", publications);
  const room = new FakeRoom([participant]);
  const video = fakeVideo();
  const states = [];
  const feedSnapshots = [];
  const mediaStreams = [];
  let roomOptions;
  const source = new FmsLiveKitVideoSource({
    video,
    roomFactory(options) {
      roomOptions = options;
      return room;
    },
    onFeeds(feeds) {
      feedSnapshots.push(feeds.map((feed) => ({ ...feed })));
    },
    onState(state) {
      states.push(state);
    },
    onMediaStream(stream) {
      mediaStreams.push(stream);
    },
  });

  await source.connect({
    url: "wss://livekit.example.test",
    token: "short-lived-test-token",
  });
  return {
    source,
    room,
    roomOptions,
    participant,
    video,
    states,
    feedSnapshots,
    mediaStreams,
  };
}

async function emitSubscribed(room, participant, publication) {
  publication.isSubscribed = true;
  room.emit(
    RoomEvent.TrackSubscribed,
    publication.track,
    publication,
    participant,
  );
  await Promise.resolve();
}

function countDesired(publications) {
  return publications.filter((publication) => publication.isSubscribed).length;
}

test("connects with manual subscription and never subscribes to audio", async () => {
  const audio = audioPublication();
  const rear = videoPublication("video-rear", "rear_view");
  const context = await harness([audio, rear]);

  assert.equal(context.roomOptions.adaptiveStream, false);
  assert.deepEqual(context.room.connectCalls, [
    {
      url: "wss://livekit.example.test",
      token: "short-lived-test-token",
      options: { autoSubscribe: false },
    },
  ]);
  assert.equal(audio.subscriptionCalls.includes(true), false);
  assert.deepEqual(rear.subscriptionCalls, [true]);
  assert.equal(countDesired([audio, rear]), 1);
  assert.deepEqual(context.states, ["connecting", "waiting"]);

  await emitSubscribed(context.room, context.participant, rear);
  assert.equal(context.video.muted, true);
  assert.equal(context.video.playsInline, true);
  assert.equal(context.video.playCalls, 1);
  assert.deepEqual(rear.track.attachCalls, [context.video]);
  assert.equal(context.mediaStreams.at(-1), rear.track.stream);
  assert.equal(context.states.at(-1), "live");
  assert.deepEqual(
    context.feedSnapshots.at(-1).map((feed) => feed.trackName),
    ["rear_view"],
  );

  audio.isSubscribed = true;
  context.room.emit(
    RoomEvent.TrackSubscribed,
    audio.track,
    audio,
    context.participant,
  );
  assert.equal(audio.isSubscribed, false);
  assert.equal(audio.track.attachCalls.length, 0);
  assert.equal(audio.track.detachCalls.length, 1);
  assert.equal(rear.isSubscribed, true);
});

test("selects name=front_view before other video publications", async () => {
  const rear = videoPublication("video-rear", "rear_view");
  const side = videoPublication("video-side", "side_view");
  const front = videoPublication("video-front", "front_view");
  const context = await harness([rear, side, front]);

  assert.equal(context.source.selectedFeedId, front.trackSid);
  assert.equal(front.subscriptionCalls.includes(true), true);
  assert.equal(rear.subscriptionCalls.includes(true), false);
  assert.equal(side.subscriptionCalls.includes(true), false);
  assert.equal(countDesired([rear, side, front]), 1);
  assert.deepEqual(
    context.feedSnapshots.at(-1).map((feed) => [feed.trackName, feed.selected]),
    [
      ["front_view", true],
      ["rear_view", false],
      ["side_view", false],
    ],
  );
});

test("switches subscriptions for a newly published front feed and manual selection", async () => {
  const rear = videoPublication("video-rear", "rear_view");
  const context = await harness([rear]);
  await emitSubscribed(context.room, context.participant, rear);

  const front = videoPublication("video-front", "front-view-main");
  context.participant.trackPublications.set(front.trackSid, front);
  context.room.emit(
    RoomEvent.TrackPublished,
    front,
    context.participant,
  );

  assert.equal(rear.subscriptionCalls.at(-1), false);
  assert.equal(front.subscriptionCalls.at(-1), true);
  assert.equal(context.source.selectedFeedId, front.trackSid);
  assert.equal(rear.track.detachCalls.at(-1), context.video);
  assert.equal(countDesired([rear, front]), 1);

  await emitSubscribed(context.room, context.participant, front);
  assert.equal(front.track.attachCalls.at(-1), context.video);
  assert.equal(context.mediaStreams.at(-1), front.track.stream);

  assert.equal(context.source.selectFeed(rear.trackSid), true);
  assert.equal(front.subscriptionCalls.at(-1), false);
  assert.equal(rear.subscriptionCalls.at(-1), true);
  assert.equal(front.track.detachCalls.at(-1), context.video);
  assert.equal(context.source.selectFeed("missing-feed"), false);
  assert.equal(countDesired([rear, front]), 1);

  await emitSubscribed(context.room, context.participant, rear);
  assert.equal(rear.track.attachCalls.at(-1), context.video);
  assert.equal(context.source.selectedFeedId, rear.trackSid);
});

test("handles playback, reconnection, unsubscription, and resume events", async () => {
  const front = videoPublication("video-front", "front_view");
  const context = await harness([front]);
  await emitSubscribed(context.room, context.participant, front);

  context.room.emit(RoomEvent.Reconnecting);
  assert.equal(context.states.at(-1), "reconnecting");
  context.room.emit(RoomEvent.Reconnected);
  assert.equal(context.states.at(-1), "live");

  context.room.emit(RoomEvent.VideoPlaybackStatusChanged, false);
  assert.equal(context.states.at(-1), "waiting");
  assert.equal(await context.source.resumeVideo(), true);
  assert.equal(context.room.startVideoCalls, 1);
  assert.equal(context.states.at(-1), "live");

  front.isSubscribed = false;
  context.room.emit(
    RoomEvent.TrackUnsubscribed,
    front.track,
    front,
    context.participant,
  );
  assert.equal(context.states.at(-1), "waiting");
  assert.equal(context.mediaStreams.at(-1), null);
  assert.equal(front.track.detachCalls.at(-1), context.video);
});

test("disconnect removes listeners, unsubscribes, detaches, and clears snapshots", async () => {
  const front = videoPublication("video-front", "front_view");
  const context = await harness([front]);
  await emitSubscribed(context.room, context.participant, front);
  assert.ok(context.room.listenerCount() > 0);

  await context.source.disconnect();
  assert.equal(context.room.listenerCount(), 0);
  assert.equal(context.room.disconnectCalls, 1);
  assert.equal(front.subscriptionCalls.at(-1), false);
  assert.equal(front.track.detachCalls.at(-1), context.video);
  assert.equal(context.video.srcObject, null);
  assert.deepEqual(context.feedSnapshots.at(-1), []);
  assert.equal(context.mediaStreams.at(-1), null);
  assert.equal(context.states.at(-1), "waiting");

  const previousSnapshotCount = context.feedSnapshots.length;
  context.room.emit(
    RoomEvent.TrackPublished,
    videoPublication("late-video", "front_view"),
    context.participant,
  );
  assert.equal(context.feedSnapshots.length, previousSnapshotCount);
});

test("unexpected room disconnection clears media and reports error", async () => {
  const front = videoPublication("video-front", "front_view");
  const context = await harness([front]);
  await emitSubscribed(context.room, context.participant, front);

  context.room.emit(RoomEvent.Disconnected);
  assert.equal(context.states.at(-1), "error");
  assert.equal(context.room.listenerCount(), 0);
  assert.equal(context.mediaStreams.at(-1), null);
  assert.deepEqual(context.source.feeds, []);
});
