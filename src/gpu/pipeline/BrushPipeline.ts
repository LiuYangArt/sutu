/**
 * BrushPipeline - WebGPU render pipeline for parametric brush dab rendering
 *
 * Extends BaseBrushPipeline with:
 * - Procedural brush shape generation (hardness-controlled Gaussian falloff)
 * - Gaussian LUT storage buffer for erf approximation
 *
 * Uses brush.wgsl shader for soft/hard brush rendering with Alpha Darken blending.
 */

import { BaseBrushPipeline } from './BaseBrushPipeline';
import { DAB_INSTANCE_SIZE } from '../types';
import { erfLUT } from '@/utils/maskCache';

// Import shader source (Vite handles ?raw imports)
import brushShaderCode from '../shaders/brush.wgsl?raw';

export class BrushPipeline extends BaseBrushPipeline {
  private gaussianBuffer: GPUBuffer;

  constructor(device: GPUDevice) {
    super(device);

    // Create Gaussian LUT buffer before initialize() since createBindGroupLayout needs it
    this.gaussianBuffer = this.createBuffer(
      'Gaussian LUT',
      erfLUT.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      erfLUT
    );

    // Initialize pipeline (calls abstract methods)
    this.initialize();
  }

  // ============================================================================
  // Abstract method implementations
  // ============================================================================

  protected getShaderCode(): string {
    return brushShaderCode;
  }

  protected getPipelineLabel(): string {
    return 'Brush';
  }

  protected createBindGroupLayout(): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
      label: 'Brush Bind Group Layout',
      entries: [
        {
          // Uniforms (canvas size, blend mode)
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          // Stroke source texture (previous frame for Alpha Darken read)
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' }, // rgba16float requires unfilterable-float
        },
        {
          // Gaussian LUT storage buffer
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });
  }

  protected getInstanceBufferLayout(): GPUVertexBufferLayout {
    return {
      // Instance buffer layout (per-instance data, 36 bytes)
      arrayStride: DAB_INSTANCE_SIZE,
      stepMode: 'instance',
      attributes: [
        {
          // dab_pos: vec2<f32>
          shaderLocation: 0,
          offset: 0,
          format: 'float32x2',
        },
        {
          // dab_size: f32
          shaderLocation: 1,
          offset: 8,
          format: 'float32',
        },
        {
          // hardness: f32
          shaderLocation: 2,
          offset: 12,
          format: 'float32',
        },
        {
          // color: vec3<f32> (r, g, b)
          shaderLocation: 3,
          offset: 16,
          format: 'float32x3',
        },
        {
          // dabOpacity: f32 (alpha ceiling)
          shaderLocation: 4,
          offset: 28,
          format: 'float32',
        },
        {
          // flow: f32
          shaderLocation: 5,
          offset: 32,
          format: 'float32',
        },
      ],
    };
  }

  // ============================================================================
  // Public methods
  // ============================================================================

  /**
   * Create a bind group for rendering
   * Must be called each frame with the current source texture
   */
  createBindGroup(sourceTexture: GPUTexture): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'Brush Bind Group',
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: sourceTexture.createView(),
        },
        {
          binding: 3,
          resource: { buffer: this.gaussianBuffer },
        },
      ],
    });
  }

  /**
   * Release GPU resources
   */
  override destroy(): void {
    super.destroy();
    this.gaussianBuffer.destroy();
  }
}
