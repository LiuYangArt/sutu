/**
 * ComputeDualBlendPipeline - GPU compute pipeline for dual brush stroke-level blending
 */

import type { Rect } from '@/utils/strokeBuffer';

import computeShaderCode from '../shaders/computeDualBlend.wgsl?raw';

export class ComputeDualBlendPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;

  private cachedBindGroups: Map<string, GPUBindGroup> = new Map();
  private debugFirstBindGroup: boolean = false;

  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    // Uniform buffer: bbox_offset(8) + bbox_size(8) + canvas_size(8) + blend_mode(4) + padding(4) = 32 bytes
    this.uniformBuffer = device.createBuffer({
      label: 'Compute Dual Blend Uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.initPipeline();
  }

  private initPipeline(): void {
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Compute Dual Blend Bind Group Layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float' },
        },
      ],
    });

    this.pipeline = this.device.createComputePipeline({
      label: 'Compute Dual Blend Pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: {
        module: this.device.createShaderModule({
          label: 'Compute Dual Blend Shader',
          code: computeShaderCode,
        }),
        entryPoint: 'main',
      },
    });
  }

  updateCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.cachedBindGroups.clear();
  }

  dispatch(
    encoder: GPUCommandEncoder,
    primaryTexture: GPUTexture,
    dualMaskTexture: GPUTexture,
    outputTexture: GPUTexture,
    dirtyRect: Rect,
    blendMode: number,
    renderScale: number = 1.0
  ): void {
    const scale = renderScale;
    const bboxX = Math.max(0, Math.floor(dirtyRect.left * scale));
    const bboxY = Math.max(0, Math.floor(dirtyRect.top * scale));
    const bboxRight = Math.min(this.canvasWidth, Math.ceil(dirtyRect.right * scale));
    const bboxBottom = Math.min(this.canvasHeight, Math.ceil(dirtyRect.bottom * scale));
    const bboxW = bboxRight - bboxX;
    const bboxH = bboxBottom - bboxY;

    if (bboxW <= 0 || bboxH <= 0) return;

    const uniformData = new ArrayBuffer(32);
    const u32View = new Uint32Array(uniformData);
    u32View[0] = bboxX;
    u32View[1] = bboxY;
    u32View[2] = bboxW;
    u32View[3] = bboxH;
    u32View[4] = this.canvasWidth;
    u32View[5] = this.canvasHeight;
    u32View[6] = blendMode >>> 0;
    u32View[7] = 0;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const bindGroup = this.getOrCreateBindGroup(primaryTexture, dualMaskTexture, outputTexture);

    const pass = encoder.beginComputePass({ label: 'Compute Dual Blend Pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(bboxW / 8);
    const workgroupsY = Math.ceil(bboxH / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();
  }

  private getOrCreateBindGroup(
    primaryTexture: GPUTexture,
    dualMaskTexture: GPUTexture,
    outputTexture: GPUTexture
  ): GPUBindGroup {
    const key = `${primaryTexture.label || 'primary'}_${dualMaskTexture.label || 'dual'}_${
      outputTexture.label || 'output'
    }`;

    let bindGroup = this.cachedBindGroups.get(key);
    if (!bindGroup) {
      let debugStart = 0;
      if (!this.debugFirstBindGroup) {
        this.debugFirstBindGroup = true;
        debugStart = performance.now();
        console.log('[ComputeDualBlendPipeline] First bind group create start');
      }
      bindGroup = this.device.createBindGroup({
        label: `Compute Dual Blend BindGroup (${key})`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: primaryTexture.createView() },
          { binding: 2, resource: dualMaskTexture.createView() },
          { binding: 3, resource: outputTexture.createView() },
        ],
      });
      if (debugStart > 0) {
        console.log(
          `[ComputeDualBlendPipeline] First bind group create end: ${(performance.now() - debugStart).toFixed(2)}ms`
        );
      }
      this.cachedBindGroups.set(key, bindGroup);
    }

    return bindGroup;
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.cachedBindGroups.clear();
  }
}
