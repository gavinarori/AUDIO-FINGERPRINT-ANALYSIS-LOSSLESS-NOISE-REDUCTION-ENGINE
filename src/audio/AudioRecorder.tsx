import React, { useState, useRef, useEffect, useCallback } from 'react';

interface AudioRecorderProps {
  onRecordingComplete: (audioData: Float32Array, sampleRate: number) => void;
}

export function AudioRecorder({ onRecordingComplete }: AudioRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [bars, setBars] = useState<number[]>(Array(40).fill(0));
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isRecordingRef = useRef(false);

  const NUM_BARS = 40;

  const updateBars = useCallback(() => {
    if (!analyserRef.current || !isRecordingRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    const step = Math.floor(dataArray.length / NUM_BARS);
    const newBars = Array.from({ length: NUM_BARS }, (_, i) => {
      const slice = dataArray.slice(i * step, (i + 1) * step);
      const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
      return avg / 255;
    });

    setBars(newBars);
    animationFrameRef.current = requestAnimationFrame(updateBars);
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setHasPermission(true);

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.start();
      setIsRecording(true);
      isRecordingRef.current = true;
      setRecordingTime(0);

      timerIntervalRef.current = setInterval(() => {
        setRecordingTime((t) => t + 100);
      }, 100);

      animationFrameRef.current = requestAnimationFrame(updateBars);
    } catch (err) {
      console.error('Microphone access denied:', err);
      setHasPermission(false);
    }
  };

  const stopAnimations = () => {
    isRecordingRef.current = false;
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    setBars(Array(NUM_BARS).fill(0));
  };

  const stopRecording = async () => {
    stopAnimations();
    setIsRecording(false);

    if (!mediaRecorderRef.current || !streamRef.current) return;

    mediaRecorderRef.current.stop();
    streamRef.current.getTracks().forEach((track) => track.stop());

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    let monoData = audioBuffer.getChannelData(0);
    if (audioBuffer.numberOfChannels > 1) {
      monoData = new Float32Array(audioBuffer.length);
      for (let i = 0; i < audioBuffer.length; i++) {
        let sum = 0;
        for (let j = 0; j < audioBuffer.numberOfChannels; j++) {
          sum += audioBuffer.getChannelData(j)[i];
        }
        monoData[i] = sum / audioBuffer.numberOfChannels;
      }
    } else {
      monoData = new Float32Array(audioBuffer.getChannelData(0));
    }

    onRecordingComplete(monoData, audioBuffer.sampleRate);
    setRecordingTime(0);
  };

  const cancelRecording = () => {
    stopAnimations();
    setIsRecording(false);
    if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    audioChunksRef.current = [];
    setRecordingTime(0);
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centis = Math.floor((ms % 1000) / 10);
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${centis.toString().padStart(2, '0')}`;
  };

  return (
    <>
      <style>{`
        .rec-root {
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 24px;
          font-family: 'Syne', sans-serif;
        }

        .rec-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 20px;
        }

        .rec-title {
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #6b7f8e;
          font-family: 'JetBrains Mono', monospace;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .rec-timer {
          font-family: 'JetBrains Mono', monospace;
          font-size: 22px;
          font-weight: 500;
          color: ${isRecording ? '#ff4d6d' : '#2a3845'};
          letter-spacing: 0.04em;
          transition: color 0.3s ease;
        }

        .rec-timer.recording {
          color: #ff4d6d;
          text-shadow: 0 0 20px rgba(255,77,109,0.4);
        }

        /* Waveform bars */
        .rec-waveform {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 3px;
          height: 64px;
          margin: 16px 0;
          padding: 0 4px;
        }

        .rec-bar {
          flex: 1;
          border-radius: 3px;
          transition: height 0.05s ease;
          min-height: 3px;
          transform-origin: center;
        }

        .rec-bar.active {
          background: linear-gradient(180deg, #ff4d6d 0%, #ff8c42 100%);
          box-shadow: 0 0 6px rgba(255,77,109,0.3);
        }

        .rec-bar.idle {
          background: rgba(255,255,255,0.07);
          height: 3px !important;
        }

        /* Controls */
        .rec-controls {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 20px;
        }

        .rec-btn-record {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 24px;
          border-radius: 50px;
          font-family: 'Syne', sans-serif;
          font-size: 14px;
          font-weight: 600;
          border: none;
          cursor: pointer;
          transition: all 0.2s ease;
          flex: 1;
          justify-content: center;
          background: linear-gradient(135deg, #ff4d6d, #ff8c42);
          color: white;
          box-shadow: 0 4px 20px rgba(255,77,109,0.3);
        }

        .rec-btn-record:hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 24px rgba(255,77,109,0.45);
        }

        .rec-btn-record:active { transform: scale(0.98); }

        .rec-btn-stop {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 24px;
          border-radius: 50px;
          font-family: 'Syne', sans-serif;
          font-size: 14px;
          font-weight: 600;
          border: none;
          cursor: pointer;
          transition: all 0.2s ease;
          flex: 1;
          justify-content: center;
          background: linear-gradient(135deg, #00c8a0, #0078ff);
          color: white;
          box-shadow: 0 4px 20px rgba(0,200,160,0.25);
        }

        .rec-btn-stop:hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 24px rgba(0,200,160,0.4);
        }

        .rec-btn-cancel {
          padding: 12px 20px;
          border-radius: 50px;
          font-family: 'Syne', sans-serif;
          font-size: 14px;
          font-weight: 600;
          border: 1px solid rgba(255,255,255,0.1);
          cursor: pointer;
          transition: all 0.2s ease;
          background: transparent;
          color: #6b7f8e;
        }

        .rec-btn-cancel:hover {
          background: rgba(255,255,255,0.05);
          color: #e8edf2;
        }

        .rec-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: currentColor;
        }

        .rec-dot.pulsing {
          animation: rec-pulse 0.8s ease-in-out infinite;
        }

        @keyframes rec-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.4); opacity: 0.7; }
        }

        .rec-permission-error {
          font-size: 12px;
          color: #ff4d6d;
          margin-top: 12px;
          font-family: 'JetBrains Mono', monospace;
          background: rgba(255,77,109,0.08);
          padding: 8px 12px;
          border-radius: 8px;
          border: 1px solid rgba(255,77,109,0.2);
        }
      `}</style>

      <div className="rec-root">
        <div className="rec-header">
          <div className="rec-title">
            <span>🎙</span> Microphone Input
          </div>
          <div className={`rec-timer ${isRecording ? 'recording' : ''}`}>
            {formatTime(recordingTime)}
          </div>
        </div>

        {/* Waveform visualizer */}
        <div className="rec-waveform">
          {bars.map((val, i) => {
            const height = isRecording ? Math.max(4, val * 60) : 3;
            const mid = NUM_BARS / 2;
            const distFromCenter = Math.abs(i - mid) / mid;
            const shaped = height * (1 - distFromCenter * 0.3);
            return (
              <div
                key={i}
                className={`rec-bar ${isRecording ? 'active' : 'idle'}`}
                style={{ height: `${shaped}px` }}
              />
            );
          })}
        </div>

        {/* Controls */}
        <div className="rec-controls">
          {!isRecording ? (
            <button className="rec-btn-record" onClick={startRecording}>
              <span className="rec-dot" />
              Start Recording
            </button>
          ) : (
            <>
              <button className="rec-btn-stop" onClick={stopRecording}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <rect width="10" height="10" rx="2" />
                </svg>
                Save Recording
              </button>
              <button className="rec-btn-cancel" onClick={cancelRecording}>
                Discard
              </button>
            </>
          )}
        </div>

        {hasPermission === false && (
          <div className="rec-permission-error">
            ⚠ Microphone access denied. Please allow microphone access in your browser settings.
          </div>
        )}
      </div>
    </>
  );
}