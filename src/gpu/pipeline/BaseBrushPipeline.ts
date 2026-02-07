/**
 * BaseBrushPipeline - Abstract base class for GPU brush pipelines
 *
 * Provides shared functionality for both parametric and texture brush pipelines:
 * - Uniform buffer management (canvas size, blend mode)
 * - Pipeline accessor
 * - Common helper methods
 *
 * Subclasses implement the specific shader, bind group layout, and instance buffer layout.
 */

import type { ColorBlendMode } from '@/stores/settings';

export abstract class BaseBrushPipeline {
  protected device: GPUDevice;
  protected pipeline!: GPURenderPipeline;
  protected uniformBuffer!: GPUBuffer;
  protected bindGroupLayout!: GPUBindGroupLayout;

  // Cached state to avoid redundant GPU uploads
  protected cachedWidth: number = 0;
  protected cachedHeight: number = 0;
  protected cachedColorBlendMode: number = 0; // 0 = sRGB, 1 = linear

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Initialize the pipeline - must be called by subclass constructor after super()
   */
  protected initialize(): void {
    this.uniformBuffer = this.createUniformBuffer();
    this.bindGroupLayout = this.createBindGroupLayout();
    this.pipeline = this.createPipeline();
  }

  // ============================================================================
  // Abstract methods - subclasses must implement
  // ============================================================================

  /**
   * Create the bind group layout specific to this pipeline
   */
  protected abstract createBindGroupLayout(): GPUBindGroupLayout;

  /**
   * Create the render pipeline with shader and instance buffer layout
   * Uses shared logic - subclasses only need to implement getShaderCode() and getInstanceBufferLayout()
   */
  protected createPipeline(): GPURenderPipeline {
    const shaderModule = this.createShaderModule();
    const pipelineLayout = this.device.createPipelineLayout({
      label: `${this.getPipelineLabel()} Pipeline Layout`,
      bindGroupLayouts: [this.bindGroupLayout],
    });
    return this.device.createRenderPipeline(
      this.createBasePipelineDescriptor(shaderModule, pipelineLayout)
    );
  }

  /**
   * Get the shader source code
   */
  protected abstract getShaderCode(): string;

  /**
   * Get the instance buffer layout for vertex shader
   */
  protected abstract getInstanceBufferLayout(): GPUVertexBufferLayout;

  /**
   * Get the pipeline label for debugging
   */
  protected abstract getPipelineLabel(): string;

  // ============================================================================
  // Shared methods
  // ============================================================================

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
   * @param mode - 'srgb' (0) or 'linear' (1)
   */
  updateColorBlendMode(mode: ColorBlendMode): void {
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
   * Get the render pipeline
   */
  get renderPipeline(): GPURenderPipeline {
    return this.pipeline;
  }

  /**
   * Release GPU resources
   * Subclasses should override and call super.destroy() to release additional resources
   */
  destroy(): void {
    this.uniformBuffer.destroy();
  }

  // ============================================================================
  // Helper methods
  // ============================================================================

  /**
   * Create and optionally initialize a GPU buffer
   */
  protected createBuffer(
    label: string,
    size: number,
    usage: number,
    data?: BufferSource | Float32Array
  ): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size, usage });
    if (data) {
      this.device.queue.writeBuffer(buffer, 0, data as unknown as BufferSource);
    }
    return buffer;
  }

  /**
   * Create the uniform buffer (16 bytes: vec2 canvas_size + f32 blend_mode + f32 padding)
   */
  private createUniformBuffer(): GPUBuffer {
    return this.device.createBuffer({
      label: `${this.getPipelineLabel()} Uniforms`,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Create the shader module from source code
   */
  protected createShaderModule(): GPUShaderModule {
    return this.device.createShaderModule({
      label: `${this.getPipelineLabel()} Shader`,
      code: this.getShaderCode(),
    });
  }

  /**
   * Create the base render pipeline descriptor (shared settings)
   * Subclasses call this and customize as needed
   */
  protected createBasePipelineDescriptor(
    shaderModule: GPUShaderModule,
    pipelineLayout: GPUPipelineLayout
  ): GPURenderPipelineDescriptor {
    return {
      label: `${this.getPipelineLabel()} Render Pipeline`,
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [this.getInstanceBufferLayout()],
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
    };
  }
}
