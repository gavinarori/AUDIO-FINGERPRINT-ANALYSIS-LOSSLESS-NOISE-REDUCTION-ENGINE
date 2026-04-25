import React, { useState, useRef, useEffect, useCallback } from 'react';

interface AudioPlayerProps {
  originalAudio: Float32Array;
  processedAudio: Float32Array;
  sampleRate: number;
}

type ActiveTrack = 'original' | 'processed' | null;

function buildWaveformPath(audio: Float32Array, width: number, height: number, numPoints = 400): string {
  if (!audio.length) return `M 0 ${height / 2}`;
  const step = Math.floor(audio.length / numPoints);
  const half = height / 2;
  const points: string[] = [];
  for (let i = 0; i < numPoints; i++) {
    const start = i * step;
    let max = 0;
    for (let j = start; j < start + step && j < audio.length; j++) {
      max = Math.max(max, Math.abs(audio[j]));
    }
    const y = half - max * (half * 0.85);
    points.push(`${(i / numPoints) * width},${y}`);
  }
  // Mirror for bottom half
  for (let i = numPoints - 1; i >= 0; i--) {
    const start = i * step;
    let max = 0;
    for (let j = start; j < start + step && j < audio.length; j++) {
      max = Math.max(max, Math.abs(audio[j]));
    }
    const y = half + max * (half * 0.85);
    points.push(`${(i / numPoints) * width},${y}`);
  }
  return `M ${points[0]} L ${points.slice(1).join(' L ')} Z`;
}

export function AudioPlayer({ originalAudio, processedAudio, sampleRate }: AudioPlayerProps) {
  const [activeTrack, setActiveTrack] = useState<ActiveTrack>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [playbackBars, setPlaybackBars] = useState<number[]>(Array(32).fill(0));

  const duration = Math.max(originalAudio.length / sampleRate, processedAudio.length / sampleRate);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const startTimeRef = useRef(0);
  const pausedTimeRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);

  const NUM_BARS = 32;

  const getCtx = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return audioContextRef.current;
  };

  const stopSource = () => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch (e) {}
      sourceRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    isPlayingRef.current = false;
    setPlaybackBars(Array(NUM_BARS).fill(0));
  };

  const animateBars = useCallback(() => {
    if (!analyserRef.current || !isPlayingRef.current) return;
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    const step = Math.floor(data.length / NUM_BARS);
    const bars = Array.from({ length: NUM_BARS }, (_, i) => {
      const slice = data.slice(i * step, (i + 1) * step);
      return (slice.reduce((s, v) => s + v, 0) / slice.length) / 255;
    });
    setPlaybackBars(bars);

    // Update current time
    const ctx = audioContextRef.current!;
    const elapsed = ctx.currentTime - startTimeRef.current;
    setCurrentTime(Math.min(elapsed, duration));

    animFrameRef.current = requestAnimationFrame(animateBars);
  }, [duration]);

  const playAudio = (audioData: Float32Array, track: ActiveTrack) => {
    stopSource();
    const ctx = getCtx();

    const audioBuffer = ctx.createBuffer(1, audioData.length, sampleRate);
    audioBuffer.getChannelData(0).set(audioData);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyserRef.current = analyser;

    if (!gainNodeRef.current) {
      gainNodeRef.current = ctx.createGain();
      gainNodeRef.current.connect(ctx.destination);
    }
    gainNodeRef.current.gain.value = volume;

    source.connect(analyser);
    analyser.connect(gainNodeRef.current);

    source.start(0, pausedTimeRef.current);
    sourceRef.current = source;
    startTimeRef.current = ctx.currentTime - pausedTimeRef.current;
    isPlayingRef.current = true;
    setActiveTrack(track);

    source.onended = () => {
      if (isPlayingRef.current) {
        stopSource();
        setActiveTrack(null);
        pausedTimeRef.current = 0;
        setCurrentTime(0);
      }
    };

    animFrameRef.current = requestAnimationFrame(animateBars);
  };

  const togglePlay = (audioData: Float32Array, track: ActiveTrack) => {
    if (activeTrack === track && isPlayingRef.current) {
      // Pause
      pausedTimeRef.current = currentTime;
      stopSource();
      setActiveTrack(null);
    } else if (activeTrack !== null && activeTrack !== track) {
      // Switch track
      pausedTimeRef.current = 0;
      setCurrentTime(0);
      playAudio(audioData, track);
    } else {
      playAudio(audioData, track);
    }
  };

  const stopAll = () => {
    stopSource();
    pausedTimeRef.current = 0;
    setCurrentTime(0);
    setActiveTrack(null);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>, audioData: Float32Array, track: ActiveTrack) => {
    const newTime = parseFloat(e.target.value);
    pausedTimeRef.current = newTime;
    setCurrentTime(newTime);
    if (activeTrack === track) {
      stopSource();
      setActiveTrack(null);
      setTimeout(() => playAudio(audioData, track), 30);
    }
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (gainNodeRef.current) gainNodeRef.current.gain.value = v;
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

  const origPath = buildWaveformPath(originalAudio, 600, 80);
  const procPath = buildWaveformPath(processedAudio, 600, 80);
  const progress = duration > 0 ? currentTime / duration : 0;

  const isOriginalPlaying = activeTrack === 'original';
  const isProcessedPlaying = activeTrack === 'processed';

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

        .ap2-root {
          font-family: 'Syne', sans-serif;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        /* Playback bars visualizer */
        .ap2-bars {
          display: flex;
          align-items: flex-end;
          justify-content: center;
          gap: 3px;
          height: 48px;
          padding: 4px 0;
        }

        .ap2-bar {
          flex: 1;
          border-radius: 3px 3px 0 0;
          transition: height 0.06s ease;
          min-height: 3px;
        }

        .ap2-bar.orig {
          background: linear-gradient(180deg, #ef4444, #f97316);
        }

        .ap2-bar.proc {
          background: linear-gradient(180deg, #00c8a0, #0078ff);
        }

        .ap2-bar.idle {
          background: rgba(255,255,255,0.06);
          height: 3px !important;
        }

        /* Track card */
        .ap2-track {
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 20px;
          transition: border-color 0.3s ease;
        }

        .ap2-track.playing-orig {
          border-color: rgba(239,68,68,0.35);
          box-shadow: 0 0 24px rgba(239,68,68,0.06);
        }

        .ap2-track.playing-proc {
          border-color: rgba(0,200,160,0.35);
          box-shadow: 0 0 24px rgba(0,200,160,0.06);
        }

        .ap2-track-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 14px;
        }

        .ap2-track-label {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          font-family: 'JetBrains Mono', monospace;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .ap2-track-label.orig { color: #ef4444; }
        .ap2-track-label.proc { color: #00c8a0; }

        .ap2-track-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: currentColor;
        }

        .ap2-track-dot.playing {
          animation: ap2-pulse 0.6s ease-in-out infinite;
          box-shadow: 0 0 8px currentColor;
        }

        @keyframes ap2-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.5); }
        }

        /* Waveform SVG */
        .ap2-waveform-wrap {
          position: relative;
          border-radius: 10px;
          overflow: hidden;
          margin-bottom: 14px;
          background: rgba(0,0,0,0.2);
          cursor: pointer;
        }

        .ap2-waveform-svg {
          width: 100%;
          display: block;
        }

        /* Controls row */
        .ap2-controls {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .ap2-btn-play {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: all 0.2s ease;
          font-size: 14px;
        }

        .ap2-btn-play.orig {
          background: linear-gradient(135deg, #ef4444, #f97316);
          color: white;
          box-shadow: 0 3px 14px rgba(239,68,68,0.35);
        }

        .ap2-btn-play.proc {
          background: linear-gradient(135deg, #00c8a0, #0078ff);
          color: white;
          box-shadow: 0 3px 14px rgba(0,200,160,0.3);
        }

        .ap2-btn-play:hover { transform: scale(1.1); }
        .ap2-btn-play:active { transform: scale(0.95); }

        .ap2-seek-wrap {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .ap2-seek {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 4px;
          border-radius: 4px;
          outline: none;
          cursor: pointer;
        }

        .ap2-seek.orig {
          background: linear-gradient(
            to right,
            #ef4444 0%,
            #ef4444 ${progress * 100}%,
            rgba(255,255,255,0.1) ${progress * 100}%,
            rgba(255,255,255,0.1) 100%
          );
        }

        .ap2-seek.proc {
          background: linear-gradient(
            to right,
            #00c8a0 0%,
            #00c8a0 ${progress * 100}%,
            rgba(255,255,255,0.1) ${progress * 100}%,
            rgba(255,255,255,0.1) 100%
          );
        }

        .ap2-seek::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: white;
          cursor: pointer;
          box-shadow: 0 1px 6px rgba(0,0,0,0.4);
        }

        .ap2-time {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #4a5a68;
          white-space: nowrap;
        }

        .ap2-time.active { color: #e8edf2; }

        /* Volume */
        .ap2-volume-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 0 4px;
          border-top: 1px solid rgba(255,255,255,0.05);
          margin-top: 4px;
        }

        .ap2-vol-label {
          font-size: 11px;
          font-family: 'JetBrains Mono', monospace;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #3d4f5c;
          white-space: nowrap;
        }

        .ap2-vol-slider {
          -webkit-appearance: none;
          flex: 1;
          height: 3px;
          border-radius: 3px;
          outline: none;
          cursor: pointer;
          background: linear-gradient(
            to right,
            #00c8a0 0%,
            #00c8a0 ${volume * 100}%,
            rgba(255,255,255,0.08) ${volume * 100}%,
            rgba(255,255,255,0.08) 100%
          );
        }

        .ap2-vol-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: white;
          cursor: pointer;
          box-shadow: 0 1px 6px rgba(0,0,0,0.4);
        }

        .ap2-vol-pct {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #4a5a68;
          min-width: 36px;
          text-align: right;
        }

        .ap2-stop-btn {
          padding: 7px 14px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.08);
          background: transparent;
          color: #4a5a68;
          font-family: 'Syne', sans-serif;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .ap2-stop-btn:hover { background: rgba(255,255,255,0.05); color: #e8edf2; }
      `}</style>

      <div className="ap2-root">
        {/* Original Track */}
        <div className={`ap2-track ${isOriginalPlaying ? 'playing-orig' : ''}`}>
          <div className="ap2-track-header">
            <div className="ap2-track-label orig">
              <span className={`ap2-track-dot ${isOriginalPlaying ? 'playing' : ''}`} />
              Original
            </div>
            {/* Live bars when this track is playing */}
            {isOriginalPlaying && (
              <div className="ap2-bars" style={{ width: 120, height: 28 }}>
                {playbackBars.map((v, i) => (
                  <div
                    key={i}
                    className="ap2-bar orig"
                    style={{ height: `${Math.max(3, v * 24)}px` }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Waveform */}
          <div className="ap2-waveform-wrap">
            <svg className="ap2-waveform-svg" viewBox="0 0 600 80" preserveAspectRatio="none" height={64}>
              <defs>
                <linearGradient id="orig-grad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity="0.7" />
                  <stop offset="100%" stopColor="#f97316" stopOpacity="0.7" />
                </linearGradient>
                <linearGradient id="orig-played" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#ef4444" />
                  <stop offset="100%" stopColor="#f97316" />
                </linearGradient>
                <clipPath id="played-clip-orig">
                  <rect x="0" y="0" width={progress * 600} height="80" />
                </clipPath>
                <clipPath id="unplayed-clip-orig">
                  <rect x={progress * 600} y="0" width={600 - progress * 600} height="80" />
                </clipPath>
              </defs>
              <path d={origPath} fill="url(#orig-grad)" clipPath="url(#unplayed-clip-orig)" />
              <path d={origPath} fill="url(#orig-played)" clipPath="url(#played-clip-orig)" />
              {/* Playhead */}
              {activeTrack === 'original' && (
                <line x1={progress * 600} y1="0" x2={progress * 600} y2="80"
                  stroke="white" strokeWidth="1.5" opacity="0.8" />
              )}
            </svg>
          </div>

          <div className="ap2-controls">
            <button
              className="ap2-btn-play orig"
              onClick={() => togglePlay(originalAudio, 'original')}
            >
              {isOriginalPlaying ? '⏸' : '▶'}
            </button>
            <div className="ap2-seek-wrap">
              <input
                type="range"
                className="ap2-seek orig"
                min="0"
                max={duration}
                step="0.05"
                value={activeTrack === 'original' ? currentTime : pausedTimeRef.current}
                onChange={(e) => handleSeek(e, originalAudio, 'original')}
              />
            </div>
            <span className={`ap2-time ${isOriginalPlaying ? 'active' : ''}`}>
              {fmt(isOriginalPlaying ? currentTime : 0)} / {fmt(duration)}
            </span>
          </div>
        </div>

        {/* Processed Track */}
        <div className={`ap2-track ${isProcessedPlaying ? 'playing-proc' : ''}`}>
          <div className="ap2-track-header">
            <div className="ap2-track-label proc">
              <span className={`ap2-track-dot ${isProcessedPlaying ? 'playing' : ''}`} />
              Processed
            </div>
            {isProcessedPlaying && (
              <div className="ap2-bars" style={{ width: 120, height: 28 }}>
                {playbackBars.map((v, i) => (
                  <div
                    key={i}
                    className="ap2-bar proc"
                    style={{ height: `${Math.max(3, v * 24)}px` }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Waveform */}
          <div className="ap2-waveform-wrap">
            <svg className="ap2-waveform-svg" viewBox="0 0 600 80" preserveAspectRatio="none" height={64}>
              <defs>
                <linearGradient id="proc-grad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#00c8a0" stopOpacity="0.7" />
                  <stop offset="100%" stopColor="#0078ff" stopOpacity="0.7" />
                </linearGradient>
                <linearGradient id="proc-played" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#00c8a0" />
                  <stop offset="100%" stopColor="#0078ff" />
                </linearGradient>
                <clipPath id="played-clip-proc">
                  <rect x="0" y="0" width={progress * 600} height="80" />
                </clipPath>
                <clipPath id="unplayed-clip-proc">
                  <rect x={progress * 600} y="0" width={600 - progress * 600} height="80" />
                </clipPath>
              </defs>
              <path d={procPath} fill="url(#proc-grad)" clipPath="url(#unplayed-clip-proc)" />
              <path d={procPath} fill="url(#proc-played)" clipPath="url(#played-clip-proc)" />
              {activeTrack === 'processed' && (
                <line x1={progress * 600} y1="0" x2={progress * 600} y2="80"
                  stroke="white" strokeWidth="1.5" opacity="0.8" />
              )}
            </svg>
          </div>

          <div className="ap2-controls">
            <button
              className="ap2-btn-play proc"
              onClick={() => togglePlay(processedAudio, 'processed')}
            >
              {isProcessedPlaying ? '⏸' : '▶'}
            </button>
            <div className="ap2-seek-wrap">
              <input
                type="range"
                className="ap2-seek proc"
                min="0"
                max={duration}
                step="0.05"
                value={activeTrack === 'processed' ? currentTime : 0}
                onChange={(e) => handleSeek(e, processedAudio, 'processed')}
              />
            </div>
            <span className={`ap2-time ${isProcessedPlaying ? 'active' : ''}`}>
              {fmt(isProcessedPlaying ? currentTime : 0)} / {fmt(duration)}
            </span>
          </div>
        </div>

        {/* Volume */}
        <div className="ap2-volume-row">
          <span className="ap2-vol-label">Vol</span>
          <input
            type="range"
            className="ap2-vol-slider"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={handleVolume}
          />
          <span className="ap2-vol-pct">{Math.round(volume * 100)}%</span>
          {activeTrack && (
            <button className="ap2-stop-btn" onClick={stopAll}>⏹ Stop</button>
          )}
        </div>
      </div>
    </>
  );
}