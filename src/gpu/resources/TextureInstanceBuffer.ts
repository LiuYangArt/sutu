/**
 * TextureInstanceBuffer - GPU instance buffer for texture brush dabs
 *
 * Similar to InstanceBuffer but with different layout for texture brushes.
 * Layout: 48 bytes per instance (12 floats)
 */

import {
  TEXTURE_DAB_INSTANCE_SIZE,
  TEXTURE_DAB_FLOATS_PER_INSTANCE,
  INITIAL_INSTANCE_CAPACITY,
  type TextureDabInstanceData,
} from '../types';

export class TextureInstanceBuffer {
  private device: GPUDevice;
  private buffer: GPUBuffer;
  private capacity: number;
  private data: Float32Array;
  private _count: number = 0;

  // Bounding box for scissor optimization
  private minX: number = Infinity;
  private minY: number = Infinity;
  private maxX: number = -Infinity;
  private maxY: number = -Infinity;

  // Pending dabs for batch processing
  private pendingDabs: TextureDabInstanceData[] = [];

  constructor(device: GPUDevice) {
    this.device = device;
    this.capacity = INITIAL_INSTANCE_CAPACITY;
    this.data = new Float32Array(this.capacity * TEXTURE_DAB_FLOATS_PER_INSTANCE);

    this.buffer = device.createBuffer({
      label: 'Texture Instance Buffer',
      size: this.capacity * TEXTURE_DAB_INSTANCE_SIZE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Get current dab count
   */
  get count(): number {
    return this._count;
  }

  /**
   * Push a new dab instance
   */
  push(dab: TextureDabInstanceData): void {
    // Grow buffer if needed
    if (this._count >= this.capacity) {
      this.grow();
    }

    // Write to data array
    const offset = this._count * TEXTURE_DAB_FLOATS_PER_INSTANCE;
    this.data[offset] = dab.x;
    this.data[offset + 1] = dab.y;
    this.data[offset + 2] = dab.size;
    this.data[offset + 3] = dab.roundness;
    this.data[offset + 4] = dab.angle;
    this.data[offset + 5] = dab.r;
    this.data[offset + 6] = dab.g;
    this.data[offset + 7] = dab.b;
    this.data[offset + 8] = dab.dabOpacity;
    this.data[offset + 9] = dab.flow;
    this.data[offset + 10] = dab.texWidth;
    this.data[offset + 11] = dab.texHeight;

    // Update bounding box (approximate based on size)
    const halfSize = dab.size / 2;
    this.minX = Math.min(this.minX, dab.x - halfSize);
    this.minY = Math.min(this.minY, dab.y - halfSize);
    this.maxX = Math.max(this.maxX, dab.x + halfSize);
    this.maxY = Math.max(this.maxY, dab.y + halfSize);

    // Store for batch processing
    this.pendingDabs.push(dab);

    this._count++;
  }

  /**
   * Get pending dabs data for per-dab rendering
   */
  getDabsData(): TextureDabInstanceData[] {
    return [...this.pendingDabs];
  }

  /**
   * Get bounding box of all dabs
   */
  getBoundingBox(): { x: number; y: number; width: number; height: number } {
    if (this._count === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return {
      x: this.minX,
      y: this.minY,
      width: this.maxX - this.minX,
      height: this.maxY - this.minY,
    };
  }

  /**
   * Flush data to GPU and return buffer for rendering
   */
  flush(): { buffer: GPUBuffer; count: number } {
    if (this._count === 0) {
      return { buffer: this.buffer, count: 0 };
    }

    // Upload data to GPU
    const uploadSize = this._count * TEXTURE_DAB_INSTANCE_SIZE;
    this.device.queue.writeBuffer(this.buffer, 0, this.data.buffer, 0, uploadSize);

    const count = this._count;

    // Reset for next batch
    this._count = 0;
    this.pendingDabs = [];
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;

    return { buffer: this.buffer, count };
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this._count = 0;
    this.pendingDabs = [];
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }

  /**
   * Grow buffer capacity
   */
  private grow(): void {
    const newCapacity = this.capacity * 2;
    const newData = new Float32Array(newCapacity * TEXTURE_DAB_FLOATS_PER_INSTANCE);
    newData.set(this.data);
    this.data = newData;

    // Destroy old buffer and create new one
    this.buffer.destroy();
    this.buffer = this.device.createBuffer({
      label: 'Texture Instance Buffer',
      size: newCapacity * TEXTURE_DAB_INSTANCE_SIZE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.capacity = newCapacity;
  }

  /**
   * Release GPU resources
   */
  destroy(): void {
    this.buffer.destroy();
  }
}
