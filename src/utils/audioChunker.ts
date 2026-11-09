export interface AudioChunkPayload {
  chunkIndex: number;
  totalChunks: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  sizeMB: number;
  mimeType: string;
  base64Wav: string;
}

/**
 * Encodes a mono Float32Array PCM slice at `sampleRate` (16000Hz) into a standard 16-bit WAV Blob.
 */
export function encodeMonoWavBlob(samples: Float32Array, sampleRate = 16000): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () =>
      reject(new Error('ဖိုင်ကို Base64 ပြောင်းလဲရာတွင် အမှားဖြစ်ပွားပါသည်။'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Downsamples a specific time window [startSec, endSec] from an AudioBuffer directly
 * to 16kHz Mono without allocating an OfflineAudioContext (prevents mobile RAM crashes).
 */
function downsampleSliceTo16kMono(
  audioBuffer: AudioBuffer,
  startSec: number,
  endSec: number,
  targetRate = 16000
): Float32Array {
  const sourceRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : null;

  const duration = Math.max(0.1, endSec - startSec);
  const outLength = Math.floor(duration * targetRate);
  const output = new Float32Array(outLength);
  const ratio = sourceRate / targetRate;
  const startSourceIndex = Math.floor(startSec * sourceRate);
  const maxSourceIndex = ch0.length - 1;

  for (let i = 0; i < outLength; i++) {
    const srcIdx = Math.min(maxSourceIndex, Math.floor(startSourceIndex + i * ratio));
    const sample = ch1 ? (ch0[srcIdx] + ch1[srcIdx]) * 0.5 : ch0[srcIdx];
    output[i] = sample;
  }

  return output;
}

/**
 * Probes media duration using an HTML5 video/audio element without loading the entire file into RAM.
 */
export function probeMediaDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(
      file.type.startsWith('audio') ? 'audio' : 'video'
    );
    el.preload = 'metadata';

    const cleanup = (dur: number) => {
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      resolve(dur);
    };

    const timer = window.setTimeout(() => cleanup(120), 4500);

    el.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 120;
      cleanup(d);
    };
    el.onerror = () => {
      window.clearTimeout(timer);
      cleanup(120);
    };
    el.src = url;
  });
}

/**
 * Zero-RAM WAV file slicer: reads the 44-byte WAV header from the start of a huge .wav file
 * and slices the PCM payload via Blob.slice(), prepending a valid WAV header to every chunk.
 */
async function streamWavFileSlices(
  file: File,
  totalDurationSeconds: number,
  onChunkReady: (chunk: AudioChunkPayload) => Promise<void>,
  shouldCancel?: () => boolean
): Promise<number> {
  const headerBuf = await file.slice(0, 44).arrayBuffer();
  const headerView = new DataView(headerBuf);
  const channels = headerView.getUint16(22, true) || 1;
  const sampleRate = headerView.getUint32(24, true) || 16000;
  const bitsPerSample = headerView.getUint16(34, true) || 16;
  const blockAlign = Math.max(1, channels * (bitsPerSample / 8));

  const maxChunkBytes = Math.floor((8 * 1024 * 1024) / blockAlign) * blockAlign;
  const dataSize = Math.max(0, file.size - 44);
  const totalChunks = Math.max(1, Math.ceil(dataSize / maxChunkBytes));

  for (let i = 0; i < totalChunks; i++) {
    if (shouldCancel?.()) break;

    const startOffset = 44 + i * maxChunkBytes;
    const endOffset = Math.min(file.size, 44 + (i + 1) * maxChunkBytes);
    const sliceByteLength = endOffset - startOffset;

    const newHeader = headerBuf.slice(0);
    const newHeaderView = new DataView(newHeader);
    newHeaderView.setUint32(4, 36 + sliceByteLength, true);
    newHeaderView.setUint32(40, sliceByteLength, true);

    const pcmSlice = file.slice(startOffset, endOffset);
    const validWavBlob = new Blob([newHeader, pcmSlice], { type: 'audio/wav' });
    const base64Wav = await blobToBase64(validWavBlob);

    const startRatio = (startOffset - 44) / Math.max(1, dataSize);
    const endRatio = (endOffset - 44) / Math.max(1, dataSize);
    const startSeconds = Number((startRatio * totalDurationSeconds).toFixed(2));
    const endSeconds = Number((endRatio * totalDurationSeconds).toFixed(2));
    const durationSeconds = Number(Math.max(1, endSeconds - startSeconds).toFixed(2));
    const sizeMB = Number((validWavBlob.size / (1024 * 1024)).toFixed(2));

    await onChunkReady({
      chunkIndex: i + 1,
      totalChunks,
      startSeconds,
      endSeconds,
      durationSeconds,
      sizeMB,
      mimeType: 'audio/wav',
      base64Wav,
    });
  }

  return totalChunks;
}

/**
 * Fallback frame/byte slicer when Web Audio API cannot decode an audio/video file directly.
 */
async function streamFallbackSlices(
  file: File,
  totalDurationSeconds: number,
  onChunkReady: (chunk: AudioChunkPayload) => Promise<void>,
  shouldCancel?: () => boolean
): Promise<number> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.wav') && file.size > 44) {
    return streamWavFileSlices(file, totalDurationSeconds, onChunkReady, shouldCancel);
  }

  const maxChunkBytes = 8 * 1024 * 1024; // 8 MB binary (~10.6 MB base64)
  const totalChunks = Math.max(1, Math.ceil(file.size / maxChunkBytes));
  const mimeType =
    file.type || (lower.endsWith('.mp3') ? 'audio/mp3' : 'video/mp4');

  for (let i = 0; i < totalChunks; i++) {
    if (shouldCancel?.()) break;

    const startByte = i * maxChunkBytes;
    const endByte = Math.min(file.size, (i + 1) * maxChunkBytes);
    const sliceBlob = file.slice(startByte, endByte, mimeType);

    const startRatio = startByte / Math.max(1, file.size);
    const endRatio = endByte / Math.max(1, file.size);
    const startSeconds = Number((startRatio * totalDurationSeconds).toFixed(2));
    const endSeconds = Number((endRatio * totalDurationSeconds).toFixed(2));
    const durationSeconds = Number(Math.max(1, endSeconds - startSeconds).toFixed(2));
    const base64Wav = await blobToBase64(sliceBlob);
    const sizeMB = Number((sliceBlob.size / (1024 * 1024)).toFixed(2));

    await onChunkReady({
      chunkIndex: i + 1,
      totalChunks,
      startSeconds,
      endSeconds,
      durationSeconds,
      sizeMB,
      mimeType,
      base64Wav,
    });
  }

  return totalChunks;
}

/**
 * Streams 2-minute (120s = ~3.66 MB) 16kHz Mono WAV chunks ONE AT A TIME via `onChunkReady`
 * so peak memory stays minimal (never holding multiple Base64 chunks in RAM at once)
 * and every chunk has a valid 16kHz Mono WAV header.
 */
export async function processAudioChunksStreaming(
  file: File,
  chunkDurationSeconds = 120,
  onProgress: (message: string, percent: number) => void,
  onChunkReady: (chunk: AudioChunkPayload) => Promise<void>,
  shouldCancel?: () => boolean
): Promise<number> {
  onProgress('ဗီဒီယို/အသံဖိုင်ကို စစ်ဆေးပြီး 16kHz အသံချုံ့စနစ် စတင်နေပါသည်...', 8);

  const probedDuration = await probeMediaDuration(file);
  const lower = file.name.toLowerCase();

  // If it's already a .wav file larger than 80MB, slice its PCM bytes directly with zero RAM
  if (lower.endsWith('.wav') && file.size > 80 * 1024 * 1024) {
    onProgress('WAV အသံဖိုင်ကြီးကို Zero-RAM Slicer စနစ်ဖြင့် အပိုင်းခွဲနေပါသည်...', 12);
    return streamWavFileSlices(file, probedDuration, onChunkReady, shouldCancel);
  }

  try {
    let arrayBuffer: ArrayBuffer | null = await file.arrayBuffer();
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new AudioCtx();

    let decodedBuffer: AudioBuffer;
    try {
      decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      // Immediately release raw file ArrayBuffer so garbage collector frees RAM
      arrayBuffer = null;
    } finally {
      await audioCtx.close().catch(() => {});
    }

    const totalDuration = decodedBuffer.duration || probedDuration;
    const safeChunkSec = Math.min(chunkDurationSeconds, 120); // 2 mins (~3.66 MB) per WAV chunk
    const totalChunks = Math.max(1, Math.ceil(totalDuration / safeChunkSec));

    for (let i = 0; i < totalChunks; i++) {
      if (shouldCancel?.()) break;

      const startSeconds = Number((i * safeChunkSec).toFixed(2));
      const endSeconds = Number(Math.min(totalDuration, (i + 1) * safeChunkSec).toFixed(2));
      const durationSeconds = Number(Math.max(0.5, endSeconds - startSeconds).toFixed(2));

      const mono16kSamples = downsampleSliceTo16kMono(
        decodedBuffer,
        startSeconds,
        endSeconds,
        16000
      );
      const wavBlob = encodeMonoWavBlob(mono16kSamples, 16000);
      const base64Wav = await blobToBase64(wavBlob);
      const sizeMB = Number((wavBlob.size / (1024 * 1024)).toFixed(2));

      await onChunkReady({
        chunkIndex: i + 1,
        totalChunks,
        startSeconds,
        endSeconds,
        durationSeconds,
        sizeMB,
        mimeType: 'audio/wav',
        base64Wav,
      });
    }

    return totalChunks;
  } catch (decodeErr) {
    console.warn('Web Audio decode fallback to stream slices:', decodeErr);
    onProgress('Direct Media Chunking စနစ်ဖြင့် အသံအပိုင်းခွဲထုတ်နေပါသည်...', 12);
    return streamFallbackSlices(file, probedDuration, onChunkReady, shouldCancel);
  }
}

/**
 * Legacy helper that collects all chunks into an array.
 */
export async function extractAndSliceAudioChunks(
  file: File,
  chunkDurationSeconds = 120,
  onProgress?: (message: string, percent: number) => void
): Promise<AudioChunkPayload[]> {
  const chunks: AudioChunkPayload[] = [];
  await processAudioChunksStreaming(
    file,
    chunkDurationSeconds,
    onProgress || (() => {}),
    async (chunk) => {
      chunks.push(chunk);
    }
  );
  return chunks;
}
