import tileCompositeShader from '../shaders/tileComposite.wgsl?raw';
import { GpuLayerStore, type TileCoord, type TileRect } from './GpuLayerStore';
import { TileResidencyManager } from './TileResidencyManager';
import { SelectionMaskGpu } from './SelectionMaskGpu';
import { alignTo } from '../utils/textureCopyRect';
import type { Rect } from '@/utils/strokeBuffer';

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
}

interface ReadbackTarget {
  layerId: string;
  tiles: TileCoord[];
  targetCtx: CanvasRenderingContext2D;
}

const DEFAULT_DITHER_STRENGTH = 1.0;

function createSolidTexture1x1Unorm(
  device: GPUDevice,
  label: string,
  rgba: [number, number, number, number]
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
  return texture;
}

function createSolidTextureUnorm(
  device: GPUDevice,
  label: string,
  size: number,
  rgba: [number, number, number, number]
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [size, size],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
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
  private bindGroupLayout: GPUBindGroupLayout;
  private pipelineLayout: GPUPipelineLayout;
  private displayPipeline: GPURenderPipeline;
  private commitPipeline: GPURenderPipeline;

  private whiteMaskTexture: GPUTexture;
  private whiteMaskView: GPUTextureView;
  private transparentLayerTexture: GPUTexture;
  private transparentLayerView: GPUTextureView;
  private transparentScratchTexture: GPUTexture;
  private transparentScratchView: GPUTextureView;

  private width: number;
  private height: number;
  private tileSize: number;
  private layerFormat: GPUTextureFormat;
  private visibleTiles: TileCoord[] = [];
  private layerRevisions: Map<string, number> = new Map();

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

    this.uniformData = new ArrayBuffer(48);
    this.uniformBuffer = device.createBuffer({
      label: 'Tile Composite Uniforms',
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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
        entryPoint: 'fs_main',
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

    this.whiteMaskTexture = createSolidTexture1x1Unorm(
      device,
      'Selection Mask Fallback',
      [255, 255, 255, 255]
    );
    this.whiteMaskView = this.whiteMaskTexture.createView();

    this.transparentLayerTexture = createSolidTextureUnorm(
      device,
      'Layer Fallback',
      this.tileSize,
      [0, 0, 0, 0]
    );
    this.transparentLayerView = this.transparentLayerTexture.createView();

    this.transparentScratchTexture = createSolidTexture1x1Float(
      device,
      'Scratch Fallback',
      [0, 0, 0, 0]
    );
    this.transparentScratchView = this.transparentScratchTexture.createView();

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
    this.rebuildVisibleTiles();
  }

  setSelectionMask(mask: ImageData | null): void {
    this.selectionMask.update(mask);
  }

  syncLayerFromCanvas(layerId: string, canvas: HTMLCanvasElement, revision: number): void {
    const last = this.layerRevisions.get(layerId);
    if (last === revision) return;
    this.layerStore.uploadLayerFromCanvas(layerId, canvas);
    this.layerRevisions.set(layerId, revision);
  }

  renderFrame(params: RenderFrameParams): void {
    const { layerId, scratchTexture, strokeOpacity, renderScale } = params;
    const clampedOpacity = Math.max(0, Math.min(1, strokeOpacity));
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

    for (const coord of this.visibleTiles) {
      const rect = this.layerStore.getTileRect(coord);
      if (rect.width <= 0 || rect.height <= 0) continue;

      const tile = this.layerStore.getTile(layerId, coord);
      const tileView = tile ? tile.view : this.transparentLayerView;

      this.writeUniforms({
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
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: tileView },
          { binding: 2, resource: scratchView },
          { binding: 3, resource: selectionView },
        ],
      });

      pass.setViewport(rect.originX, rect.originY, rect.width, rect.height, 0, 1);
      pass.setScissorRect(rect.originX, rect.originY, rect.width, rect.height);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6, 1, 0, 0);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  commitStroke(params: CommitStrokeParams): TileCoord[] {
    const { layerId, scratchTexture, dirtyRect, strokeOpacity, renderScale, applyDither } = params;
    const clampedOpacity = Math.max(0, Math.min(1, strokeOpacity));
    const ditherStrength = params.ditherStrength ?? DEFAULT_DITHER_STRENGTH;
    const tiles = this.getTilesForRect(dirtyRect);
    if (tiles.length === 0) return [];

    const scratchView = scratchTexture.createView();
    const selectionView = this.selectionMask.getTextureView() ?? this.whiteMaskView;

    const encoder = this.device.createCommandEncoder();

    for (const coord of tiles) {
      const rect = this.layerStore.getTileRect(coord);
      if (rect.width <= 0 || rect.height <= 0) continue;

      const existingTile = this.layerStore.getTile(layerId, coord);
      if (existingTile) {
        const tempTexture = this.createTempTileTexture();
        const tempView = tempTexture.createView();

        this.renderCompositePass({
          encoder,
          targetView: tempView,
          tileView: existingTile.view,
          scratchView,
          selectionView,
          tileRect: rect,
          strokeOpacity: clampedOpacity,
          renderScale,
          applyDither,
          ditherStrength,
        });

        encoder.copyTextureToTexture({ texture: tempTexture }, { texture: existingTile.texture }, [
          this.tileSize,
          this.tileSize,
        ]);
        tempTexture.destroy();
      } else {
        const newTile = this.layerStore.getOrCreateTile(layerId, coord);
        this.renderCompositePass({
          encoder,
          targetView: newTile.view,
          tileView: this.transparentLayerView,
          scratchView,
          selectionView,
          tileRect: rect,
          strokeOpacity: clampedOpacity,
          renderScale,
          applyDither,
          ditherStrength,
        });
      }
    }

    this.device.queue.submit([encoder.finish()]);
    return tiles;
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

  private renderCompositePass(args: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    tileView: GPUTextureView;
    scratchView: GPUTextureView;
    selectionView: GPUTextureView;
    tileRect: TileRect;
    strokeOpacity: number;
    renderScale: number;
    applyDither: boolean;
    ditherStrength: number;
  }): void {
    const {
      encoder,
      targetView,
      tileView,
      scratchView,
      selectionView,
      tileRect,
      strokeOpacity,
      renderScale,
      applyDither,
      ditherStrength,
    } = args;

    this.writeUniforms({
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
        { binding: 0, resource: { buffer: this.uniformBuffer } },
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
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    pass.setPipeline(this.commitPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setViewport(0, 0, tileRect.width, tileRect.height, 0, 1);
    pass.setScissorRect(0, 0, tileRect.width, tileRect.height);
    pass.draw(6, 1, 0, 0);
    pass.end();
  }

  private writeUniforms(args: {
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
  }): void {
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
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
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
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }
}
