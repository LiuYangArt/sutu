/**
 * PatternManager - Frontend manager for texture pattern resources
 *
 * Responsibility:
 * 1. Fetch pattern data from backend (project://pattern/{id})
 * 2. Decompress LZ4 data using src/utils/lz4.ts
 * 3. Cache decompressed pattern data for rendering
 * 4. Provide synchronous access for the render loop
 */

import { decompressLz4PrependSize } from './lz4';

export interface PatternData {
  id: string;
  width: number;
  height: number;
  data: Uint8Array; // Raw RGBA data
}

class PatternManager {
  private static instance: PatternManager;
  private patterns: Map<string, PatternData> = new Map();
  private pendingRequests: Map<string, Promise<PatternData>> = new Map();

  private constructor() {}

  public static getInstance(): PatternManager {
    if (!PatternManager.instance) {
      PatternManager.instance = new PatternManager();
    }
    return PatternManager.instance;
  }

  /**
   * Get a pattern synchronously (returns undefined if not loaded)
   * This is designed to be called inside the tight render loop (strokeBuffer)
   */
  public getPattern(id: string): PatternData | undefined {
    return this.patterns.get(id);
  }

  /**
   * Check if a pattern is already loaded
   */
  public hasPattern(id: string): boolean {
    return this.patterns.has(id);
  }

  /**
   * Load a pattern from the backend
   * Deduplicates concurrent requests for the same ID
   */
  public async loadPattern(id: string): Promise<PatternData> {
    // 1. Check cache
    if (this.patterns.has(id)) {
      return this.patterns.get(id)!;
    }

    // 2. Check pending requests
    if (this.pendingRequests.has(id)) {
      return this.pendingRequests.get(id)!;
    }

    // 3. Create new request
    const request = this.fetchPattern(id);
    this.pendingRequests.set(id, request);

    try {
      const pattern = await request;
      this.patterns.set(id, pattern);
      return pattern;
    } finally {
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Fetch and decompress pattern data
   */
  private async fetchPattern(id: string): Promise<PatternData> {
    // Tauri v2 Windows restriction: Must use http://project.localhost instead of project://
    // The backend handles /pattern/{id} requests
    const url = `http://project.localhost/pattern/${id}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch pattern ${id}: ${response.status} ${response.statusText}`);
    }

    // Get dimensions from headers (X-Image-Width, X-Image-Height)
    // These are set by the backend (src-tauri/src/lib.rs)
    const widthHeader = response.headers.get('X-Image-Width');
    const heightHeader = response.headers.get('X-Image-Height');

    if (!widthHeader || !heightHeader) {
      throw new Error(`Missing dimension headers for pattern ${id}`);
    }

    const width = parseInt(widthHeader, 10);
    const height = parseInt(heightHeader, 10);

    // Get raw body (LZ4 compressed with prepended size)
    const buffer = await response.arrayBuffer();
    const compressedData = new Uint8Array(buffer);

    // Decompress
    try {
      const decompressedData = decompressLz4PrependSize(compressedData);

      // Verify size
      if (decompressedData.length !== width * height * 4) {
        console.warn(
          `[PatternManager] Decompressed size mismatch for ${id}. Expected ${width * height * 4}, got ${decompressedData.length}`
        );
      }

      return {
        id,
        width,
        height,
        data: decompressedData,
      };
    } catch (e) {
      throw new Error(`Failed to decompress pattern ${id}: ${e}`);
    }
  }
}

export const patternManager = PatternManager.getInstance();
