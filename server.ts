import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import {
  cleanCorruptedMyanmarText,
  formatSrtTime,
  parseSrtTime,
  safeParseJsonArray,
  normalizeAndRepairCues,
  SrtCue,
} from './src/utils/srtTools.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isValidConfiguredKey(key?: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('MY_') || trimmed.startsWith('YOUR_')) return false;
  return true;
}

function getGenAIClient() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getStyleInstruction(style: string): string {
  if (style === 'movie') {
    return 'Use natural, expressive Burmese cinema/movie dialogue phrasing (သဘာဝကျသော ရုပ်ရှင်စကားပြောဟန်).';
  }
  if (style === 'formal') {
    return 'Use clear, polite, formal Myanmar documentary/educational style (သပ်ရပ်ရှင်းလင်းသော စာပေ/မှတ်တမ်းဟန်).';
  }
  return 'Use fluent, natural everyday spoken Myanmar (Burmese) language (နေ့စဉ်သုံး သဘာဝ မြန်မာစကားပြောဟန်).';
}

/**
 * Retries an async operation with exponential backoff to handle transient 429 rate-limit or 503 errors
 * during multi-chunk / multi-batch processing of long videos.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1800): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403') || msg.includes('API_KEY_INVALID')) {
        throw err;
      }
      if (attempt < maxRetries - 1) {
        const waitMs = baseDelayMs * Math.pow(1.8, attempt);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastError;
}

/**
 * Calls Groq Whisper (whisper-large-v3-turbo) with verbose_json when GROQ_API_KEY is configured on the server.
 */
async function transcribeWithGroqWhisper(
  base64Audio: string,
  mimeType: string,
  offsetSeconds: number,
  chunkDurationSeconds: number
): Promise<Array<{ id: number; startSeconds: number; endSeconds: number; originalText: string }>> {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (!isValidConfiguredKey(groqKey)) {
    throw new Error('GROQ_API_KEY not configured');
  }

  return withRetry(async () => {
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    const ext = mimeType.includes('mp3')
      ? 'mp3'
      : mimeType.includes('mp4') || mimeType.includes('m4a')
      ? 'm4a'
      : 'wav';
    const blob = new Blob([audioBuffer], { type: mimeType || 'audio/wav' });

    const formData = new FormData();
    formData.append('file', blob, `chunk.${ext}`);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'verbose_json');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(
        (errData as { error?: { message?: string } })?.error?.message ||
          `Groq Whisper transcription failed (${response.status})`
      );
    }

    const data = (await response.json()) as {
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

    const segments = data.segments || [];
    if (segments.length > 0) {
      return segments
        .filter((seg) => (seg.text || '').trim().length > 0)
        .map((seg, idx) => {
          const startSeconds = Number(
            Math.max(0, Number(seg.start || 0) + offsetSeconds).toFixed(3)
          );
          const endSeconds = Number(
            Math.max(
              startSeconds + 0.4,
              Number(seg.end || startSeconds + 2) + offsetSeconds
            ).toFixed(3)
          );
          return {
            id: idx + 1,
            startSeconds,
            endSeconds,
            originalText: cleanCorruptedMyanmarText(seg.text || '').cleaned,
          };
        });
    }

    if (data.text && data.text.trim().length > 0) {
      return [
        {
          id: 1,
          startSeconds: Number(offsetSeconds.toFixed(3)),
          endSeconds: Number((offsetSeconds + Math.max(2, chunkDurationSeconds)).toFixed(3)),
          originalText: cleanCorruptedMyanmarText(data.text).cleaned,
        },
      ];
    }

    return [];
  });
}

/**
 * Translates a single sub-batch (<= 20 cues) into clean Myanmar using Gemini (`gemini-3.8-flash`)
 * with strict ID-locking, safe JSON recovery, and automatic retry.
 */
async function translateSubBatchWithGemini(
  cues: Array<{ id: number; startSeconds: number; endSeconds: number; originalText: string }>,
  style: string
): Promise<SrtCue[]> {
  if (cues.length === 0) return [];

  const ai = getGenAIClient();
  const styleInstruction = getStyleInstruction(style);

  const inputPayload = cues.map((c) => ({
    id: c.id,
    text: c.originalText,
  }));

  const translatedList = await withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: `Translate the following subtitle lines into natural Myanmar (Burmese).
${styleInstruction}

STRICT RULES:
1. Return the exact same "id" for each item so timestamps stay 100% locked.
2. NEVER output emojis, icons, or unicode surrogate codes (like ud83c, ud83cd, ufe0f, u200d, \\u, etc.). Use ONLY pure Myanmar Unicode text.
3. Translate every single item in the JSON array without skipping or merging any lines.

Input Subtitles:
${JSON.stringify(inputPayload)}`,
      config: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.INTEGER },
              translatedText: { type: Type.STRING },
            },
            required: ['id', 'translatedText'],
          },
        },
      },
    });

    return safeParseJsonArray<{ id: number; translatedText: string }>(response.text ?? '[]');
  });

  const mapById = new Map<number, string>();
  for (const item of translatedList) {
    if (item && item.id !== undefined) {
      mapById.set(
        Number(item.id),
        cleanCorruptedMyanmarText(item.translatedText || '').cleaned
      );
    }
  }

  return cues.map((cue, idx) => {
    const byId = mapById.get(Number(cue.id));
    const byIndex =
      translatedList[idx] && translatedList[idx].translatedText
        ? cleanCorruptedMyanmarText(translatedList[idx].translatedText).cleaned
        : '';
    return {
      id: cue.id,
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      startTime: formatSrtTime(cue.startSeconds),
      endTime: formatSrtTime(cue.endSeconds),
      originalText: cue.originalText,
      translatedText: byId || byIndex || cue.originalText,
    };
  });
}

/**
 * Translates any number of subtitle cues in safe 20-cue sub-batches so output token limits are never exceeded.
 */
async function translateCuesWithGemini(
  cues: Array<{ id: number; startSeconds: number; endSeconds: number; originalText: string }>,
  style: string
): Promise<SrtCue[]> {
  if (cues.length === 0) return [];
  const subBatchSize = 20;
  const results: SrtCue[] = [];
  for (let i = 0; i < cues.length; i += subBatchSize) {
    const slice = cues.slice(i, i + subBatchSize);
    const translatedSlice = await translateSubBatchWithGemini(slice, style);
    results.push(...translatedSlice);
  }
  return results;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  app.get('/api/status', (_req, res) => {
    res.json({
      ok: true,
      groqConfigured: isValidConfiguredKey(process.env.GROQ_API_KEY),
      geminiConfigured: isValidConfiguredKey(process.env.GEMINI_API_KEY),
    });
  });

  app.post('/api/transcribe-chunk', async (req, res) => {
    try {
      const {
        base64Audio,
        mimeType = 'audio/wav',
        offsetSeconds = 0,
        chunkDurationSeconds = 120,
        style = 'natural',
      } = req.body;

      if (!base64Audio) {
        res.status(400).json({ error: 'အသံဖိုင် ဒေတာ မပါဝင်ပါ။' });
        return;
      }

      const numOffset = Number(offsetSeconds) || 0;
      const numDuration = Number(chunkDurationSeconds) || 120;

      // Path A: Groq Whisper + Gemini Sub-Batched Translation if GROQ_API_KEY is valid
      if (isValidConfiguredKey(process.env.GROQ_API_KEY)) {
        try {
          const whisperSegments = await transcribeWithGroqWhisper(
            base64Audio,
            mimeType,
            numOffset,
            numDuration
          );
          if (whisperSegments.length > 0) {
            const translatedCues = await translateCuesWithGemini(whisperSegments, style);
            res.json({
              cues: normalizeAndRepairCues(translatedCues),
              engine: 'groq-whisper+gemini',
            });
            return;
          }
        } catch (groqErr) {
          console.warn('Groq Whisper fallback to Gemini multimodal:', groqErr);
        }
      }

      // Path B: Direct Gemini Multimodal Transcription + Translation with Retry & Safe JSON Recovery
      const ai = getGenAIClient();
      const styleInstruction = getStyleInstruction(style);

      const segments = await withRetry(async () => {
        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Audio,
                },
              },
              {
                text: `Listen carefully to this audio clip (duration approx ${Math.round(
                  numDuration
                )} seconds) and generate accurate, time-aligned subtitle segments.
For each spoken phrase or sentence:
1. Provide exact "start" and "end" times in seconds (e.g. 1.25 to 4.10) relative to the start of this audio clip (between 0 and ${Math.ceil(
                  numDuration + 2
                )}).
2. Provide the exact "originalText" in the spoken language.
3. Provide the "translatedText" translated into natural Myanmar (Burmese). ${styleInstruction}
CRITICAL RULES:
- NEVER include emojis, icons, or unicode surrogate codes like ud83c, ud83cd, ufe0f, u200d, or \\u in the Myanmar translation.
- Keep each subtitle segment concise (1 to 2 lines, 2 to 6 seconds each) so it matches the speaker's exact timing.`,
              },
            ],
          },
          config: {
            temperature: 0.2,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  start: { type: Type.NUMBER },
                  end: { type: Type.NUMBER },
                  originalText: { type: Type.STRING },
                  translatedText: { type: Type.STRING },
                },
                required: ['start', 'end', 'originalText', 'translatedText'],
              },
            },
          },
        });

        return safeParseJsonArray<{
          start: number | string;
          end: number | string;
          originalText: string;
          translatedText: string;
        }>(response.text ?? '[]');
      });

      const cues = segments
        .filter((seg) => seg && (seg.originalText || seg.translatedText || '').trim().length > 0)
        .map((seg, idx) => {
          const parsedRelStart =
            typeof seg.start === 'number'
              ? seg.start
              : parseSrtTime(String(seg.start || '0'));
          const parsedRelEnd =
            typeof seg.end === 'number'
              ? seg.end
              : parseSrtTime(String(seg.end || String(parsedRelStart + 2)));

          const clampedRelStart = Math.max(
            0,
            Math.min(numDuration + 5, Number.isFinite(parsedRelStart) ? parsedRelStart : 0)
          );
          const clampedRelEnd = Math.max(
            clampedRelStart + 0.5,
            Math.min(
              numDuration + 10,
              Number.isFinite(parsedRelEnd) ? parsedRelEnd : clampedRelStart + 2.5
            )
          );

          const startSec = Number((clampedRelStart + numOffset).toFixed(3));
          const endSec = Number((clampedRelEnd + numOffset).toFixed(3));

          return {
            id: idx + 1,
            startSeconds: startSec,
            endSeconds: endSec,
            startTime: formatSrtTime(startSec),
            endTime: formatSrtTime(endSec),
            originalText: cleanCorruptedMyanmarText(seg.originalText || '').cleaned,
            translatedText: cleanCorruptedMyanmarText(
              seg.translatedText || seg.originalText || ''
            ).cleaned,
          };
        });

      res.json({ cues: normalizeAndRepairCues(cues), engine: 'gemini' });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'API ခေါ်ဆိုမှု မအောင်မြင်ပါ။';
      console.error('Transcription error:', message);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/translate-srt-batch', async (req, res) => {
    try {
      const { cues, style = 'natural' } = req.body;
      if (!Array.isArray(cues) || cues.length === 0) {
        res.status(400).json({ error: 'ဘာသာပြန်ရန် စာတန်းထိုး ဒေတာ မရှိပါ။' });
        return;
      }

      const normalizedInput = cues.map((cue, idx) => {
        const startSec =
          typeof cue.startSeconds === 'number'
            ? cue.startSeconds
            : parseSrtTime(cue.startTime || '00:00:00,000');
        const endSec =
          typeof cue.endSeconds === 'number'
            ? cue.endSeconds
            : parseSrtTime(cue.endTime || '00:00:02,000');
        return {
          id: Number(cue.id) || idx + 1,
          startSeconds: startSec,
          endSeconds: endSec,
          originalText: cleanCorruptedMyanmarText(
            cue.originalText || cue.translatedText || ''
          ).cleaned,
        };
      });

      const updatedCues = await translateCuesWithGemini(normalizedInput, style);
      res.json({ cues: normalizeAndRepairCues(updatedCues) });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'မြန်မာဘာသာပြန်ဆိုမှု မအောင်မြင်ပါ။';
      console.error('Translation error:', message);
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MyanmarSub Studio Server running on http://localhost:${PORT}`);
  });
}

startServer();
