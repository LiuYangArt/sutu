/**
 * BrushPipeline - WebGPU render pipeline for brush dab rendering
 *
 * Creates and manages the GPU pipeline for instanced dab rendering
 * with custom Alpha Darken blending in the fragment shader.
 */

import { DAB_INSTANCE_SIZE } from '../types';

// Import shader source (Vite handles ?raw imports)
import brushShaderCode from '../shaders/brush.wgsl?raw';

export class BrushPipeline {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;

  // Cached canvas size to avoid redundant updates
  private cachedWidth: number = 0;
  private cachedHeight: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      label: 'Brush Shader',
      code: brushShaderCode,
    });

    // Uniform buffer for canvas size (16 bytes: vec2 + padding)
    this.uniformBuffer = device.createBuffer({
      label: 'Brush Uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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
          texture: { sampleType: 'float' },
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
            // Instance buffer layout (per-instance data)
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
                // color: vec4<f32>
                shaderLocation: 3,
                offset: 16,
                format: 'float32x4',
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
            format: 'rgba16float',
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
  }
}
