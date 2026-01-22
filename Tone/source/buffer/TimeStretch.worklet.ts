/**
 * SoundTouch AudioWorklet Processor for TimeStretchPlayer
 * Handles real-time time-stretching and pitch-shifting using SoundTouch WASM.
 */

export const workletName = "soundtouch-timestretch-processor";

export const timeStretchWorkletCode = /* javascript */ `
let wasmInitialized = false;
let SoundTouchWasm = null;

// Constants
const PROGRESS_REPORT_INTERVAL = 4096;
const MAX_CHUNK_SIZE = 4096;
const MAX_ITERATIONS = 10;
const MAX_FLUSH_ITERATIONS = 3;

class SoundTouchTimeStretchProcessor extends AudioWorkletProcessor {
  /**
   * AudioParam descriptors for automated parameter control
   * - tempo: playback speed without pitch change (k-rate for efficiency)
   * - pitch: pitch shift in semitones (k-rate for efficiency)
   */
  static get parameterDescriptors() {
    return [
      {
        name: 'tempo',
        defaultValue: 1.0,
        minValue: 0.1,
        maxValue: 4.0,
        automationRate: 'k-rate'
      },
      {
        name: 'pitch',
        defaultValue: 0,
        minValue: -24,
        maxValue: 24,
        automationRate: 'k-rate'
      },
      {
        name: 'rate',
        defaultValue: 1,
        minValue: 0.1,
        maxValue: 4.0,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor(options) {
    super();
    
    const opts = options.processorOptions || {};
    
    // Configuration
    this.sampleRate = opts.sampleRate || 48000;
    this.channels = opts.channels || 2;
    this.useQuickSeek = opts.useQuickSeek ?? true;
    this.useAaFilter = opts.useAaFilter ?? false;
    this.tempo = opts.tempo || 1.0;
    this.pitch = opts.pitch || 0;
    this.rate = opts.rate || 1.0;
    this.wasmBytes = opts.wasmBytes;
    this.soundtouchCode = opts.soundtouchCode;
    
    // State
    this.initialized = false;
    this.soundtouch = null;
    this.playing = false;
    this.disposed = false;
    this.paused = false;
    
    // Audio data
    this.audioData = null;
    this.audioDataPosition = 0;
    this.audioDataLength = 0;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    
    // Working buffers
    this.inputBuffer = new Float32Array(MAX_CHUNK_SIZE * this.channels);
    // receiveBuffer needs to be large enough to hold a full render quantum (128 samples typically)
    // Make it larger to handle cases where we need more data
    this.receiveBuffer = new Float32Array(MAX_CHUNK_SIZE * this.channels * 2);
    this.outputBuffer = new Float32Array(MAX_CHUNK_SIZE * this.channels); // Buffer for current output
    
    // Track receiveBuffer usage: how many frames are available and current read position
    this.receiveBufferAvailableFrames = 0; // Number of frames available in receiveBuffer
    this.receiveBufferReadOffset = 0; // Current read position in receiveBuffer (in samples)
    
    // Progress tracking
    this.lastReportedPosition = 0;
    this.playbackTime = 0;

    // Parameter automation tracking
    // Store last applied values to detect changes from AudioParam automation
    this._lastAppliedTempo = this.tempo;
    this._lastAppliedPitch = this.pitch;

    // Error throttling
    this.lastErrorTime = 0;
    this.errorThrottleMs = 1000;
    
    this.init();
    this.setupMessageHandler();
  }
  
  // --- Initialization ---
  
  init() {
    try {
      if (!this.wasmBytes) throw new Error('WASM bytes not provided');
      if (!this.soundtouchCode) throw new Error('SoundTouch code not provided');

      if (!wasmInitialized) {
        new Function(this.soundtouchCode)();
        
        SoundTouchWasm = globalThis.SoundTouchWasm;
        const initSync = globalThis.initSync;
        
        if (!initSync || !SoundTouchWasm) {
          throw new Error('SoundTouch exports not found');
        }
        
        initSync({ module: this.wasmBytes });
        wasmInitialized = true;
      }

      this.soundtouch = new SoundTouchWasm(
        this.sampleRate,
        this.channels,
        this.useQuickSeek,
        this.useAaFilter
      );
      this.soundtouch.setTempo(this.tempo);
      this.soundtouch.setPitchSemitones(this.pitch);
      if (this.rate !== 1.0) {
        this.soundtouch.setRate(this.rate);
      }

      this.initialized = true;
      this.port.postMessage({ type: 'initialized' });
    } catch (err) {
      console.error('Failed to initialize SoundTouch:', err);
      this.port.postMessage({
        type: 'error',
        message: err.toString(),
        stack: err.stack,
        fatal: true
      });
    }
  }

  setupMessageHandler() {
    this.port.onmessage = ({ data }) => {
      const { type, value, audioData, offset, loop, loopStart, loopEnd, sharedBuffer, channels, sampleRate } = data;
      
      const handlers = {
        dispose: () => this.dispose(),
        setTempo: () => this.setTempo(value),
        setPitch: () => this.setPitch(value),
        setRate: () => this.setRate(value),
        setAudioData: () => this.setAudioData(audioData, offset, loop, loopStart, loopEnd),
        setSharedAudioData: () => this.setSharedAudioData(sharedBuffer, channels, sampleRate, offset, loop, loopStart, loopEnd),
        start: () => this.start(offset),
        stop: () => this.stop(),
        pause: () => this.pause(),
        resume: () => this.resume(),
        seek: () => this.seek(value),
        setLoop: () => this.setLoopParameters(value),
        ping: () => this.port.postMessage({ type: 'pong' }),
        getStats: () => this.sendStats()
      };
      
      const handler = handlers[type];
      if (handler) {
        try {
          handler();
        } catch (err) {
          this.reportError('Message handler error (' + type + '): ' + err.message);
        }
      }
    };
  }
  
  // --- Playback Control ---
  
  setAudioData(audioData, offset = 0, loop = false, loopStart = 0, loopEnd = 0) {
    if (!audioData?.[0]) {
      this.reportError('Invalid audio data provided');
      return;
    }
    
    this.audioData = audioData;
    this.audioDataLength = audioData[0].length;
    this.audioDataPosition = this.clamp(offset, 0, this.audioDataLength);
    this.loop = loop;
    this.loopStart = Math.max(0, loopStart);
    this.loopEnd = loopEnd > 0 ? Math.min(loopEnd, this.audioDataLength) : this.audioDataLength;
    this.playbackTime = this.audioDataPosition / this.sampleRate;
    
    this.clearBuffers();
    
    this.port.postMessage({
      type: 'audioDataLoaded',
      duration: this.audioDataLength / this.sampleRate,
      channels: audioData.length,
      length: this.audioDataLength,
      sampleRate: this.sampleRate
    });
  }
  
  /**
   * Set audio data from SharedArrayBuffer (zero-copy).
   * The SharedArrayBuffer contains planar audio data: [L0, L1, ..., Ln, R0, R1, ..., Rn]
   */
  setSharedAudioData(sharedBuffer, channels, sampleRate, offset = 0, loop = false, loopStart = 0, loopEnd = 0) {
    if (!sharedBuffer || !(sharedBuffer instanceof SharedArrayBuffer)) {
      this.reportError('Invalid SharedArrayBuffer provided');
      return;
    }
    
    // Update sample rate if provided
    if (sampleRate && sampleRate !== this.sampleRate) {
      this.sampleRate = sampleRate;
    }
    
    // Create Float32Array views directly on the SharedArrayBuffer (zero-copy)
    const floatView = new Float32Array(sharedBuffer);
    const totalSamples = floatView.length;
    const samplesPerChannel = Math.floor(totalSamples / channels);
    
    // Create array of Float32Array views for each channel (planar format)
    this.audioData = [];
    for (let ch = 0; ch < channels; ch++) {
      const channelOffset = ch * samplesPerChannel;
      // Create a view into the SharedArrayBuffer for this channel
      this.audioData.push(new Float32Array(sharedBuffer, channelOffset * Float32Array.BYTES_PER_ELEMENT, samplesPerChannel));
    }
    
    this.channels = channels;
    this.audioDataLength = samplesPerChannel;
    this.audioDataPosition = this.clamp(offset, 0, this.audioDataLength);
    this.loop = loop;
    this.loopStart = Math.max(0, loopStart);
    this.loopEnd = loopEnd > 0 ? Math.min(loopEnd, this.audioDataLength) : this.audioDataLength;
    this.playbackTime = this.audioDataPosition / this.sampleRate;
    
    this.clearBuffers();
    
    this.port.postMessage({
      type: 'audioDataLoaded',
      duration: this.audioDataLength / this.sampleRate,
      channels: channels,
      length: this.audioDataLength,
      sampleRate: this.sampleRate,
      sharedBuffer: true
    });
  }
  
  setLoopParameters(params) {
    this.loop = params.enabled;
    this.loopStart = params.start || 0;
    this.loopEnd = params.end || this.audioDataLength;
  }
  
  start(offset = 0) {
    if (!this.audioData) {
      this.reportError('No audio data loaded');
      return;
    }
    
    this.audioDataPosition = this.clamp(offset, 0, this.audioDataLength);
    this.playbackTime = this.audioDataPosition / this.sampleRate;
    this.clearBuffers();
    this.playing = true;
    this.paused = false;
  }
  
  stop() {
    if (this.playing) {
      this.playing = false;
      this.paused = false;
      this.clearBuffers();
      this.port.postMessage({ type: 'stopped' });
    }
  }
  
  pause() {
    if (this.playing && !this.paused) {
      this.paused = true;
    }
  }
  
  resume() {
    if (this.paused) {
      this.paused = false;
    }
  }
  
  seek(position) {
    this.audioDataPosition = this.clamp(position, 0, this.audioDataLength);
    this.playbackTime = this.audioDataPosition / this.sampleRate;
    this.clearBuffers();
    
    this.port.postMessage({
      type: 'seeked',
      position: this.audioDataPosition,
      time: this.playbackTime
    });
  }
  
  // --- Parameter Control ---
  
  setTempo(value) {
    const newTempo = this.clamp(value, 0.1, 4.0);
    if (Math.abs(newTempo - this.tempo) > 0.001) {
      this.tempo = newTempo;
      this.soundtouch?.setTempo(this.tempo);
    }
  }
  
  setPitch(value) {
    const newPitch = this.clamp(value, -24, 24);
    if (Math.abs(newPitch - this.pitch) > 0.001) {
      this.pitch = newPitch;
      this.soundtouch?.setPitchSemitones(this.pitch);
    }
  }
  
  setRate(value) {
    const newRate = this.clamp(value, 0.1, 4.0);
    if (Math.abs(newRate - this.rate) > 0.001) {
      this.rate = newRate;
      this.soundtouch?.setRate(this.rate);
    }
  }
  
  // --- Buffer Management ---
  
  clearBuffers() {
    this.lastReportedPosition = this.audioDataPosition;
    this.soundtouch?.clear();
    // Reset receiveBuffer tracking
    this.receiveBufferAvailableFrames = 0;
    this.receiveBufferReadOffset = 0;
  }
  
  fillInputBuffer(chunkSize, startPosition) {
    const { channels, audioData, inputBuffer } = this;
    
    const endPosition = Math.min(startPosition + chunkSize, this.audioDataLength);
    const actualChunkSize = endPosition - startPosition;
    
    if (actualChunkSize <= 0) return 0;
    
    if (channels === 2) {
      const left = audioData[0];
      const right = audioData[1] || left;
      
      for (let i = 0; i < actualChunkSize; i++) {
        const pos = startPosition + i;
        inputBuffer[i * 2] = left[pos] || 0;
        inputBuffer[i * 2 + 1] = right[pos] || 0;
      }
    } else if (channels === 1) {
      const mono = audioData[0];
      for (let i = 0; i < actualChunkSize; i++) {
        inputBuffer[i] = mono[startPosition + i] || 0;
      }
    } else {
      for (let i = 0; i < actualChunkSize; i++) {
        const pos = startPosition + i;
        for (let ch = 0; ch < channels; ch++) {
          inputBuffer[i * channels + ch] = audioData[ch]?.[pos] || 0;
        }
      }
    }
    
    return actualChunkSize;
  }
  
  // --- Utilities ---
  
  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  
  reportError(message) {
    const now = Date.now();
    if (now - this.lastErrorTime > this.errorThrottleMs) {
      this.port.postMessage({ type: 'error', message, time: now });
      this.lastErrorTime = now;
    }
  }
  
  outputSilence(output) {
    for (const channel of output) {
      if (channel) channel.fill(0);
    }
  }
  
  handleLoop() {
    if (!this.loop) return false;
    
    const loopLength = this.loopEnd - this.loopStart;
    if (loopLength <= 0) return false;
    
    const overshoot = this.audioDataPosition - this.loopEnd;
    this.audioDataPosition = this.loopStart + (overshoot % loopLength);
    
    this.soundtouch?.clear();
    
    this.port.postMessage({
      type: 'loop',
      position: this.audioDataPosition,
      playbackTime: this.playbackTime
    });
    
    return true;
  }
  
  endPlayback() {
    this.playing = false;
    this.clearBuffers();
    this.port.postMessage({ type: 'ended', totalTime: this.playbackTime });
  }
  
  sendStats() {
    this.port.postMessage({
      type: 'stats',
      playing: this.playing,
      paused: this.paused
    });
  }
  
  dispose() {
    this.disposed = true;
    this.playing = false;
    this.paused = false;
    this.audioData = null;
    this.inputBuffer = null;
    this.receiveBuffer = null;
    this.outputBuffer = null;
    
    if (this.soundtouch) {
      try { this.soundtouch.clear(); } catch (e) {}
      this.soundtouch = null;
    }

    this.port.postMessage({ type: 'disposed' });
    this.port.onmessage = null;
  }
  
  // --- Main Processing ---

  process(inputs, outputs, parameters) {
    if (this.disposed) return false;

    const output = outputs[0];
    if (!output?.[0]) return true;

    const samplesCount = output[0].length;

    // Process AudioParam automation
    // k-rate parameters have length 1 (one value per render quantum)
    if (parameters && this.initialized && this.soundtouch) {
      const tempoParam = parameters.tempo;
      const pitchParam = parameters.pitch;

      if (tempoParam && tempoParam.length > 0) {
        const currentTempo = tempoParam[0];
        // Update SoundTouch only if value changed (avoid unnecessary processing)
        if (Math.abs(currentTempo - this._lastAppliedTempo) > 0.001) {
          try {
            this.soundtouch.setTempo(currentTempo);
            this._lastAppliedTempo = currentTempo;
            // Also update instance variable for backward compatibility
            this.tempo = currentTempo;
          } catch (e) {
            // Silently ignore tempo setting errors to avoid console spam
          }
        }
      }

      if (pitchParam && pitchParam.length > 0) {
        const currentPitch = pitchParam[0];
        // Update SoundTouch only if value changed
        if (Math.abs(currentPitch - this._lastAppliedPitch) > 0.1) {
          try {
            this.soundtouch.setPitchSemitones(currentPitch);
            this._lastAppliedPitch = currentPitch;
            // Also update instance variable for backward compatibility
            this.pitch = currentPitch;
          } catch (e) {
            // Silently ignore pitch setting errors
          }
        }
      }
    }

    if (!this.initialized || !this.soundtouch || !this.playing || !this.audioData || this.paused) {
      this.outputSilence(output);
      return true;
    }

    try {
      // feedSoundTouch will keep trying until it gets enough data or audio ends
      const receivedFrames = this.feedSoundTouch(samplesCount);

      // Handle end of audio
      if (this.audioDataPosition >= this.loopEnd) {
        if (this.loop) {
          // In loop mode, handle the loop
          if (!this.handleLoop()) {
            this.endPlayback();
          }
        } else {
          // In non-loop mode, if we got no data, end playback
          if (receivedFrames <= 0) {
            this.endPlayback();
          }
        }
      }

      const positionDelta = Math.abs(this.audioDataPosition - this.lastReportedPosition);
      if (positionDelta >= PROGRESS_REPORT_INTERVAL) {
        this.port.postMessage({
          type: 'progress',
          position: this.audioDataPosition,
          playbackTime: this.playbackTime
        });
        this.lastReportedPosition = this.audioDataPosition;
      }

      this.outputAudio(output, samplesCount, receivedFrames);
    } catch (err) {
      console.error('Processing error:', err);
      this.outputSilence(output);
      this.reportError('Process error: ' + err.message);
    }
    
    return true;
  }
  
  feedSoundTouch(samplesCount) {
    const { channels } = this;
    let totalProduced = 0;
    
    // Loop until accumulated output data is sufficient for samplesCount
    let loopCount = 0;
    const maxLoops = 100; // Maximum loop count to prevent infinite loops
    
    while (totalProduced < samplesCount && loopCount < maxLoops) {
      loopCount++;
      
      // Calculate how many frames are still needed
      const neededFrames = samplesCount - totalProduced;

      // First try to get data from receiveBuffer (if there's unused data from previous calls)
      if (this.receiveBufferAvailableFrames > 0) {
        const framesToUse = Math.min(neededFrames, this.receiveBufferAvailableFrames);
        const samplesToUse = framesToUse * channels;
        const readOffset = this.receiveBufferReadOffset;
        const writeOffset = totalProduced * channels;
        
        // Copy directly from receiveBuffer to outputBuffer (both are interleaved format)
        this.outputBuffer.set(
          this.receiveBuffer.subarray(readOffset, readOffset + samplesToUse),
          writeOffset
        );
        totalProduced += framesToUse;
        this.playbackTime += framesToUse / this.sampleRate;
        
        this.receiveBufferReadOffset += samplesToUse;
        this.receiveBufferAvailableFrames -= framesToUse;
        if (this.receiveBufferAvailableFrames === 0) {
          this.receiveBufferReadOffset = 0;
        }
        if (totalProduced >= samplesCount) {
          break;
        }
      }
      
      // If receiveBuffer has no data or not enough, need to feed data first, then get data
      if (totalProduced < samplesCount) {
        const availableFrames = this.loopEnd - this.audioDataPosition;
        if (availableFrames <= 0) {
          // No more source data available, try to flush SoundTouch to get remaining data
          this.soundtouch.flush();
          const flushReceived = this.soundtouch.receiveSamples(this.receiveBuffer);
          if (flushReceived > 0) {
            this.receiveBufferAvailableFrames = flushReceived;
            this.receiveBufferReadOffset = 0;
            continue;
          }
          break;
        }
        
        // Feed data to SoundTouch first
        // Calculate the number of frames to read this time
        const readSize = Math.max(128, Math.ceil(samplesCount * (this.tempo || 1)));
        const framesToRead = Math.min(readSize, availableFrames, MAX_CHUNK_SIZE);
        const actualChunkSize = this.fillInputBuffer(framesToRead, this.audioDataPosition);
        if (actualChunkSize <= 0) break;
        this.soundtouch.putSamples(this.inputBuffer.subarray(0, actualChunkSize * channels));
        this.audioDataPosition += actualChunkSize;
        
        // Then get data from SoundTouch (will get all available data)
        const received = this.soundtouch.receiveSamples(this.receiveBuffer);        
        if (received > 0) {
          this.receiveBufferAvailableFrames = received;
          this.receiveBufferReadOffset = 0;
          // Continue loop, next iteration will get data from receiveBuffer
          continue;
        }
      }
    }
    return totalProduced;
  }
  
  outputAudio(output, samplesCount, receivedFrames) {
    if (receivedFrames >= samplesCount) {
      // We have enough data, output directly from outputBuffer
      this.outputAudioDirect(output, samplesCount);
    } else {
      // Not enough data (should rarely happen, only when audio ends)
      // Output what we have and fill the rest with silence
      if (receivedFrames > 0) {
        this.outputAudioDirect(output, receivedFrames);
        for (const channel of output) {
          if (channel) channel.fill(0, receivedFrames);
        }
      } else {
        // No data available, output silence
        this.outputSilence(output);
      }
    }
  }
  
  outputAudioDirect(output, samplesCount) {
    const { channels, outputBuffer } = this;
    
    if (channels === 2 && output.length >= 2) {
      const left = output[0];
      const right = output[1];
      
      for (let i = 0; i < samplesCount; i++) {
        left[i] = outputBuffer[i * 2];
        right[i] = outputBuffer[i * 2 + 1];
      }
    } else if (channels === 1) {
      const mono = output[0];
      for (let i = 0; i < samplesCount; i++) {
        mono[i] = outputBuffer[i];
      }
    } else {
      for (let i = 0; i < samplesCount; i++) {
        for (let ch = 0; ch < channels && ch < output.length; ch++) {
          if (output[ch]) {
            output[ch][i] = outputBuffer[i * channels + ch];
          }
        }
      }
    }
    
  }
}

registerProcessor('${workletName}', SoundTouchTimeStretchProcessor);
`;
