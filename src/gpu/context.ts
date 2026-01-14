/**
 * GPUContext - WebGPU device initialization and capability detection
 *
 * Singleton pattern for managing WebGPU device lifecycle.
 * Provides graceful fallback detection for unsupported environments.
 */

import type { GPUContextState } from './types';

export class GPUContext {
  private static instance: GPUContext | null = null;
  private state: GPUContextState = {
    supported: false,
    device: null,
    adapter: null,
    features: new Set(),
    limits: null,
  };
  private initPromise: Promise<boolean> | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): GPUContext {
    if (!GPUContext.instance) {
      GPUContext.instance = new GPUContext();
    }
    return GPUContext.instance;
  }

  /**
   * Initialize WebGPU device
   * @returns true if WebGPU is available and initialized successfully
   */
  async initialize(): Promise<boolean> {
    // Return cached promise if already initializing
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<boolean> {
    // Check basic WebGPU support
    if (!navigator.gpu) {
      console.warn('[GPUContext] WebGPU not supported in this browser');
      return false;
    }

    try {
      // Request high-performance adapter
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });

      if (!adapter) {
        console.warn('[GPUContext] No suitable GPU adapter found');
        return false;
      }

      // Check for required features
      const requiredFeatures: GPUFeatureName[] = [];

      // Optional: timestamp-query for performance profiling
      if (adapter.features.has('timestamp-query')) {
        requiredFeatures.push('timestamp-query');
      }

      // Request device with required features and limits
      const device = await adapter.requestDevice({
        requiredFeatures,
        requiredLimits: {
          // 256MB buffer for large canvases (4K+)
          maxBufferSize: 256 * 1024 * 1024,
        },
      });

      // Handle device loss
      device.lost.then((info) => {
        console.error('[GPUContext] Device lost:', info.message);
        this.state.device = null;
        this.state.supported = false;
        // Reset init promise to allow re-initialization
        this.initPromise = null;
      });

      // Handle uncaptured errors
      device.addEventListener('uncapturederror', (event) => {
        console.error('[GPUContext] Uncaptured error:', event.error);
      });

      this.state = {
        supported: true,
        device,
        adapter,
        features: new Set(device.features),
        limits: device.limits,
      };

      console.log('[GPUContext] WebGPU initialized successfully');
      console.log('[GPUContext] Features:', Array.from(device.features));

      return true;
    } catch (e) {
      console.error('[GPUContext] Initialization failed:', e);
      return false;
    }
  }

  /**
   * Get the GPU device (null if not initialized or not supported)
   */
  get device(): GPUDevice | null {
    return this.state.device;
  }

  /**
   * Get the GPU adapter
   */
  get adapter(): GPUAdapter | null {
    return this.state.adapter;
  }

  /**
   * Check if WebGPU is supported and initialized
   */
  get isSupported(): boolean {
    return this.state.supported && this.state.device !== null;
  }

  /**
   * Check if a specific feature is available
   */
  hasFeature(name: string): boolean {
    return this.state.features.has(name);
  }

  /**
   * Get device limits
   */
  get limits(): GPUSupportedLimits | null {
    return this.state.limits;
  }

  /**
   * Check if timestamp query is available for profiling
   */
  get hasTimestampQuery(): boolean {
    return this.hasFeature('timestamp-query');
  }

  /**
   * Destroy the GPU context and release resources
   */
  destroy(): void {
    if (this.state.device) {
      this.state.device.destroy();
    }
    this.state = {
      supported: false,
      device: null,
      adapter: null,
      features: new Set(),
      limits: null,
    };
    this.initPromise = null;
    GPUContext.instance = null;
  }
}

/**
 * Check if WebGPU should be used based on environment and user preferences
 */
export function shouldUseGPU(): boolean {
  // Check WebGPU support
  if (!navigator.gpu) {
    return false;
  }

  // Check for known problematic environments
  const ua = navigator.userAgent;

  // Linux non-Chrome browsers may have compatibility issues
  if (ua.includes('Linux') && !ua.includes('Chrome')) {
    console.log('[shouldUseGPU] Linux non-Chrome detected, falling back to Canvas 2D');
    return false;
  }

  // Check user preference (allow manual override)
  const preference = localStorage.getItem('paintboard-gpu-enabled');
  if (preference === 'false') {
    console.log('[shouldUseGPU] GPU disabled by user preference');
    return false;
  }

  return true;
}

/**
 * Report GPU fallback for debugging/analytics
 */
export function reportGPUFallback(reason: string): void {
  console.warn(`[GPU Fallback] ${reason}, using Canvas 2D`);
  // Could send to analytics service in production
}
