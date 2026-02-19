export type StrokePhaseV3 = 'idle' | 'hover' | 'drawing' | 'ended';

export class StrokeStateMachineV3 {
  private phase: StrokePhaseV3 = 'idle';

  get currentPhase(): StrokePhaseV3 {
    return this.phase;
  }

  step(inputPhase: 'hover' | 'down' | 'move' | 'up'): StrokePhaseV3 {
    if (inputPhase === 'down') {
      this.phase = 'drawing';
      return this.phase;
    }
    if (inputPhase === 'up') {
      this.phase = 'ended';
      return this.phase;
    }
    if (inputPhase === 'hover') {
      this.phase = this.phase === 'drawing' ? 'drawing' : 'hover';
      return this.phase;
    }
    if (this.phase === 'idle') {
      this.phase = 'hover';
    }
    return this.phase;
  }

  reset(): void {
    this.phase = 'idle';
  }
}
