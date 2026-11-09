import React, { useState, useRef } from 'react';
import {
  Upload,
  FileAudio,
  FileText,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Download,
  Square,
} from 'lucide-react';
import {
  SrtCue,
  parseSrt,
  serializeSrt,
  cleanCorruptedMyanmarText,
  chunkCuesForBatchTranslation,
  formatSrtTime,
  normalizeAndRepairCues,
} from './utils/srtTools';
import { processAudioChunksStreaming } from './utils/audioChunker';
import { VideoPreviewPlayer } from './components/VideoPreviewPlayer';
import { SubtitleTimelineEditor } from './components/SubtitleTimelineEditor';

async function fetchJsonWithClientRetry<T>(
  url: string,
  options: RequestInit,
  maxRetries = 2
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (data as { error?: string })?.error || `Request failed (${res.status})`
        );
      }
      return data as T;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

export default function App() {
  const [cues, setCues] = useState<SrtCue[]>([]);
  const [inputMode, setInputMode] = useState<'media' | 'srt'>('media');
  const [translationStyle, setTranslationStyle] = useState<'natural' | 'movie' | 'formal'>('natural');

  // Media file state (clean, zero demos)
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'video' | 'audio' | 'none'>('none');
  const [mediaName, setMediaName] = useState<string>('');
  const [mediaDuration, setMediaDuration] = useState<number>(0);
  const [fileSizeBytes, setFileSizeBytes] = useState<number>(0);

  // Paste SRT text state when in 'srt' input mode
  const [pastedSrtText, setPastedSrtText] = useState<string>('');

  // Player state
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [subtitleDisplayMode, setSubtitleDisplayMode] = useState<
    'myanmar' | 'bilingual' | 'original' | 'off'
  >('myanmar');

  // Processing pipeline state
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [activeStep, setActiveStep] = useState<0 | 1 | 2 | 3>(0);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cancelRequestedRef = useRef<boolean>(false);

  const showNotice = (msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  };

  const handleStopProcessing = () => {
    cancelRequestedRef.current = true;
    showNotice('⏹ တွက်ချက်မှုကို ရပ်တန့်နေပါသည် (ပြီးသမျှ စာတန်းထိုးများ ကျန်ရှိပါမည်)...');
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMessage(null);
    const lowerName = file.name.toLowerCase();

    // Direct .srt or .vtt file upload
    if (lowerName.endsWith('.srt') || lowerName.endsWith('.vtt')) {
      const text = await file.text();
      const parsed = parseSrt(text);
      if (parsed.length > 0) {
        setCues(parsed);
        setMediaName(file.name);
        setSelectedFile(file);
        setFileSizeBytes(file.size);
        const lastEnd = parsed[parsed.length - 1]?.endSeconds || 0;
        setMediaDuration(lastEnd);
        setCurrentTime(parsed[0]?.startSeconds || 0);
        showNotice(`✓ ${file.name} မှ စာတန်းထိုး (${parsed.length}) ကြောင်း ဖတ်ရှုပြီးပါပြီ။`);
      } else {
        setErrorMessage('ရွေးချယ်ထားသော SRT ဖိုင်ထဲတွင် အချိန်မှတ်သားချက် (Timestamp) မတွေ့ရှိပါ။');
      }
      return;
    }

    // Video or Audio file of ANY size
    if (mediaUrl) {
      URL.revokeObjectURL(mediaUrl);
    }
    const objUrl = URL.createObjectURL(file);
    setSelectedFile(file);
    setMediaUrl(objUrl);
    setMediaName(file.name);
    setFileSizeBytes(file.size);
    setMediaType(file.type.startsWith('audio') ? 'audio' : 'video');

    const tempMedia = document.createElement(file.type.startsWith('audio') ? 'audio' : 'video');
    tempMedia.preload = 'metadata';
    tempMedia.src = objUrl;
    tempMedia.onloadedmetadata = () => {
      if (Number.isFinite(tempMedia.duration) && tempMedia.duration > 0) {
        setMediaDuration(Math.ceil(tempMedia.duration));
      }
    };

    const mb = (file.size / (1024 * 1024)).toFixed(2);
    showNotice(`📁 ${file.name} (${mb} MB) ရွေးချယ်ပြီးပါပြီ။`);
  };

  /**
   * Translates existing subtitle cues in 20-cue batches via server-side Gemini API
   */
  const handleBatchTranslateExistingCues = async (sourceCues: SrtCue[] = cues) => {
    if (sourceCues.length === 0) {
      setErrorMessage('ကျေးဇူးပြု၍ Video / Audio ဖိုင် သို့မဟုတ် .SRT ဖိုင် အရင်ရွေးချယ်ပေးပါ။');
      return;
    }

    cancelRequestedRef.current = false;
    setIsProcessing(true);
    setErrorMessage(null);
    setActiveStep(3);
    setProgressPercent(25);
    setStatusMessage('Gemini AI ဖြင့် အပိုင်းလိုက် (Batch) မြန်မာဘာသာပြန်ပြီး ud83c ကုဒ်သန့်စင်နေပါသည်...');

    try {
      const batches = chunkCuesForBatchTranslation(sourceCues, 20);
      const translatedAll: SrtCue[] = [];

      for (let i = 0; i < batches.length; i++) {
        if (cancelRequestedRef.current) break;

        setStatusMessage(
          `Gemini AI ဖြင့် မြန်မာဘာသာပြန်နေပါသည် — အပိုင်း (${i + 1}/${batches.length})...`
        );
        setProgressPercent(25 + Math.round(((i + 1) / batches.length) * 70));

        const data = await fetchJsonWithClientRetry<{ cues: SrtCue[] }>(
          '/api/translate-srt-batch',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cues: batches[i],
              style: translationStyle,
            }),
          }
        );

        translatedAll.push(...(data.cues || []));

        // Update UI incrementally after every batch so progress is never lost
        const partialNormalized = normalizeAndRepairCues([
          ...translatedAll,
          ...sourceCues.slice(translatedAll.length),
        ]);
        setCues(partialNormalized);
      }

      const finalCues = normalizeAndRepairCues(
        translatedAll.length > 0
          ? [...translatedAll, ...sourceCues.slice(translatedAll.length)]
          : sourceCues
      );
      setCues(finalCues);
      setProgressPercent(100);
      setStatusMessage(
        cancelRequestedRef.current
          ? `⏹ ရပ်တန့်လိုက်ပါပြီ — ပြီးစီးသမျှ စာတန်းထိုး (${translatedAll.length}) ကြောင်း သိမ်းဆည်းထားပါသည်။`
          : `✓ စာတန်းထိုး (${finalCues.length}) ကြောင်းလုံး အချိန်အတိအကျဖြင့် မြန်မာပြန်ဆိုပြီးပါပြီ!`
      );
      showNotice('🎉 မြန်မာစာတန်းထိုး ပြန်ဆိုခြင်းနှင့် သန့်စင်ခြင်း အောင်မြင်ပါပြီ!');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ဘာသာပြန်ဆိုရာတွင် အမှားဖြစ်ပွားပါသည်။';
      setErrorMessage(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Full Pipeline:
   * - Streams 2-minute (120s, ~3.66 MB) 16kHz Mono WAV chunks ONE AT A TIME
   * - Never accumulates all Base64 chunks in memory
   * - Updates subtitle timeline live after each chunk and survives single-chunk errors
   */
  const handleRunFullPipeline = async () => {
    setErrorMessage(null);
    cancelRequestedRef.current = false;

    if (inputMode === 'srt') {
      if (!pastedSrtText.trim() && cues.length === 0) {
        setErrorMessage('ဘာသာပြန်ရန် .SRT စာသားများကို အကွက်ထဲတွင် အရင်ထည့်သွင်းပေးပါ။');
        return;
      }
      if (pastedSrtText.trim()) {
        const parsed = parseSrt(pastedSrtText);
        if (parsed.length === 0) {
          setErrorMessage(
            'ထည့်သွင်းထားသော စာသားသည် မှန်ကန်သော SRT Format မဟုတ်ပါ (00:00:01,000 --> 00:00:04,000 ပါဝင်ရပါမည်)။'
          );
          return;
        }
        setCues(parsed);
        await handleBatchTranslateExistingCues(parsed);
        return;
      }
      await handleBatchTranslateExistingCues(cues);
      return;
    }

    if (!selectedFile) {
      setErrorMessage('ကျေးဇူးပြု၍ Video၊ Audio သို့မဟုတ် .SRT ဖိုင် အရင်ရွေးချယ်ပေးပါ။');
      return;
    }

    if (
      selectedFile.name.toLowerCase().endsWith('.srt') ||
      selectedFile.name.toLowerCase().endsWith('.vtt')
    ) {
      await handleBatchTranslateExistingCues(cues);
      return;
    }

    setIsProcessing(true);
    setActiveStep(1);
    setProgressPercent(8);
    setStatusMessage('၁/၃။ ဗီဒီယိုထဲမှ အသံကို 16kHz Mono အဖြစ် ချုံ့ပြီး အပိုင်းလိုက် ထုတ်ယူနေပါသည်...');

    const allStitchedCues: SrtCue[] = [];
    let failedChunks = 0;

    try {
      const totalChunks = await processAudioChunksStreaming(
        selectedFile,
        120,
        (msg, pct) => {
          setStatusMessage(msg);
          setProgressPercent(pct);
        },
        async (chunk) => {
          setActiveStep(2);
          setStatusMessage(
            `၂/၃။ အပိုင်း (${chunk.chunkIndex}/${chunk.totalChunks}) [${formatSrtTime(
              chunk.startSeconds
            )} → ${formatSrtTime(
              chunk.endSeconds
            )}] (${chunk.sizeMB} MB) ကို SRT ထုတ်ပြီး မြန်မာပြန်နေပါသည်...`
          );
          setProgressPercent(
            18 + Math.round(((chunk.chunkIndex - 0.3) / chunk.totalChunks) * 78)
          );

          try {
            const data = await fetchJsonWithClientRetry<{ cues: SrtCue[] }>(
              '/api/transcribe-chunk',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  base64Audio: chunk.base64Wav,
                  mimeType: chunk.mimeType || 'audio/wav',
                  offsetSeconds: chunk.startSeconds,
                  chunkDurationSeconds: chunk.durationSeconds,
                  style: translationStyle,
                }),
              }
            );

            const chunkCues: SrtCue[] = data.cues || [];
            allStitchedCues.push(...chunkCues);

            const liveIndexed = normalizeAndRepairCues(allStitchedCues);
            if (liveIndexed.length > 0) {
              setCues(liveIndexed);
            }
          } catch (chunkErr) {
            failedChunks += 1;
            console.error(`Chunk ${chunk.chunkIndex} error:`, chunkErr);
            if (chunk.totalChunks === 1) {
              throw chunkErr;
            }
          }
        },
        () => cancelRequestedRef.current
      );

      setActiveStep(3);
      const reindexed = normalizeAndRepairCues(allStitchedCues);

      if (reindexed.length === 0) {
        throw new Error(
          'ဗီဒီယို/အသံဖိုင်ထဲမှ စကားပြောသံ ရှာမတွေ့ပါ သို့မဟုတ် API ချိတ်ဆက်မှု အခက်အခဲရှိနေပါသည်။'
        );
      }

      setCues(reindexed);
      setProgressPercent(100);
      setStatusMessage(
        failedChunks > 0
          ? `✓ စာတန်းထိုး (${reindexed.length}) ကြောင်း ရရှိပါပြီ (အပိုင်း ${failedChunks} ပိုင်း ကျော်သွားပါသည်)။`
          : `✓ အပိုင်း (${totalChunks}) ပိုင်းလုံး ပေါင်းစပ်ပြီး စာတန်းထိုး (${reindexed.length}) ကြောင်း ရရှိပါပြီ!`
      );
      showNotice('🎉 ဗီဒီယိုမှ မြန်မာ SRT စာတန်းထိုး ထုတ်ယူခြင်း အောင်မြင်ပါပြီ!');
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'ဗီဒီယို အသံခွဲထုတ်ရာတွင် အမှားဖြစ်ပွားပါသည်။';
      setErrorMessage(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePrimaryExportSrt = () => {
    if (cues.length === 0) {
      showNotice('⚠️ ဒေါင်းလုဒ်ဆွဲရန် စာတန်းထိုး မရှိသေးပါ။');
      return;
    }
    const content = serializeSrt(cues, 'myanmar');
    const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'myanmar_subtitles.srt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showNotice('📥 myanmar_subtitles.srt ဖိုင်ကို ဒေါင်းလုဒ်ဆွဲနေပါပြီ!');
  };

  const fileSizeMB = selectedFile ? (fileSizeBytes / (1024 * 1024)).toFixed(2) : null;
  const estimatedCompressedMB =
    mediaDuration > 0 ? ((mediaDuration * 32000) / (1024 * 1024)).toFixed(2) : null;
  const estimatedChunks = mediaDuration > 0 ? Math.max(1, Math.ceil(mediaDuration / 120)) : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/90 px-4 sm:px-8 py-3.5 flex items-center justify-between gap-8">
        <a
          href="#workspace"
          className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 font-display"
        >
          MyanmarSub Studio
        </a>

        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400"
        >
          <a
            href="#workspace"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Workspace
          </a>
          <a
            href="#timeline-section"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Timeline Editor
          </a>
          <a
            href="#guide"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Quick Guide
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={handlePrimaryExportSrt}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export .SRT</span>
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-8 py-6 space-y-10">
        {/* Hero Header & Metadata Bar */}
        <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-800/80 pb-6">
          <div className="max-w-2xl">
            <p className="text-xs text-cyan-400 font-medium mb-1.5">
              Groq Whisper + Gemini AI · Auto 16kHz Audio Compression · Pure Unicode Sanitizer
            </p>
            <h1
              className="text-2xl sm:text-3xl font-bold text-slate-100 font-myanmar leading-[1.55]"
              style={{ textWrap: 'balance' }}
            >
              အချိန်အတိအကျ မြန်မာစာတန်းထိုး (.SRT) ထုတ်လုပ်သည့် စတူဒီယို
            </h1>
          </div>

          {/* Unboxed Clean Metadata */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <span>ဖိုင်ဆိုဒ် အကန့်အသတ်မရှိ (Unlimited Size)</span>
            <span aria-hidden="true">·</span>
            <span>{cues.length} Cues</span>
            <span aria-hidden="true">·</span>
            <span>ud83c Auto-Filter Active</span>
          </div>
        </section>

        {/* Primary 12-Column Studio Workspace */}
        <section
          id="workspace"
          className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
        >
          {/* Left Column (5 Cols): Media Source, Unlimited Upload, Pipeline & Video Preview */}
          <div className="lg:col-span-5 space-y-5 min-w-0">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4 overflow-hidden">
              {/* Segmented Input Mode Toggle */}
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-950 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setInputMode('media')}
                  className={`min-h-[42px] px-2.5 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer min-w-0 ${
                    inputMode === 'media'
                      ? 'bg-cyan-400 text-slate-950'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <FileAudio className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">Video / Audio ဖိုင်</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('srt')}
                  className={`min-h-[42px] px-2.5 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer min-w-0 ${
                    inputMode === 'srt'
                      ? 'bg-cyan-400 text-slate-950'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">.SRT စာသားပြန်မည်</span>
                </button>
              </div>

              {inputMode === 'media' ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label="Upload video, audio, or SRT file of any size"
                  className="border-2 border-dashed border-slate-700 hover:border-cyan-400 rounded-xl p-6 text-center cursor-pointer bg-slate-950/60 transition-colors"
                >
                  <Upload className="w-7 h-7 text-cyan-400 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-slate-100 break-all">
                    {selectedFile
                      ? selectedFile.name
                      : 'ဖုန်း သို့မဟုတ် ကွန်ပျူတာထဲမှ Video / Audio / .SRT ဖိုင်ရွေးပါ'}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    MP4, MOV, MKV, MP3, WAV, M4A, SRT · ဖိုင်ဆိုဒ် အကန့်အသတ်မရှိ (16kHz Auto-Compression)
                  </p>
                  {fileSizeMB && (
                    <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[11px] font-mono tabular-nums text-emerald-400">
                      <span>မူရင်းဆိုဒ်: {fileSizeMB} MB</span>
                      {estimatedCompressedMB && (
                        <>
                          <span aria-hidden="true">→</span>
                          <span>16kHz WAV: ~{estimatedCompressedMB} MB</span>
                        </>
                      )}
                      {estimatedChunks && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{estimatedChunks} Chunk(s)</span>
                        </>
                      )}
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*,audio/*,.srt,.vtt"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <label
                    htmlFor="paste-srt-box"
                    className="block text-xs font-medium text-slate-300"
                  >
                    မူရင်း .SRT စာသားများကို ဒီနေရာတွင် Paste ချပါ:
                  </label>
                  <textarea
                    id="paste-srt-box"
                    rows={6}
                    value={pastedSrtText}
                    onChange={(e) => setPastedSrtText(e.target.value)}
                    placeholder={`1\n00:00:01,000 --> 00:00:04,000\nSubtitle line one...\n\n2\n00:00:04,500 --> 00:00:08,000\nSubtitle line two...`}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-400"
                  />
                </div>
              )}

              {/* Translation Tone / Style Selector */}
              <div>
                <label
                  htmlFor="translation-style-select"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  မြန်မာဘာသာပြန် စကားပြောဟန် (Translation Style):
                </label>
                <select
                  id="translation-style-select"
                  value={translationStyle}
                  onChange={(e) =>
                    setTranslationStyle(e.target.value as 'natural' | 'movie' | 'formal')
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-400"
                >
                  <option value="natural">
                    သဘာဝ နေ့စဉ်သုံး မြန်မာစကားပြောဟန် (Natural Spoken Burmese)
                  </option>
                  <option value="movie">
                    ရုပ်ရှင် / ဇာတ်လမ်းတွဲ စာတန်းထိုးဟန် (Cinema & Drama Dialogue)
                  </option>
                  <option value="formal">
                    မှတ်တမ်းရုပ်ရှင် / ပညာပေးဟန် (Formal Documentary & Educational)
                  </option>
                </select>
              </div>

              {/* Primary Action CTA Button + Stop Button */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={handleRunFullPipeline}
                  className="flex-1 min-h-[48px] py-3.5 px-5 rounded-xl bg-cyan-400 hover:bg-cyan-300 active:scale-[0.99] text-slate-950 font-bold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>AI ဖြင့် တွက်ချက်ပြန်ဆိုနေပါသည်...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>SRT ထုတ်ပြီး မြန်မာဘာသာပြန်မည်</span>
                    </>
                  )}
                </button>

                {isProcessing && (
                  <button
                    type="button"
                    onClick={handleStopProcessing}
                    className="min-h-[48px] px-4 py-3.5 rounded-xl bg-rose-950 hover:bg-rose-900 border border-rose-700/60 text-rose-200 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>ရပ်မည်</span>
                  </button>
                )}
              </div>

              {/* 3-Step Visual Progress Tracker */}
              {(isProcessing || statusMessage) && (
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
                  <div className="flex items-center justify-between text-xs gap-2">
                    <span className="text-cyan-300 font-medium">{statusMessage}</span>
                    <span className="font-mono tabular-nums text-slate-400 shrink-0">
                      {progressPercent}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
                    <div
                      style={{ width: `${progressPercent}%` }}
                      className="h-full bg-cyan-400 transition-all duration-300"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] text-slate-400">
                    <span className={activeStep >= 1 ? 'text-emerald-400 font-medium' : ''}>
                      1. 16kHz အသံချုံ့ခြင်း
                    </span>
                    <span className={activeStep >= 2 ? 'text-emerald-400 font-medium' : ''}>
                      2. Timestamp ထုတ်ခြင်း
                    </span>
                    <span className={activeStep >= 3 ? 'text-emerald-400 font-medium' : ''}>
                      3. မြန်မာပြန်နှင့် သန့်စင်ခြင်း
                    </span>
                  </div>
                </div>
              )}

              {/* Error Banner */}
              {errorMessage && (
                <div
                  role="alert"
                  className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-700/60 text-rose-200 text-xs flex items-start gap-2.5"
                >
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-semibold">သတိပြုရန် အချက်</p>
                    <p className="leading-relaxed">{errorMessage}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Synchronized Video & Subtitle Preview Player */}
            <VideoPreviewPlayer
              mediaUrl={mediaUrl}
              mediaType={mediaType}
              mediaName={mediaName}
              cues={cues}
              durationSeconds={mediaDuration}
              currentTime={currentTime}
              onTimeUpdate={setCurrentTime}
              subtitleDisplayMode={subtitleDisplayMode}
              onSubtitleDisplayModeChange={setSubtitleDisplayMode}
            />
          </div>

          {/* Right Column (7 Cols): Interactive Subtitle Timeline & Raw SRT Editor */}
          <div id="timeline-section" className="lg:col-span-7">
            <SubtitleTimelineEditor
              cues={cues}
              onChangeCues={setCues}
              currentTime={currentTime}
              onSeekTo={setCurrentTime}
              onTranslateAllWithAI={() => handleBatchTranslateExistingCues(cues)}
              isProcessing={isProcessing}
              onNotify={showNotice}
            />
          </div>
        </section>

        {/* Section 2: Studio Capabilities */}
        <section
          id="guide"
          aria-labelledby="guide-heading"
          className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5"
        >
          <div>
            <h2 id="guide-heading" className="text-xl font-bold text-slate-100">
              01. အသုံးပြုနည်းနှင့် အဆင့်မြင့် စနစ်များ (Studio Capabilities)
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              ဖုန်းနှင့် ကွန်ပျူတာ နှစ်မျိုးလုံးတွင် အဆင်ပြေစွာ အသုံးပြုနိုင်ရန် တည်ဆောက်ထားသော အဓိက စနစ် (၃) ခု
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-100">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>၁။ ဖိုင်ဆိုဒ် အကန့်အသတ်မရှိ (Unlimited Size)</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                ဗီဒီယိုဖိုင် 100MB, 500MB, 1GB ကျော်နေပါစေ ဖုန်း Memory မပြည့်စေဘဲ ဗီဒီယိုထဲမှ အသံကို 16kHz Mono WAV အဖြစ် အလိုအလျောက် ချုံ့ပြီး ၂ မိနစ်စီ (~3.66 MB) တစ်ပိုင်းချင်း Stream ပို့ပေးသဖြင့် 25MB Limit နှင့် Memory Crash ကို လုံးဝကျော်လွှားနိုင်ပါသည်။
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-100">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>၂။ ud83c / ud83cd အမှိုက်ကုဒ် အလိုအလျောက် ဖယ်ရှားမှု</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                CapCut, VN နှင့် Premiere Pro တို့တွင် စာတန်းထိုးထည့်သည့်အခါ ပေါ်တတ်သော <code className="text-amber-300 font-mono">ud83cd</code>, <code className="text-amber-300 font-mono">ud83cudf38</code>, <code className="text-amber-300 font-mono">ufe0f</code> ကဲ့သို့ Emoji Surrogate ကုဒ်အပျက်များကို AI Prompt ရော Auto-Cleaner ဖြင့်ပါ နှစ်ထပ်ကွမ်း ဖယ်ရှားပေးထားပါသည်။
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-100">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>၃။ အချိန် ၁၀၀% တိကျမှုနှင့် အချိန်ညှိစနစ်</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                စာကြောင်းတစ်ကြောင်းချင်းစီကို ID စနစ်ဖြင့် အချိန်သော့ခတ် (Timestamp Lock) ထားသဖြင့် ဘာသာပြန်ရာတွင် အချိန်လုံးဝမလွဲနိုင်သလို <code className="text-cyan-300 font-mono">+100ms / -100ms</code> ခလုတ်ဖြင့်လည်း တစ်ပြိုင်နက် အချိန်ညှိနိုင်ပါသည်။
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Clean Minimal Footer */}
      <footer className="border-t border-slate-900 py-6 px-4 sm:px-8 text-center text-xs text-slate-500">
        MyanmarSub Studio · Precision Burmese Subtitle Generation & Timeline Editor
      </footer>

      {/* Non-intrusive Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-slate-900 border border-cyan-400/50 text-slate-100 px-4 py-2.5 rounded-xl text-xs font-medium shadow-xl"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
