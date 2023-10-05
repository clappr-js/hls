import TrackerClient, { PeerCandidate } from "bittorrent-tracker";
import * as RIPEMD160 from "ripemd160";
import { Peer } from "./peer";
import * as PeerUtil from "./utils/peer-utils";
import { Segment, Settings, StreamWithSegments } from "./types";
import { JsonSegmentAnnouncement } from "./internal-types";
import { SegmentsMemoryStorage } from "./segments-storage";
import * as Utils from "./utils/utils";
import * as LoggerUtils from "./utils/logger";
import { PeerSegmentStatus } from "./enums";
import { RequestContainer } from "./request";
import debug from "debug";

export class P2PLoader {
  private readonly streamExternalId: string;
  private readonly streamHash: string;
  private readonly peerHash: string;
  private readonly trackerClient: TrackerClient;
  private readonly peers = new Map<string, Peer>();
  private announcement: JsonSegmentAnnouncement = { i: "" };
  private readonly logger = debug("core:p2p-manager");

  constructor(
    private streamManifestUrl: string,
    private readonly stream: StreamWithSegments,
    private readonly requests: RequestContainer,
    private readonly segmentStorage: SegmentsMemoryStorage,
    private readonly settings: Settings
  ) {
    const peerId = PeerUtil.generatePeerId();
    this.streamExternalId = Utils.getStreamExternalId(
      this.streamManifestUrl,
      this.stream
    );
    this.streamHash = getHash(this.streamExternalId);
    this.peerHash = getHash(peerId);

    this.trackerClient = createTrackerClient({
      streamHash: this.streamHash,
      peerHash: this.peerHash,
    });
    this.logger(
      `create tracker client: ${LoggerUtils.getStreamString(stream)}`
    );
    this.subscribeOnTrackerEvents(this.trackerClient);
    this.segmentStorage.subscribeOnUpdate(
      this.stream,
      this.updateAndBroadcastAnnouncement
    );
    this.requests.subscribeOnHttpRequestsUpdate(
      this.updateAndBroadcastAnnouncement
    );
    this.updateSegmentAnnouncement();
    this.trackerClient.start();
  }

  private subscribeOnTrackerEvents(trackerClient: TrackerClient) {
    // TODO: tracker event handlers
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    trackerClient.on("update", () => {});
    trackerClient.on("peer", (candidate) => {
      const peer = this.peers.get(candidate.id);
      if (peer) peer.addCandidate(candidate);
      else this.createPeer(candidate);
    });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    trackerClient.on("warning", (warning) => {
      this.logger(
        `tracker warning (${LoggerUtils.getStreamString(
          this.stream
        )}: ${warning})`
      );
    });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    trackerClient.on("error", (error) => {
      this.logger(
        `tracker error (${LoggerUtils.getStreamString(this.stream)}: ${error})`
      );
    });
  }

  private createPeer(candidate: PeerCandidate) {
    const peer = new Peer(
      `${LoggerUtils.getStreamString(this.stream)}-${this.peers.size + 1}`,
      candidate,
      {
        onPeerConnected: this.onPeerConnected.bind(this),
        onSegmentRequested: this.onSegmentRequested.bind(this),
      },
      this.settings
    );
    this.peers.set(candidate.id, peer);
    this.logger(`create new peer: ${peer.localId}`);
  }

  async downloadSegment(segment: Segment): Promise<ArrayBuffer | undefined> {
    const peerWithSegment: Peer[] = [];

    for (const peer of this.peers.values()) {
      if (
        !peer.downloadingSegment &&
        peer.getSegmentStatus(segment) === PeerSegmentStatus.Loaded
      ) {
        peerWithSegment.push(peer);
      }
    }

    if (peerWithSegment.length === 0) return undefined;

    const peer =
      peerWithSegment[Math.floor(Math.random() * peerWithSegment.length)];
    const request = peer.requestSegment(segment);
    this.logger(`p2p request ${segment.externalId}`);
    this.requests.addLoaderRequest(segment, request);
    return request.promise;
  }

  isLoadingOrLoadedBySomeone(segment: Segment): boolean {
    for (const peer of this.peers.values()) {
      if (peer.getSegmentStatus(segment)) return true;
    }
    return false;
  }

  private updateSegmentAnnouncement() {
    const loaded: string[] =
      this.segmentStorage.getStoredSegmentExternalIdsOfStream(this.stream);
    const httpLoading: string[] = [];

    for (const request of this.requests.httpRequests()) {
      const segment = this.stream.segments.get(request.segment.localId);
      if (!segment) continue;

      httpLoading.push(segment.externalId);
    }

    this.announcement = PeerUtil.getJsonSegmentsAnnouncement(
      loaded,
      httpLoading
    );
  }

  private onPeerConnected(peer: Peer) {
    this.logger(`connected with peer: ${peer.localId}`);
    peer.sendSegmentsAnnouncement(this.announcement);
  }

  private updateAndBroadcastAnnouncement = () => {
    this.updateSegmentAnnouncement();
    this.broadcastSegmentAnnouncement();
  };

  private async onSegmentRequested(peer: Peer, segmentExternalId: string) {
    const segment = Utils.getSegmentFromStreamByExternalId(
      this.stream,
      segmentExternalId
    );
    const segmentData =
      segment && (await this.segmentStorage.getSegmentData(segment));
    if (segmentData) peer.sendSegmentData(segmentExternalId, segmentData);
    else peer.sendSegmentAbsent(segmentExternalId);
  }

  private broadcastSegmentAnnouncement() {
    for (const peer of this.peers.values()) {
      if (!peer.isConnected) continue;
      peer.sendSegmentsAnnouncement(this.announcement);
    }
  }

  destroy() {
    this.logger(
      `destroy tracker client: ${LoggerUtils.getStreamString(this.stream)}`
    );
    this.segmentStorage.unsubscribeFromUpdate(
      this.stream,
      this.updateAndBroadcastAnnouncement
    );
    this.requests.unsubscribeFromHttpRequestsUpdate(
      this.updateAndBroadcastAnnouncement
    );
    for (const peer of this.peers.values()) {
      peer.destroy();
    }
    this.peers.clear();
    this.trackerClient.destroy();
  }
}

function getHash(data: string) {
  return new RIPEMD160().update(data).digest("hex");
}

function createTrackerClient({
  streamHash,
  peerHash,
}: {
  streamHash: string;
  peerHash: string;
}) {
  return new TrackerClient({
    infoHash: streamHash,
    peerId: peerHash,
    port: 6881,
    announce: [
      "wss://tracker.novage.com.ua",
      "wss://tracker.openwebtorrent.com",
    ],
    rtcConfig: {
      iceServers: [
        {
          urls: [
            "stun:stun.l.google.com:19302",
            "stun:global.stun.twilio.com:3478",
          ],
        },
      ],
    },
  });
}
