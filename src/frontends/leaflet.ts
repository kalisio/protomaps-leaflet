// biome-ignore lint: leaflet 1.x
declare const L: any;

import Point from "@mapbox/point-geometry";

import type { Coords } from "leaflet";
import { PMTiles } from "pmtiles";
import { labelRules, paintRules } from "../default_style/style";
import themes from "../default_style/themes";
import { LabelRule, Labelers } from "../labeler";
import { PaintRule, paint } from "../painter";
import { PreparedTile, SourceOptions, sourcesToViews } from "../view";
import { PickedFeature } from "../tilecache";

const timer = (duration: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, duration);
  });
};

// replacement for Promise.allSettled (requires ES2020+)
// this is called for every tile render,
// so ensure font loading failure does not make map rendering fail
type Status = {
  status: string;
  value?: unknown;
  reason: Error;
};

type Pointer = {
  // Local tile coordinates
  x: number;
  y: number;
  // Tile
  tileX: number;
  tileY: number;
  // Global map coordinates
  X: number;
  Y: number;
};

const reflect = (promise: Promise<Status>) => {
  return promise.then(
    (v) => {
      return { status: "fulfilled", value: v };
    },
    (error) => {
      return { status: "rejected", reason: error };
    },
  );
};

type DoneCallback = (error?: Error, tile?: HTMLElement) => void;
type KeyedHtmlCanvasElement = HTMLCanvasElement & { key: string };

interface LeafletLayerOptions {
  bounds?: number[][];
  attribution?: string;
  debug?: string;
  lang?: string;
  tileDelay?: number;
  language?: string[];
  noWrap?: boolean;
  paintRules?: PaintRule[];
  labelRules?: LabelRule[];
  tasks?: Promise<Status>[];
  maxDataZoom?: number;
  url?: PMTiles | string;
  sources?: Record<string, SourceOptions>;
  theme?: string;
  backgroundColor?: string;
}

const leafletLayer = (options: LeafletLayerOptions = {}): unknown => {
  class LeafletLayer extends L.GridLayer {
    constructor(options: LeafletLayerOptions = {}) {
      if (options.noWrap && !options.bounds)
        options.bounds = [
          [-90, -180],
          [90, 180],
        ];
      if (options.attribution == null)
        options.attribution =
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';
      super(options);

      if (options.theme) {
        const theme = themes[options.theme];
        this.paintRules = paintRules(theme);
        this.labelRules = labelRules(theme);
        this.backgroundColor = theme.background;
      } else {
        this.paintRules = options.paintRules || [];
        this.labelRules = options.labelRules || [];
        this.backgroundColor = options.backgroundColor;
      }

      this.lastRequestedZ = undefined;
      this.tasks = options.tasks || [];

      this.views = sourcesToViews(options);

      this.debug = options.debug;
      const scratch = document.createElement("canvas").getContext("2d");
      this.scratch = scratch;
      this.onTilesInvalidated = (tiles: Set<string>) => {
        for (const t of tiles) {
          this.rerenderTile(t);
        }
      };
      this.labelers = new Labelers(
        this.scratch,
        this.labelRules,
        16,
        this.onTilesInvalidated,
      );
      this.tileSize = 256 * window.devicePixelRatio;
      this.tileDelay = options.tileDelay || 3;
      this.lang = options.lang;
    }

    public async renderTile(
      coords: Coords,
      element: KeyedHtmlCanvasElement,
      key: string,
      done = () => {},
    ) {
      this.lastRequestedZ = coords.z;

      const promises = [];
      for (const [k, v] of this.views) {
        const promise = v.getDisplayTile(coords);
        promises.push({ key: k, promise: promise });
      }
      const tileResponses = await Promise.all(
        promises.map((o) => {
          return o.promise.then(
            (v: PreparedTile[]) => {
              return { status: "fulfilled", value: v, key: o.key };
            },
            (error: Error) => {
              return { status: "rejected", reason: error, key: o.key };
            },
          );
        }),
      );

      const preparedTilemap = new Map<string, PreparedTile[]>();
      for (const tileResponse of tileResponses) {
        if (tileResponse.status === "fulfilled") {
          preparedTilemap.set(tileResponse.key, [tileResponse.value]);
        } else {
          if (tileResponse.reason.name === "AbortError") {
            // do nothing
          } else {
            console.error(tileResponse.reason);
          }
        }
      }

      if (element.key !== key) return;
      if (this.lastRequestedZ !== coords.z) return;

      await Promise.all(this.tasks.map(reflect));

      if (element.key !== key) return;
      if (this.lastRequestedZ !== coords.z) return;

      const layoutTime = this.labelers.add(coords.z, preparedTilemap);

      if (element.key !== key) return;
      if (this.lastRequestedZ !== coords.z) return;

      const labelData = this.labelers.getIndex(coords.z);

      if (!this._map) return; // the layer has been removed from the map

      const center = this._map.getCenter().wrap();
      const pixelBounds = this._getTiledPixelBounds(center);
      const tileRange = this._pxBoundsToTileRange(pixelBounds);
      const tileCenter = tileRange.getCenter();
      const priority = coords.distanceTo(tileCenter) * this.tileDelay;

      await timer(priority);

      if (element.key !== key) return;
      if (this.lastRequestedZ !== coords.z) return;

      const bbox = {
        minX: 256 * coords.x,
        minY: 256 * coords.y,
        maxX: 256 * (coords.x + 1),
        maxY: 256 * (coords.y + 1),
      };
      const buf = 16;
      const bboxWithBuffer = {
        minX: 256 * coords.x - buf,
        minY: 256 * coords.y - buf,
        maxX: 256 * (coords.x + 1) + buf,
        maxY: 256 * (coords.y + 1) + buf,
      };
      const origin = new Point(256 * coords.x, 256 * coords.y);

      element.width = this.tileSize;
      element.height = this.tileSize;
      const ctx = element.getContext("2d");
      if (!ctx) {
        console.error("Failed to get Canvas context");
        return;
      }
      ctx.setTransform(this.tileSize / 256, 0, 0, this.tileSize / 256, 0, 0);
      ctx.clearRect(0, 0, 256, 256);

      if (this.backgroundColor) {
        ctx.save();
        ctx.fillStyle = this.backgroundColor;
        ctx.fillRect(0, 0, 256, 256);
        ctx.restore();
      }

      let paintingTime = 0;

      const paintRules = this.paintRules;

      // We only check for pointer on the right tile
      let pointer, pointerInTile
      if (this.pointer) {
        pointerInTile = (
          (this.pointer.X >= bbox.minX) &&
          (this.pointer.X <= bbox.maxX) &&
          (this.pointer.Y <= bbox.maxY) &&
          (this.pointer.Y >= bbox.minY)
        )
        if (pointerInTile) {
          pointer = new Point(this.pointer.x, this.pointer.y)
        }
      }

      paintingTime = paint(
        ctx,
        coords.z,
        preparedTilemap,
        this.xray ? null : labelData,
        paintRules,
        bboxWithBuffer,
        origin,
        false,
        this.debug,
        pointer,
        this.pickedFeatures
      );

      if (this.debug) {
        ctx.save();
        ctx.fillStyle = this.debug;
        ctx.font = "600 12px sans-serif";
        let ypos = 14;
        ctx.fillText(`${coords.z} ${coords.x} ${coords.y}`, 4, ypos);
        ypos += 14;
        ctx.fillText(`[${bbox.minX.toFixed()},${bbox.minY.toFixed()},${bbox.maxX.toFixed()},${bbox.maxY.toFixed()}] bbox`, 4, ypos);
        ypos += 14;
        if (pointerInTile) {
          ctx.fillText(`(${this.pointer.x.toFixed()},${this.pointer.y.toFixed()}) - (${this.pointer.tileX.toFixed()},${this.pointer.tileY.toFixed()}) - (${this.pointer.X.toFixed()},${this.pointer.Y.toFixed()}) pointer`, 4, ypos);
          ypos += 14;
        }
        ctx.font = "12px sans-serif";
        for (const [k, v] of preparedTilemap) {
          const dt = v[0].dataTile;
          const d = v[0].dim;
          const o = v[0].origin;
          ctx.fillText(`${k + (k ? " " : "") + dt.z} ${dt.x} ${dt.y}`, 4, ypos);
          ypos += 14;
          ctx.fillText(`[${o.x.toFixed()},${o.y.toFixed()},${(o.x+d).toFixed()},${(o.y+d).toFixed()}] bbox`, 4, ypos);
          ypos += 14;
          if (pointerInTile) {
            const preparedTilePointer = new Point(
              origin.x + this.pointer.x - o.x,
              origin.y + this.pointer.y - o.y)
            ctx.fillText(`(${preparedTilePointer.x.toFixed()},${preparedTilePointer.y.toFixed()}) - (${dt.x.toFixed()},${dt.y.toFixed()}) pointer`, 4, ypos);
            ypos += 14;
          }
        }

        ctx.font = "600 10px sans-serif";
        if (paintingTime > 8) {
          ctx.fillText(`${paintingTime.toFixed()} ms paint`, 4, ypos);
          ypos += 14;
        }

        if (layoutTime > 8) {
          ctx.fillText(`${layoutTime.toFixed()} ms layout`, 4, ypos);
          ypos += 14;
        }
        
        ctx.strokeStyle = this.debug;

        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 256);
        ctx.stroke();

        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(256, 0);
        ctx.stroke();

        ctx.restore();
      }
      done();
    }

    public rerenderTile(key: string) {
      for (const unwrappedK in this._tiles) {
        const wrappedCoord = this._wrapCoords(
          this._keyToTileCoords(unwrappedK),
        );
        if (key === this._tileCoordsToKey(wrappedCoord)) {
          this.renderTile(wrappedCoord, this._tiles[unwrappedK].el, key);
        }
      }
    }

    // a primitive way to check the features at a certain point.
    // it does not support hover states, cursor changes, or changing the style of the selected feature,
    // so is only appropriate for debuggging or very basic use cases.
    // those features are outside of the scope of this library:
    // for fully pickable, interactive features, use MapLibre GL JS instead.
    public queryTileFeaturesDebug(
      lng: number,
      lat: number,
      brushSize = 16,
    ): Map<string, PickedFeature[]> {
      const featuresBySourceName = new Map<string, PickedFeature[]>();
      for (const [sourceName, view] of this.views) {
        featuresBySourceName.set(
          sourceName,
          view.queryFeatures(lng, lat, this._map.getZoom(), brushSize),
        );
      }
      return featuresBySourceName;
    }

    public clearLayout() {
      this.labelers = new Labelers(
        this.scratch,
        this.labelRules,
        16,
        this.onTilesInvalidated,
      );
    }

    public rerenderTiles() {
      for (const unwrappedK in this._tiles) {
        const wrappedCoord = this._wrapCoords(
          this._keyToTileCoords(unwrappedK),
        );
        const key = this._tileCoordsToKey(wrappedCoord);
        this.renderTile(wrappedCoord, this._tiles[unwrappedK].el, key);
      }
    }

    public createTile(coords: Coords, showTile: DoneCallback) {
      const element = L.DomUtil.create("canvas", "leaflet-tile");
      element.lang = this.lang;

      const key = this._tileCoordsToKey(coords);
      element.key = key;

      this.renderTile(coords, element, key, () => {
        showTile(undefined, element);
      });

      return element;
    }

    public _removeTile(key: string) {
      const tile = this._tiles[key];
      if (!tile) {
        return;
      }
      tile.el.removed = true;
      tile.el.key = undefined;
      L.DomUtil.removeClass(tile.el, "leaflet-tile-loaded");
      tile.el.width = tile.el.height = 0;
      L.DomUtil.remove(tile.el);
      delete this._tiles[key];
      this.fire("tileunload", {
        tile: tile.el,
        coords: this._keyToTileCoords(key),
      });
    }

    public _getPointer (event: any): Pointer {
      const R = 6378137;
      const MAX_LATITUDE = 85.0511287798;
      const MAXCOORD = R * Math.PI;

      const project = (latlng: number[]) => {
        const d = Math.PI / 180;
        const constrainedLat = Math.max(
          Math.min(MAX_LATITUDE, latlng[0]),
          -MAX_LATITUDE,
        );
        const sin = Math.sin(constrainedLat * d);
        return new Point(
          R * latlng[1] * d,
          (R * Math.log((1 + sin) / (1 - sin))) / 2,
        );
      };
      const projected = project([event.latlng.lat, event.latlng.lng]);
      const normalized = new Point(
        (projected.x + MAXCOORD) / (MAXCOORD * 2),
        1 - (projected.y + MAXCOORD) / (MAXCOORD * 2),
      );
      if (normalized.x > 1)
        normalized.x = normalized.x - Math.floor(normalized.x);
      const onZoom = normalized.mult(1 << this._map.getZoom());
      const tileX = Math.floor(onZoom.x);
      const tileY = Math.floor(onZoom.y);
      const x = (onZoom.x - tileX) * this.tileSize;
      const y = (onZoom.y - tileY) * this.tileSize;
      const X = tileX * this.tileSize + x;
      const Y = tileY * this.tileSize + y;
      return { x, y, tileX, tileY, X, Y }
    }

    public _onLayerClick (event: any) {
      this.pointer = this._getPointer (event)
      this.pickedFeatures = [];
      // FIXME: we need to redraw to get picked features now
      this.redraw();
      // Check for intersected features
      setTimeout(() => {
        if (this.pickedFeatures.length) {
          this.fire('click', Object.assign({}, event, { feature: this.pickedFeatures[0].feature }));
        }
        // Avoid checking again on next draw
        this.pointer = null;
      }, 1000);
    }
    
    public onAdd (map: any) {
      L.GridLayer.prototype.onAdd.call(this, map);
      map.on({
        click: this._onLayerClick
      }, this);
    }

    public onRemove (map: any) {
      L.GridLayer.prototype.onRemove.call(this, map);
      map.off({
        click: this._onLayerClick
      }, this);
    }
  }
  return new LeafletLayer(options);
};

export { leafletLayer };
