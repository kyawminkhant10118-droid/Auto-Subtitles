export interface SrtCue {
  id: number;
  startSeconds: number;
  endSeconds: number;
  startTime: string;
  endTime: string;
  originalText: string;
  translatedText: string;
}

export interface ChunkPlanItem {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  estimatedWavMB: number;
}

export interface ChunkPlanSummary {
  originalSizeMB: number;
  totalDurationSeconds: number;
  compressedTotalMB: number;
  chunkCount: number;
  chunks: ChunkPlanItem[];
}

/**
 * Formats seconds into standard SRT timestamp format: HH:MM:SS,mmm
 */
export function formatSrtTime(seconds: number): string {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalMs = Math.round(safeSeconds * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Formats seconds into WebVTT timestamp format: HH:MM:SS.mmm
 */
export function formatVttTime(seconds: number): string {
  return formatSrtTime(seconds).replace(',', '.');
}

/**
 * Parses an SRT or VTT timestamp (HH:MM:SS,mmm or MM:SS,mmm or seconds string) into seconds
 */
export function parseSrtTime(timestamp: string): number {
  if (!timestamp) return 0;
  const clean = String(timestamp).trim().replace('.', ',');
  const match = clean.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[,](\d{1,3}))?$/);
  if (!match) {
    const asNum = Number(clean.replace(',', '.'));
    return Number.isFinite(asNum) && asNum >= 0 ? asNum : 0;
  }
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  const msStr = (match[4] || '0').padEnd(3, '0').slice(0, 3);
  const ms = parseInt(msStr, 10);
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

/**
 * Removes ALL corrupted Unicode surrogate sequences (including ud83cd, ud83cudf38,
 * ud83cdf38, \ud83c\udf38, d83c, udf38, u200d, ufe0f, \uXXXX), broken hex escapes,
 * HTML entities, and emoji pictographs that fail to render in mobile/desktop video editors.
 */
export function cleanCorruptedMyanmarText(text: string): {
  cleaned: string;
  removedCount: number;
} {
  if (!text) return { cleaned: '', removedCount: 0 };

  let removedCount = 0;
  let working = String(text);

  const countAndReplace = (
    regex: RegExp,
    replacer: string | ((substring: string, ...args: string[]) => string)
  ) => {
    const matches = working.match(regex);
    if (matches) {
      removedCount += matches.length;
    }
    if (typeof replacer === 'string') {
      working = working.replace(regex, replacer);
    } else {
      working = working.replace(regex, replacer);
    }
  };

  // 1. Full or partial surrogate pairs & truncated hex sequences like:
  // ud83cudf38, \ud83c\udf38, ud83cd, ud83cdf38, ud83d, uD83C, d83cudf38
  const fullOrPartialSurrogateRegex =
    /(?:\\*u)?[dD][89abAB][0-9a-fA-F]{2}(?:\s*(?:\\*u)?[dD][c-fC-F][0-9a-fA-F]{0,4}|[0-9a-fA-F]{0,4})?/g;
  countAndReplace(fullOrPartialSurrogateRegex, '');

  // 2. Trailing low surrogate fragments like udf38, \udf38, udc00, ude0a
  const lowSurrogateRegex = /(?:\\*u)[dD][c-fC-F][0-9a-fA-F]{1,4}/g;
  countAndReplace(lowSurrogateRegex, '');

  // 3. Unescaped or escaped BMP emoji/variation-selector/zero-width hex codes like ufe0f, u200d, u200b, u2764, u2728
  const bmpArtifactHexRegex =
    /(?:\\*u)(?:200[bBcCdDeEfF]|fe0[0-9a-fA-F]|2[67][0-9a-fA-F]{2}|1[fF][0-9a-fA-F]{3})/g;
  countAndReplace(bmpArtifactHexRegex, '');

  // 4. Escaped unicode hex sequences \uXXXX outside Myanmar blocks (0x1000-0x109F, 0xAA60-0xAA7F, 0xA9E0-0xA9FF)
  working = working.replace(/\\+u([0-9a-fA-F]{4})/g, (_full, hex) => {
    const code = parseInt(hex, 16);
    if (
      (code >= 0x1000 && code <= 0x109f) ||
      (code >= 0xaa60 && code <= 0xaa7f) ||
      (code >= 0xa9e0 && code <= 0xa9ff)
    ) {
      return String.fromCharCode(code);
    }
    removedCount += 1;
    return '';
  });

  // 5. All Emoji pictographs, variation selectors, dingbats, and replacement chars (\uFFFD)
  const emojiRegex =
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{FE00}-\u{FE0F}\u{200D}\u{FFFD}]/gu;
  countAndReplace(emojiRegex, '');

  // 6. Actual unpaired UTF-16 surrogates
  const rawSurrogateRegex = /[\uD800-\uDFFF]/g;
  countAndReplace(rawSurrogateRegex, '');

  // 7. Decode common HTML entities that sometimes appear in ASR/LLM outputs
  working = working
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');

  // 8. Remove stray markdown fences if ever present
  working = working.replace(/```(?:srt|vtt|json|text)?/gi, '').replace(/```/g, '');

  // Normalize horizontal whitespace per line while preserving line breaks
  const cleaned = working
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .trim();

  return { cleaned, removedCount };
}

/**
 * Indestructible JSON Array parser for LLM responses.
 * Handles markdown code fences, leading/trailing text, unescaped control characters,
 * and truncated JSON arrays (salvaging all complete objects if the response was cut off).
 */
export function safeParseJsonArray<T = Record<string, unknown>>(rawText: string): T[] {
  if (!rawText || !rawText.trim()) return [];

  const cleaned = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  // Attempt 1: Direct JSON.parse
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed as T[];
    if (parsed && typeof parsed === 'object') {
      const possibleArray = Object.values(parsed).find((v) => Array.isArray(v));
      if (Array.isArray(possibleArray)) return possibleArray as T[];
    }
  } catch {
    // Proceed to recovery steps
  }

  // Attempt 2: Extract between first '[' and last ']'
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const slice = cleaned.slice(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed as T[];
    } catch {
      // Proceed to object-by-object salvage
    }
  }

  // Attempt 3: Salvage all complete `{ ... }` JSON objects (handles truncated LLM JSON output)
  const salvaged: T[] = [];
  const startIdx = firstBracket !== -1 ? firstBracket : 0;
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const candidate = cleaned.slice(objStart, i + 1);
        try {
          const obj = JSON.parse(candidate);
          salvaged.push(obj as T);
        } catch {
          // Ignore malformed individual object
        }
        objStart = -1;
      }
    }
  }

  return salvaged;
}

/**
 * Repairs, sorts, and normalizes cue timestamps and sequence numbers so exported SRTs
 * never have NaN times, reversed start/end times, or uncleaned characters.
 */
export function normalizeAndRepairCues(cues: SrtCue[]): SrtCue[] {
  return cues
    .filter((c) => {
      const text = (c.translatedText || c.originalText || '').trim();
      return text.length > 0;
    })
    .map((cue, index) => {
      const rawStart = Number.isFinite(cue.startSeconds)
        ? Math.max(0, cue.startSeconds)
        : parseSrtTime(cue.startTime || '00:00:00,000');
      const rawEnd = Number.isFinite(cue.endSeconds)
        ? cue.endSeconds
        : parseSrtTime(cue.endTime || '00:00:02,000');
      const startSeconds = Number(rawStart.toFixed(3));
      const endSeconds = Number(Math.max(startSeconds + 0.4, rawEnd).toFixed(3));
      const origCleaned = cleanCorruptedMyanmarText(cue.originalText || '').cleaned;
      const transCleaned = cleanCorruptedMyanmarText(
        cue.translatedText || cue.originalText || ''
      ).cleaned;

      return {
        id: index + 1,
        startSeconds,
        endSeconds,
        startTime: formatSrtTime(startSeconds),
        endTime: formatSrtTime(endSeconds),
        originalText: origCleaned || transCleaned,
        translatedText: transCleaned || origCleaned,
      };
    });
}

/**
 * Parses an SRT string into structured cues.
 */
export function parseSrt(srtContent: string, existingOriginalCues?: SrtCue[]): SrtCue[] {
  if (!srtContent || !srtContent.trim()) return [];

  const normalized = srtContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/```srt/gi, '')
    .replace(/```/g, '')
    .trim();

  const blocks = normalized.split(/\n\s*\n/);
  const cues: SrtCue[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) continue;

    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];
    const [rawStart, rawEnd] = timeLine.split('-->').map((s) => s.trim());
    if (!rawStart || !rawEnd) continue;

    const startSeconds = parseSrtTime(rawStart);
    const endSeconds = Math.max(startSeconds + 0.4, parseSrtTime(rawEnd));
    const startTime = formatSrtTime(startSeconds);
    const endTime = formatSrtTime(endSeconds);

    const textLines = lines.slice(timeLineIndex + 1).join('\n');
    const { cleaned } = cleanCorruptedMyanmarText(textLines);

    const id = cues.length + 1;
    const origMatch = existingOriginalCues?.[id - 1];

    cues.push({
      id,
      startSeconds,
      endSeconds,
      startTime,
      endTime,
      originalText: origMatch ? origMatch.originalText : cleaned,
      translatedText: cleaned,
    });
  }

  return cues;
}

/**
 * Serializes cues into valid SRT format with 100% accurate sequence numbers and timestamps.
 */
export function serializeSrt(
  cues: SrtCue[],
  mode: 'myanmar' | 'original' | 'bilingual' = 'myanmar'
): string {
  const repaired = normalizeAndRepairCues(cues);
  return repaired
    .map((cue, index) => {
      const seq = index + 1;
      const start = formatSrtTime(cue.startSeconds);
      const end = formatSrtTime(cue.endSeconds);
      const myText = cleanCorruptedMyanmarText(cue.translatedText || cue.originalText).cleaned;
      const origText = cleanCorruptedMyanmarText(cue.originalText).cleaned;

      let body = myText;
      if (mode === 'original') {
        body = origText;
      } else if (mode === 'bilingual') {
        body = origText && origText !== myText ? `${myText}\n${origText}` : myText;
      }

      return `${seq}\n${start} --> ${end}\n${body}`;
    })
    .join('\n\n');
}

/**
 * Serializes cues into WebVTT format for HTML5 video track preview or export.
 */
export function serializeVtt(
  cues: SrtCue[],
  mode: 'myanmar' | 'original' | 'bilingual' = 'myanmar'
): string {
  const repaired = normalizeAndRepairCues(cues);
  const body = repaired
    .map((cue, index) => {
      const seq = index + 1;
      const start = formatVttTime(cue.startSeconds);
      const end = formatVttTime(cue.endSeconds);
      const myText = cleanCorruptedMyanmarText(cue.translatedText || cue.originalText).cleaned;
      const origText = cleanCorruptedMyanmarText(cue.originalText).cleaned;

      let text = myText;
      if (mode === 'original') {
        text = origText;
      } else if (mode === 'bilingual') {
        text = origText && origText !== myText ? `${myText}\n${origText}` : myText;
      }

      return `${seq}\n${start} --> ${end}\n${text}`;
    })
    .join('\n\n');

  return `WEBVTT\n\n${body}`;
}

/**
 * Shifts all cue timestamps by offsetMs milliseconds (positive or negative).
 */
export function shiftSrtTimestamps(cues: SrtCue[], offsetMs: number): SrtCue[] {
  const offsetSec = offsetMs / 1000;
  return cues.map((cue) => {
    const duration = Math.max(0.2, cue.endSeconds - cue.startSeconds);
    const newStart = Math.max(0, Number((cue.startSeconds + offsetSec).toFixed(3)));
    const newEnd = Number((newStart + duration).toFixed(3));
    return {
      ...cue,
      startSeconds: newStart,
      endSeconds: newEnd,
      startTime: formatSrtTime(newStart),
      endTime: formatSrtTime(newEnd),
    };
  });
}

/**
 * Splits cues into compact batches (default 20 cues per batch) so long videos translate
 * reliably without hitting token output limits or timeouts.
 */
export function chunkCuesForBatchTranslation(
  cues: SrtCue[],
  batchSize = 20
): SrtCue[][] {
  const safeBatchSize = Math.max(1, batchSize);
  const batches: SrtCue[][] = [];
  for (let i = 0; i < cues.length; i += safeBatchSize) {
    batches.push(cues.slice(i, i + safeBatchSize));
  }
  return batches;
}

/**
 * Calculates the 16kHz Mono WAV compression and chunking plan for any file size.
 * Uses 120-second (2-minute) chunks (~3.66 MB raw WAV / ~4.88 MB base64) by default
 * so mobile browsers and serverless proxies never hit 413 Payload Too Large or memory limits.
 */
export function calculateChunkPlan(
  fileSizeBytes: number,
  durationSeconds: number,
  chunkDurationSeconds = 120
): ChunkPlanSummary {
  const originalSizeMB = Number((fileSizeBytes / (1024 * 1024)).toFixed(2));
  const safeDuration = Math.max(1, durationSeconds);
  const bytesPerSecond16kMono = 16000 * 2; // 32,000 bytes/sec
  const compressedTotalMB = Number(
    ((safeDuration * bytesPerSecond16kMono) / (1024 * 1024)).toFixed(2)
  );

  const chunkCount = Math.max(1, Math.ceil(safeDuration / chunkDurationSeconds));
  const chunks: ChunkPlanItem[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const startSeconds = i * chunkDurationSeconds;
    const endSeconds = Math.min(safeDuration, (i + 1) * chunkDurationSeconds);
    const dur = endSeconds - startSeconds;
    const estimatedWavMB = Number(
      ((dur * bytesPerSecond16kMono + 44) / (1024 * 1024)).toFixed(2)
    );
    chunks.push({
      index: i + 1,
      startSeconds,
      endSeconds,
      durationSeconds: dur,
      estimatedWavMB,
    });
  }

  return {
    originalSizeMB,
    totalDurationSeconds: safeDuration,
    compressedTotalMB,
    chunkCount,
    chunks,
  };
}
