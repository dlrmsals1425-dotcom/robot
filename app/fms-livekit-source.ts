import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RoomOptions,
} from "livekit-client";

export type FmsLiveKitSourceState =
  | "connecting"
  | "waiting"
  | "live"
  | "reconnecting"
  | "error";

export type FmsLiveKitFeed = {
  id: string;
  participantIdentity: string;
  participantName: string;
  trackName: string;
  source: Track.Source;
  selected: boolean;
  subscribed: boolean;
};

export type FmsLiveKitConnection = {
  url: string;
  token: string;
};

export type FmsLiveKitRoomFactory = (options: RoomOptions) => Room;

export type FmsLiveKitVideoSourceOptions = {
  video: HTMLVideoElement;
  roomFactory?: FmsLiveKitRoomFactory;
  onFeeds?: (feeds: readonly FmsLiveKitFeed[]) => void;
  onState?: (state: FmsLiveKitSourceState) => void;
  onMediaStream?: (stream: MediaStream | null) => void;
};

type FeedRecord = {
  id: string;
  participant: RemoteParticipant;
  publication: RemoteTrackPublication;
};

type AttachedTrack = {
  id: string;
  track: RemoteTrack;
};

const defaultRoomFactory: FmsLiveKitRoomFactory = (options) =>
  new Room(options);

function normalizedTrackName(name: string) {
  return name.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function feedPriority(record: FeedRecord) {
  const name = normalizedTrackName(record.publication.trackName);
  if (name === "front_view") return 0;
  if (name.includes("front_view")) return 1;
  return 2;
}

function compareFeedRecords(left: FeedRecord, right: FeedRecord) {
  const priority = feedPriority(left) - feedPriority(right);
  if (priority !== 0) return priority;
  const participant = left.participant.identity.localeCompare(
    right.participant.identity,
  );
  if (participant !== 0) return participant;
  const trackName = left.publication.trackName.localeCompare(
    right.publication.trackName,
  );
  if (trackName !== 0) return trackName;
  return left.id.localeCompare(right.id);
}

function mediaStreamFromVideo(video: HTMLVideoElement): MediaStream | null {
  const source = video.srcObject;
  if (
    source &&
    typeof (source as MediaStream).getTracks === "function"
  ) {
    return source as MediaStream;
  }
  return null;
}

/**
 * Selective LiveKit receiver for a ROBOTIS FMS room.
 *
 * Only one remote video publication is desired at a time. Audio publications
 * are never subscribed, and credentials are passed directly to LiveKit without
 * being logged or retained by this adapter.
 */
export class FmsLiveKitVideoSource {
  private readonly video: HTMLVideoElement;
  private readonly roomFactory: FmsLiveKitRoomFactory;
  private readonly onFeeds?: FmsLiveKitVideoSourceOptions["onFeeds"];
  private readonly onState?: FmsLiveKitVideoSourceOptions["onState"];
  private readonly onMediaStream?:
    FmsLiveKitVideoSourceOptions["onMediaStream"];
  private room: Room | null = null;
  private records = new Map<string, FeedRecord>();
  private selectedId: string | null = null;
  private manualSelectionId: string | null = null;
  private attached: AttachedTrack | null = null;
  private connected = false;
  private state: FmsLiveKitSourceState = "waiting";
  private runId = 0;
  private attachmentId = 0;

  constructor(options: FmsLiveKitVideoSourceOptions) {
    this.video = options.video;
    this.roomFactory = options.roomFactory ?? defaultRoomFactory;
    this.onFeeds = options.onFeeds;
    this.onState = options.onState;
    this.onMediaStream = options.onMediaStream;
  }

  get feeds(): readonly FmsLiveKitFeed[] {
    return this.feedSnapshot();
  }

  get currentState(): FmsLiveKitSourceState {
    return this.state;
  }

  get selectedFeedId(): string | null {
    return this.selectedId;
  }

  async connect(connection: FmsLiveKitConnection): Promise<void> {
    const runId = ++this.runId;
    await this.releaseCurrentRoom(true);
    if (runId !== this.runId) return;

    this.setState("connecting");
    const room = this.roomFactory({ adaptiveStream: false });
    this.room = room;
    this.bindRoom(room);

    try {
      await room.connect(connection.url, connection.token, {
        autoSubscribe: false,
      });
      if (runId !== this.runId || this.room !== room) {
        this.unbindRoom(room);
        await room.disconnect().catch(() => undefined);
        return;
      }

      this.connected = true;
      this.collectExistingPublications(room);
      this.reconcileSelection();
      if (!this.attached) this.setState("waiting");
    } catch {
      if (runId === this.runId && this.room === room) {
        this.releaseRoomState(room);
      } else {
        this.unbindRoom(room);
      }
      await room.disconnect().catch(() => undefined);
      throw new Error("FMS 실시간 영상에 연결하지 못했습니다.");
    }
  }

  /**
   * Selects a published video feed. Passing null restores automatic
   * front_view-first selection. Returns false for an unknown feed id.
   */
  selectFeed(feedId: string | null): boolean {
    if (feedId !== null && !this.records.has(feedId)) return false;
    this.manualSelectionId = feedId;
    this.reconcileSelection();
    return true;
  }

  async resumeVideo(): Promise<boolean> {
    const room = this.room;
    if (!room || !this.attached) return false;
    try {
      await room.startVideo();
      await this.video.play();
      if (room === this.room && this.attached) this.setState("live");
      return room === this.room && this.attached !== null;
    } catch {
      if (room === this.room) this.setState("waiting");
      return false;
    }
  }

  async disconnect(): Promise<void> {
    ++this.runId;
    await this.releaseCurrentRoom(true);
    this.setState("waiting");
  }

  private readonly handleTrackPublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    this.registerPublication(publication, participant);
    if (this.connected) this.reconcileSelection();
  };

  private readonly handleTrackUnpublished = (
    publication: RemoteTrackPublication,
  ) => {
    const record = this.records.get(publication.trackSid);
    if (!record) {
      if (publication.kind === Track.Kind.Audio) {
        publication.setSubscribed(false);
      }
      return;
    }

    if (this.manualSelectionId === record.id) {
      this.manualSelectionId = null;
    }
    if (this.selectedId === record.id) {
      publication.setSubscribed(false);
      this.detachAttached(record.id);
      this.selectedId = null;
    }
    this.records.delete(record.id);
    this.reconcileSelection();
  };

  private readonly handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
  ) => {
    const record = this.records.get(publication.trackSid);
    if (
      track.kind !== Track.Kind.Video ||
      !record ||
      record.id !== this.selectedId
    ) {
      publication.setSubscribed(false);
      track.detach();
      this.emitFeeds();
      return;
    }

    this.attachTrack(record, track);
    this.emitFeeds();
  };

  private readonly handleTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
  ) => {
    const record = this.records.get(publication.trackSid);
    if (this.attached?.track === track) {
      this.detachAttached(publication.trackSid);
    } else {
      track.detach();
    }
    if (record?.id === this.selectedId) this.setState("waiting");
    this.emitFeeds();
  };

  private readonly handleReconnecting = () => {
    this.setState("reconnecting");
  };

  private readonly handleReconnected = () => {
    const room = this.room;
    if (!room) return;
    this.connected = true;
    this.collectExistingPublications(room);
    this.reconcileSelection(true);
    this.setState(this.attached ? "live" : "waiting");
  };

  private readonly handleDisconnected = (reason?: DisconnectReason) => {
    const room = this.room;
    if (!room) return;
    const wasConnected = this.connected;
    this.releaseRoomState(room);
    // LiveKit can emit Disconnected before room.connect() rejects. In that
    // initial-failure path, let connect() surface the actual join error instead
    // of misreporting it as a previously-live session ending. Deliberate
    // disconnects are unbound before Room.disconnect() and normally never reach
    // this callback, but keep the reason guard for SDK/server variations.
    if (wasConnected && reason !== DisconnectReason.CLIENT_INITIATED) {
      this.setState("error");
    } else if (wasConnected) {
      this.setState("waiting");
    }
  };

  private readonly handleVideoPlaybackStatusChanged = (playing: boolean) => {
    if (!this.attached) return;
    this.setState(playing ? "live" : "waiting");
  };

  private bindRoom(room: Room) {
    room
      .on(RoomEvent.TrackPublished, this.handleTrackPublished)
      .on(RoomEvent.TrackUnpublished, this.handleTrackUnpublished)
      .on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed)
      .on(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed)
      .on(RoomEvent.Reconnecting, this.handleReconnecting)
      .on(RoomEvent.SignalReconnecting, this.handleReconnecting)
      .on(RoomEvent.Reconnected, this.handleReconnected)
      .on(RoomEvent.Disconnected, this.handleDisconnected)
      .on(
        RoomEvent.VideoPlaybackStatusChanged,
        this.handleVideoPlaybackStatusChanged,
      );
  }

  private unbindRoom(room: Room) {
    room.off(RoomEvent.TrackPublished, this.handleTrackPublished);
    room.off(RoomEvent.TrackUnpublished, this.handleTrackUnpublished);
    room.off(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    room.off(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed);
    room.off(RoomEvent.Reconnecting, this.handleReconnecting);
    room.off(RoomEvent.SignalReconnecting, this.handleReconnecting);
    room.off(RoomEvent.Reconnected, this.handleReconnected);
    room.off(RoomEvent.Disconnected, this.handleDisconnected);
    room.off(
      RoomEvent.VideoPlaybackStatusChanged,
      this.handleVideoPlaybackStatusChanged,
    );
  }

  private collectExistingPublications(room: Room) {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        this.registerPublication(publication, participant);
      }
    }
  }

  private registerPublication(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) {
    if (publication.kind !== Track.Kind.Video) {
      publication.setSubscribed(false);
      return;
    }
    this.records.set(publication.trackSid, {
      id: publication.trackSid,
      participant,
      publication,
    });
    this.emitFeeds();
  }

  private automaticSelection(): FeedRecord | null {
    return [...this.records.values()].sort(compareFeedRecords)[0] ?? null;
  }

  private reconcileSelection(force = false) {
    if (!this.connected) {
      this.emitFeeds();
      return;
    }

    const manual = this.manualSelectionId
      ? this.records.get(this.manualSelectionId) ?? null
      : null;
    const target = manual ?? this.automaticSelection();
    const nextId = target?.id ?? null;
    const previousId = this.selectedId;

    if (!force && nextId === previousId) {
      this.emitFeeds();
      return;
    }

    const previous = previousId ? this.records.get(previousId) : null;
    if (previous && previous.id !== nextId) {
      previous.publication.setSubscribed(false);
      this.detachAttached(previous.id);
    }

    this.selectedId = nextId;
    for (const record of this.records.values()) {
      if (record.id !== nextId && record.id !== previous?.id) {
        record.publication.setSubscribed(false);
      }
    }
    if (target) target.publication.setSubscribed(true);

    if (!target || !this.attached || this.attached.id !== target.id) {
      this.setState("waiting");
    }
    this.emitFeeds();
  }

  private attachTrack(record: FeedRecord, track: RemoteTrack) {
    if (this.attached?.id === record.id && this.attached.track === track) {
      return;
    }
    this.detachAttached();

    this.video.muted = true;
    this.video.playsInline = true;
    track.attach(this.video);
    this.attached = { id: record.id, track };
    const attachmentId = ++this.attachmentId;
    this.onMediaStream?.(mediaStreamFromVideo(this.video));

    let playback: Promise<void>;
    try {
      playback = this.video.play();
    } catch {
      this.setState("waiting");
      return;
    }
    void playback.then(
      () => {
        if (
          attachmentId === this.attachmentId &&
          this.attached?.id === record.id
        ) {
          this.setState("live");
        }
      },
      () => {
        if (
          attachmentId === this.attachmentId &&
          this.attached?.id === record.id
        ) {
          this.setState("waiting");
        }
      },
    );
  }

  private detachAttached(expectedId?: string) {
    const attached = this.attached;
    if (!attached || (expectedId && attached.id !== expectedId)) return;
    ++this.attachmentId;
    attached.track.detach(this.video);
    this.attached = null;
    try {
      this.video.pause();
    } catch {
      // Some test and embedded media elements do not implement pause.
    }
    if (this.video.srcObject !== null) this.video.srcObject = null;
    this.onMediaStream?.(null);
  }

  private feedSnapshot(): FmsLiveKitFeed[] {
    return [...this.records.values()].sort(compareFeedRecords).map((record) => ({
      id: record.id,
      participantIdentity: record.participant.identity,
      participantName: record.participant.name ?? "",
      trackName: record.publication.trackName,
      source: record.publication.source,
      selected: record.id === this.selectedId,
      subscribed: record.publication.isSubscribed,
    }));
  }

  private emitFeeds() {
    this.onFeeds?.(this.feedSnapshot());
  }

  private setState(next: FmsLiveKitSourceState) {
    if (this.state === next) return;
    this.state = next;
    this.onState?.(next);
  }

  private releaseRoomState(room: Room) {
    this.unbindRoom(room);
    if (this.room === room) this.room = null;
    this.connected = false;
    for (const record of this.records.values()) {
      record.publication.setSubscribed(false);
    }
    this.detachAttached();
    this.records.clear();
    this.selectedId = null;
    this.manualSelectionId = null;
    this.emitFeeds();
  }

  private async releaseCurrentRoom(disconnectRoom: boolean) {
    const room = this.room;
    if (!room) {
      this.connected = false;
      this.detachAttached();
      this.records.clear();
      this.selectedId = null;
      this.manualSelectionId = null;
      this.emitFeeds();
      return;
    }

    this.releaseRoomState(room);
    if (disconnectRoom) {
      await room.disconnect().catch(() => undefined);
    }
  }
}
