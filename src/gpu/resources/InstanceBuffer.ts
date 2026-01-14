/**
 * InstanceBuffer - GPU buffer for batched dab rendering
 *
 * Manages a dynamic buffer for GPU instancing of brush dabs.
 * Each dab is packed as 36 bytes (9 floats) for efficient GPU transfer.
 *
 * Layout per instance:
 * | Offset | Size | Field      | Description              |
 * |--------|------|------------|--------------------------|
 * | 0      | 8    | position   | vec2<f32> (x, y)         |
 * | 8      | 4    | size       | f32 (radius)             |
 * | 12     | 4    | hardness   | f32 (0-1)                |
 * | 16     | 12   | color      | vec3<f32> (r,g,b)        |
 * | 28     | 4    | dabOpacity | f32 (alpha ceiling)      |
 * | 32     | 4    | flow       | f32 (per-dab flow)       |
 */

import {
  DAB_INSTANCE_SIZE,
  DAB_FLOATS_PER_INSTANCE,
  INITIAL_INSTANCE_CAPACITY,
  calculateEffectiveRadius,
  type DabInstanceData,
  type BoundingBox,
} from '../types';

export class InstanceBuffer {
  private buffer: GPUBuffer;
  private capacity: number;
  private device: GPUDevice;

  // CPU-side staging data
  private cpuData: Float32Array;
  private pendingCount: number = 0;

  // Cached bounding box
  private minX: number = Infinity;
  private minY: number = Infinity;
  private maxX: number = -Infinity;
  private maxY: number = -Infinity;

  constructor(device: GPUDevice, initialCapacity: number = INITIAL_INSTANCE_CAPACITY) {
    this.device = device;
    this.capacity = initialCapacity;
    this.cpuData = new Float32Array(initialCapacity * DAB_FLOATS_PER_INSTANCE);

    this.buffer = device.createBuffer({
      size: initialCapacity * DAB_INSTANCE_SIZE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Add a dab instance to the buffer
   */
  push(dab: DabInstanceData): void {
    if (this.pendingCount >= this.capacity) {
      this.grow();
    }

    const offset = this.pendingCount * DAB_FLOATS_PER_INSTANCE;
    this.cpuData[offset + 0] = dab.x;
    this.cpuData[offset + 1] = dab.y;
    this.cpuData[offset + 2] = dab.size;
    this.cpuData[offset + 3] = dab.hardness;
    this.cpuData[offset + 4] = dab.r;
    this.cpuData[offset + 5] = dab.g;
    this.cpuData[offset + 6] = dab.b;
    this.cpuData[offset + 7] = dab.dabOpacity;
    this.cpuData[offset + 8] = dab.flow;

    const effectiveRadius = calculateEffectiveRadius(dab.size, dab.hardness);
    this.minX = Math.min(this.minX, dab.x - effectiveRadius);
    this.minY = Math.min(this.minY, dab.y - effectiveRadius);
    this.maxX = Math.max(this.maxX, dab.x + effectiveRadius);
    this.maxY = Math.max(this.maxY, dab.y + effectiveRadius);

    this.pendingCount++;
  }

  /**
   * Get the bounding box of all pending dabs
   * Includes 1px margin for anti-aliasing
   */
  getBoundingBox(): BoundingBox {
    if (this.pendingCount === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    // Add margin for AA edge
    const margin = 2;
    return {
      x: Math.floor(this.minX) - margin,
      y: Math.floor(this.minY) - margin,
      width: Math.ceil(this.maxX - this.minX) + margin * 2,
      height: Math.ceil(this.maxY - this.minY) + margin * 2,
    };
  }

  /**
   * Upload pending data to GPU and reset for next batch
   * @returns Buffer and instance count for draw call
   */
  flush(): { buffer: GPUBuffer; count: number } {
    if (this.pendingCount > 0) {
      this.device.queue.writeBuffer(
        this.buffer,
        0,
        this.cpuData.buffer,
        0,
        this.pendingCount * DAB_INSTANCE_SIZE
      );
    }

    const count = this.pendingCount;
    this.pendingCount = 0;
    this.resetBoundingBox();

    return { buffer: this.buffer, count };
  }

  /**
   * Clear pending data without uploading
   */
  clear(): void {
    this.pendingCount = 0;
    this.resetBoundingBox();
  }

  private resetBoundingBox(): void {
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }

  /**
   * Get pending dab data for per-dab loop rendering
   * Returns array of dab data without clearing the buffer
   */
  getDabsData(): DabInstanceData[] {
    const dabs: DabInstanceData[] = [];
    for (let i = 0; i < this.pendingCount; i++) {
      const offset = i * DAB_FLOATS_PER_INSTANCE;
      dabs.push({
        x: this.cpuData[offset + 0]!,
        y: this.cpuData[offset + 1]!,
        size: this.cpuData[offset + 2]!,
        hardness: this.cpuData[offset + 3]!,
        r: this.cpuData[offset + 4]!,
        g: this.cpuData[offset + 5]!,
        b: this.cpuData[offset + 6]!,
        dabOpacity: this.cpuData[offset + 7]!,
        flow: this.cpuData[offset + 8]!,
      });
    }
    return dabs;
  }

  /**
   * Current number of pending instances
   */
  get count(): number {
    return this.pendingCount;
  }

  /**
   * Get the GPU buffer (for binding)
   */
  get gpuBuffer(): GPUBuffer {
    return this.buffer;
  }

  /**
   * Double the buffer capacity
   */
  private grow(): void {
    const newCapacity = this.capacity * 2;
    const newCpuData = new Float32Array(newCapacity * DAB_FLOATS_PER_INSTANCE);
    newCpuData.set(this.cpuData);
    this.cpuData = newCpuData;

    this.buffer.destroy();
    this.buffer = this.device.createBuffer({
      size: newCapacity * DAB_INSTANCE_SIZE,
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
