/**
 * BrushPipeline - WebGPU render pipeline for brush dab rendering
 *
 * Creates and manages the GPU pipeline for instanced dab rendering
 * with custom Alpha Darken blending in the fragment shader.
 */

import { DAB_INSTANCE_SIZE } from '../types';
import { erfLUT } from '@/utils/maskCache';

// Import shader source (Vite handles ?raw imports)
import brushShaderCode from '../shaders/brush.wgsl?raw';

export class BrushPipeline {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private gaussianBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;

  // Cached canvas size to avoid redundant updates
  private cachedWidth: number = 0;
  private cachedHeight: number = 0;
  private cachedColorBlendMode: number = 0; // 0 = sRGB, 1 = linear

  constructor(device: GPUDevice) {
    this.device = device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      label: 'Brush Shader',
      code: brushShaderCode,
    });

    // Uniform buffer for canvas size (16 bytes: vec2 + padding)
    this.uniformBuffer = this.createBuffer(
      'Brush Uniforms',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );

    // Gaussian lookup table storage buffer
    this.gaussianBuffer = this.createBuffer(
      'Gaussian LUT',
      erfLUT.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      erfLUT
    );

    // Bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'Brush Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' }, // rgba32float requires unfilterable-float
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    // Pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      label: 'Brush Pipeline Layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Create render pipeline
    this.pipeline = device.createRenderPipeline({
      label: 'Brush Render Pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
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
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: 'rgba32float', // Changed from rgba16float for easy readback
            // No hardware blend - Alpha Darken is done in shader
            blend: undefined,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }

  /**
   * Helper to create and optionally initialize a GPU buffer
   */
  private createBuffer(
    label: string,
    size: number,
    usage: number,
    data?: BufferSource | Float32Array
  ): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size, usage });
    if (data) {
      // Cast needed because WebGPU expects BufferSource (which includes ArrayBufferView),
      // but strict types sometimes mismatch with standard Float32Array
      this.device.queue.writeBuffer(buffer, 0, data as unknown as BufferSource);
    }
    return buffer;
  }

  /**
   * Update canvas size uniform
   */
  updateCanvasSize(width: number, height: number): void {
    if (width === this.cachedWidth && height === this.cachedHeight) {
      return;
    }

    const data = new Float32Array([width, height, 0, 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    this.cachedWidth = width;
    this.cachedHeight = height;
  }

  /**
   * Update color blend mode uniform
   * @param mode - 'srgb' (0) or 'linear' (1)
   */
  updateColorBlendMode(mode: 'srgb' | 'linear'): void {
    const modeValue = mode === 'linear' ? 1.0 : 0.0;
    if (modeValue === this.cachedColorBlendMode) {
      return;
    }

    // Write to offset 8 (third float in the uniform buffer)
    const data = new Float32Array([modeValue]);
    this.device.queue.writeBuffer(this.uniformBuffer, 8, data);

    this.cachedColorBlendMode = modeValue;
  }

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
   * Get the render pipeline
   */
  get renderPipeline(): GPURenderPipeline {
    return this.pipeline;
  }

  /**
   * Release GPU resources
   */
  destroy(): void {
    this.uniformBuffer.destroy();
    this.gaussianBuffer.destroy();
  }
}
