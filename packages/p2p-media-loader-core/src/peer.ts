import { PeerConnection } from "bittorrent-tracker";
import {
  JsonSegmentAnnouncement,
  PeerCommand,
  PeerSegmentAnnouncementCommand,
  PeerSegmentCommand,
  PeerSendSegmentCommand,
} from "./internal-types";
import { PeerCommandType, PeerSegmentStatus } from "./enums";
import * as PeerUtil from "./utils/peer-utils";
import { P2PRequest } from "./request";
import { Segment, Settings } from "./types";
import * as Utils from "./utils/utils";
import { PeerRequestError } from "./errors";
import debug from "debug";

type PeerEventHandlers = {
  onPeerConnected: (peer: Peer) => void;
  onPeerClosed: (peer: Peer) => void;
  onSegmentRequested: (peer: Peer, segmentId: string) => void;
};

type PeerRequest = {
  segment: Segment;
  p2pRequest: P2PRequest;
  resolve: (data: ArrayBuffer) => void;
  reject: (error: PeerRequestError) => void;
  chunks: ArrayBuffer[];
  responseTimeoutId: number;
};

type PeerSettings = Pick<
  Settings,
  "p2pSegmentDownloadTimeout" | "webRtcMaxMessageSize"
>;

export class Peer {
  readonly id: string;
  private connection?: PeerConnection;
  private segments = new Map<string, PeerSegmentStatus>();
  private request?: PeerRequest;
  private isSendingData = false;
  private readonly logger = debug("core:peer");

  constructor(
    connection: PeerConnection,
    private readonly eventHandlers: PeerEventHandlers,
    private readonly settings: PeerSettings
  ) {
    this.id = hexToUtf8(connection.id);
    this.eventHandlers = eventHandlers;
    this.setConnection(connection);
  }

  setConnection(connection: PeerConnection) {
    connection.on("connect", () => {
      if (!this.connection) {
        this.connection = connection;
        this.eventHandlers.onPeerConnected(this);
        this.logger(`connected with peer: ${this.id}`);
      } else {
        connection.destroy();
      }
    });
    connection.on("data", this.onReceiveData.bind(this));
    connection.on("close", () => {
      this.connection = undefined;
      this.cancelSegmentRequest("peer-closed");
      this.logger(`connection with peer closed: ${this.id}`);
      this.eventHandlers.onPeerClosed(this);
    });
    connection.on("error", (error) => {
      if (error.code === "ERR_DATA_CHANNEL") {
        this.logger(`peer error: ${this.id} ${error.code}`);
        this.destroy();
        this.eventHandlers.onPeerClosed(this);
      }
    });
  }

  get isConnected() {
    return !!this.connection;
  }

  get downloadingSegment(): Segment | undefined {
    return this.request?.segment;
  }

  getSegmentStatus(segment: Segment): PeerSegmentStatus | undefined {
    const { externalId } = segment;
    return this.segments.get(externalId);
  }

  private onReceiveData(data: ArrayBuffer) {
    const command = PeerUtil.getPeerCommandFromArrayBuffer(data);
    if (!command) {
      this.receiveSegmentChunk(data);
      return;
    }

    switch (command.c) {
      case PeerCommandType.SegmentsAnnouncement:
        this.segments = PeerUtil.getSegmentsFromPeerAnnouncement(command.a);
        break;

      case PeerCommandType.SegmentRequest:
        this.eventHandlers.onSegmentRequested(this, command.i);
        break;

      case PeerCommandType.SegmentData:
        if (this.request?.segment.externalId === command.i) {
          this.request.p2pRequest.progress = {
            percent: 0,
            loadedBytes: 0,
            totalBytes: command.s,
          };
        }
        break;

      case PeerCommandType.SegmentAbsent:
        if (this.request?.segment.externalId === command.i) {
          this.cancelSegmentRequest("segment-absent");
          this.segments.delete(command.i);
        }
        break;

      case PeerCommandType.CancelSegmentRequest:
        this.stopSendSegmentData();
        break;
    }
  }

  private sendCommand(command: PeerCommand) {
    if (!this.connection) return;
    this.connection.send(JSON.stringify(command));
  }

  requestSegment(segment: Segment) {
    if (this.request) {
      throw new Error("Segment already is downloading");
    }
    const { externalId } = segment;
    const command: PeerSegmentCommand = {
      c: PeerCommandType.SegmentRequest,
      i: externalId,
    };
    this.sendCommand(command);
    this.request = this.createPeerRequest(segment);
    return this.request.p2pRequest;
  }

  sendSegmentsAnnouncement(announcement: JsonSegmentAnnouncement) {
    const command: PeerSegmentAnnouncementCommand = {
      c: PeerCommandType.SegmentsAnnouncement,
      a: announcement,
    };
    this.sendCommand(command);
  }

  sendSegmentData(segmentExternalId: string, data: ArrayBuffer) {
    if (!this.connection) return;
    this.logger(`send segment ${segmentExternalId} to peer ${this.id}`);
    const command: PeerSendSegmentCommand = {
      c: PeerCommandType.SegmentData,
      i: segmentExternalId,
      s: data.byteLength,
    };
    this.sendCommand(command);

    this.isSendingData = true;
    for (const chunk of getBufferChunks(
      data,
      this.settings.webRtcMaxMessageSize
    )) {
      if (!this.isSendingData) break;
      this.connection?.send(chunk);
    }
    this.isSendingData = false;
  }

  stopSendSegmentData() {
    // TODO: revise sending cancellation
    this.isSendingData = false;
  }

  sendSegmentAbsent(segmentExternalId: string) {
    const command: PeerSegmentCommand = {
      c: PeerCommandType.SegmentAbsent,
      i: segmentExternalId,
    };
    this.sendCommand(command);
  }

  private createPeerRequest(segment: Segment): PeerRequest {
    const { promise, resolve, reject } =
      Utils.getControlledPromise<ArrayBuffer>();
    return {
      segment,
      resolve,
      reject,
      responseTimeoutId: this.setRequestTimeout(),
      chunks: [],
      p2pRequest: {
        type: "p2p",
        startTimestamp: performance.now(),
        promise,
        abort: () => this.cancelSegmentRequest("abort"),
      },
    };
  }

  private receiveSegmentChunk(chunk: ArrayBuffer): void {
    const { request } = this;
    const progress = request?.p2pRequest?.progress;
    if (!request || !progress) return;

    progress.loadedBytes += chunk.byteLength;
    progress.percent = (progress.loadedBytes / progress.loadedBytes) * 100;
    progress.lastLoadedChunkTimestamp = performance.now();
    request.chunks.push(chunk);

    if (progress.loadedBytes === progress.totalBytes) {
      const segmentData = joinChunks(request.chunks);
      this.approveRequest(segmentData);
    } else if (progress.loadedBytes > progress.totalBytes) {
      this.cancelSegmentRequest("response-bytes-mismatch");
    }
  }

  private approveRequest(data: ArrayBuffer) {
    this.request?.resolve(data);
    this.clearRequest();
  }

  private cancelSegmentRequest(type: PeerRequestError["type"]) {
    this.logger(
      `cancel segment ${this.request?.segment.externalId} request (${type})`
    );
    const error = new PeerRequestError(type);
    if (!this.request) return;
    if (!["segment-absent", "peer-closed"].includes(type)) {
      this.sendCommand({
        c: PeerCommandType.CancelSegmentRequest,
        i: this.request.segment.externalId,
      });
    }
    this.request.reject(error);
    this.clearRequest();
  }

  private setRequestTimeout(): number {
    return window.setTimeout(
      () => this.cancelSegmentRequest("request-timeout"),
      this.settings.p2pSegmentDownloadTimeout
    );
  }

  private clearRequest() {
    clearTimeout(this.request?.responseTimeoutId);
    this.request = undefined;
  }

  destroy() {
    this.cancelSegmentRequest("destroy");
    this.connection?.destroy();
  }
}

function* getBufferChunks(
  data: ArrayBuffer,
  maxChunkSize: number
): Generator<ArrayBuffer> {
  let bytesLeft = data.byteLength;
  while (bytesLeft > 0) {
    const bytesToSend = bytesLeft >= maxChunkSize ? maxChunkSize : bytesLeft;
    const from = data.byteLength - bytesLeft;
    const buffer = data.slice(from, from + bytesToSend);
    bytesLeft -= bytesToSend;
    yield buffer;
  }
}

function joinChunks(chunks: ArrayBuffer[]): ArrayBuffer {
  const bytesSum = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const buffer = new Uint8Array(bytesSum);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  return buffer;
}

function hexToUtf8(hexString: string) {
  const bytes = new Uint8Array(hexString.length / 2);

  for (let i = 0; i < hexString.length; i += 2) {
    bytes[i / 2] = parseInt(hexString.slice(i, i + 2), 16);
  }
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}
