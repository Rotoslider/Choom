import type { STTSettings, STTResult } from './types';
import { ensureEndpoint } from './utils';

export class STTClient {
  private endpoint: string;
  private language: string;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private onRecordingChange?: (isRecording: boolean) => void;
  private onResult?: (result: STTResult) => void;
  private onError?: (error: Error) => void;

  constructor(
    settings: STTSettings,
    callbacks?: {
      onRecordingChange?: (isRecording: boolean) => void;
      onResult?: (result: STTResult) => void;
      onError?: (error: Error) => void;
    }
  ) {
    this.endpoint = settings.endpoint;
    this.language = settings.language;
    this.onRecordingChange = callbacks?.onRecordingChange;
    this.onResult = callbacks?.onResult;
    this.onError = callbacks?.onError;
  }

  async startRecording(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: 'audio/webm',
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        await this.processAudio();
      };

      this.mediaRecorder.start();
      this.onRecordingChange?.(true);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to start recording');
      this.onError?.(err);
      throw err;
    }
  }

  stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    this.onRecordingChange?.(false);
  }

  private async processAudio(): Promise<void> {
    if (this.audioChunks.length === 0) return;

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
    this.audioChunks = [];

    try {
      const result = await this.transcribe(audioBlob);
      this.onResult?.(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Transcription failed');
      this.onError?.(err);
    }
  }

  async transcribe(audioBlob: Blob): Promise<STTResult> {
    // Use server-side API route to proxy to Whisper (avoids CORS issues)
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    formData.append('endpoint', this.endpoint);

    const response = await fetch('/api/stt', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`STT request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Transcription failed');
    }

    return {
      text: data.text || '',
      confidence: 1.0,
      language: this.language,
    };
  }

  isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording';
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(this.endpoint, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Voice Activity Detection (VAD) recorder
export class VADRecorder {
  private sttClient: STTClient;
  private settings: STTSettings;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private isActive: boolean = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private vadSensitivity: number;
  private silenceThreshold: number = 1500; // ms of silence to stop

  constructor(
    settings: STTSettings,
    callbacks?: {
      onRecordingChange?: (isRecording: boolean) => void;
      onResult?: (result: STTResult) => void;
      onError?: (error: Error) => void;
    }
  ) {
    this.sttClient = new STTClient(settings, callbacks);
    this.settings = settings;
    this.vadSensitivity = settings.vadSensitivity;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();

    const source = this.audioContext.createMediaStreamSource(this.stream);
    source.connect(this.analyser);

    this.analyser.fftSize = 512;
    this.isActive = true;

    this.monitorAudio();
  }

  stop(): void {
    this.isActive = false;

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.sttClient.isRecording()) {
      this.sttClient.stopRecording();
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  private monitorAudio(): void {
    if (!this.isActive || !this.analyser) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);

    // Calculate average volume
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const threshold = 255 * (1 - this.vadSensitivity);

    if (average > threshold) {
      // Voice detected
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }

      if (!this.sttClient.isRecording()) {
        this.sttClient.startRecording();
      }
    } else {
      // Silence detected
      if (this.sttClient.isRecording() && !this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.sttClient.stopRecording();
          this.silenceTimer = null;
        }, this.silenceThreshold);
      }
    }

    // Continue monitoring
    requestAnimationFrame(() => this.monitorAudio());
  }
}
