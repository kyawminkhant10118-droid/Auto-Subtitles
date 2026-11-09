import React, { useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Volume2, VolumeX, Subtitles, Film } from 'lucide-react';
import { SrtCue, formatSrtTime } from '../utils/srtTools';

interface VideoPreviewPlayerProps {
  mediaUrl: string | null;
  mediaType: 'video' | 'audio' | 'none';
  mediaName: string;
  cues: SrtCue[];
  durationSeconds: number;
  currentTime: number;
  onTimeUpdate: (seconds: number) => void;
  subtitleDisplayMode: 'myanmar' | 'bilingual' | 'original' | 'off';
  onSubtitleDisplayModeChange: (mode: 'myanmar' | 'bilingual' | 'original' | 'off') => void;
}

export const VideoPreviewPlayer: React.FC<VideoPreviewPlayerProps> = ({
  mediaUrl,
  mediaType,
  mediaName,
  cues,
  durationSeconds,
  currentTime,
  onTimeUpdate,
  subtitleDisplayMode,
  onSubtitleDisplayModeChange,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const activeCue = cues.find(
    (c) => currentTime >= c.startSeconds && currentTime <= c.endSeconds
  );

  const handleSeek = (newSeconds: number) => {
    onTimeUpdate(newSeconds);
    if (videoRef.current) {
      videoRef.current.currentTime = newSeconds;
    }
  };

  const togglePlay = () => {
    if (mediaUrl && videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      } else {
        videoRef.current.pause();
        setIsPlaying(false);
      }
    }
  };

  const handleReset = () => {
    setIsPlaying(false);
    handleSeek(0);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

  const toggleMute = () => {
    setIsMuted((prev) => !prev);
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
    }
  };

  const safeDuration = Math.max(0, durationSeconds);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      <div className="relative aspect-video bg-slate-950 flex items-center justify-center overflow-hidden">
        {mediaUrl ? (
          <video
            ref={videoRef}
            src={mediaUrl}
            className="w-full h-full object-contain"
            onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
            onEnded={() => setIsPlaying(false)}
            playsInline
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-center p-6">
            <Film className="w-8 h-8 text-slate-600 mb-2" />
            <p className="text-xs font-medium text-slate-400">
              {mediaName || 'Video သို့မဟုတ် Audio ဖိုင် ရွေးချယ်ထားခြင်း မရှိသေးပါ'}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              ဖိုင်ရွေးချယ်ပြီးပါက ဒီနေရာတွင် စာတန်းထိုးနှင့်တကွ တိုက်ရိုက် ဖွင့်ကြည့်နိုင်ပါမည်
            </p>
          </div>
        )}

        {/* Synchronized Subtitle Scrim Overlay */}
        {subtitleDisplayMode !== 'off' && activeCue && (
          <div
            data-testid="live-subtitle-overlay"
            className="absolute inset-x-0 bottom-0 pt-10 pb-4 px-4 bg-gradient-to-t from-black/90 via-black/55 to-transparent flex flex-col items-center justify-end text-center pointer-events-none"
          >
            {(subtitleDisplayMode === 'myanmar' || subtitleDisplayMode === 'bilingual') && (
              <p className="font-myanmar text-base sm:text-lg font-bold text-white drop-shadow-md max-w-xl leading-relaxed px-3 py-1 rounded bg-black/60">
                {activeCue.translatedText}
              </p>
            )}
            {(subtitleDisplayMode === 'original' || subtitleDisplayMode === 'bilingual') && (
              <p className="text-xs sm:text-sm text-slate-200 mt-1 max-w-xl px-2.5 py-0.5 rounded bg-black/50">
                {activeCue.originalText}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Player Controls */}
      <div className="p-4 border-t border-slate-800 space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono tabular-nums text-slate-400 w-20">
            {formatSrtTime(currentTime)}
          </span>
          <input
            type="range"
            aria-label="Seek subtitle timeline"
            disabled={!mediaUrl && cues.length === 0}
            min={0}
            max={Math.max(1, safeDuration)}
            step={0.1}
            value={Math.min(currentTime, Math.max(1, safeDuration))}
            onChange={(e) => handleSeek(parseFloat(e.target.value))}
            className="flex-1 accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer disabled:opacity-40"
          />
          <span className="text-xs font-mono tabular-nums text-slate-400 w-20 text-right">
            {formatSrtTime(safeDuration)}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!mediaUrl}
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
              className="min-h-[40px] px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-semibold text-xs flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              <span>{isPlaying ? 'ခေတ္တရပ်မည်' : 'ဖွင့်ကြည့်မည်'}</span>
            </button>

            <button
              type="button"
              disabled={!mediaUrl && currentTime === 0}
              onClick={handleReset}
              aria-label="Reset playback to start"
              className="min-h-[40px] min-w-[40px] p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {mediaType !== 'none' && (
              <button
                type="button"
                onClick={toggleMute}
                aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
                className="min-h-[40px] min-w-[40px] p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center transition-colors cursor-pointer"
              >
                {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
            <Subtitles className="w-3.5 h-3.5 text-slate-400 ml-2 mr-1 shrink-0" />
            {(
              [
                { id: 'myanmar', label: 'မြန်မာ' },
                { id: 'bilingual', label: 'နှစ်ဘာသာ' },
                { id: 'original', label: 'မူရင်း' },
                { id: 'off', label: 'ပိတ်' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSubtitleDisplayModeChange(item.id)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  subtitleDisplayMode === item.id
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
