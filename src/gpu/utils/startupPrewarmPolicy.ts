export interface DualStartupPrewarmPolicyInput {
  width: number;
  height: number;
  maxBufferSize: number;
}

export interface DualStartupPrewarmDecision {
  skip: boolean;
  reasons: string[];
}

const LARGE_CANVAS_AREA_THRESHOLD = 16_000_000;
const MAX_BUFFER_SIZE_THRESHOLD = 536_870_912;

export function decideDualStartupPrewarmPolicy(
  input: DualStartupPrewarmPolicyInput
): DualStartupPrewarmDecision {
  const reasons: string[] = [];
  const area = input.width * input.height;

  if (area >= LARGE_CANVAS_AREA_THRESHOLD) {
    reasons.push(`large-canvas-area:${area}`);
  }
  if (input.maxBufferSize <= MAX_BUFFER_SIZE_THRESHOLD) {
    reasons.push(`max-buffer-size:${input.maxBufferSize}`);
  }

  return {
    skip: reasons.length > 0,
    reasons,
  };
}
