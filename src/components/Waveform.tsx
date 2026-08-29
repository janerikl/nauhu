import { useEffect, useRef, useState } from "react";

// Peaks are cached per source id so re-renders (drag, trim, zoom) don't
// re-decode the audio file each time.
const peaksCache = new Map<string, Float32Array>();
let sharedAudioContext: AudioContext | null = null;

async function getPeaks(sourceId: string, blob: Blob): Promise<Float32Array> {
  const cached = peaksCache.get(sourceId);
  if (cached) return cached;

  sharedAudioContext ??= new AudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await sharedAudioContext.decodeAudioData(arrayBuffer);

  const channel = audioBuffer.getChannelData(0);
  const samplesPerPeak = 512;
  const peakCount = Math.ceil(channel.length / samplesPerPeak);
  const peaks = new Float32Array(peakCount);
  for (let i = 0; i < peakCount; i++) {
    let max = 0;
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, channel.length);
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }

  const withDuration = Object.assign(peaks, { duration: audioBuffer.duration }) as Float32Array & {
    duration: number;
  };
  peaksCache.set(sourceId, withDuration);
  return withDuration;
}

interface WaveformProps {
  sourceId: string;
  blob: Blob;
  /** seconds into the source where the visible clip region starts */
  sourceIn: number;
  /** seconds into the source where the visible clip region ends */
  sourceOut: number;
  width: number;
  height: number;
}

export function Waveform({ sourceId, blob, sourceIn, sourceOut, width, height }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<(Float32Array & { duration?: number }) | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPeaks(sourceId, blob).then((p) => {
      if (!cancelled) setPeaks(p);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceId, blob]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || !peaks.duration || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";

    const peaksPerSecond = peaks.length / peaks.duration;
    const startIdx = Math.floor(sourceIn * peaksPerSecond);
    const endIdx = Math.ceil(sourceOut * peaksPerSecond);
    const visibleCount = Math.max(1, endIdx - startIdx);
    const mid = height / 2;

    for (let x = 0; x < width; x++) {
      const idx = startIdx + Math.floor((x / width) * visibleCount);
      const value = peaks[idx] ?? 0;
      const barHeight = Math.max(1, value * height);
      ctx.fillRect(x, mid - barHeight / 2, 1, barHeight);
    }
  }, [peaks, sourceIn, sourceOut, width, height]);

  return <canvas ref={canvasRef} className="clip-waveform" style={{ width, height }} />;
}
