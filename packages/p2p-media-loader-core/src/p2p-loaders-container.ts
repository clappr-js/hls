import { P2PLoader } from "./p2p-loader";
import debug from "debug";
import { Settings, Stream, StreamWithSegments } from "./index";
import { RequestContainer } from "./request";
import { SegmentsMemoryStorage } from "./segments-storage";
import * as LoggerUtils from "./utils/logger";

type P2PLoaderContainerItem = {
  stream: Stream;
  loader: P2PLoader;
  destroyTimeoutId?: number;
  loggerInfo: string;
};

export class P2PLoadersContainer {
  private readonly loaders = new Map<string, P2PLoaderContainerItem>();
  private _activeLoaderItem!: P2PLoaderContainerItem;
  private readonly logger = debug("core:p2p-loaders-container");

  constructor(
    private readonly streamManifestUrl: string,
    stream: StreamWithSegments,
    private readonly requests: RequestContainer,
    private readonly segmentStorage: SegmentsMemoryStorage,
    private readonly settings: Settings
  ) {
    this.changeActiveLoader(stream);
  }

  private createLoader(stream: StreamWithSegments): P2PLoaderContainerItem {
    if (this.loaders.has(stream.localId)) {
      throw new Error("Loader for this stream already exists");
    }
    const loader = new P2PLoader(
      this.streamManifestUrl,
      stream,
      this.requests,
      this.segmentStorage,
      this.settings
    );
    const loggerInfo = LoggerUtils.getStreamString(stream);
    this.logger(`created new loader: ${loggerInfo}`);
    return {
      loader,
      stream,
      loggerInfo: LoggerUtils.getStreamString(stream),
    };
  }

  changeActiveLoader(stream: StreamWithSegments) {
    const loaderItem = this.loaders.get(stream.localId);
    const prevActive = this._activeLoaderItem;
    if (loaderItem) {
      this._activeLoaderItem = loaderItem;
      clearTimeout(loaderItem.destroyTimeoutId);
    } else {
      const loader = this.createLoader(stream);
      this.loaders.set(stream.localId, loader);
      this._activeLoaderItem = loader;
    }
    this.logger(
      `change active p2p loader: ${LoggerUtils.getStreamString(stream)}`
    );

    if (!prevActive) return;

    const ids = this.segmentStorage.getStoredSegmentExternalIdsOfStream(stream);
    if (!ids.length) this.destroyAndRemoveLoader(prevActive);
    else this.setLoaderDestroyTimeout(prevActive);
  }

  private setLoaderDestroyTimeout(item: P2PLoaderContainerItem) {
    item.destroyTimeoutId = window.setTimeout(
      () => this.destroyAndRemoveLoader(item),
      this.settings.p2pLoaderDestroyTimeout
    );
  }

  private destroyAndRemoveLoader(item: P2PLoaderContainerItem) {
    item.loader.destroy();
    this.loaders.delete(item.stream.localId);
    this.logger(`destroy p2p loader: `, item.loggerInfo);
  }

  get activeLoader() {
    return this._activeLoaderItem.loader;
  }

  destroy() {
    for (const { loader, destroyTimeoutId } of this.loaders.values()) {
      loader.destroy();
      clearTimeout(destroyTimeoutId);
    }
    this.loaders.clear();
  }
}