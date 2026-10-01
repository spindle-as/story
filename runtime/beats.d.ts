export interface BeatAnalysis {
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
}

export function analyzeBeats(data: ArrayBuffer): Promise<BeatAnalysis>;
