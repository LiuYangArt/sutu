/**
 * TextureBrushPipeline - WebGPU render pipeline for texture-based brush rendering
 *
 * This pipeline is COMPLETELY SEPARATE from BrushPipeline to ensure:
 * - Zero impact on existing soft/hard parametric brushes
 * - Clean separation of texture vs procedural brush logic
 * - Independent optimization paths
 *
 * Uses textureBrush.wgsl shader for texture sampling with Alpha Darken blending.
 */

import type { GPUBrushTexture } from '../resources/TextureAtlas';
import { TEXTURE_DAB_INSTANCE_SIZE } from '../types';

// Import shader source
import textureBrushShaderCode from '../shaders/textureBrush.wgsl?raw';

export class TextureBrushPipeline {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;

  // Cached values to avoid redundant updates
  private cachedWidth: number = 0;
  private cachedHeight: number = 0;
  private cachedColorBlendMode: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      label: 'Texture Brush Shader',
      code: textureBrushShaderCode,
    });

    // Uniform buffer for canvas size (16 bytes: vec2 + blend mode + padding)
    this.uniformBuffer = device.createBuffer({
      label: 'Texture Brush Uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Bind group layout - different from BrushPipeline (has texture + sampler instead of gaussian LUT)
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'Texture Brush Bind Group Layout',
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
          texture: { sampleType: 'unfilterable-float' }, // rgba32float
        },
        {
          // Brush tip texture
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' }, // rgba8unorm
        },
        {
          // Brush texture sampler
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    // Pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      label: 'Texture Brush Pipeline Layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Create render pipeline
    this.pipeline = device.createRenderPipeline({
      label: 'Texture Brush Render Pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            // Instance buffer layout (per-instance data, 48 bytes)
            // Layout: x, y, size, roundness, angle, r, g, b, dabOpacity, flow, texWidth, texHeight
            arrayStride: TEXTURE_DAB_INSTANCE_SIZE,
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
                // roundness: f32
                shaderLocation: 2,
                offset: 12,
                format: 'float32',
              },
              {
                // angle: f32
                shaderLocation: 3,
                offset: 16,
                format: 'float32',
              },
              {
                // color: vec3<f32> (r, g, b)
                shaderLocation: 4,
                offset: 20,
                format: 'float32x3',
              },
              {
                // dabOpacity: f32
                shaderLocation: 5,
                offset: 32,
                format: 'float32',
              },
              {
                // flow: f32
                shaderLocation: 6,
                offset: 36,
                format: 'float32',
              },
              {
                // tex_size: vec2<f32>
                shaderLocation: 7,
                offset: 40,
                format: 'float32x2',
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
            format: 'rgba32float',
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

    const data = new Float32Array([width, height, this.cachedColorBlendMode, 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    this.cachedWidth = width;
    this.cachedHeight = height;
  }

  /**
   * Update color blend mode uniform
   */
  updateColorBlendMode(mode: 'srgb' | 'linear'): void {
    const modeValue = mode === 'linear' ? 1.0 : 0.0;
    if (modeValue === this.cachedColorBlendMode) {
      return;
    }

    const data = new Float32Array([modeValue]);
    this.device.queue.writeBuffer(this.uniformBuffer, 8, data);

    this.cachedColorBlendMode = modeValue;
  }

  /**
   * Create a bind group for rendering
   * Must be called each frame with current source texture and brush texture
   */
  createBindGroup(sourceTexture: GPUTexture, brushTexture: GPUBrushTexture): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'Texture Brush Bind Group',
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
          binding: 2,
          resource: brushTexture.view,
        },
        {
          binding: 3,
          resource: brushTexture.sampler,
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
