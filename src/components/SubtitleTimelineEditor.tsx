import React, { useState } from 'react';
import {
  Search,
  Sparkles,
  Clock,
  Plus,
  Trash2,
  Copy,
  Download,
  Check,
  Wand2,
} from 'lucide-react';
import {
  SrtCue,
  formatSrtTime,
  parseSrtTime,
  parseSrt,
  serializeSrt,
  serializeVtt,
  cleanCorruptedMyanmarText,
  shiftSrtTimestamps,
} from '../utils/srtTools';

interface SubtitleTimelineEditorProps {
  cues: SrtCue[];
  onChangeCues: (cues: SrtCue[]) => void;
  currentTime: number;
  onSeekTo: (seconds: number) => void;
  onTranslateAllWithAI: () => void;
  isProcessing: boolean;
  onNotify: (msg: string) => void;
}

export const SubtitleTimelineEditor: React.FC<SubtitleTimelineEditorProps> = ({
  cues,
  onChangeCues,
  currentTime,
  onSeekTo,
  onTranslateAllWithAI,
  isProcessing,
  onNotify,
}) => {
  const [editorTab, setEditorTab] = useState<'timeline' | 'myanmar_srt' | 'original_srt' | 'bilingual_srt'>('timeline');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedState, setCopiedState] = useState(false);

  // Count how many cues currently contain corrupted unicode surrogates (like ud83c) or emojis
  const corruptedArtifactCount = cues.reduce((acc, cue) => {
    const r1 = cleanCorruptedMyanmarText(cue.translatedText).removedCount;
    const r2 = cleanCorruptedMyanmarText(cue.originalText).removedCount;
    return acc + r1 + r2;
  }, 0);

  const handleCleanAllArtifacts = () => {
    let totalRemoved = 0;
    const cleanedCues = cues.map((cue) => {
      const myClean = cleanCorruptedMyanmarText(cue.translatedText);
      const origClean = cleanCorruptedMyanmarText(cue.originalText);
      totalRemoved += myClean.removedCount + origClean.removedCount;
      return {
        ...cue,
        translatedText: myClean.cleaned,
        originalText: origClean.cleaned,
      };
    });
    onChangeCues(cleanedCues);
    onNotify(
      totalRemoved > 0
        ? `🧹 ud83c နှင့် Emoji ကုဒ်အပျက် (${totalRemoved}) ခုကို အောင်မြင်စွာ ဖယ်ရှားသန့်စင်ပြီးပါပြီ!`
        : '✓ စာသားအားလုံး သန့်စင်ပြီးသား ဖြစ်ပါသည် (ud83c ကုဒ်အပျက် မရှိပါ)။'
    );
  };

  const handleShiftTime = (offsetMs: number) => {
    const shifted = shiftSrtTimestamps(cues, offsetMs);
    onChangeCues(shifted);
    const sign = offsetMs > 0 ? `+${offsetMs}ms` : `${offsetMs}ms`;
    onNotify(`⏱️ စာတန်းထိုး အချိန်အားလုံးကို (${sign}) ရွှေ့ပြီးပါပြီ။`);
  };

  const handleUpdateCueText = (id: number, field: 'translatedText' | 'originalText', value: string) => {
    onChangeCues(
      cues.map((c) => (c.id === id ? { ...c, [field]: value } : c))
    );
  };

  const handleUpdateCueTime = (id: number, field: 'startTime' | 'endTime', value: string) => {
    onChangeCues(
      cues.map((c) => {
        if (c.id !== id) return c;
        const sec = parseSrtTime(value);
        return {
          ...c,
          [field]: value,
          ...(field === 'startTime' ? { startSeconds: sec } : { endSeconds: sec }),
        };
      })
    );
  };

  const handleAddCue = () => {
    const lastCue = cues[cues.length - 1];
    const startSec = lastCue ? Number((lastCue.endSeconds + 0.5).toFixed(2)) : 0;
    const endSec = Number((startSec + 3.5).toFixed(2));
    const newCue: SrtCue = {
      id: cues.length + 1,
      startSeconds: startSec,
      endSeconds: endSec,
      startTime: formatSrtTime(startSec),
      endTime: formatSrtTime(endSec),
      originalText: 'New subtitle line...',
      translatedText: 'စာတန်းထိုး အသစ် ရေးသားပါ...',
    };
    onChangeCues([...cues, newCue]);
    onNotify('➕ စာတန်းထိုး အပိုဒ်အသစ် (၁) ခု ထပ်ပေါင်းထည့်ပြီးပါပြီ။');
  };

  const handleDeleteCue = (id: number) => {
    const filtered = cues
      .filter((c) => c.id !== id)
      .map((c, idx) => ({ ...c, id: idx + 1 }));
    onChangeCues(filtered);
  };

  const getActiveRawText = () => {
    if (editorTab === 'original_srt') return serializeSrt(cues, 'original');
    if (editorTab === 'bilingual_srt') return serializeSrt(cues, 'bilingual');
    return serializeSrt(cues, 'myanmar');
  };

  const handleRawTextChange = (rawText: string) => {
    const parsed = parseSrt(rawText, cues);
    if (parsed.length > 0) {
      onChangeCues(parsed);
    }
  };

  const handleCopySrt = async () => {
    const text = serializeSrt(
      cues,
      editorTab === 'original_srt'
        ? 'original'
        : editorTab === 'bilingual_srt'
        ? 'bilingual'
        : 'myanmar'
    );
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const tempArea = document.createElement('textarea');
      tempArea.value = text;
      tempArea.style.position = 'fixed';
      tempArea.style.opacity = '0';
      document.body.appendChild(tempArea);
      tempArea.focus();
      tempArea.select();
      document.execCommand('copy');
      document.body.removeChild(tempArea);
    }
    setCopiedState(true);
    onNotify('📋 သန့်စင်ပြီးသား SRT စာသားအားလုံးကို Copy ကူးယူပြီးပါပြီ!');
    setTimeout(() => setCopiedState(false), 2000);
  };

  const handleDownloadFile = (format: 'srt' | 'vtt') => {
    const mode =
      editorTab === 'original_srt'
        ? 'original'
        : editorTab === 'bilingual_srt'
        ? 'bilingual'
        : 'myanmar';

    const content =
      format === 'vtt' ? serializeVtt(cues, mode) : serializeSrt(cues, mode);
    // Prepend UTF-8 BOM (\uFEFF) so CapCut, VN, and mobile video players never garble Myanmar Unicode
    const blob = new Blob(['\uFEFF' + content], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `myanmar_subtitles_${mode}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onNotify(`📥 myanmar_subtitles_${mode}.${format} ဖိုင်ကို ဒေါင်းလုဒ်ဆွဲနေပါပြီ!`);
  };

  const filteredCues = cues.filter((cue) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      cue.translatedText.toLowerCase().includes(q) ||
      cue.originalText.toLowerCase().includes(q) ||
      cue.startTime.includes(q) ||
      String(cue.id) === q
    );
  });

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col h-full space-y-4">
      {/* Top Editor Segmented View Switcher & Primary Export Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div
          role="tablist"
          aria-label="Subtitle view modes"
          className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 overflow-x-auto"
        >
          {(
            [
              { id: 'timeline', label: `Timeline (${cues.length})` },
              { id: 'myanmar_srt', label: 'မြန်မာ SRT' },
              { id: 'original_srt', label: 'မူရင်း SRT' },
              { id: 'bilingual_srt', label: 'နှစ်ဘာသာ SRT' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={editorTab === tab.id}
              onClick={() => setEditorTab(tab.id)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                editorTab === tab.id
                  ? 'bg-cyan-400 text-slate-950'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopySrt}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            {copiedState ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedState ? 'Copied!' : 'Copy SRT'}</span>
          </button>

          <button
            type="button"
            onClick={() => handleDownloadFile('srt')}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download .SRT</span>
          </button>
        </div>
      </div>

      {/* Toolbar: Search, Timestamp Sync Offset, & ud83c Sanitizer */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            aria-label="Search subtitles"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="စာသား သို့မဟုတ် အချိန် (00:00:04) ဖြင့် ရှာရန်..."
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>

        {/* Timestamp Offset Controls */}
        <div className="flex items-center gap-1 bg-slate-950 px-2 py-1 rounded-xl border border-slate-800">
          <Clock className="w-3.5 h-3.5 text-slate-400 mr-1 shrink-0" />
          <span className="text-[11px] text-slate-400 mr-1 whitespace-nowrap">အချိန်ညှိရန်:</span>
          {[-500, -100, 100, 500].map((ms) => (
            <button
              key={ms}
              type="button"
              onClick={() => handleShiftTime(ms)}
              className="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-[11px] font-mono tabular-nums text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {ms > 0 ? `+${ms}ms` : `${ms}ms`}
            </button>
          ))}
        </div>

        {/* One-Click ud83c & Emoji Sanitizer Button */}
        <button
          type="button"
          onClick={handleCleanAllArtifacts}
          className={`min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
            corruptedArtifactCount > 0
              ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'
              : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Wand2 className="w-3.5 h-3.5 shrink-0" />
          <span>
            {corruptedArtifactCount > 0
              ? `ud83c အမှိုက်ကုဒ် (${corruptedArtifactCount}) ခု သန့်စင်မည်`
              : 'ud83c အမှိုက်ကုဒ် သန့်စင်မည်'}
          </span>
        </button>
      </div>

      {/* Main Content Area: Either Interactive Cue Timeline or Raw SRT Textarea */}
      {editorTab === 'timeline' ? (
        <div className="space-y-2.5 max-h-[540px] overflow-y-auto pr-1">
          {cues.length === 0 ? (
            <div className="py-16 px-6 text-center border border-dashed border-slate-800 rounded-xl space-y-3">
              <p className="text-sm font-medium text-slate-300">
                စာတန်းထိုး မရှိသေးပါ
              </p>
              <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                ဘယ်ဘက်တွင် Video / Audio ဖိုင် ရွေးချယ်၍ဖြစ်စေ၊ .SRT စာသား တိုက်ရိုက်ထည့်၍ဖြစ်စေ မြန်မာစာတန်းထိုး စတင်ထုတ်ယူနိုင်ပါသည်။
              </p>
              <button
                type="button"
                onClick={handleAddCue}
                className="mt-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-cyan-300 transition-colors cursor-pointer"
              >
                + စာကြောင်းအသစ် ကိုယ်တိုင်စတင်ရေးသားမည်
              </button>
            </div>
          ) : filteredCues.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-slate-800 rounded-xl">
              <p className="text-sm text-slate-400">ရှာဖွေထားသော စာတန်းထိုး မတွေ့ရှိပါ။</p>
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="mt-3 px-4 py-2 rounded-xl bg-slate-800 text-xs font-medium text-cyan-300 hover:bg-slate-700 cursor-pointer"
              >
                စာရင်းအားလုံး ပြန်ပြမည်
              </button>
            </div>
          ) : (
            filteredCues.map((cue) => {
              const isActive =
                currentTime >= cue.startSeconds && currentTime <= cue.endSeconds;
              const hasDirtyCode =
                cleanCorruptedMyanmarText(cue.translatedText).removedCount > 0;

              return (
                <div
                  key={cue.id}
                  className={`p-3.5 rounded-xl border transition-colors ${
                    isActive
                      ? 'bg-slate-800/90 border-cyan-400/60'
                      : 'bg-slate-950/80 border-slate-800/90 hover:border-slate-700'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onSeekTo(cue.startSeconds)}
                        aria-label={`Jump to cue ${cue.id}`}
                        className="px-2 py-0.5 rounded bg-slate-800 hover:bg-cyan-400 hover:text-slate-950 text-xs font-mono tabular-nums font-semibold text-cyan-300 transition-colors cursor-pointer"
                      >
                        #{cue.id}
                      </button>

                      <input
                        type="text"
                        aria-label={`Start time for cue ${cue.id}`}
                        value={cue.startTime}
                        onChange={(e) =>
                          handleUpdateCueTime(cue.id, 'startTime', e.target.value)
                        }
                        className="w-28 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-200 focus:outline-none focus:border-cyan-400"
                      />
                      <span className="text-xs text-slate-500 font-mono">→</span>
                      <input
                        type="text"
                        aria-label={`End time for cue ${cue.id}`}
                        value={cue.endTime}
                        onChange={(e) =>
                          handleUpdateCueTime(cue.id, 'endTime', e.target.value)
                        }
                        className="w-28 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-slate-200 focus:outline-none focus:border-cyan-400"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      {hasDirtyCode && (
                        <span className="text-[11px] text-amber-300">
                          ud83c ကုဒ်ပါဝင်နေသည်
                        </span>
                      )}
                      <span className="text-[11px] font-mono tabular-nums text-slate-500">
                        {(cue.endSeconds - cue.startSeconds).toFixed(1)}s
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDeleteCue(cue.id)}
                        aria-label={`Delete cue ${cue.id}`}
                        className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-900 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Original & Translated Inputs */}
                  <div className="space-y-1.5">
                    <input
                      type="text"
                      aria-label={`Original text for cue ${cue.id}`}
                      value={cue.originalText}
                      onChange={(e) =>
                        handleUpdateCueText(cue.id, 'originalText', e.target.value)
                      }
                      placeholder="Original speech text..."
                      className="w-full bg-transparent text-xs text-slate-400 focus:text-slate-200 focus:outline-none px-1"
                    />
                    <textarea
                      rows={2}
                      aria-label={`Myanmar subtitle for cue ${cue.id}`}
                      value={cue.translatedText}
                      onChange={(e) =>
                        handleUpdateCueText(cue.id, 'translatedText', e.target.value)
                      }
                      placeholder="မြန်မာဘာသာပြန် စာသား..."
                      className="w-full bg-slate-900/90 border border-slate-800 rounded-lg px-3 py-2 text-sm font-myanmar text-slate-100 focus:outline-none focus:border-cyan-400 resize-none"
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            aria-label="Raw SRT subtitle output"
            value={getActiveRawText()}
            onChange={(e) => handleRawTextChange(e.target.value)}
            className="w-full h-[480px] bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs font-mono tabular-nums text-slate-200 leading-relaxed focus:outline-none focus:border-cyan-400"
          />
          <p className="text-xs text-slate-400">
            အချိန်မှတ်သားချက်များ (00:00:01,000 --&gt; 00:00:04,200) ၁၀၀% တိကျစွာ ထိန်းသိမ်းထားပါသည်။
          </p>
        </div>
      )}

      {/* Bottom Footer Actions */}
      <div className="pt-2 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleAddCue}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>စာကြောင်းအသစ် ထပ်ထည့်မည်</span>
          </button>

          <button
            type="button"
            onClick={() => handleDownloadFile('vtt')}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 transition-colors cursor-pointer"
          >
            Export .VTT
          </button>
        </div>

        <button
          type="button"
          disabled={isProcessing}
          onClick={onTranslateAllWithAI}
          className="min-h-[40px] px-4 py-2 rounded-xl bg-cyan-400/15 hover:bg-cyan-400/25 border border-cyan-400/40 text-cyan-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Gemini AI ဖြင့် အားလုံးပြန်လည် ဘာသာပြန်မည်</span>
        </button>
      </div>
    </div>
  );
};
