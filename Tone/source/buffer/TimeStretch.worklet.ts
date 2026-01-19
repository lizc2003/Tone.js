/**
 * SoundTouch AudioWorklet Processor for TimeStretchPlayer
 * Handles real-time time-stretching and pitch-shifting using SoundTouch WASM.
 */

export const workletName = "soundtouch-timestretch-processor";

export const timeStretchWorkletCode = /* javascript */ `
let wasmInitialized = false;
let SoundTouchWasm = null;

// Constants
const RING_BUFFER_SIZE = 16384;
const PROGRESS_REPORT_INTERVAL = 4096;
const MAX_CHUNK_SIZE = 4096;
const MAX_ITERATIONS = 10;
const MAX_FLUSH_ITERATIONS = 3;

class SoundTouchTimeStretchProcessor extends AudioWorkletProcessor {
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
    
    // Ring buffer (power of 2 for efficient masking)
    this.initRingBuffer();
    
    // Working buffers
    this.inputBuffer = new Float32Array(MAX_CHUNK_SIZE * this.channels);
    this.receiveBuffer = new Float32Array(MAX_CHUNK_SIZE * this.channels * 2);
    
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

  initRingBuffer() {
    const requiredSize = RING_BUFFER_SIZE * this.channels;
    let size = 1;
    while (size < requiredSize) size <<= 1;
    
    this.ringBufferSize = size;
    this.ringBufferMask = size - 1;
    this.ringBuffer = new Float32Array(size);
    this.ringReadPtr = 0;
    this.ringWritePtr = 0;
    this.ringAvailable = 0;
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
    if (this.ringBuffer) {
      this.ringBuffer.fill(0);
    }
    this.ringReadPtr = 0;
    this.ringWritePtr = 0;
    this.ringAvailable = 0;
    this.lastReportedPosition = this.audioDataPosition;
    this.soundtouch?.clear();
  }
  
  writeToRingBuffer(samples, samplesCount) {
    const totalSamples = samplesCount * this.channels;
    
    if (this.ringAvailable + totalSamples > this.ringBufferSize) {
      return false;
    }
    
    const writePtr = this.ringWritePtr;
    
    if (writePtr + totalSamples <= this.ringBufferSize) {
      this.ringBuffer.set(samples.subarray(0, totalSamples), writePtr);
      this.ringWritePtr = (writePtr + totalSamples) & this.ringBufferMask;
    } else {
      const firstPart = this.ringBufferSize - writePtr;
      const secondPart = totalSamples - firstPart;
      
      this.ringBuffer.set(samples.subarray(0, firstPart), writePtr);
      this.ringBuffer.set(samples.subarray(firstPart, totalSamples), 0);
      this.ringWritePtr = secondPart;
    }
    
    this.ringAvailable += totalSamples;
    return true;
  }
  
  readFromRingBuffer(output, samplesCount) {
    const { channels, ringBuffer, ringBufferMask } = this;
    let ptr = this.ringReadPtr;
    
    if (channels === 2 && output.length >= 2) {
      const left = output[0];
      const right = output[1];
      
      for (let i = 0; i < samplesCount; i++) {
        left[i] = ringBuffer[ptr];
        right[i] = ringBuffer[ptr + 1];
        ptr = (ptr + 2) & ringBufferMask;
      }
    } else {
      for (let i = 0; i < samplesCount; i++) {
        for (let ch = 0; ch < channels && ch < output.length; ch++) {
          if (output[ch]) {
            output[ch][i] = ringBuffer[ptr + ch];
          }
        }
        ptr = (ptr + channels) & ringBufferMask;
      }
    }
    
    this.ringReadPtr = ptr;
    this.ringAvailable -= samplesCount * channels;
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
  
  clampOutput(output, samplesCount) {
    for (const channel of output) {
      if (!channel) continue;
      for (let i = 0; i < samplesCount; i++) {
        const val = channel[i];
        if (!Number.isFinite(val)) {
          channel[i] = 0;
        } else if (val < -1.0) {
          channel[i] = -1.0;
        } else if (val > 1.0) {
          channel[i] = 1.0;
        }
      }
    }
  }
  
  handleLoop() {
    if (!this.loop) return false;
    
    const loopLength = this.loopEnd - this.loopStart;
    if (loopLength <= 0) return false;
    
    const overshoot = this.audioDataPosition - this.loopEnd;
    this.audioDataPosition = this.loopStart + (overshoot % loopLength);
    
    this.soundtouch?.clear();
    this.ringReadPtr = 0;
    this.ringWritePtr = 0;
    this.ringAvailable = 0;
    
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
      ringBufferUsage: (this.ringAvailable / this.ringBufferSize * 100).toFixed(1),
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
    this.ringBuffer = null;
    
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
      this.feedSoundTouch(samplesCount);

      if (this.audioDataPosition >= this.loopEnd) {
        this.handleEndOfAudio(samplesCount);
      }

      const positionDelta = Math.abs(this.audioDataPosition - this.lastReportedPosition);
      if (positionDelta >= PROGRESS_REPORT_INTERVAL) {
        this.port.postMessage({
          type: 'progress',
          position: this.audioDataPosition,
          playbackTime: this.playbackTime,
          bufferLevel: this.ringAvailable / this.ringBufferSize
        });
        this.lastReportedPosition = this.audioDataPosition;
      }

      this.outputAudio(output, samplesCount);
    } catch (err) {
      console.error('Processing error:', err);
      this.outputSilence(output);
      this.reportError('Process error: ' + err.message);
    }
    
    return true;
  }
  
  feedSoundTouch(samplesCount) {
    const neededSamples = samplesCount * this.channels;
    let iterations = 0;
    
    while (this.ringAvailable < neededSamples && 
           this.audioDataPosition < this.loopEnd &&
           iterations++ < MAX_ITERATIONS) {
      
      const chunkSize = Math.min(MAX_CHUNK_SIZE, this.loopEnd - this.audioDataPosition);
      if (chunkSize <= 0) break;
      
      const actualChunkSize = this.fillInputBuffer(chunkSize, this.audioDataPosition);
      if (actualChunkSize <= 0) break;
      
      this.soundtouch.putSamples(this.inputBuffer.subarray(0, actualChunkSize * this.channels));
      this.audioDataPosition += actualChunkSize;
      
      const received = this.soundtouch.receiveSamples(this.receiveBuffer);
      if (received > 0) {
        if (!this.writeToRingBuffer(this.receiveBuffer, received)) break;
        this.playbackTime += received / this.sampleRate;
      }
    }
  }
  
  handleEndOfAudio(samplesCount) {
    if (this.loop) {
      // In loop mode, just handle the loop without flushing
      const neededSamples = samplesCount * this.channels;
      if (this.ringAvailable < neededSamples) {
        if (!this.handleLoop()) this.endPlayback();
      }
    } else {
      // In non-loop mode, flush SoundTouch to get all remaining samples
      this.soundtouch.flush();
      
      for (let i = 0; i < MAX_FLUSH_ITERATIONS; i++) {
        const received = this.soundtouch.receiveSamples(this.receiveBuffer);
        if (received <= 0) break;
        this.writeToRingBuffer(this.receiveBuffer, received);
        this.playbackTime += received / this.sampleRate;
      }
      
      if (this.ringAvailable <= 0) {
        this.endPlayback();
      }
    }
  }
  
  outputAudio(output, samplesCount) {
    const neededSamples = samplesCount * this.channels;
    
    if (this.ringAvailable >= neededSamples) {
      this.readFromRingBuffer(output, samplesCount);
      this.clampOutput(output, samplesCount);
    } else if (this.ringAvailable > 0) {
      const availableFrames = Math.floor(this.ringAvailable / this.channels);
      if (availableFrames > 0) {
        this.readFromRingBuffer(output, availableFrames);
        this.clampOutput(output, availableFrames);
      }
      for (const channel of output) {
        if (channel) channel.fill(0, availableFrames);
      }
    } else {
      this.outputSilence(output);
    }
  }
}

registerProcessor('${workletName}', SoundTouchTimeStretchProcessor);
`;
