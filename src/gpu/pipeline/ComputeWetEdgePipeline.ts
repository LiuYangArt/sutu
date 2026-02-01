/**
 * ComputeWetEdgePipeline - WebGPU Compute Pipeline for Wet Edge Post-Processing
 *
 * This pipeline applies wet edge effect as a stroke-level post-process.
 * It reads from the raw accumulator buffer and writes to a separate display texture,
 * ensuring the raw buffer remains unmodified (avoiding idempotency issues).
 *
 * Key design:
 * - Wet Edge is a "read-only display filter", not an in-place modification
 * - Algorithm matches CPU strokeBuffer.ts:buildWetEdgeLut() exactly
 * - Parameters: centerOpacity=0.65, maxBoost=1.8, minBoost=1.4, gamma=1.3
 */

import type { Rect } from '@/utils/strokeBuffer';

// Import shader source
import wetEdgeShaderCode from '../shaders/computeWetEdge.wgsl?raw';

export class ComputeWetEdgePipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;

  // BindGroup cache (reduce GC pressure)
  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();
  private debugFirstBindGroup: boolean = false;

  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    // Uniform buffer: bbox_offset(8) + bbox_size(8) + canvas_size(8) + hardness(4) + strength(4) = 32 bytes
    this.uniformBuffer = device.createBuffer({
      label: 'Wet Edge Uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.initPipeline();
  }

  private initPipeline(): void {
    // Bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Wet Edge Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float' },
        },
      ],
    });

    this.pipeline = this.device.createComputePipeline({
      label: 'Wet Edge Pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module: this.device.createShaderModule({
          label: 'Wet Edge Shader',
          code: wetEdgeShaderCode,
        }),
        entryPoint: 'main',
      },
    });
  }

  /**
   * Update canvas size (for bounds protection)
   */
  updateCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    // Clear cached BindGroups (texture size may have changed)
    this.cachedBindGroups.clear();
  }

  /**
   * Apply wet edge effect to the stroke buffer
   *
   * IMPORTANT: This reads from inputTexture (raw accumulator) and writes to
   * outputTexture (display buffer). It does NOT modify the raw accumulator,
   * avoiding the idempotency issue where Alpha = f(f(Alpha)) would corrupt the image.
   *
   * @param encoder - Command encoder
   * @param inputTexture - Raw accumulator texture (read-only)
   * @param outputTexture - Display texture (write target)
   * @param dirtyRect - Region to process (in logical coordinates)
   * @param hardness - Brush hardness (0-1)
   * @param strength - Wet edge strength (0-1)
   * @param renderScale - Current render scale (for coordinate conversion)
   */
  dispatch(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    dirtyRect: Rect,
    hardness: number,
    strength: number,
    renderScale: number = 1.0
  ): void {
    // Convert logical coordinates to texture coordinates
    const scale = renderScale;
    const bboxX = Math.max(0, Math.floor(dirtyRect.left * scale));
    const bboxY = Math.max(0, Math.floor(dirtyRect.top * scale));
    const bboxRight = Math.min(this.canvasWidth, Math.ceil(dirtyRect.right * scale));
    const bboxBottom = Math.min(this.canvasHeight, Math.ceil(dirtyRect.bottom * scale));
    const bboxW = bboxRight - bboxX;
    const bboxH = bboxBottom - bboxY;

    if (bboxW <= 0 || bboxH <= 0) return;

    // Upload uniforms
    // Layout: bbox_offset(u32x2) + bbox_size(u32x2) + canvas_size(u32x2) + hardness(f32) + strength(f32)
    const uniformData = new ArrayBuffer(32);
    const u32View = new Uint32Array(uniformData);
    const f32View = new Float32Array(uniformData);

    u32View[0] = bboxX;
    u32View[1] = bboxY;
    u32View[2] = bboxW;
    u32View[3] = bboxH;
    u32View[4] = this.canvasWidth;
    u32View[5] = this.canvasHeight;
    f32View[6] = hardness;
    f32View[7] = strength;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Get or create BindGroup
    const bindGroup = this.getOrCreateBindGroup(inputTexture, outputTexture);

    // Dispatch compute shader
    const pass = encoder.beginComputePass({ label: 'Wet Edge Pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);

    // Workgroup size is 8x8, so dispatch enough workgroups to cover bbox
    const workgroupsX = Math.ceil(bboxW / 8);
    const workgroupsY = Math.ceil(bboxH / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);

    pass.end();
  }

  /**
   * Get or create BindGroup (with caching for performance)
   */
  private getOrCreateBindGroup(inputTexture: GPUTexture, outputTexture: GPUTexture): GPUBindGroup {
    // Use texture label as cache key
    const key = `${inputTexture.label || 'input'}_${outputTexture.label || 'output'}`;

    let bindGroup = this.cachedBindGroups.get(key);
    if (!bindGroup) {
      let debugStart = 0;
      if (!this.debugFirstBindGroup) {
        this.debugFirstBindGroup = true;
        debugStart = performance.now();
        console.log('[ComputeWetEdgePipeline] First bind group create start');
      }
      bindGroup = this.device.createBindGroup({
        label: `Wet Edge BindGroup (${key})`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: inputTexture.createView() },
          { binding: 2, resource: outputTexture.createView() },
        ],
      });
      if (debugStart > 0) {
        console.log(
          `[ComputeWetEdgePipeline] First bind group create end: ${(performance.now() - debugStart).toFixed(2)}ms`
        );
      }
      this.cachedBindGroups.set(key, bindGroup);
    }

    return bindGroup;
  }

  /**
   * Clear cache (call when textures are recreated)
   */
  clearCache(): void {
    this.cachedBindGroups.clear();
  }

  /**
   * Release GPU resources
   */
  destroy(): void {
    this.uniformBuffer.destroy();
    this.cachedBindGroups.clear();
  }
}
