import { Platform } from 'obsidian';
import type { EdgeTTSPluginSettings } from './settings';

export interface TTSClient {
  setMetadata(voice: string, format: string): Promise<void>;
  toStream(text: string, prosodyOptions?: any): any;
}

// Environment detection
const isMobile = Platform.isMobile;
const isElectron = !isMobile && typeof window !== 'undefined' && (window as any).require;

// Buffer polyfill for mobile environments
let BufferPolyfill: any;
if (typeof Buffer === 'undefined' && typeof window !== 'undefined') {
  // Create a minimal Buffer polyfill for mobile
  BufferPolyfill = {
    from: (data: any) => {
      if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
      }
      if (data instanceof Uint8Array) {
        return data;
      }
      if (typeof data === 'string') {
        const encoder = new TextEncoder();
        return encoder.encode(data);
      }
      return new Uint8Array(0);
    },
    concat: (arrays: Uint8Array[]) => {
      const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
      }
      return result;
    }
  };

  // Set global Buffer for edge-tts-universal if needed
  (globalThis as any).Buffer = BufferPolyfill;
}

// Try to load the appropriate entry point for the environment
let TTSPackage: any;
try {
  // Try browser entry point first since it's now truly Node.js-free and works universally
  try {
    TTSPackage = require('edge-tts-universal/browser');
    console.log('Loaded edge-tts-universal/browser (Node.js-free)');
  } catch (e) {
    console.warn("Could not load 'edge-tts-universal/browser', trying isomorphic fallback.", e);
    try {
      TTSPackage = require('edge-tts-universal/isomorphic');
      console.log('Loaded edge-tts-universal/isomorphic as fallback');
    } catch (e2) {
      console.warn("Could not load 'edge-tts-universal/isomorphic', falling back to main entry point.", e2);
      TTSPackage = require('edge-tts-universal');
      console.log('Loaded edge-tts-universal main entry point as final fallback');
    }
  }
} catch (error) {
  console.error('Failed to import edge-tts-universal package:', error);
  TTSPackage = null;
}

// Re-export OUTPUT_FORMAT and other constants from the loaded package if they exist
export const OUTPUT_FORMAT = TTSPackage?.OUTPUT_FORMAT || {
  AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3',
  WEBM_24KHZ_16BIT_MONO_OPUS: 'webm-24khz-16bit-mono-opus',
};

// Helper function to create prosody options in the new format
export function createProsodyOptions(rate?: number): any {
  const prosody: any = {};

  if (rate !== undefined) {
    // Convert from number (e.g., 1.2) to percentage string (e.g., "+20%")
    const percentage = Math.round((rate - 1) * 100);
    if (percentage !== 0) {
      prosody.rate = percentage > 0 ? `+${percentage}%` : `${percentage}%`;
    }
  }

  return prosody;
}

/**
 * Basic stream adapter used to normalize streaming responses into the Node-like interface
 * the rest of the plugin expects.
 */
class SimpleStreamAdapter {
  private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  private hasEnded = false;

  on(event: string, callback: (...args: any[]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);

    // Immediately fire end event callbacks if the stream already ended
    if (event === 'end' && this.hasEnded) {
      callback();
    }
  }

  emit(event: string, ...args: any[]) {
    if (event === 'end') {
      this.hasEnded = true;
    }
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((callback) => callback(...args));
  }
}

class DeepgramTTSClient implements TTSClient {
  private apiKey: string;
  private model: string;
  private format: 'mp3' | 'opus' = 'mp3';
  private baseUrl: string;

  constructor(options: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = (options.apiKey || '').trim();
    this.model = (options.model || 'aura-asteria-en').trim();
    this.baseUrl = (options.baseUrl || 'https://api.deepgram.com').replace(/\/+$/, '');
  }

  async setMetadata(voice: string, format: string): Promise<void> {
    if (voice?.trim()) {
      this.model = voice.trim();
    }
    this.format = format && format.toLowerCase().includes('opus') ? 'opus' : 'mp3';
  }

  toStream(text: string, prosodyOptions?: any): any {
    if (!this.apiKey) {
      throw new Error('Deepgram API key is not set. Add it in the plugin settings.');
    }

    const streamAdapter = new SimpleStreamAdapter();
    const url = `${this.baseUrl}/v1/speak?model=${encodeURIComponent(this.model)}&encoding=${this.format}`;

    const requestBody: Record<string, any> = { text };
    if (prosodyOptions && typeof prosodyOptions.rate === 'number' && prosodyOptions.rate > 0 && prosodyOptions.rate !== 1) {
      requestBody.speed = prosodyOptions.rate;
    }

    (async () => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Token ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          throw new Error(`Deepgram TTS request failed (${response.status}: ${response.statusText})`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Deepgram response stream is not readable.');
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            streamAdapter.emit('data', value);
          }
        }

        streamAdapter.emit('end');
      } catch (error) {
        console.error('Deepgram TTS streaming error:', error);
        streamAdapter.emit('error', error);
        streamAdapter.emit('end');
      }
    })();

    return streamAdapter;
  }
}

/**
 * Universal TTS Client that provides a consistent API across platforms
 * Adapts the new edge-tts-universal API to match the old edge-tts-client API
 */
export class UniversalTTSClient implements TTSClient {
  private CommunicateClass: any;
  private currentVoice?: string;
  private currentFormat?: string;

  constructor() {
    if (!TTSPackage) {
      throw new Error('edge-tts-universal package not available');
    }

    // The browser/isomorphic entry might export `Communicate` or `IsomorphicCommunicate`
    this.CommunicateClass = TTSPackage.Communicate || TTSPackage.IsomorphicCommunicate;

    if (!this.CommunicateClass) {
      throw new Error('No suitable Communicate class found in the loaded edge-tts-universal package. Expected Communicate or IsomorphicCommunicate.');
    }
  }

  /**
   * Set metadata for TTS generation (compatible with old API)
   */
  async setMetadata(voice: string, format: string): Promise<void> {
    this.currentVoice = voice;
    this.currentFormat = format;
  }

  /**
   * Generate TTS stream (compatible with old API)
   */
  toStream(text: string, prosodyOptions?: any): any {
    if (!this.CommunicateClass) {
      throw new Error('TTS client not initialized');
    }

    // Convert prosody options to the correct format for edge-tts-universal
    const finalProsodyOptions: any = {};
    if (prosodyOptions && typeof prosodyOptions.rate === 'number') {
      const convertedProsody = createProsodyOptions(prosodyOptions.rate);
      finalProsodyOptions.rate = convertedProsody.rate;
    }

    try {
      // Create options object - IsomorphicCommunicate supports prosody options!
      const communicateOptions: any = {
        voice: this.currentVoice
      };

      // Add prosody options if provided (IsomorphicCommunicate supports these)
      if (finalProsodyOptions.rate) {
        communicateOptions.rate = finalProsodyOptions.rate;
      }
      if (finalProsodyOptions.pitch) {
        communicateOptions.pitch = finalProsodyOptions.pitch;
      }
      if (finalProsodyOptions.volume) {
        communicateOptions.volume = finalProsodyOptions.volume;
      }

      let communicate;
      try {
        // Create the communicate instance with text and options
        communicate = new this.CommunicateClass(text, communicateOptions);
      } catch (error) {
        console.warn('Failed to create Communicate with prosody options, trying with voice only:', error);
        // Fallback: try with just voice
        const minimalOptions = { voice: this.currentVoice };
        communicate = new this.CommunicateClass(text, minimalOptions);
      }

      // Use the new async generator API
      const asyncGenerator = communicate.stream();

      // Create a readable-like interface for compatibility
      const streamAdapter = {
        listeners: new Map<string, Array<(...args: any[]) => void>>(),

        on(event: string, callback: (...args: any[]) => void) {
          if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
          }
          this.listeners.get(event)!.push(callback);

          // Start consuming the async generator when a 'data' listener is added
          if (event === 'data' && !this.isConsuming) {
            this.consumeAsyncGenerator();
          }
        },

        emit(event: string, ...args: any[]) {
          const callbacks = this.listeners.get(event) || [];
          callbacks.forEach((callback: (...args: any[]) => void) => callback(...args));
        },

        isConsuming: false,

        async consumeAsyncGenerator() {
          this.isConsuming = true;
          try {
            for await (const chunk of asyncGenerator) {
              if (chunk.type === 'audio' && chunk.data) {
                // Handle Buffer/ArrayBuffer differences between environments
                let audioData: Uint8Array;
                if (chunk.data instanceof Uint8Array) {
                  audioData = chunk.data;
                } else if (chunk.data instanceof ArrayBuffer) {
                  audioData = new Uint8Array(chunk.data);
                } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(chunk.data)) {
                  audioData = new Uint8Array(chunk.data);
                } else if (BufferPolyfill && typeof chunk.data === 'object') {
                  audioData = BufferPolyfill.from(chunk.data);
                } else {
                  console.warn('Unexpected audio data type:', typeof chunk.data, chunk.data);
                  audioData = new Uint8Array(0);
                }
                this.emit('data', audioData);
              }
            }
            this.emit('end');
          } catch (error) {
            console.error('TTS stream: error consuming generator:', error);
            this.emit('error', error);
          }
        }
      };

      return streamAdapter;
    } catch (error) {
      console.error('Error creating TTS stream:', error);
      throw new Error(`Failed to create TTS stream: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

export function createTTSClient(settings: EdgeTTSPluginSettings): TTSClient {
  if (settings.ttsEngine === 'deepgram') {
    return new DeepgramTTSClient({
      apiKey: settings.deepgramApiKey,
      model: getVoiceForSettings(settings)
    });
  }
  return new UniversalTTSClient();
}

export function getVoiceForSettings(settings: EdgeTTSPluginSettings): string {
  if (settings.ttsEngine === 'deepgram') {
    return (settings.deepgramModel || 'aura-asteria-en').trim() || 'aura-asteria-en';
  }
  return settings.customVoice.trim() || settings.selectedVoice;
}
