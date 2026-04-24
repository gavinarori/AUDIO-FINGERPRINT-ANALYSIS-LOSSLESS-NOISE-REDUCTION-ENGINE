import { useState, useRef } from 'react';
import { decodeAudioFile, processAudioPipeline, type ProcessingResult, type ProcessingStep } from '../../lib/audio/utils';
import { GraphsGrid } from '../audio/GraphsGrid';
import { PerformanceMetricsTable } from '../audio/PerformanceMetricsTable';

export function AudioProcessor() {
  const [file, setFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [error, setError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sampleRate] = useState(44100);

  const handleFileSelect = (selectedFile: File) => {
    if (!selectedFile.type.includes('audio')) {
      setError('Please select a valid audio file');
      return;
    }
    setFile(selectedFile);
    setError('');
    setResult(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileSelect(files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleProcess = async () => {
    if (!file) {
      setError('Please select an audio file first');
      return;
    }

    try {
      setProcessing(true);
      setError('');
      setCurrentStep('Decoding audio...');

      const decoded = await decodeAudioFile(file);
      const audioData = decoded.channels[0];
      setCurrentStep('Processing audio pipeline...');

      const processingResult = await processAudioPipeline(audioData, decoded.sampleRate);

      setResult(processingResult);
      setCurrentStep('');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to process audio';
      setError(errorMessage);
      setCurrentStep('');
    } finally {
      setProcessing(false);
    }
  };

  const handleExport = () => {
    if (!result) return;

    const exportData = {
      fileName: file?.name,
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

    const jsonString = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audio-processing-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadProcessedAudio = () => {
    if (!result) return;

    const finalAudio = result.iirResult.filtered;
    const audioLength = finalAudio.length;

    // Create WAV file from audio data
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuffer = audioContext.createBuffer(1, audioLength, sampleRate);
    audioBuffer.getChannelData(0).set(finalAudio);

    const offlineContext = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(
      1,
      audioLength,
      sampleRate
    );
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start(0);

    offlineContext.startRendering().then((renderedBuffer) => {
      const channelData = renderedBuffer.getChannelData(0);
      const wavData = encodeWAV(channelData, sampleRate);
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

  const encodeWAV = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
    const length = samples.length;
    const arrayBuffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(arrayBuffer);

    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length * 2, true);

    // Audio data
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    return arrayBuffer;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground mb-2">Audio Noise Reduction Pipeline</h1>
          <p className="text-muted-foreground">Upload an audio file to process through our noise reduction pipeline with real-time visualization</p>
        </div>

        {/* Upload Section */}
        <div className="mb-8 bg-card rounded-lg border border-border p-6">
          <div
            className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:bg-muted/50 transition"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              onChange={(e) => e.target.files && handleFileSelect(e.target.files[0])}
              className="hidden"
            />
            <div className="text-4xl mb-2">🎵</div>
            <p className="text-foreground font-medium mb-1">Drag and drop your audio file here</p>
            <p className="text-muted-foreground text-sm">or click to select from your computer</p>
            {file && <p className="text-sm text-green-600 mt-2">✓ {file.name}</p>}
          </div>

          {error && <div className="mt-4 p-3 bg-red-100 border border-red-300 rounded text-red-800 text-sm">{error}</div>}
        </div>

        {/* Control Buttons */}
        <div className="flex gap-4 mb-8">
          <button
            onClick={handleProcess}
            disabled={!file || processing}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg font-medium transition"
          >
            {processing ? `${currentStep}...` : 'Process Audio'}
          </button>

          {result && (
            <>
              <button
                onClick={downloadProcessedAudio}
                className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition"
              >
                Download Processed Audio
              </button>
              <button
                onClick={handleExport}
                className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium transition"
              >
                Export Report
              </button>
            </>
          )}
        </div>

        {/* Processing Status */}
        {processing && (
          <div className="mb-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center gap-3">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
              <p className="text-blue-900">{currentStep}</p>
            </div>
          </div>
        )}

        {/* Results Section */}
        {result && (
          <div className="space-y-8">
            {/* Summary Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-card rounded-lg border border-border p-4">
                <p className="text-muted-foreground text-sm font-medium mb-1">Total Processing Time</p>
                <p className="text-2xl font-bold text-foreground">{result.totalTime.toFixed(2)}ms</p>
              </div>
              <div className="bg-card rounded-lg border border-border p-4">
                <p className="text-muted-foreground text-sm font-medium mb-1">Number of Stages</p>
                <p className="text-2xl font-bold text-foreground">{result.steps.length}</p>
              </div>
              <div className="bg-card rounded-lg border border-border p-4">
                <p className="text-muted-foreground text-sm font-medium mb-1">Sample Rate</p>
                <p className="text-2xl font-bold text-foreground">{sampleRate / 1000}kHz</p>
              </div>
              <div className="bg-card rounded-lg border border-border p-4">
                <p className="text-muted-foreground text-sm font-medium mb-1">Audio Duration</p>
                <p className="text-2xl font-bold text-foreground">{(result.originalAudio.length / sampleRate).toFixed(2)}s</p>
              </div>
            </div>

            {/* Performance Metrics Table */}
            <PerformanceMetricsTable steps={result.steps} totalTime={result.totalTime} />

            {/* Graphs Grid */}
            <div>
              <h2 className="text-2xl font-bold text-foreground mb-4">Audio Analysis</h2>
              <GraphsGrid result={result} sampleRate={sampleRate} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
