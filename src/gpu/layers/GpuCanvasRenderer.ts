import tileCompositeShader from '../shaders/tileComposite.wgsl?raw';
import tileLayerBlendShader from '../shaders/tileLayerBlend.wgsl?raw';
import { GpuLayerStore, type TileCoord, type TileRect } from './GpuLayerStore';
import { TileResidencyManager } from './TileResidencyManager';
import { SelectionMaskGpu } from './SelectionMaskGpu';
import type { GpuStrokeHistoryStore, GpuStrokeHistoryTileApplyItem } from './GpuStrokeHistoryStore';
import { buildBelowCacheSignature } from './layerStackCache';
import { computeTileDrawRegion, type TileDrawRegion } from './dirtyTileClip';
import {
  buildExportChunkRects,
  computeReadbackBytesPerRow,
  copyMappedRowsToImageData,
  normalizeExportChunkSize,
} from './exportReadback';
import { alignTo } from '../utils/textureCopyRect';
import type { Rect } from '@/utils/strokeBuffer';
import { TRANSPARENT_BACKDROP_EPS } from '@/utils/layerBlendMath';
import type { GpuRenderableLayer } from '../types';

interface GpuCanvasRendererOptions {
  tileSize: number;
  layerFormat: GPUTextureFormat;
}

interface RenderFrameParams {
  layerId: string;
  scratchTexture: GPUTexture | null;
  strokeOpacity: number;
  renderScale: number;
}

interface CommitStrokeParams {
  layerId: string;
  scratchTexture: GPUTexture;
  dirtyRect: Rect;
  strokeOpacity: number;
  renderScale: number;
  applyDither: boolean;
  ditherStrength: number;
  baseLayerCanvas?: HTMLCanvasElement | null;
  historyCapture?: CommitStrokeHistoryCapture;
}

interface CommitStrokeHistoryCapture {
  entryId: string;
  store: GpuStrokeHistoryStore;
}

interface RenderLayerStackFrameParams {
  layers: GpuRenderableLayer[];
  activeLayerId: string | null;
  scratchTexture: GPUTexture | null;
  strokeOpacity: number;
  renderScale: number;
}

interface ReadbackTarget {
  layerId: string;
  tiles: TileCoord[];
  targetCtx: CanvasRenderingContext2D;
}

interface ReadbackLayerExportParams {
  layerId: string;
  chunkSize?: number;
  targetCtx?: CanvasRenderingContext2D;
}

interface ReadbackFlattenedExportParams {
  layers: GpuRenderableLayer[];
  chunkSize?: number;
  targetCtx?: CanvasRenderingContext2D;
}

export interface GpuLayerStackCacheStats {
  enabled: boolean;
  belowCacheHits: number;
  belowCacheMisses: number;
  belowCacheTileCount: number;
  lastInvalidationReason: string | null;
}

type TileSourceKind =
  | 'transparent'
  | 'layer'
  | 'below-cache'
  | 'work-a'
  | 'work-b'
  | 'active-preview';

interface TileSourceRef {
  texture: GPUTexture;
  view: GPUTextureView;
  source: TileSourceKind;
}

const DEFAULT_DITHER_STRENGTH = 1.0;
const UNIFORM_STRUCT_BYTES = 48;
const INITIAL_UNIFORM_SLOTS = 1024;
const LAYER_BLEND_UNIFORM_BYTES = 16;
const INITIAL_LAYER_BLEND_UNIFORM_SLOTS = 1024;

function createSolidMaskTexture1x1(device: GPUDevice, label: string, value: number): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [1, 1],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Uint8Array([value]), { bytesPerRow: 1 }, [1, 1]);
  return texture;
}

function createSolidTextureUnorm(
  device: GPUDevice,
  label: string,
  size: number,
  rgba: [number, number, number, number],
  extraUsage: GPUTextureUsageFlags = 0
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [size, size],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | extraUsage,
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        clearValue: {
          r: rgba[0] / 255,
          g: rgba[1] / 255,
          b: rgba[2] / 255,
          a: rgba[3] / 255,
        },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
  return texture;
}

function createSolidTexture1x1Float(
  device: GPUDevice,
  label: string,
  rgba: [number, number, number, number]
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [1, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Float32Array(rgba), { bytesPerRow: 16 }, [1, 1]);
  return texture;
}

export class GpuCanvasRenderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext;
  private canvasFormat: GPUTextureFormat;
  private layerStore: GpuLayerStore;
  private residency: TileResidencyManager;
  private selectionMask: SelectionMaskGpu;

  private uniformBuffer: GPUBuffer;
  private uniformData: ArrayBuffer;
  private uniformStride: number;
  private uniformSlots: number;
  private bindGroupLayout: GPUBindGroupLayout;
  private pipelineLayout: GPUPipelineLayout;
  private displayPipeline: GPURenderPipeline;
  private commitPipeline: GPURenderPipeline;
  private layerBlendBindGroupLayout: GPUBindGroupLayout;
  private layerBlendPipelineLayout: GPUPipelineLayout;
  private layerBlendPipeline: GPURenderPipeline;
  private layerBlendUniformBuffer: GPUBuffer;
  private layerBlendUniformStride: number;
  private layerBlendUniformSlots: number;
  private layerBlendUniformWriteIndex = 0;

  private whiteMaskTexture: GPUTexture;
  private whiteMaskView: GPUTextureView;
  private transparentLayerTexture: GPUTexture;
  private transparentLayerView: GPUTextureView;
  private transparentScratchTexture: GPUTexture;
  private transparentScratchView: GPUTextureView;
  private workTileTextureA: GPUTexture;
  private workTileViewA: GPUTextureView;
  private workTileTextureB: GPUTexture;
  private workTileViewB: GPUTextureView;
  private activePreviewTexture: GPUTexture;
  private activePreviewView: GPUTextureView;

  private width: number;
  private height: number;
  private tileSize: number;
  private layerFormat: GPUTextureFormat;
  private visibleTiles: TileCoord[] = [];
  private layerRevisions: Map<string, number> = new Map();
  private layerContentGenerations: Map<string, number> = new Map();
  private belowCacheTiles: Map<string, { texture: GPUTexture; view: GPUTextureView }> = new Map();
  private belowCacheSignature: string | null = null;
  private belowCacheHits = 0;
  private belowCacheMisses = 0;
  private belowCacheLastInvalidationReason: string | null = null;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement, options: GpuCanvasRendererOptions) {
    this.device = device;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    if (!this.context) {
      throw new Error('[GpuCanvasRenderer] WebGPU context unavailable');
    }

    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.tileSize = options.tileSize;
    this.layerFormat = options.layerFormat;
    this.width = canvas.width;
    this.height = canvas.height;

    this.context.configure({
      device,
      format: this.canvasFormat,
      alphaMode: 'premultiplied',
    });

    this.residency = new TileResidencyManager();
    this.layerStore = new GpuLayerStore({
      device,
      tileSize: this.tileSize,
      format: this.layerFormat,
      width: this.width,
      height: this.height,
      residency: this.residency,
    });

    this.selectionMask = new SelectionMaskGpu(device);

    this.uniformData = new ArrayBuffer(UNIFORM_STRUCT_BYTES);
    this.uniformStride = alignTo(
      UNIFORM_STRUCT_BYTES,
      device.limits.minUniformBufferOffsetAlignment
    );
    this.uniformSlots = INITIAL_UNIFORM_SLOTS;
    this.uniformBuffer = this.createUniformBuffer(this.uniformSlots);

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: UNIFORM_STRUCT_BYTES,
          },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const shaderModule = device.createShaderModule({
      label: 'Tile Composite Shader',
      code: tileCompositeShader,
    });

    this.displayPipeline = device.createRenderPipeline({
      label: 'Tile Display Pipeline',
      layout: this.pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_display',
        targets: [{ format: this.canvasFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.commitPipeline = device.createRenderPipeline({
      label: 'Tile Commit Pipeline',
      layout: this.pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.layerFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const layerBlendShaderModule = device.createShaderModule({
      label: 'Tile Layer Blend Shader',
      code: tileLayerBlendShader,
    });
    this.layerBlendBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: LAYER_BLEND_UNIFORM_BYTES },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.layerBlendPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.layerBlendBindGroupLayout],
    });
    this.layerBlendPipeline = device.createRenderPipeline({
      label: 'Tile Layer Blend Pipeline',
      layout: this.layerBlendPipelineLayout,
      vertex: { module: layerBlendShaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: layerBlendShaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.layerFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.layerBlendUniformStride = alignTo(
      LAYER_BLEND_UNIFORM_BYTES,
      device.limits.minUniformBufferOffsetAlignment
    );
    this.layerBlendUniformSlots = INITIAL_LAYER_BLEND_UNIFORM_SLOTS;
    this.layerBlendUniformBuffer = this.createLayerBlendUniformBuffer(this.layerBlendUniformSlots);

    this.whiteMaskTexture = createSolidMaskTexture1x1(device, 'Selection Mask Fallback', 255);
    this.whiteMaskView = this.whiteMaskTexture.createView();

    this.transparentLayerTexture = createSolidTextureUnorm(
      device,
      'Layer Fallback',
      this.tileSize,
      [0, 0, 0, 0],
      GPUTextureUsage.COPY_SRC
    );
    this.transparentLayerView = this.transparentLayerTexture.createView();

    this.transparentScratchTexture = createSolidTexture1x1Float(
      device,
      'Scratch Fallback',
      [0, 0, 0, 0]
    );
    this.transparentScratchView = this.transparentScratchTexture.createView();

    this.workTileTextureA = this.createTileRenderTexture('Tile Work A');
    this.workTileViewA = this.workTileTextureA.createView();
    this.workTileTextureB = this.createTileRenderTexture('Tile Work B');
    this.workTileViewB = this.workTileTextureB.createView();
    this.activePreviewTexture = this.createTileRenderTexture('Active Preview Tile');
    this.activePreviewView = this.activePreviewTexture.createView();

    this.rebuildVisibleTiles();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: 'premultiplied',
    });
    this.layerStore.resize(width, height);
    this.invalidateBelowCache('canvas-resize');
    this.rebuildVisibleTiles();
  }

  setSelectionMask(mask: ImageData | null): void {
    this.selectionMask.update(mask);
  }

  setResidencyBudgetBytes(maxBytes: number): void {
    this.residency.setBudgetBytes(maxBytes);
  }

  getLayerStackCacheStats(): GpuLayerStackCacheStats {
    return {
      enabled: true,
      belowCacheHits: this.belowCacheHits,
      belowCacheMisses: this.belowCacheMisses,
      belowCacheTileCount: this.belowCacheTiles.size,
      lastInvalidationReason: this.belowCacheLastInvalidationReason,
    };
  }

  syncLayerFromCanvas(layerId: string, canvas: HTMLCanvasElement, revision: number): void {
    const prevRevision = this.layerRevisions.get(layerId);
    if (prevRevision === revision) return;
    this.layerStore.uploadLayerFromCanvas(layerId, canvas);
    this.layerRevisions.set(layerId, revision);
    this.bumpLayerContentGeneration(layerId);
  }

  syncLayerTilesFromCanvas(layerId: string, canvas: HTMLCanvasElement, tiles: TileCoord[]): void {
    this.layerStore.uploadTilesFromCanvas(layerId, canvas, tiles);
    if (tiles.length > 0) {
      this.bumpLayerContentGeneration(layerId);
    }
  }

  renderFrame(params: RenderFrameParams): void {
    const { layerId, scratchTexture, strokeOpacity, renderScale } = params;
    const clampedOpacity = Math.max(0, Math.min(1, strokeOpacity));
    this.ensureUniformBufferCapacity(this.visibleTiles.length);
    const view = this.context.getCurrentTexture().createView();
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    pass.setPipeline(this.displayPipeline);

    const scratchView = scratchTexture ? scratchTexture.createView() : this.transparentScratchView;
    const selectionView = this.selectionMask.getTextureView() ?? this.whiteMaskView;
    let drawIndex = 0;

    for (const coord of this.visibleTiles) {
      const rect = this.layerStore.getTileRect(coord);
      if (rect.width <= 0 || rect.height <= 0) continue;

      const tile = this.layerStore.getTile(layerId, coord);
      const tileView = tile ? tile.view : this.transparentLayerView;

      const uniformOffset = this.writeUniforms(drawIndex, {
        canvasWidth: this.width,
        canvasHeight: this.height,
        tileOriginX: rect.originX,
        tileOriginY: rect.originY,
        positionOriginX: 0,
        positionOriginY: 0,
        strokeOpacity: clampedOpacity,
        applyDither: false,
        ditherStrength: DEFAULT_DITHER_STRENGTH,
        renderScale,
      });

      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer, size: UNIFORM_STRUCT_BYTES } },
          { binding: 1, resource: tileView },
          { binding: 2, resource: scratchView },
          { binding: 3, resource: selectionView },
        ],
      });

      pass.setViewport(rect.originX, rect.originY, rect.width, rect.height, 0, 1);
      pass.setScissorRect(rect.originX, rect.originY, rect.width, rect.height);
      pass.setBindGroup(0, bindGroup, [uniformOffset]);
      pass.draw(6, 1, 0, 0);
      drawIndex += 1;
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  renderLayerStackFrame(params: RenderLayerStackFrameParams): void {
    const { layers, activeLayerId, scratchTexture, strokeOpacity, renderScale } = params;
    this.pruneLayerRevisionState(layers);
    const visibleLayers = layers.filter((layer) => layer.visible);
    if (visibleLayers.length === 0) {
      const view = this.context.getCurrentTexture().createView();
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      return;
    }

    const activeIndex = activeLayerId
      ? visibleLayers.findIndex((layer) => layer.id === activeLayerId)
      : -1;
    const belowLayers = activeIndex > 0 ? visibleLayers.slice(0, activeIndex) : [];
    const activeLayer = activeIndex >= 0 ? visibleLayers[activeIndex] : null;
    const aboveLayers = activeIndex >= 0 ? visibleLayers.slice(activeIndex + 1) : visibleLayers;

    const belowSignature = this.createBelowCacheSignature(activeLayer?.id ?? null, belowLayers);
    if (belowSignature !== this.belowCacheSignature) {
      this.invalidateBelowCache('below-signature-changed');
      this.belowCacheSignature = belowSignature;
    }

    this.ensureUniformBufferCapacity(this.visibleTiles.length * 2);
    const estimatedBlendPasses =
      this.visibleTiles.length * Math.max(1, visibleLayers.length) + visibleLayers.length;
    this.ensureLayerBlendUniformCapacity(estimatedBlendPasses);
    this.layerBlendUniformWriteIndex = 0;
    const selectionView = this.selectionMask.getTextureView() ?? this.whiteMaskView;
    const scratchView = scratchTexture ? scratchTexture.createView() : null;
    const clampedStrokeOpacity = Math.max(0, Math.min(1, strokeOpacity));

    const encoder = this.device.createCommandEncoder();
    const canvasView = this.context.getCurrentTexture().createView();

    let uniformIndex = 0;
    let hasDrawnTile = false;
    for (const coord of this.visibleTiles) {
      const rect = this.layerStore.getTileRect(coord);
      if (rect.width <= 0 || rect.height <= 0) continue;

      let current = this.resolveBelowCompositeTile({
        encoder,
        coord,
        tileRect: rect,
        belowLayers,
      });

      if (activeLayer) {
        let activeSource = this.resolveLayerTileRef(activeLayer.id, coord);
        if (scratchView) {
          this.renderCompositePass({
            encoder,
            targetView: this.activePreviewView,
            tileView: activeSource.view,
            scratchView,
            selectionView,
            tileRect: rect,
            strokeOpacity: clampedStrokeOpacity,
            renderScale,
            applyDither: false,
            ditherStrength: DEFAULT_DITHER_STRENGTH,
            uniformIndex,
          });
          uniformIndex += 1;
          activeSource = {
            texture: this.activePreviewTexture,
            view: this.activePreviewView,
            source: 'active-preview',
          };
        }

        current = this.blendLayerIntoCurrent({
          encoder,
          current,
          layer: activeLayer,
          source: activeSource,
          tileRect: rect,
        });
      }

      for (const layer of aboveLayers) {
        const source = this.resolveLayerTileRef(layer.id, coord);
        current = this.blendLayerIntoCurrent({
          encoder,
          current,
          layer,
          source,
          tileRect: rect,
        });
      }

      const displayPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: canvasView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: hasDrawnTile ? 'load' : 'clear',
            storeOp: 'store',
          },
        ],
      });
      displayPass.setPipeline(this.displayPipeline);
      this.drawDisplayTile({
        pass: displayPass,
        tileView: current.view,
        tileRect: rect,
        uniformIndex,
      });
      displayPass.end();
      hasDrawnTile = true;
      uniformIndex += 1;
    }

    if (!hasDrawnTile) {
      const clearPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: canvasView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      clearPass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  commitStroke(params: CommitStrokeParams): TileCoord[] {
    const {
      layerId,
      scratchTexture,
      dirtyRect,
      strokeOpacity,
      renderScale,
      applyDither,
      baseLayerCanvas,
      historyCapture,
    } = params;
    const clampedOpacity = Math.max(0, Math.min(1, strokeOpacity));
    const ditherStrength = params.ditherStrength ?? DEFAULT_DITHER_STRENGTH;
    const tiles = this.getTilesForRect(dirtyRect);
    if (tiles.length === 0) return [];

    this.ensureUniformBufferCapacity(tiles.length);
    const scratchView = scratchTexture.createView();
    const selectionView = this.selectionMask.getTextureView() ?? this.whiteMaskView;

    const encoder = this.device.createCommandEncoder();
    let activeLayerTmpTexture: GPUTexture | null = null;
    let activeLayerTmpView: GPUTextureView | null = null;
    const committedTiles: TileCoord[] = [];

    let drawIndex = 0;

    for (const coord of tiles) {
      const rect = this.layerStore.getTileRect(coord);
      if (rect.width <= 0 || rect.height <= 0) continue;
      const drawRegion = computeTileDrawRegion(rect, dirtyRect);
      if (!drawRegion) continue;

      let existingTile = this.layerStore.getTile(layerId, coord);
      if (!existingTile && baseLayerCanvas) {
        this.layerStore.uploadTilesFromCanvas(layerId, baseLayerCanvas, [coord], {
          onlyMissing: true,
        });
        existingTile = this.layerStore.getTile(layerId, coord);
      }

      historyCapture?.store.captureBeforeTile(
        historyCapture.entryId,
        encoder,
        layerId,
        coord,
        existingTile?.texture ?? this.transparentLayerTexture
      );

      if (existingTile) {
        if (!activeLayerTmpTexture || !activeLayerTmpView) {
          activeLayerTmpTexture = this.createTempTileTexture();
          activeLayerTmpView = activeLayerTmpTexture.createView();
        }
        const preserveOutsideDirtyRegion = !this.isFullTileDraw(drawRegion, rect);
        if (preserveOutsideDirtyRegion) {
          encoder.copyTextureToTexture(
            { texture: existingTile.texture },
            { texture: activeLayerTmpTexture },
            [this.tileSize, this.tileSize, 1]
          );
        }

        this.renderCompositePass({
          encoder,
          targetView: activeLayerTmpView,
          tileView: existingTile.view,
          scratchView,
          selectionView,
          tileRect: rect,
          drawRegion,
          strokeOpacity: clampedOpacity,
          renderScale,
          applyDither,
          ditherStrength,
          loadExistingTarget: preserveOutsideDirtyRegion,
          uniformIndex: drawIndex,
        });

        encoder.copyTextureToTexture(
          { texture: activeLayerTmpTexture },
          { texture: existingTile.texture },
          [this.tileSize, this.tileSize, 1]
        );
        historyCapture?.store.captureAfterTile(
          historyCapture.entryId,
          encoder,
          layerId,
          coord,
          existingTile.texture
        );
      } else {
        const newTile = this.layerStore.getOrCreateTile(layerId, coord);
        this.renderCompositePass({
          encoder,
          targetView: newTile.view,
          tileView: this.transparentLayerView,
          scratchView,
          selectionView,
          tileRect: rect,
          drawRegion,
          strokeOpacity: clampedOpacity,
          renderScale,
          applyDither,
          ditherStrength,
          uniformIndex: drawIndex,
        });
        historyCapture?.store.captureAfterTile(
          historyCapture.entryId,
          encoder,
          layerId,
          coord,
          newTile.texture
        );
      }
      committedTiles.push(coord);
      drawIndex += 1;
    }

    this.device.queue.submit([encoder.finish()]);
    if (activeLayerTmpTexture) {
      activeLayerTmpTexture.destroy();
    }
    if (committedTiles.length > 0) {
      this.bumpLayerContentGeneration(layerId);
    }
    return committedTiles;
  }

  applyHistoryTiles(params: {
    layerId: string;
    tiles: GpuStrokeHistoryTileApplyItem[];
  }): TileCoord[] {
    const { layerId, tiles } = params;
    if (tiles.length === 0) return [];

    const encoder = this.device.createCommandEncoder();
    const appliedTiles: TileCoord[] = [];

    for (const item of tiles) {
      const rect = this.layerStore.getTileRect(item.coord);
      if (rect.width <= 0 || rect.height <= 0) continue;

      const targetTile = this.layerStore.getOrCreateTile(layerId, item.coord);
      const sourceTexture = item.texture ?? this.transparentLayerTexture;
      encoder.copyTextureToTexture({ texture: sourceTexture }, { texture: targetTile.texture }, [
        this.tileSize,
        this.tileSize,
        1,
      ]);
      appliedTiles.push(item.coord);
    }

    if (appliedTiles.length > 0) {
      this.device.queue.submit([encoder.finish()]);
      this.bumpLayerContentGeneration(layerId);
    }
    return appliedTiles;
  }

  async readbackTilesToLayer(params: ReadbackTarget): Promise<void> {
    const { layerId, tiles, targetCtx } = params;
    if (tiles.length === 0) return;

    await this.device.queue.onSubmittedWorkDone();

    for (const coord of tiles) {
      const tile = this.layerStore.getTile(layerId, coord);
      if (!tile) continue;

      const rect = this.layerStore.getTileRect(coord);
      if (rect.width <= 0 || rect.height <= 0) continue;

      const bytesPerRow = alignTo(rect.width * 4, 256);
      const bufferSize = bytesPerRow * rect.height;
      const readbackBuffer = this.device.createBuffer({
        label: 'Tile Readback',
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: tile.texture, origin: { x: 0, y: 0 } },
        { buffer: readbackBuffer, bytesPerRow },
        [rect.width, rect.height]
      );
      this.device.queue.submit([encoder.finish()]);

      await readbackBuffer.mapAsync(GPUMapMode.READ);
      const mapped = readbackBuffer.getMappedRange();
      const src = new Uint8Array(mapped);
      const data = new Uint8ClampedArray(rect.width * rect.height * 4);

      for (let y = 0; y < rect.height; y += 1) {
        const rowStart = y * bytesPerRow;
        const dstStart = y * rect.width * 4;
        data.set(src.subarray(rowStart, rowStart + rect.width * 4), dstStart);
      }

      readbackBuffer.unmap();
      readbackBuffer.destroy();

      const imageData = new ImageData(data, rect.width, rect.height);
      targetCtx.putImageData(imageData, rect.originX, rect.originY);
    }
  }

  async readbackLayerExport(params: ReadbackLayerExportParams): Promise<ImageData> {
    const { layerId, targetCtx } = params;
    const chunkSize = normalizeExportChunkSize(params.chunkSize, this.tileSize);
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    const chunks = buildExportChunkRects(this.width, this.height, chunkSize);

    for (const chunk of chunks) {
      const tiles = this.getTilesForRect({
        left: chunk.x,
        top: chunk.y,
        right: chunk.x + chunk.width,
        bottom: chunk.y + chunk.height,
      });

      for (const coord of tiles) {
        const rect = this.layerStore.getTileRect(coord);
        if (rect.width <= 0 || rect.height <= 0) continue;
        const tile = this.layerStore.getTile(layerId, coord);
        const sourceTexture = tile?.texture ?? this.transparentLayerTexture;
        await this.readbackTextureRectToImageData({
          texture: sourceTexture,
          rect,
          out,
          destroyTextureAfterReadback: false,
        });
      }
    }

    const image = new ImageData(out, this.width, this.height);
    targetCtx?.putImageData(image, 0, 0);
    return image;
  }

  async readbackFlattenedExport(params: ReadbackFlattenedExportParams): Promise<ImageData> {
    const { targetCtx } = params;
    const visibleLayers = params.layers.filter((layer) => layer.visible);
    const chunkSize = normalizeExportChunkSize(params.chunkSize, this.tileSize);
    const out = new Uint8ClampedArray(this.width * this.height * 4);

    if (visibleLayers.length === 0) {
      const image = new ImageData(out, this.width, this.height);
      targetCtx?.putImageData(image, 0, 0);
      return image;
    }

    this.layerBlendUniformWriteIndex = 0;

    const chunks = buildExportChunkRects(this.width, this.height, chunkSize);
    for (const chunk of chunks) {
      const tiles = this.getTilesForRect({
        left: chunk.x,
        top: chunk.y,
        right: chunk.x + chunk.width,
        bottom: chunk.y + chunk.height,
      });

      for (const coord of tiles) {
        const rect = this.layerStore.getTileRect(coord);
        if (rect.width <= 0 || rect.height <= 0) continue;
        const sourceTexture = await this.composeFlattenedTileTexture({
          coord,
          tileRect: rect,
          layers: visibleLayers,
        });
        await this.readbackTextureRectToImageData({
          texture: sourceTexture,
          rect,
          out,
          destroyTextureAfterReadback: true,
        });
      }
    }

    const image = new ImageData(out, this.width, this.height);
    targetCtx?.putImageData(image, 0, 0);
    return image;
  }

  async sampleLayerPixel(
    layerId: string,
    canvasX: number,
    canvasY: number
  ): Promise<[number, number, number, number] | null> {
    const pixelX = Math.floor(canvasX);
    const pixelY = Math.floor(canvasY);
    if (pixelX < 0 || pixelX >= this.width || pixelY < 0 || pixelY >= this.height) {
      return null;
    }

    const tileCoord = {
      x: Math.floor(pixelX / this.tileSize),
      y: Math.floor(pixelY / this.tileSize),
    };
    const tile = this.layerStore.getTile(layerId, tileCoord);
    if (!tile) {
      return [0, 0, 0, 0];
    }

    const tileRect = this.layerStore.getTileRect(tileCoord);
    const localX = pixelX - tileRect.originX;
    const localY = pixelY - tileRect.originY;
    if (localX < 0 || localX >= tileRect.width || localY < 0 || localY >= tileRect.height) {
      return [0, 0, 0, 0];
    }

    const bytesPerRow = alignTo(4, 256);
    const readbackBuffer = this.device.createBuffer({
      label: 'Pixel Readback',
      size: bytesPerRow,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: tile.texture, origin: { x: localX, y: localY } },
        { buffer: readbackBuffer, bytesPerRow },
        [1, 1]
      );
      this.device.queue.submit([encoder.finish()]);

      await readbackBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(readbackBuffer.getMappedRange());
      return [mapped[0] ?? 0, mapped[1] ?? 0, mapped[2] ?? 0, mapped[3] ?? 0];
    } finally {
      if (readbackBuffer.mapState === 'mapped') {
        readbackBuffer.unmap();
      }
      readbackBuffer.destroy();
    }
  }

  private resolveBelowCompositeTile(args: {
    encoder: GPUCommandEncoder;
    coord: TileCoord;
    tileRect: TileRect;
    belowLayers: GpuRenderableLayer[];
  }): TileSourceRef {
    const { encoder, coord, tileRect, belowLayers } = args;
    if (belowLayers.length === 0) {
      return {
        texture: this.transparentLayerTexture,
        view: this.transparentLayerView,
        source: 'transparent',
      };
    }

    const key = this.getTileKey(coord);
    const cached = this.belowCacheTiles.get(key);
    if (cached) {
      this.belowCacheHits += 1;
      return {
        texture: cached.texture,
        view: cached.view,
        source: 'below-cache',
      };
    }

    this.belowCacheMisses += 1;
    const belowTarget = this.createTileRenderTexture(`Below Cache ${key}`);
    const belowTargetView = belowTarget.createView();
    this.belowCacheTiles.set(key, { texture: belowTarget, view: belowTargetView });

    let current: TileSourceRef = {
      texture: this.transparentLayerTexture,
      view: this.transparentLayerView,
      source: 'transparent',
    };
    for (const layer of belowLayers) {
      const source = this.resolveLayerTileRef(layer.id, coord);
      current = this.blendLayerIntoCurrent({
        encoder,
        current,
        layer,
        source,
        tileRect,
      });
    }

    encoder.copyTextureToTexture({ texture: current.texture }, { texture: belowTarget }, [
      this.tileSize,
      this.tileSize,
      1,
    ]);
    return {
      texture: belowTarget,
      view: belowTargetView,
      source: 'below-cache',
    };
  }

  private resolveLayerTileRef(layerId: string, coord: TileCoord): TileSourceRef {
    const tile = this.layerStore.getTile(layerId, coord);
    if (tile) {
      return {
        texture: tile.texture,
        view: tile.view,
        source: 'layer',
      };
    }
    return {
      texture: this.transparentLayerTexture,
      view: this.transparentLayerView,
      source: 'transparent',
    };
  }

  private blendLayerIntoCurrent(args: {
    encoder: GPUCommandEncoder;
    current: TileSourceRef;
    layer: GpuRenderableLayer;
    source: TileSourceRef;
    tileRect: TileRect;
  }): TileSourceRef {
    const { encoder, current, layer, source, tileRect } = args;
    const opacity = Math.max(0, Math.min(1, layer.opacity / 100));
    if (opacity <= 0) {
      return current;
    }

    const target =
      current.source === 'work-a'
        ? {
            texture: this.workTileTextureB,
            view: this.workTileViewB,
            source: 'work-b' as const,
          }
        : {
            texture: this.workTileTextureA,
            view: this.workTileViewA,
            source: 'work-a' as const,
          };

    this.renderLayerBlendPass({
      encoder,
      targetView: target.view,
      baseView: current.view,
      sourceView: source.view,
      tileRect,
      layerOpacity: opacity,
      blendMode: this.normalizeBlendMode(layer.blendMode),
    });

    return target;
  }

  private drawDisplayTile(args: {
    pass: GPURenderPassEncoder;
    tileView: GPUTextureView;
    tileRect: TileRect;
    uniformIndex: number;
  }): void {
    const { pass, tileView, tileRect, uniformIndex } = args;
    const uniformOffset = this.writeUniforms(uniformIndex, {
      canvasWidth: this.width,
      canvasHeight: this.height,
      tileOriginX: tileRect.originX,
      tileOriginY: tileRect.originY,
      positionOriginX: 0,
      positionOriginY: 0,
      strokeOpacity: 0,
      applyDither: false,
      ditherStrength: DEFAULT_DITHER_STRENGTH,
      renderScale: 1,
    });

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: UNIFORM_STRUCT_BYTES } },
        { binding: 1, resource: tileView },
        { binding: 2, resource: this.transparentScratchView },
        { binding: 3, resource: this.whiteMaskView },
      ],
    });

    pass.setViewport(tileRect.originX, tileRect.originY, tileRect.width, tileRect.height, 0, 1);
    pass.setScissorRect(tileRect.originX, tileRect.originY, tileRect.width, tileRect.height);
    pass.setBindGroup(0, bindGroup, [uniformOffset]);
    pass.draw(6, 1, 0, 0);
  }

  private async composeFlattenedTileTexture(args: {
    coord: TileCoord;
    tileRect: TileRect;
    layers: GpuRenderableLayer[];
  }): Promise<GPUTexture> {
    const { coord, tileRect, layers } = args;
    const encoder = this.device.createCommandEncoder();

    let current: TileSourceRef = {
      texture: this.transparentLayerTexture,
      view: this.transparentLayerView,
      source: 'transparent',
    };

    for (const layer of layers) {
      const source = this.resolveLayerTileRef(layer.id, coord);
      current = this.blendLayerIntoCurrent({
        encoder,
        current,
        layer,
        source,
        tileRect,
      });
    }

    const copyTarget = this.createTempTileTexture();
    encoder.copyTextureToTexture({ texture: current.texture }, { texture: copyTarget }, [
      this.tileSize,
      this.tileSize,
      1,
    ]);
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    return copyTarget;
  }

  private async readbackTextureRectToImageData(args: {
    texture: GPUTexture;
    rect: TileRect;
    out: Uint8ClampedArray;
    destroyTextureAfterReadback: boolean;
  }): Promise<void> {
    const { texture, rect, out, destroyTextureAfterReadback } = args;
    const bytesPerRow = computeReadbackBytesPerRow(rect.width);
    const bufferSize = bytesPerRow * rect.height;
    const readbackBuffer = this.device.createBuffer({
      label: 'Export Tile Readback',
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture, origin: { x: 0, y: 0 } },
        { buffer: readbackBuffer, bytesPerRow },
        [rect.width, rect.height]
      );
      this.device.queue.submit([encoder.finish()]);
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(readbackBuffer.getMappedRange());
      copyMappedRowsToImageData({
        mapped,
        bytesPerRow,
        width: rect.width,
        height: rect.height,
        dest: out,
        destWidth: this.width,
        destX: rect.originX,
        destY: rect.originY,
      });
    } finally {
      if (readbackBuffer.mapState === 'mapped') {
        readbackBuffer.unmap();
      }
      readbackBuffer.destroy();
      if (destroyTextureAfterReadback) {
        texture.destroy();
      }
    }
  }

  private renderLayerBlendPass(args: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    baseView: GPUTextureView;
    sourceView: GPUTextureView;
    tileRect: TileRect;
    layerOpacity: number;
    blendMode: GpuRenderableLayer['blendMode'];
  }): void {
    const { encoder, targetView, baseView, sourceView, tileRect, layerOpacity, blendMode } = args;
    const uniformOffset = this.nextLayerBlendUniformOffset();
    const blendData = new ArrayBuffer(LAYER_BLEND_UNIFORM_BYTES);
    const blendView = new DataView(blendData);
    blendView.setUint32(0, this.encodeBlendMode(blendMode), true);
    blendView.setFloat32(4, layerOpacity, true);
    blendView.setFloat32(8, TRANSPARENT_BACKDROP_EPS, true);
    blendView.setUint32(12, 0, true);
    this.device.queue.writeBuffer(this.layerBlendUniformBuffer, uniformOffset, blendData);

    const bindGroup = this.device.createBindGroup({
      layout: this.layerBlendBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.layerBlendUniformBuffer,
            offset: uniformOffset,
            size: LAYER_BLEND_UNIFORM_BYTES,
          },
        },
        { binding: 1, resource: baseView },
        { binding: 2, resource: sourceView },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.layerBlendPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setViewport(0, 0, tileRect.width, tileRect.height, 0, 1);
    pass.setScissorRect(0, 0, tileRect.width, tileRect.height);
    pass.draw(6, 1, 0, 0);
    pass.end();
  }

  private normalizeBlendMode(
    blendMode: GpuRenderableLayer['blendMode']
  ): GpuRenderableLayer['blendMode'] {
    return blendMode;
  }

  private encodeBlendMode(blendMode: GpuRenderableLayer['blendMode']): number {
    switch (blendMode) {
      case 'normal':
        return 0;
      case 'multiply':
        return 1;
      case 'screen':
        return 2;
      case 'overlay':
        return 3;
      case 'darken':
        return 4;
      case 'lighten':
        return 5;
      case 'color-dodge':
        return 6;
      case 'color-burn':
        return 7;
      case 'hard-light':
        return 8;
      case 'soft-light':
        return 9;
      case 'difference':
        return 10;
      case 'exclusion':
        return 11;
      case 'hue':
        return 12;
      case 'saturation':
        return 13;
      case 'color':
        return 14;
      case 'luminosity':
        return 15;
      default:
        return 0;
    }
  }

  private createBelowCacheSignature(
    activeLayerId: string | null,
    belowLayers: GpuRenderableLayer[]
  ): string {
    return buildBelowCacheSignature({
      activeLayerId,
      belowLayers,
      getContentGeneration: (layerId) => this.getLayerContentGeneration(layerId),
    });
  }

  private getLayerContentGeneration(layerId: string): number {
    return this.layerContentGenerations.get(layerId) ?? 0;
  }

  private bumpLayerContentGeneration(layerId: string): void {
    this.layerContentGenerations.set(layerId, this.getLayerContentGeneration(layerId) + 1);
  }

  private pruneLayerRevisionState(layers: readonly GpuRenderableLayer[]): void {
    const liveIds = new Set(layers.map((layer) => layer.id));
    for (const layerId of this.layerRevisions.keys()) {
      if (!liveIds.has(layerId)) {
        this.layerRevisions.delete(layerId);
      }
    }
    for (const layerId of this.layerContentGenerations.keys()) {
      if (!liveIds.has(layerId)) {
        this.layerContentGenerations.delete(layerId);
      }
    }
  }

  private invalidateBelowCache(reason: string): void {
    for (const entry of this.belowCacheTiles.values()) {
      entry.texture.destroy();
    }
    this.belowCacheTiles.clear();
    this.belowCacheSignature = null;
    this.belowCacheLastInvalidationReason = reason;
  }

  private getTileKey(coord: TileCoord): string {
    return `${coord.x}_${coord.y}`;
  }

  private isFullTileDraw(drawRegion: TileDrawRegion, tileRect: TileRect): boolean {
    return (
      drawRegion.x === 0 &&
      drawRegion.y === 0 &&
      drawRegion.width === tileRect.width &&
      drawRegion.height === tileRect.height
    );
  }

  private renderCompositePass(args: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    tileView: GPUTextureView;
    scratchView: GPUTextureView;
    selectionView: GPUTextureView;
    tileRect: TileRect;
    drawRegion?: TileDrawRegion;
    strokeOpacity: number;
    renderScale: number;
    applyDither: boolean;
    ditherStrength: number;
    loadExistingTarget?: boolean;
    uniformIndex: number;
  }): void {
    const {
      encoder,
      targetView,
      tileView,
      scratchView,
      selectionView,
      tileRect,
      drawRegion,
      strokeOpacity,
      renderScale,
      applyDither,
      ditherStrength,
      loadExistingTarget,
      uniformIndex,
    } = args;

    const uniformOffset = this.writeUniforms(uniformIndex, {
      canvasWidth: this.width,
      canvasHeight: this.height,
      tileOriginX: tileRect.originX,
      tileOriginY: tileRect.originY,
      positionOriginX: tileRect.originX,
      positionOriginY: tileRect.originY,
      strokeOpacity,
      applyDither,
      ditherStrength,
      renderScale,
    });

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: UNIFORM_STRUCT_BYTES } },
        { binding: 1, resource: tileView },
        { binding: 2, resource: scratchView },
        { binding: 3, resource: selectionView },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: loadExistingTarget ? 'load' : 'clear',
          storeOp: 'store',
        },
      ],
    });

    pass.setPipeline(this.commitPipeline);
    pass.setBindGroup(0, bindGroup, [uniformOffset]);
    const viewport = drawRegion ?? { x: 0, y: 0, width: tileRect.width, height: tileRect.height };
    pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
    pass.setScissorRect(viewport.x, viewport.y, viewport.width, viewport.height);
    pass.draw(6, 1, 0, 0);
    pass.end();
  }

  private writeUniforms(
    index: number,
    args: {
      canvasWidth: number;
      canvasHeight: number;
      tileOriginX: number;
      tileOriginY: number;
      positionOriginX: number;
      positionOriginY: number;
      strokeOpacity: number;
      applyDither: boolean;
      ditherStrength: number;
      renderScale: number;
    }
  ): number {
    const offset = index * this.uniformStride;
    const view = new DataView(this.uniformData);
    view.setUint32(0, args.canvasWidth, true);
    view.setUint32(4, args.canvasHeight, true);
    view.setUint32(8, args.tileOriginX, true);
    view.setUint32(12, args.tileOriginY, true);
    view.setUint32(16, args.positionOriginX, true);
    view.setUint32(20, args.positionOriginY, true);
    view.setFloat32(24, args.strokeOpacity, true);
    view.setUint32(28, args.applyDither ? 1 : 0, true);
    view.setFloat32(32, args.ditherStrength, true);
    view.setFloat32(36, args.renderScale, true);
    this.device.queue.writeBuffer(this.uniformBuffer, offset, this.uniformData);
    return offset;
  }

  private createUniformBuffer(slots: number): GPUBuffer {
    const size = Math.max(this.uniformStride, this.uniformStride * slots);
    return this.device.createBuffer({
      label: 'Tile Composite Uniforms',
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private ensureUniformBufferCapacity(drawCount: number): void {
    if (drawCount <= this.uniformSlots) return;
    let nextSlots = this.uniformSlots;
    while (nextSlots < drawCount) {
      nextSlots *= 2;
    }
    this.uniformBuffer.destroy();
    this.uniformSlots = nextSlots;
    this.uniformBuffer = this.createUniformBuffer(this.uniformSlots);
  }

  private createLayerBlendUniformBuffer(slots: number): GPUBuffer {
    const size = Math.max(this.layerBlendUniformStride, this.layerBlendUniformStride * slots);
    return this.device.createBuffer({
      label: 'Tile Layer Blend Uniforms',
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private ensureLayerBlendUniformCapacity(requiredSlots: number): void {
    if (requiredSlots <= this.layerBlendUniformSlots) return;
    let nextSlots = this.layerBlendUniformSlots;
    while (nextSlots < requiredSlots) {
      nextSlots *= 2;
    }
    this.layerBlendUniformBuffer.destroy();
    this.layerBlendUniformSlots = nextSlots;
    this.layerBlendUniformBuffer = this.createLayerBlendUniformBuffer(this.layerBlendUniformSlots);
  }

  private nextLayerBlendUniformOffset(): number {
    if (this.layerBlendUniformWriteIndex >= this.layerBlendUniformSlots) {
      this.ensureLayerBlendUniformCapacity(this.layerBlendUniformWriteIndex + 1);
    }
    const offset = this.layerBlendUniformWriteIndex * this.layerBlendUniformStride;
    this.layerBlendUniformWriteIndex += 1;
    return offset;
  }

  private rebuildVisibleTiles(): void {
    this.visibleTiles = this.getTilesForRect({
      left: 0,
      top: 0,
      right: this.width,
      bottom: this.height,
    });
  }

  private getTilesForRect(rect: Rect): TileCoord[] {
    const left = Math.max(0, Math.floor(rect.left / this.tileSize));
    const top = Math.max(0, Math.floor(rect.top / this.tileSize));
    const right = Math.min(
      Math.ceil(rect.right / this.tileSize),
      Math.ceil(this.width / this.tileSize)
    );
    const bottom = Math.min(
      Math.ceil(rect.bottom / this.tileSize),
      Math.ceil(this.height / this.tileSize)
    );

    const tiles: TileCoord[] = [];
    for (let ty = top; ty < bottom; ty += 1) {
      for (let tx = left; tx < right; tx += 1) {
        tiles.push({ x: tx, y: ty });
      }
    }
    return tiles;
  }

  private createTempTileTexture(): GPUTexture {
    return this.device.createTexture({
      label: 'Temp Tile',
      size: [this.tileSize, this.tileSize],
      format: this.layerFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
  }

  private createTileRenderTexture(label: string): GPUTexture {
    return this.device.createTexture({
      label,
      size: [this.tileSize, this.tileSize],
      format: this.layerFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
  }
}
