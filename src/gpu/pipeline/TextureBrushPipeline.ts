/**
 * TextureBrushPipeline - WebGPU render pipeline for texture-based brush rendering
 *
 * Extends BaseBrushPipeline with:
 * - Texture sampling from imported brush tips (ABR files)
 * - Brush texture + sampler binding
 *
 * Uses textureBrush.wgsl shader for texture sampling with Alpha Darken blending.
 */

import { BaseBrushPipeline } from './BaseBrushPipeline';
import type { GPUBrushTexture } from '../resources/TextureAtlas';
import { TEXTURE_DAB_INSTANCE_SIZE } from '../types';

// Import shader source
import textureBrushShaderCode from '../shaders/textureBrush.wgsl?raw';

export class TextureBrushPipeline extends BaseBrushPipeline {
  constructor(device: GPUDevice) {
    super(device);

    // Initialize pipeline (calls abstract methods)
    this.initialize();
  }

  // ============================================================================
  // Abstract method implementations
  // ============================================================================

  protected getShaderCode(): string {
    return textureBrushShaderCode;
  }

  protected getPipelineLabel(): string {
    return 'Texture Brush';
  }

  protected createBindGroupLayout(): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
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
          texture: { sampleType: 'unfilterable-float' }, // rgba16float
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
  }

  protected getInstanceBufferLayout(): GPUVertexBufferLayout {
    return {
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
    };
  }

  // ============================================================================
  // Public methods
  // ============================================================================

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
}
