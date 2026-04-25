import { useState, useRef } from 'react';
import { decodeAudioFile, processAudioPipeline, type ProcessingResult, type ProcessingStep } from '../../lib/audio/utils';
import { GraphsGrid } from '../audio/GraphsGrid';
import { PerformanceMetricsTable } from '../audio/PerformanceMetricsTable';
import { AudioRecorder } from '../audio/AudioRecorder';
import { AudioPlayer } from '../audio/AudioPlayer';

type InputMode = 'upload' | 'record';

export function AudioProcessor() {
  const [inputMode, setInputMode] = useState<InputMode>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [rawAudio, setRawAudio] = useState<{ data: Float32Array; sampleRate: number } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Determine what audio data we have ready
  const hasAudio = file !== null || rawAudio !== null;

  const handleFileSelect = (selectedFile: File) => {
    if (!selectedFile.type.includes('audio')) {
      setError('Please select a valid audio file');
      return;
    }
    setFile(selectedFile);
    setRawAudio(null);
    setError('');
    setResult(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) handleFileSelect(files[0]);
  };

  const handleRecordingComplete = (audioData: Float32Array, sampleRate: number) => {
    setRawAudio({ data: audioData, sampleRate });
    setFile(null);
    setError('');
    setResult(null);
  };

  const handleProcess = async () => {
    if (!hasAudio) { setError('Please provide audio first'); return; }
    try {
      setProcessing(true);
      setError('');

      let audioData: Float32Array;
      let sr: number;

      if (file) {
        setCurrentStep('Decoding audio file…');
        const decoded = await decodeAudioFile(file);
        audioData = decoded.channels[0];
        sr = decoded.sampleRate;
      } else if (rawAudio) {
        audioData = rawAudio.data;
        sr = rawAudio.sampleRate;
      } else {
        return;
      }

      setCurrentStep('Running noise reduction pipeline…');
      const processingResult = await processAudioPipeline(audioData, sr);
      setResult(processingResult);
      setCurrentStep('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process audio');
      setCurrentStep('');
    } finally {
      setProcessing(false);
    }
  };

  const handleExport = () => {
    if (!result) return;
    const sampleRate = rawAudio?.sampleRate ?? 44100;
    const exportData = {
      fileName: file?.name ?? 'recorded-audio',
      processingDate: new Date().toISOString(),
      sampleRate,
      totalTime: result.totalTime,
      steps: result.steps.map((step) => ({
        name: step.name,
        description: step.description,
        executionTime: step.executionTime,
        snr: step.snr,
      })),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audio-processing-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const encodeWAV = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
    const length = samples.length;
    const arrayBuffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(arrayBuffer);
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length * 2, true);
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
    return arrayBuffer;
  };

  const downloadProcessedAudio = () => {
    if (!result) return;
    const sr = rawAudio?.sampleRate ?? 44100;
    const finalAudio = result.iirResult.filtered;
    const offlineContext = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(1, finalAudio.length, sr);
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuffer = ctx.createBuffer(1, finalAudio.length, sr);
    audioBuffer.getChannelData(0).set(finalAudio);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start(0);
    offlineContext.startRendering().then((renderedBuffer) => {
      const channelData = renderedBuffer.getChannelData(0);
      const wavData = encodeWAV(channelData, sr);
      const blob = new Blob([wavData], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `processed-audio-${Date.now()}.wav`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  };

  const activeSampleRate = rawAudio?.sampleRate ?? 44100;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

        .ap-root {
          min-height: 100vh;
          background: #080c0f;
          font-family: 'Syne', sans-serif;
          color: #e8edf2;
          position: relative;
          overflow-x: hidden;
        }

        .ap-root::before {
          content: '';
          position: fixed;
          inset: 0;
          background:
            radial-gradient(ellipse 60% 50% at 10% 0%, rgba(0, 200, 160, 0.07) 0%, transparent 60%),
            radial-gradient(ellipse 50% 40% at 90% 100%, rgba(0, 120, 255, 0.06) 0%, transparent 60%);
          pointer-events: none;
          z-index: 0;
        }

        .ap-grid-bg {
          position: fixed;
          inset: 0;
          background-image:
            linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
          background-size: 40px 40px;
          pointer-events: none;
          z-index: 0;
        }

        .ap-inner {
          position: relative;
          z-index: 1;
          max-width: 1200px;
          margin: 0 auto;
          padding: 48px 24px 80px;
        }

        /* Header */
        .ap-header {
          margin-bottom: 48px;
        }

        .ap-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #00c8a0;
          background: rgba(0, 200, 160, 0.08);
          border: 1px solid rgba(0, 200, 160, 0.2);
          padding: 5px 12px;
          border-radius: 4px;
          margin-bottom: 16px;
        }

        .ap-badge-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: #00c8a0; box-shadow: 0 0 8px #00c8a0;
          animation: pulse-dot 2s ease-in-out infinite;
        }

        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }

        .ap-title {
          font-size: clamp(32px, 5vw, 52px);
          font-weight: 800;
          letter-spacing: -0.03em;
          line-height: 1.05;
          color: #f0f4f8;
          margin: 0 0 10px;
        }
        .ap-title span { color: #00c8a0; }

        .ap-subtitle {
          font-size: 15px;
          color: #6b7f8e;
          font-weight: 400;
          margin: 0;
          max-width: 440px;
          line-height: 1.6;
        }

        /* Two-column input layout */
        .ap-input-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 24px;
        }

        @media (max-width: 700px) {
          .ap-input-grid { grid-template-columns: 1fr; }
        }

        /* Input mode tabs */
        .ap-tabs {
          display: flex;
          gap: 4px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 4px;
          margin-bottom: 16px;
          width: fit-content;
        }

        .ap-tab {
          padding: 8px 20px;
          border-radius: 9px;
          font-size: 13px;
          font-weight: 600;
          font-family: 'Syne', sans-serif;
          letter-spacing: 0.02em;
          border: none;
          cursor: pointer;
          transition: all 0.2s ease;
          color: #4a5a68;
          background: transparent;
        }

        .ap-tab.active {
          background: rgba(0,200,160,0.12);
          color: #00c8a0;
          border: 1px solid rgba(0,200,160,0.2);
        }

        .ap-tab:not(.active):hover {
          color: #e8edf2;
          background: rgba(255,255,255,0.04);
        }

        /* Upload card */
        .ap-upload-card {
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 6px;
        }

        .ap-dropzone {
          border: 1.5px dashed rgba(255,255,255,0.1);
          border-radius: 12px;
          padding: 32px 24px;
          cursor: pointer;
          text-align: center;
          transition: all 0.25s ease;
          background: transparent;
          min-height: 180px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 10px;
        }

        .ap-dropzone:hover, .ap-dropzone.drag-over {
          border-color: rgba(0,200,160,0.4);
          background: rgba(0,200,160,0.04);
        }

        .ap-drop-icon {
          font-size: 32px;
          opacity: 0.6;
          line-height: 1;
        }

        .ap-drop-title {
          font-size: 14px;
          font-weight: 600;
          color: #8a9aaa;
          margin: 0;
        }

        .ap-drop-sub {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #3d4f5c;
          letter-spacing: 0.06em;
          margin: 0;
        }

        .ap-file-name {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          color: #00c8a0;
          background: rgba(0,200,160,0.08);
          border: 1px solid rgba(0,200,160,0.2);
          padding: 6px 14px;
          border-radius: 6px;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .ap-recorded-ready {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 20px;
          min-height: 80px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
          color: #00c8a0;
          background: rgba(0,200,160,0.04);
          border: 1px solid rgba(0,200,160,0.15);
          border-radius: 12px;
          margin-top: 12px;
        }

        /* Action row */
        .ap-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 24px;
        }

        .ap-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 24px;
          border-radius: 10px;
          font-family: 'Syne', sans-serif;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          border: none;
          transition: all 0.2s ease;
          white-space: nowrap;
        }

        .ap-btn-primary {
          background: linear-gradient(135deg, #00c8a0 0%, #0078ff 100%);
          color: #001a14;
          box-shadow: 0 4px 20px rgba(0,200,160,0.25);
        }
        .ap-btn-primary:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 6px 28px rgba(0,200,160,0.4);
        }
        .ap-btn-primary:disabled {
          opacity: 0.35;
          cursor: not-allowed;
          transform: none;
        }

        .ap-btn-secondary {
          background: rgba(0,200,160,0.1);
          color: #00c8a0;
          border: 1px solid rgba(0,200,160,0.25);
        }
        .ap-btn-secondary:hover { background: rgba(0,200,160,0.15); }

        .ap-btn-ghost {
          background: rgba(255,255,255,0.04);
          color: #8a9aaa;
          border: 1px solid rgba(255,255,255,0.08);
        }
        .ap-btn-ghost:hover { background: rgba(255,255,255,0.08); color: #e8edf2; }

        /* Spinner */
        .ap-spinner {
          width: 14px; height: 14px;
          border: 2px solid rgba(0,0,0,0.2);
          border-top-color: #001a14;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
          flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Status */
        .ap-status {
          display: flex;
          align-items: center;
          gap: 12px;
          background: rgba(0,200,160,0.06);
          border: 1px solid rgba(0,200,160,0.15);
          border-radius: 10px;
          padding: 14px 18px;
          margin-bottom: 24px;
        }
        .ap-status-text {
          font-size: 13px;
          color: #00c8a0;
          font-family: 'JetBrains Mono', monospace;
        }
        .ap-status-bar {
          flex: 1;
          height: 3px;
          background: rgba(0,200,160,0.15);
          border-radius: 3px;
          overflow: hidden;
        }
        .ap-status-bar-inner {
          height: 100%;
          width: 40%;
          background: linear-gradient(90deg, transparent, #00c8a0, transparent);
          animation: shimmer 1.4s ease-in-out infinite;
        }
        @keyframes shimmer {
          0% { transform: translateX(-200%); }
          100% { transform: translateX(400%); }
        }

        .ap-error {
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(239,68,68,0.08);
          border: 1px solid rgba(239,68,68,0.2);
          border-radius: 8px;
          padding: 10px 14px;
          font-size: 13px;
          color: #ef4444;
          font-family: 'JetBrains Mono', monospace;
          margin-top: 12px;
        }

        /* Stats */
        .ap-stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 12px;
          margin-bottom: 32px;
        }

        .ap-stat-card {
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 18px;
          position: relative;
          overflow: hidden;
          transition: border-color 0.2s ease;
        }
        .ap-stat-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 2px;
          background: linear-gradient(90deg, transparent, rgba(0,200,160,0.4), transparent);
          opacity: 0;
          transition: opacity 0.3s;
        }
        .ap-stat-card:hover { border-color: rgba(0,200,160,0.15); }
        .ap-stat-card:hover::before { opacity: 1; }

        .ap-stat-label {
          font-size: 11px;
          font-family: 'JetBrains Mono', monospace;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #4a5a68;
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .ap-stat-label::before {
          content: '';
          display: inline-block;
          width: 6px; height: 6px;
          border-radius: 50%;
          background: #00c8a0;
          opacity: 0.5;
        }

        .ap-stat-value {
          font-size: 28px;
          font-weight: 800;
          color: #e8edf2;
          letter-spacing: -0.03em;
          line-height: 1;
        }

        .ap-stat-unit {
          font-size: 13px;
          font-weight: 500;
          color: #4a5a68;
          margin-left: 3px;
          letter-spacing: 0;
        }

        .ap-section-title {
          font-size: 20px;
          font-weight: 700;
          color: #d0dce6;
          margin: 0 0 20px;
          display: flex;
          align-items: center;
          gap: 12px;
          letter-spacing: -0.02em;
        }
        .ap-section-title::after {
          content: '';
          flex: 1;
          height: 1px;
          background: rgba(255,255,255,0.05);
        }

        .ap-results {
          animation: fadeIn 0.5s ease;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .ap-results-section { margin-bottom: 40px; }

        .ap-divider {
          height: 1px;
          background: rgba(255,255,255,0.05);
          margin: 32px 0;
        }

        /* Audio player wrapper */
        .ap-player-section {
          background: rgba(255,255,255,0.015);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 24px;
        }
      `}</style>

      <div className="ap-root">
        <div className="ap-grid-bg" />

        <div className="ap-inner">
          {/* Header */}
          <header className="ap-header">
            <div className="ap-badge">
              <span className="ap-badge-dot" />
              DSP Engine v2.0
            </div>
            <h1 className="ap-title">
              Audio Noise<br /><span>Reduction</span>
            </h1>
            <p className="ap-subtitle">
              Upload or record audio and run it through a multi-stage noise reduction pipeline with real-time analytics.
            </p>
          </header>

          {/* Mode tabs */}
          <div className="ap-tabs">
            <button
              className={`ap-tab ${inputMode === 'upload' ? 'active' : ''}`}
              onClick={() => setInputMode('upload')}
            >
              ↑ Upload File
            </button>
            <button
              className={`ap-tab ${inputMode === 'record' ? 'active' : ''}`}
              onClick={() => setInputMode('record')}
            >
              ● Record Live
            </button>
          </div>

          {/* Input area */}
          {inputMode === 'upload' ? (
            <div className="ap-upload-card" style={{ marginBottom: 24 }}>
              <div
                className={`ap-dropzone${isDragOver ? ' drag-over' : ''}`}
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  onChange={(e) => e.target.files && handleFileSelect(e.target.files[0])}
                  style={{ display: 'none' }}
                />
                <div className="ap-drop-icon">{file ? '✓' : '🎛️'}</div>
                <p className="ap-drop-title">
                  {isDragOver ? 'Release to load file' : file ? file.name : 'Drag & drop your audio file'}
                </p>
                {!file && (
                  <p className="ap-drop-sub">WAV · MP3 · FLAC · OGG · AAC · M4A</p>
                )}
                {file && (
                  <div className="ap-file-name">✓ {file.name}</div>
                )}
              </div>
              {error && <div className="ap-error"><span>⚠</span> {error}</div>}
            </div>
          ) : (
            <div style={{ marginBottom: 24 }}>
              <AudioRecorder onRecordingComplete={handleRecordingComplete} />
              {rawAudio && (
                <div className="ap-recorded-ready">
                  <span>✓ Recording captured</span>
                  <span style={{ fontSize: 11, color: '#4a8a74' }}>
                    {(rawAudio.data.length / rawAudio.sampleRate).toFixed(2)}s · {rawAudio.sampleRate / 1000}kHz
                  </span>
                </div>
              )}
              {error && <div className="ap-error" style={{ marginTop: 12 }}><span>⚠</span> {error}</div>}
            </div>
          )}

          {/* Action Buttons */}
          <div className="ap-actions">
            <button
              className="ap-btn ap-btn-primary"
              onClick={handleProcess}
              disabled={!hasAudio || processing}
            >
              {processing ? (
                <>
                  <span className="ap-spinner" />
                  {currentStep || 'Processing…'}
                </>
              ) : (
                <>⚡ Process Audio</>
              )}
            </button>

            {result && (
              <>
                <button className="ap-btn ap-btn-secondary" onClick={downloadProcessedAudio}>
                  ↓ Download WAV
                </button>
                <button className="ap-btn ap-btn-ghost" onClick={handleExport}>
                  ↗ Export Report
                </button>
              </>
            )}
          </div>

          {/* Processing Status Bar */}
          {processing && (
            <div className="ap-status">
              <div className="ap-spinner" style={{ borderTopColor: '#00c8a0', borderColor: 'rgba(0,200,160,0.15)' }} />
              <span className="ap-status-text">{currentStep}</span>
              <div className="ap-status-bar">
                <div className="ap-status-bar-inner" />
              </div>
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="ap-results">
              <div className="ap-divider" />

              {/* Audio Player */}
              <div className="ap-results-section">
                <h2 className="ap-section-title">Playback Comparison</h2>
                <div className="ap-player-section">
                  <AudioPlayer
                    originalAudio={result.originalAudio}
                    processedAudio={result.iirResult.filtered}
                    sampleRate={activeSampleRate}
                  />
                </div>
              </div>

              {/* Summary Stats */}
              <div className="ap-results-section">
                <h2 className="ap-section-title">Pipeline Summary</h2>
                <div className="ap-stats-grid">
                  <div className="ap-stat-card">
                    <div className="ap-stat-label">Processing Time</div>
                    <div className="ap-stat-value">
                      {result.totalTime.toFixed(1)}<span className="ap-stat-unit">ms</span>
                    </div>
                  </div>
                  <div className="ap-stat-card">
                    <div className="ap-stat-label">Pipeline Stages</div>
                    <div className="ap-stat-value">{result.steps.length}</div>
                  </div>
                  <div className="ap-stat-card">
                    <div className="ap-stat-label">Sample Rate</div>
                    <div className="ap-stat-value">
                      {activeSampleRate / 1000}<span className="ap-stat-unit">kHz</span>
                    </div>
                  </div>
                  <div className="ap-stat-card">
                    <div className="ap-stat-label">Audio Duration</div>
                    <div className="ap-stat-value">
                      {(result.originalAudio.length / activeSampleRate).toFixed(2)}<span className="ap-stat-unit">s</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Performance Metrics */}
              <div className="ap-results-section">
                <h2 className="ap-section-title">Stage Metrics</h2>
                <PerformanceMetricsTable steps={result.steps} totalTime={result.totalTime} />
              </div>

              {/* Graphs */}
              <div className="ap-results-section">
                <h2 className="ap-section-title">Audio Analysis</h2>
                <GraphsGrid result={result} sampleRate={activeSampleRate} />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}