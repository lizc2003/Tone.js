<template>
  <div class="app">
    <h1>TimeStretchPlayer Parameter Test</h1>
    
    <div class="container">
      <!-- Status Display -->
      <div class="status-section">
        <h2>Status</h2>
        <div class="status-info">
          <p>Player State: <span :class="playerState">{{ playerState }}</span></p>
          <p>Load State: <span :class="loadState">{{ loadState }}</span></p>
          <p v-if="duration > 0">Audio Duration: {{ duration.toFixed(2) }}s</p>
          <p v-if="currentTime >= 0">Current Progress: {{ currentTime.toFixed(2) }}s / {{ duration.toFixed(2) }}s</p>
          <div v-if="duration > 0" class="progress-bar">
            <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
          </div>
        </div>
      </div>

      <!-- Audio Source Control -->
      <div class="control-section">
        <h2>Audio File</h2>
        <div class="control-group">
          <label>Audio Source:</label>
          <select v-model="audioUrl" @change="loadAudio">
            <option value="/sample.mp3">Sample Audio (sample.mp3)</option>
            <option value="https://tonejs.github.io/audio/berklee/gong_1.mp3">Gong 1</option>
            <option value="https://tonejs.github.io/audio/berklee/malevoices_aa2_F3.mp3">Male Voices</option>
          </select>
          <button @click="loadAudio" :disabled="loading">Reload</button>
        </div>
      </div>

      <!-- Playback Control -->
      <div class="control-section">
        <h2>Playback Control</h2>
        <div class="control-group">
          <button @click="start" :disabled="!loaded || playerState === 'started'">Play</button>
          <button @click="stop" :disabled="playerState !== 'started'">Stop</button>
          <button @click="restart" :disabled="!loaded">Restart</button>
        </div>
        
        <div class="control-group">
          <label>
            <input type="checkbox" v-model="autostart" />
            Autostart
          </label>
        </div>
      </div>

      <!-- Speed and Pitch Control -->
      <div class="control-section">
        <h2>Time Stretch & Pitch Shift</h2>
        
        <div class="control-group">
          <label>Tempo (Playback Speed): {{ tempo.toFixed(2) }}x</label>
          <input 
            type="range" 
            v-model.number="tempo" 
            min="0.25" 
            max="4" 
            step="0.05"
            @input="updateTempo"
          />
          <div class="range-labels">
            <span>0.25x (Slow)</span>
            <span>1x (Normal)</span>
            <span>4x (Fast)</span>
          </div>
        </div>

        <div class="control-group">
          <label>Pitch (Pitch Shift): {{ pitch }} semitones</label>
          <input 
            type="range" 
            v-model.number="pitch" 
            min="-12" 
            max="12" 
            step="1"
            @input="updatePitch"
          />
          <div class="range-labels">
            <span>-12 (Octave Down)</span>
            <span>0 (Original)</span>
            <span>+12 (Octave Up)</span>
          </div>
        </div>
      </div>

      <!-- Loop Control -->
      <div class="control-section">
        <h2>Loop Control</h2>
        
        <div class="control-group">
          <label>
            <input type="checkbox" v-model="loop" @change="updateLoop" />
            Enable Loop
          </label>
        </div>

        <div class="control-group" v-if="loop">
          <label>Loop Start: {{ loopStart.toFixed(2) }}s</label>
          <input 
            type="range" 
            v-model.number="loopStart" 
            min="0" 
            :max="duration || 10" 
            step="0.1"
            @input="updateLoopPoints"
          />
        </div>

        <div class="control-group" v-if="loop">
          <label>Loop End: {{ loopEnd === 0 ? '(End)' : loopEnd.toFixed(2) + 's' }}</label>
          <input 
            type="range" 
            v-model.number="loopEnd" 
            min="0" 
            :max="duration || 10" 
            step="0.1"
            @input="updateLoopPoints"
          />
          <small>0 means end of audio</small>
        </div>

        <div class="control-group" v-if="loop">
          <button @click="setQuickLoop">Quick Loop (0.5s - 2s)</button>
        </div>
      </div>

      <!-- Fade In/Out Control -->
      <div class="control-section">
        <h2>Fade In/Out</h2>
        
        <div class="control-group">
          <label>Fade In: {{ fadeIn.toFixed(2) }}s</label>
          <input 
            type="range" 
            v-model.number="fadeIn" 
            min="0" 
            max="5" 
            step="0.1"
            @input="updateFade"
          />
        </div>

        <div class="control-group">
          <label>Fade Out: {{ fadeOut.toFixed(2) }}s</label>
          <input 
            type="range" 
            v-model.number="fadeOut" 
            min="0" 
            max="5" 
            step="0.1"
            @input="updateFade"
          />
        </div>
      </div>

      <!-- Other Options -->
      <div class="control-section">
        <h2>Other Options</h2>
        
        <div class="control-group">
          <label>
            <input type="checkbox" v-model="reverse" @change="updateReverse" />
            Reverse Playback
          </label>
        </div>

        <div class="control-group" v-if="playerState === 'started'">
          <label>Seek Position: {{ seekPosition.toFixed(2) }}s</label>
          <input 
            type="range" 
            v-model.number="seekPosition" 
            min="0" 
            :max="duration || 10" 
            step="0.1"
          />
          <button @click="seekTo">Seek</button>
        </div>
      </div>

      <!-- Quick Test Scenarios -->
      <div class="control-section">
        <h2>Quick Test Scenarios</h2>
        <div class="control-group">
          <button @click="testSlowMotion">Slow Motion (0.5x speed, normal pitch)</button>
          <button @click="testFastForward">Fast Forward (2x speed, normal pitch)</button>
          <button @click="testHighPitch">High Pitch (+5 semitones, normal speed)</button>
          <button @click="testLowPitch">Low Pitch (-5 semitones, normal speed)</button>
          <button @click="testChipmunk">Chipmunk Effect (1.5x speed, +7 semitones)</button>
          <button @click="resetAll">Reset All Parameters</button>
        </div>
      </div>

      <!-- Error Messages -->
      <div v-if="error" class="error-section">
        <h3>Error</h3>
        <p>{{ error }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import * as Tone from 'tone';
import wasmUrl from 'soundtouch/soundtouch_bg.wasm?url'
import soundtouchCode from 'soundtouch/soundtouch_worklet.js?raw'

// State variables
const playerState = ref('stopped');
const loadState = ref('Not loaded');
const loaded = ref(false);
const loading = ref(false);
const error = ref('');
const duration = ref(0);
const currentTime = ref(0);
const progressPercent = computed(() => {
  if (duration.value === 0) return 0;
  return (currentTime.value / duration.value) * 100;
});

// Audio source
const audioUrl = ref('/sample.mp3');

// Player parameters
const tempo = ref(1);
const pitch = ref(0);
const loop = ref(false);
const loopStart = ref(0);
const loopEnd = ref(0);
const reverse = ref(false);
const fadeIn = ref(0);
const fadeOut = ref(0);
const autostart = ref(false);
const seekPosition = ref(0);

// Tone.js player instance
let player = null;
let progressInterval = null;

// Load WASM and SoundTouch code
let wasmBytes = null;

onMounted(async () => {
  try {
    loadState.value = 'Loading SoundTouch WASM module...'
    const response = await fetch(wasmUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch SoundTouch WASM: ${response.status}`)
    }
    wasmBytes = await response.arrayBuffer()
    loadState.value = 'SoundTouch WASM module loaded!'

    // Create player
    await createPlayer();
  } catch (err) {
    error.value = `Initialization failed: ${err.message}`;
    loadState.value = 'Initialization failed';
    console.error(err);
  }
});

onUnmounted(() => {
  if (progressInterval) {
    clearInterval(progressInterval);
  }
  if (player) {
    player.dispose();
  }
});

// Create player
async function createPlayer() {
  try {
    if (player) {
      player.dispose();
    }

    loading.value = true;
    loadState.value = 'Loading audio...';
    
    player = new Tone.TimeStretchPlayer({
      url: audioUrl.value,
      tempo: tempo.value,
      pitch: pitch.value,
      loop: loop.value,
      loopStart: loopStart.value,
      loopEnd: loopEnd.value,
      reverse: reverse.value,
      fadeIn: fadeIn.value,
      fadeOut: fadeOut.value,
      autostart: autostart.value,
      fadeCurve: "exponential",
      useQuickSeek: true,   // Fast but low-quality time stretching
      useAaFilter: false,   // Enable anti-aliasing filter for higher quality pitch shifting
      wasmBytes: wasmBytes,
      soundtouchCode: soundtouchCode,
      onload: () => {
        loaded.value = true;
        loading.value = false;
        loadState.value = 'Loaded';
        duration.value = player.buffer.duration;
        if (loopEnd.value === 0) {
          loopEnd.value = duration.value;
        }
        error.value = '';
      },
      onerror: (err) => {
        error.value = `Loading error: ${err.message}`;
        loadState.value = 'Load failed';
        loading.value = false;
        console.error(err);
      }
    }).toDestination();

    // Listen to player state
    player.onstop = () => {
      playerState.value = 'stopped';
      if (progressInterval) {
        clearInterval(progressInterval);
      }
    };

  } catch (err) {
    error.value = `Player creation failed: ${err.message}`;
    loading.value = false;
    console.error(err);
  }
}

// Load audio
async function loadAudio() {
  // If autostart is enabled, start AudioContext first (must be in user action context)
  if (autostart.value) {
    await Tone.start();
  }
  await createPlayer();
}

// Playback control
async function start() {
  if (!player || !loaded.value) return;
  
  try {
    await Tone.start();
    player.start();
    playerState.value = 'started';
    
    // Start updating progress
    if (progressInterval) {
      clearInterval(progressInterval);
    }
    progressInterval = setInterval(() => {
      if (player && playerState.value === 'started') {
        currentTime.value = player.progress;
      }
    }, 100);
  } catch (err) {
    error.value = `Playback failed: ${err.message}`;
    console.error(err);
  }
}

function stop() {
  if (!player) return;
  player.stop();
  playerState.value = 'stopped';
  if (progressInterval) {
    clearInterval(progressInterval);
  }
}

function restart() {
  if (!player || !loaded.value) return;
  
  try {
    // stop first, then start from the beginning
    player.stop();
    player.start();
    playerState.value = 'started';
    currentTime.value = 0;
    
    // Start updating progress
    if (progressInterval) {
      clearInterval(progressInterval);
    }
    progressInterval = setInterval(() => {
      if (player && playerState.value === 'started') {
        currentTime.value = player.progress;
      }
    }, 100);
  } catch (err) {
    error.value = `Restart failed: ${err.message}`;
    console.error(err);
  }
}

// Parameter updates
function updateTempo() {
  if (player) {
    player.tempo = tempo.value;
  }
}

function updatePitch() {
  if (player) {
    player.pitch = pitch.value;
  }
}

function updateLoop() {
  if (player) {
    player.loop = loop.value;
  }
}

function updateLoopPoints() {
  if (player) {
    player.setLoopPoints(loopStart.value, loopEnd.value);
  }
}

function updateFade() {
  if (player) {
    player.fadeIn = fadeIn.value;
    player.fadeOut = fadeOut.value;
  }
}

function updateReverse() {
  if (player) {
    player.reverse = reverse.value;
  }
}

function seekTo() {
  if (player && playerState.value === 'started') {
    player.seek(seekPosition.value);
  }
}

function setQuickLoop() {
  loopStart.value = 0.5;
  loopEnd.value = 2;
  updateLoopPoints();
}

// Quick test scenarios
function testSlowMotion() {
  tempo.value = 0.5;
  pitch.value = 0;
  updateTempo();
  updatePitch();
}

function testFastForward() {
  tempo.value = 2;
  pitch.value = 0;
  updateTempo();
  updatePitch();
}

function testHighPitch() {
  tempo.value = 1;
  pitch.value = 5;
  updateTempo();
  updatePitch();
}

function testLowPitch() {
  tempo.value = 1;
  pitch.value = -5;
  updateTempo();
  updatePitch();
}

function testChipmunk() {
  tempo.value = 1.5;
  pitch.value = 7;
  updateTempo();
  updatePitch();
}

function resetAll() {
  tempo.value = 1;
  pitch.value = 0;
  loop.value = false;
  loopStart.value = 0;
  loopEnd.value = duration.value || 0;
  reverse.value = false;
  fadeIn.value = 0;
  fadeOut.value = 0;
  
  if (player) {
    updateTempo();
    updatePitch();
    updateLoop();
    updateFade();
    updateReverse();
  }
}
</script>

<style scoped>
.app {
  min-height: 100vh;
  padding: 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

h1 {
  text-align: center;
  color: white;
  margin-bottom: 30px;
  font-size: 2.5em;
  text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
}

.container {
  max-width: 900px;
  margin: 0 auto;
}

.status-section {
  background: white;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

.status-info p {
  margin: 10px 0;
  font-size: 1.1em;
}

.status-info span {
  font-weight: bold;
  padding: 4px 12px;
  border-radius: 4px;
}

.started {
  background: #48bb78;
  color: white;
}

.stopped {
  background: #cbd5e0;
  color: #2d3748;
}

.Loaded {
  background: #48bb78;
  color: white;
}

.Not.loaded, .Load.failed, .Initialization.failed {
  background: #fc8181;
  color: white;
}

.progress-bar {
  width: 100%;
  height: 8px;
  background: #e2e8f0;
  border-radius: 4px;
  overflow: hidden;
  margin-top: 10px;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #667eea, #764ba2);
  transition: width 0.1s linear;
}

.control-section {
  background: white;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

.control-section h2 {
  margin-top: 0;
  margin-bottom: 15px;
  color: #2d3748;
  border-bottom: 2px solid #667eea;
  padding-bottom: 8px;
}

.control-group {
  margin-bottom: 20px;
}

.control-group label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  color: #4a5568;
}

.control-group input[type="range"] {
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: #e2e8f0;
  outline: none;
  -webkit-appearance: none;
}

.control-group input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #667eea;
  cursor: pointer;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

.control-group input[type="range"]::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #667eea;
  cursor: pointer;
  border: none;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

.range-labels {
  display: flex;
  justify-content: space-between;
  font-size: 0.85em;
  color: #718096;
  margin-top: 4px;
}

.control-group select {
  padding: 8px 12px;
  border: 2px solid #e2e8f0;
  border-radius: 6px;
  font-size: 1em;
  margin-right: 10px;
  min-width: 200px;
}

button {
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1em;
  font-weight: 600;
  margin-right: 10px;
  margin-bottom: 10px;
  transition: transform 0.2s, box-shadow 0.2s;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0,0,0,0.3);
}

button:active:not(:disabled) {
  transform: translateY(0);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.control-group input[type="checkbox"] {
  width: 18px;
  height: 18px;
  margin-right: 8px;
  vertical-align: middle;
  cursor: pointer;
}

.control-group small {
  display: block;
  margin-top: 4px;
  color: #718096;
  font-size: 0.9em;
}

.error-section {
  background: #fc8181;
  color: white;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

.error-section h3 {
  margin-top: 0;
}
</style>
