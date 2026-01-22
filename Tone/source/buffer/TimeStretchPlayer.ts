import { Gain } from "../../core/context/Gain.js";
import { ToneAudioBuffer } from "../../core/context/ToneAudioBuffer.js";
import { connect } from "../../core/context/ToneAudioNode.js";
import { Cents, Positive, Seconds, Time } from "../../core/type/Units.js";
import { assertRange, assert } from "../../core/util/Debug.js";
import { timeRange } from "../../core/util/Decorator.js";
import { defaultArg, optionsFromArguments } from "../../core/util/Defaults.js";
import { noOp } from "../../core/util/Interface.js";
import { Source, SourceOptions } from "../Source.js";
import { workletName, timeStretchWorkletCode } from "./TimeStretch.worklet.js";

/**
 * The curve applied to fade in/out, either "linear" or "exponential"
 */
export type FadeCurve = "linear" | "exponential";

export interface TimeStretchPlayerOptions extends SourceOptions {
	onload: () => void;
	onerror: (error: Error) => void;
	url?: ToneAudioBuffer | string | AudioBuffer;
	tempo: Positive;
	pitch: Cents;
	/**
	 * The playback rate. 1 = normal speed, 2 = double speed (and pitch), 0.5 = half speed (and pitch).
	 * Unlike tempo, this affects both speed AND pitch together, similar to a tape speed change.
	 */
	playbackRate: Positive;
	loop: boolean;
	loopStart: Time;
	loopEnd: Time;
	reverse: boolean;
	fadeIn: Time;
	fadeOut: Time;
	/** The curve applied to fade in/out, either "linear" or "exponential" */
	fadeCurve: FadeCurve;
	autostart: boolean;
	/** SoundTouch WASM file content */
	wasmBytes?: ArrayBuffer;
	/** The raw SoundTouch worklet JS code string */
	soundtouchCode?: string;
	/** Use quick seek mode for faster but lower quality time stretching */
	useQuickSeek: boolean;
	/** Use anti-alias filter for higher quality pitch shifting */
	useAaFilter: boolean;
}

/**
 * TimeStretchPlayer is an audio player with independent time-stretching and pitch-shifting
 * capabilities using the SoundTouch library via AudioWorklet.
 *
 * Unlike the regular Player, TimeStretchPlayer allows you to change the playback speed
 * (tempo) without affecting the pitch, and vice versa.
 *
 * @example
 * // First, load the soundtouch dependencies
 * const wasmResponse = await fetch('soundtouch/soundtouch_bg.wasm');
 * const wasmBytes = await wasmResponse.arrayBuffer();
 * const soundtouchCode = await (await fetch('soundtouch/soundtouch_worklet.js')).text();
 *
 * const player = new Tone.TimeStretchPlayer({
 *   url: "https://tonejs.github.io/audio/berklee/gong_1.mp3",
 *   wasmBytes: wasmBytes,
 *   soundtouchCode: soundtouchCode,
 *   onload: () => {
 *     player.start();
 *   }
 * }).toDestination();
 *
 * // Change tempo without affecting pitch
 * player.tempo = 1.5; // 50% faster
 *
 * // Change pitch without affecting tempo
 * player.pitch = 5; // 5 semitones up
 *
 * @category Source
 */
export class TimeStretchPlayer extends Source<TimeStretchPlayerOptions> {
	readonly name: string = "TimeStretchPlayer";

	/**
	 * Track which contexts have the worklet registered
	 */
	private static _workletRegisteredContexts = new WeakSet<BaseAudioContext>();

	/**
	 * Track ongoing initialization promises per context
	 */
	private static _workletInitPromises = new WeakMap<BaseAudioContext, Promise<void>>();

	/**
	 * If the file should play as soon as the buffer is loaded.
	 */
	autostart: boolean;

	/**
	 * The audio buffer
	 */
	private _buffer: ToneAudioBuffer;

	/**
	 * The tempo (playback speed without pitch change)
	 */
	private _tempo: Positive = 1;

	/**
	 * The pitch shift in semitones
	 */
	private _pitch: Cents = 0;

	/**
	 * The playback rate (affects both speed and pitch)
	 */
	private _playbackRate: Positive = 1;

	/**
	 * Whether to loop the audio
	 */
	private _loop: boolean = false;

	/**
	 * Loop start position in seconds
	 */
	private _loopStart: Time = 0;

	/**
	 * Loop end position in seconds
	 */
	private _loopEnd: Time = 0;

	/**
	 * The AudioWorkletNode for SoundTouch processing
	 */
	private _workletNode: AudioWorkletNode | null = null;

	/**
	 * WASM bytes for SoundTouch
	 */
	private _wasmBytes: ArrayBuffer | null = null;

	/**
	 * SoundTouch worklet code
	 */
	private _soundtouchCode: string = "";

	/**
	 * Use quick seek mode for faster but lower quality time stretching
	 */
	private _useQuickSeek: boolean = true;

	/**
	 * Use anti-alias filter for higher quality pitch shifting
	 */
	private _useAaFilter: boolean = false;

	/**
	 * SharedArrayBuffer for zero-copy audio data sharing with worklet
	 */
	private _sharedBuffer: SharedArrayBuffer | null = null;

	/**
	 * Number of channels when using SharedArrayBuffer
	 */
	private _sharedBufferChannels: number = 0;

	/**
	 * Sample rate when using SharedArrayBuffer
	 */
	private _sharedBufferSampleRate: number = 0;

	/**
	 * Current playback position in samples
	 */
	private _currentPosition: number = 0;

	/**
	 * The GainNode for fade in/out envelope
	 */
	private _fadeGainNode: Gain;

	/**
	 * The timeout id for stopping after fadeOut
	 */
	private _stopTimeoutId: number = -1;

	/**
	 * Whether the buffer is loaded
	 */
	private _loaded: boolean = false;

	/**
	 * The fadeIn time of the amplitude envelope.
	 */
	@timeRange(0)
	fadeIn: Time;

	/**
	 * The fadeOut time of the amplitude envelope.
	 */
	@timeRange(0)
	fadeOut: Time;

	/**
	 * The curve applied to fade in/out
	 */
	private _fadeCurve: FadeCurve;

	/**
	 * The curve applied to the fades, either "linear" or "exponential".
	 * Linear fades change at a constant rate, while exponential fades
	 * change more gradually at first and then more rapidly.
	 */
	get fadeCurve(): FadeCurve {
		return this._fadeCurve;
	}

	set fadeCurve(curve: FadeCurve) {
		this._fadeCurve = curve;
	}

	/**
	 * @param url Either the AudioBuffer or the url from which to load the AudioBuffer
	 * @param onload The function to invoke when the buffer is loaded.
	 */
	constructor(
		url?: string | AudioBuffer | ToneAudioBuffer,
		onload?: () => void
	);
	constructor(options?: Partial<TimeStretchPlayerOptions>);
	constructor() {
		const options = optionsFromArguments(
			TimeStretchPlayer.getDefaults(),
			arguments,
			["url", "onload"]
		);
		super(options);

		this._buffer = new ToneAudioBuffer({
			onload: this._onBufferLoad.bind(this, options.onload),
			onerror: options.onerror,
			reverse: options.reverse,
			url: options.url,
		});

		// Create fade gain node and connect to output
		this._fadeGainNode = new Gain({
			context: this.context,
			gain: 0,
		});
		connect(this._fadeGainNode, this.output);

		this.autostart = options.autostart;
		this._tempo = options.tempo;
		this._pitch = options.pitch;
		this._playbackRate = options.playbackRate;
		this._loop = options.loop;
		this._loopStart = options.loopStart;
		this._loopEnd = options.loopEnd;
		this.fadeIn = options.fadeIn;
		this.fadeOut = options.fadeOut;
		this._fadeCurve = options.fadeCurve;

		// SoundTouch options
		if (options.wasmBytes) {
			this._wasmBytes = options.wasmBytes;
		}
		if (options.soundtouchCode) {
			this._soundtouchCode = options.soundtouchCode;
		}
		this._useQuickSeek = options.useQuickSeek;
		this._useAaFilter = options.useAaFilter;
	}

	static getDefaults(): TimeStretchPlayerOptions {
		return Object.assign(Source.getDefaults(), {
			autostart: false,
			fadeIn: 0,
			fadeOut: 0,
			fadeCurve: "linear" as FadeCurve,
			loop: false,
			loopEnd: 0,
			loopStart: 0,
			onload: noOp,
			onerror: noOp,
			reverse: false,
			pitch: 0 as Cents,
			tempo: 1 as Positive,
			playbackRate: 1 as Positive,
			useQuickSeek: true,
			useAaFilter: false,
		});
	}

	/**
	 * Initialize the AudioWorklet
	 */
	private async _initWorklet(): Promise<void> {
		const rawContext = this.context.rawContext;
		
		// Check if worklet is already registered for this context
		if (TimeStretchPlayer._workletRegisteredContexts.has(rawContext)) {
			return Promise.resolve();
		}
		
		// Check if there's already an ongoing initialization for this context
		const existingPromise = TimeStretchPlayer._workletInitPromises.get(rawContext);
		if (existingPromise) {
			await existingPromise;
			return Promise.resolve();
		}

		const initPromise = (async () => {
			assert(
				this._wasmBytes !== null,
				"SoundTouch WASM bytes not loaded."
			);
			assert(
				this._soundtouchCode !== "",
				"SoundTouch code not loaded."
			);

			// Create worklet code blob
			const workletCode = timeStretchWorkletCode;
			const blob = new Blob([workletCode], { type: "text/javascript" });
			const workletUrl = URL.createObjectURL(blob);

			try {
				// Use Tone's context addAudioWorkletModule method
				await this.context.addAudioWorkletModule(workletUrl);
				TimeStretchPlayer._workletRegisteredContexts.add(rawContext);
			} finally {
				URL.revokeObjectURL(workletUrl);
				// Clean up the promise from the map
				TimeStretchPlayer._workletInitPromises.delete(rawContext);
			}
		})();
		
		TimeStretchPlayer._workletInitPromises.set(rawContext, initPromise);

		return initPromise;
	}

	/**
	 * Create the AudioWorkletNode
	 * @param channels The number of audio channels
	 */
	private _createWorkletNode(channels: number): void {
		// Use Tone's context createAudioWorkletNode method
		this._workletNode = this.context.createAudioWorkletNode(workletName, {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [channels],
			processorOptions: {
				sampleRate: this.context.sampleRate,
				tempo: this._tempo,
				pitch: this._pitch,
				rate: this._playbackRate,
				wasmBytes: this._wasmBytes,
				soundtouchCode: this._soundtouchCode,
				channels: channels,
				useQuickSeek: this._useQuickSeek,
				useAaFilter: this._useAaFilter,
			},
		});

		this._workletNode.port.onmessage = (event) => {
			const { type, position } = event.data;
			switch (type) {
				case "initialized":
					// Worklet is ready
					break;
				case "progress":
					this._currentPosition = position;
					break;
				case "ended":
					this._onEnded();
					break;
				case "loop":
					// Audio looped
					break;
				case "error":
					console.error("TimeStretchPlayer worklet error:", event.data.message);
					break;
				case "log":
					console.log("TimeStretchPlayer worklet warning:", event.data.message);
					break;
			}
		};

		// Connect AudioWorkletNode to fade gain node (which is connected to output)
		connect(this._workletNode, this._fadeGainNode);

		// Set initial values for AudioParams to match constructor values
		// This overrides the defaultValue from parameterDescriptors
		const tempoParam = this._workletNode.parameters.get('tempo');
		const pitchParam = this._workletNode.parameters.get('pitch');
		if (tempoParam) {
			tempoParam.value = this._tempo;
		}
		if (pitchParam) {
			pitchParam.value = this._pitch;
		}
	}

	/**
	 * Called when audio ends
	 */
	private _onEnded(): void {
		if (!this._loop) {
			this._state.setStateAtTime("stopped", this.now());
			this.onstop(this);
		}
	}

	/**
	 * Internal callback when the buffer is loaded
	 */
	private _onBufferLoad(callback: () => void = noOp): void {
		// Initialize worklet when buffer is loaded
		this._initWorklet()
			.then(() => {
				this._loaded = true;
				callback();
				if (this.autostart) {
					this.start();
				}
			})
			.catch((err) => {
				console.error("TimeStretchPlayer: Failed to initialize worklet:", err);
			});
	}

	/**
	 * Load the audio file
	 * @param url The url of the buffer to load
	 */
	async load(url: string): Promise<this> {
		await this._buffer.load(url);
		await this._initWorklet();
		return this;
	}

	/**
	 * Load audio data from a SharedArrayBuffer with non-interleaved (planar) format.
	 * The SharedArrayBuffer is passed directly to the AudioWorklet without copying,
	 * enabling zero-copy audio data sharing between the main thread and worklet.
	 * 
	 * Each channel's samples are stored contiguously in the buffer.
	 * 
	 * @param sharedBuffer The SharedArrayBuffer containing audio data in planar format
	 * @param numberOfChannels The number of audio channels (e.g., 1 for mono, 2 for stereo)
	 * @param sampleRate Optional sample rate of the audio data. Defaults to the context's sample rate.
	 * @returns Promise that resolves to this player instance
	 * 
	 * @example
	 * // Create a SharedArrayBuffer with stereo audio data in planar format
	 * // Data layout: [L0, L1, L2, ..., Ln, R0, R1, R2, ..., Rn]
	 * const samplesPerChannel = 44100 * 10; // 10 seconds
	 * const sharedBuffer = new SharedArrayBuffer(samplesPerChannel * 2 * Float32Array.BYTES_PER_ELEMENT);
	 * const view = new Float32Array(sharedBuffer);
	 * // Fill left channel samples at view[0..samplesPerChannel-1]
	 * // Fill right channel samples at view[samplesPerChannel..2*samplesPerChannel-1]
	 * 
	 * const player = new Tone.TimeStretchPlayer({
	 *   wasmBytes: wasmBytes,
	 *   soundtouchCode: soundtouchCode,
	 * }).toDestination();
	 * 
	 * await player.loadSharedArrayBuffer(sharedBuffer, 2, 44100);
	 * player.start();
	 */
	async loadSharedArrayBuffer(
		sharedBuffer: SharedArrayBuffer,
		numberOfChannels: number,
		sampleRate?: number
	): Promise<this> {
		assert(
			sharedBuffer instanceof SharedArrayBuffer,
			"Expected a SharedArrayBuffer"
		);
		assert(
			numberOfChannels > 0,
			"numberOfChannels must be greater than 0"
		);

		// Store SharedArrayBuffer reference for zero-copy sharing with worklet
		this._sharedBuffer = sharedBuffer;
		this._sharedBufferChannels = numberOfChannels;
		this._sharedBufferSampleRate = sampleRate ?? this.context.sampleRate;

		// Initialize the worklet
		await this._initWorklet();
		this._loaded = true;

		return this;
	}

	/**
	 * Start playback
	 * @param time When to start
	 * @param offset The offset from the beginning of the sample
	 * @param duration How long to play
	 */
	start(time?: Time, offset?: Time, duration?: Time): this {
		super.start(time, offset, duration);
		return this;
	}

	/**
	 * Internal start method
	 */
	protected _start(
		startTime?: Time,
		offset?: Time,
		duration?: Time
	): void {
		// Clear any pending stop timeout to prevent it from stopping this new playback
		this.context.clearTimeout(this._stopTimeoutId);
		this._stopTimeoutId = -1;

		// Cancel all scheduled automation events and reset gain immediately
		// Use time 0 to ensure we cancel everything, including ongoing ramps
		this._fadeGainNode.gain.cancelScheduledValues(0);
		this._fadeGainNode.gain.setValueAtTime(1, this.context.currentTime);

		// Determine if using SharedArrayBuffer or regular buffer
		const useSharedBuffer = this._sharedBuffer !== null;

		let numberOfChannels: number;
		let bufferDuration: number;
		let sampleRate: number;

		if (useSharedBuffer) {
			// Using SharedArrayBuffer - zero copy path
			numberOfChannels = this._sharedBufferChannels;
			sampleRate = this._sharedBufferSampleRate;
			const floatView = new Float32Array(this._sharedBuffer!);
			const samplesPerChannel = Math.floor(floatView.length / numberOfChannels);
			bufferDuration = samplesPerChannel / sampleRate;
		} else {
			// Using regular AudioBuffer
			const audioBuffer = this._buffer.get();
			if (!audioBuffer) {
				console.warn("TimeStretchPlayer: Buffer not loaded");
				return;
			}
			numberOfChannels = audioBuffer.numberOfChannels;
			bufferDuration = this._buffer.duration;
			sampleRate = this.context.sampleRate;
		}

		const computedOffset = this.toSeconds(defaultArg(offset, 0));
		const offsetSamples = Math.floor(computedOffset * sampleRate);
		const computedStartTime = this.toSeconds(startTime);
		const loopEndSeconds = this._loopEnd === 0 ? bufferDuration : this.toSeconds(this._loopEnd);

		if (!this._workletNode) {
			// Check if worklet is initialized
			if (!TimeStretchPlayer._workletRegisteredContexts.has(this.context.rawContext)) {
				console.error("TimeStretchPlayer: worklet not initialized");
				return;
			}

			// Create worklet node with the correct number of channels
			this._createWorkletNode(numberOfChannels);

			// Send audio data to worklet
			if (useSharedBuffer) {
				// Zero-copy: pass SharedArrayBuffer directly to worklet
				this._workletNode!.port.postMessage({
					type: "setSharedAudioData",
					sharedBuffer: this._sharedBuffer,
					channels: numberOfChannels,
					sampleRate: sampleRate,
					offset: offsetSamples,
					loop: this._loop,
					loopStart: Math.floor(this.toSeconds(this._loopStart) * sampleRate),
					loopEnd: Math.floor(loopEndSeconds * sampleRate),
				});
			} else {
				// Regular path: copy audio data
				const audioBuffer = this._buffer.get()!;
				const audioData: Float32Array[] = [];
				for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
					audioData.push(audioBuffer.getChannelData(ch));
				}
				this._workletNode!.port.postMessage({
					type: "setAudioData",
					audioData: audioData,
					offset: offsetSamples,
					loop: this._loop,
					loopStart: Math.floor(this.toSeconds(this._loopStart) * sampleRate),
					loopEnd: Math.floor(loopEndSeconds * sampleRate),
				});
			}

			// update tempo and pitch to ensure they are correct
			this.tempo = this._tempo;
			this.pitch = this._pitch;
			this.playbackRate = this._playbackRate;
		}

		// Apply fadeIn envelope
		const fadeInTime = this.toSeconds(this.fadeIn);
		if (fadeInTime > 0) {
			this._fadeGainNode.gain.setValueAtTime(0, computedStartTime);
			if (this._fadeCurve === "linear") {
				this._fadeGainNode.gain.linearRampToValueAtTime(1, computedStartTime + fadeInTime);
			} else {
				this._fadeGainNode.gain.exponentialApproachValueAtTime(1, computedStartTime, fadeInTime);
			}
		} else {
			this._fadeGainNode.gain.setValueAtTime(1, computedStartTime);
		}

		// Start playback
		this._workletNode!.port.postMessage({
			type: "start",
			offset: offsetSamples,
		});

		// Schedule stop if duration is provided
		if (duration !== undefined) {
			const computedDuration = this.toSeconds(duration);
			this.stop(computedStartTime + computedDuration); // TODO: incorrect when tempo!=1
		}
	}

	/**
	 * Internal stop method
	 */
	protected _stop(time?: Time): void {
		const computedTime = this.toSeconds(time);
		const fadeOutTime = this.toSeconds(this.fadeOut);

		// Clear any pending stop timeout
		this.context.clearTimeout(this._stopTimeoutId);

		if (fadeOutTime > 0) {
			// Apply fadeOut envelope
			if (this._fadeCurve === "linear") {
				this._fadeGainNode.gain.linearRampTo(0, fadeOutTime, computedTime);
			} else {
				this._fadeGainNode.gain.targetRampTo(0, fadeOutTime, computedTime);
			}
		}

		// Calculate delay from now until stop should happen
		const stopTime = computedTime + fadeOutTime;
		const delay = stopTime - this.context.currentTime;

		if (delay > 0) {
			// Schedule the actual stop using Tone's precise timing
			this._stopTimeoutId = this.context.setTimeout(() => {
				this._stopTimeoutId = -1;
				if (this._workletNode) {
					this._workletNode.port.postMessage({ type: "stop" });
				}
			}, delay);
		} else {
			// Stop immediately
			if (this._workletNode) {
				this._workletNode.port.postMessage({ type: "stop" });
			}
		}
	}

	/**
	 * Internal restart method
	 */
	protected _restart(time?: Seconds, offset?: Time, duration?: Time): void {
		this._stop(time);
		this._start(time, offset, duration);
	}

	/**
	 * Stop and then restart the player from the beginning (or offset)
	 * @param  time When the player should start.
	 * @param  offset The offset from the beginning of the sample to start at.
	 * @param  duration How long the sample should play. If no duration is given,
	 * 					it will default to the full length of the sample (minus any offset)
	 */
	restart(time?: Seconds, offset?: Time, duration?: Time): this {
		super.restart(time, offset, duration);
		return this;
	}

	/**
	 * Set the loop start and end. Will only loop if loop is set to true.
	 * @param loopStart The loop start time
	 * @param loopEnd The loop end time
	 * @example
	 * const player = new Tone.TimeStretchPlayer("https://tonejs.github.io/audio/berklee/malevoices_aa2_F3.mp3").toDestination();
	 * // loop between the given points
	 * player.setLoopPoints(0.2, 0.3);
	 * player.loop = true;
	 * player.autostart = true;
	 */
	setLoopPoints(loopStart: Time, loopEnd: Time): this {
		this.loopStart = loopStart;
		this.loopEnd = loopEnd;
		return this;
	}

	/**
	 * Seek to a specific time in the player's buffer. If the
	 * source is no longer playing at that time, it will stop.
	 * @param offset The time to seek to.
	 * @param when The time for the seek event to occur.
	 * @example
	 * const player = new Tone.TimeStretchPlayer("https://tonejs.github.io/audio/berklee/gurgling_theremin_1.mp3", () => {
	 * 	player.start();
	 * 	// seek to the offset in 1 second from now
	 * 	player.seek(0.4, "+1");
	 * }).toDestination();
	 */
	seek(offset: Time, when?: Time): this {
		const computedTime = this.toSeconds(when);
		if (this._state.getValueAtTime(computedTime) === "started") {
			const computedOffset = this.toSeconds(offset);
			const offsetSamples = Math.floor(
				computedOffset * this.context.sampleRate
			);
			if (this._workletNode) {
				this._workletNode.port.postMessage({
					type: "seek",
					value: offsetSamples,
				});
			}
		}
		return this;
	}

	/**
	 * The tempo (playback speed) of the player.
	 * 1 = normal speed, 2 = double speed, 0.5 = half speed.
	 * Does not affect pitch.
	 */
	get tempo(): Positive {
		return this._tempo;
	}
	set tempo(value: Positive) {
		this._tempo = value;
		if (this._workletNode) {
			// Try using AudioParam first (supports automation)
			const tempoParam = this._workletNode.parameters.get('tempo');
			if (tempoParam) {
				tempoParam.setValueAtTime(value, this.context.currentTime);
			} else {
				// Fallback to postMessage for backward compatibility
				this._workletNode.port.postMessage({
					type: "setTempo",
					value: value,
				});
			}
		}
	}

	/**
	 * The pitch shift in semitones.
	 * 0 = no shift, 12 = one octave up, -12 = one octave down.
	 * Does not affect playback speed.
	 */
	get pitch(): Cents {
		return this._pitch;
	}
	set pitch(value: Cents) {
		this._pitch = value;
		if (this._workletNode) {
			// Try using AudioParam first (supports automation)
			const pitchParam = this._workletNode.parameters.get('pitch');
			if (pitchParam) {
				pitchParam.setValueAtTime(value, this.context.currentTime);
			} else {
				// Fallback to postMessage for backward compatibility
				this._workletNode.port.postMessage({
					type: "setPitch",
					value: value,
				});
			}
		}
	}

	/**
	 * Get the AudioParam for tempo automation.
	 * Returns null if the worklet node is not initialized or doesn't support parameters.
	 * Use this to schedule tempo changes at specific times, e.g.:
	 * player.tempoParam?.setValueAtTime(1.0, 0);
	 * player.tempoParam?.linearRampToValueAtTime(2.0, 10);
	 */
	get tempoParam(): AudioParam | null {
		return this._workletNode?.parameters.get('tempo') ?? null;
	}

	/**
	 * Get the AudioParam for pitch automation.
	 * Returns null if the worklet node is not initialized or doesn't support parameters.
	 * Use this to schedule pitch changes at specific times, e.g.:
	 * player.pitchParam?.setValueAtTime(0, 0);
	 * player.pitchParam?.linearRampToValueAtTime(12, 10);
	 */
	get pitchParam(): AudioParam | null {
		return this._workletNode?.parameters.get('pitch') ?? null;
	}

	/**
	 * The playback rate of the player.
	 * 1 = normal speed, 2 = double speed, 0.5 = half speed.
	 * Unlike tempo, this affects both speed AND pitch together,
	 * similar to changing the speed of a tape or vinyl record.
	 */
	get playbackRate(): Positive {
		return this._playbackRate;
	}
	set playbackRate(value: Positive) {
		this._playbackRate = value;
		if (this._workletNode) {
			const playbackRateParam = this._workletNode.parameters.get('rate');
			if (playbackRateParam) {
				playbackRateParam.setValueAtTime(value, this.context.currentTime);
			} else {
				// Fallback to postMessage for backward compatibility
				this._workletNode.port.postMessage({
					type: "setRate",
					value: value,
				});
			}
		}
	}

	/**
	 * Use quick seek mode for faster but lower quality time stretching.
	 * This is a read-only property that must be set at construction time.
	 */
	get useQuickSeek(): boolean {
		return this._useQuickSeek;
	}

	/**
	 * Use anti-alias filter for higher quality pitch shifting.
	 * This is a read-only property that must be set at construction time.
	 */
	get useAaFilter(): boolean {
		return this._useAaFilter;
	}

	/**
	 * Whether the audio should loop
	 */
	get loop(): boolean {
		return this._loop;
	}
	set loop(value: boolean) {
		this._loop = value;
		this._syncLoopToWorklet();
	}

	/**
	 * If loop is true, the loop will start at this position.
	 */
	get loopStart(): Time {
		return this._loopStart;
	}
	set loopStart(loopStart: Time) {
		this._loopStart = loopStart;
		if (this.buffer.loaded) {
			assertRange(this.toSeconds(loopStart), 0, this.buffer.duration);
		}
		this._syncLoopToWorklet();
	}

	/**
	 * If loop is true, the loop will end at this position.
	 */
	get loopEnd(): Time {
		return this._loopEnd;
	}
	set loopEnd(loopEnd: Time) {
		this._loopEnd = loopEnd;
		if (this.buffer.loaded) {
			assertRange(this.toSeconds(loopEnd), 0, this.buffer.duration);
		}
		this._syncLoopToWorklet();
	}

	/**
	 * Sync loop parameters to worklet
	 */
	private _syncLoopToWorklet(): void {
		if (this._workletNode) {
			const loopEndSeconds =
				this._loopEnd === 0
					? this._buffer.duration
					: this.toSeconds(this._loopEnd);
			this._workletNode.port.postMessage({
				type: "setLoop",
				value: {
					enabled: this._loop,
					start: Math.floor(this.toSeconds(this._loopStart) * this.context.sampleRate),
					end: Math.floor(loopEndSeconds * this.context.sampleRate),
				},
			});
		}
	}

	/**
	 * The audio buffer
	 */
	get buffer(): ToneAudioBuffer {
		return this._buffer;
	}
	set buffer(buffer: ToneAudioBuffer) {
		this._buffer.set(buffer);
	}

	/**
	 * If the buffer should be reversed. Note that this sets the underlying {@link ToneAudioBuffer.reverse}, so
	 * if multiple players are pointing at the same ToneAudioBuffer, they will all be reversed.
	 * @example
	 * const player = new Tone.TimeStretchPlayer("https://tonejs.github.io/audio/berklee/chime_1.mp3").toDestination();
	 * player.autostart = true;
	 * player.reverse = true;
	 */
	get reverse(): boolean {
		return this._buffer.reverse;
	}
	set reverse(rev: boolean) {
		this._buffer.reverse = rev;
	}

	/**
	 * If the buffer is loaded
	 */
	get loaded(): boolean {
		return this._loaded;
	}

	/**
	 * The current playback position in seconds
	 */
	get progress(): Seconds {
		return this._currentPosition / this.context.sampleRate;
	}

	/**
	 * Dispose and clean up
	 */
	dispose(): this {
		this.context.clearTimeout(this._stopTimeoutId);
		this._stopTimeoutId = -1;

		// Clean up worklet node
		if (this._workletNode) {
			this._workletNode.port.postMessage({ type: "dispose" });
			this._workletNode.port.onmessage = null;
			this._workletNode.disconnect();
			this._workletNode = null;
		}

		// Clean up buffer and fade gain node
		this._buffer.dispose();
		this._fadeGainNode.dispose();
		this._wasmBytes = null;
		this._soundtouchCode = "";

		// Clean up SharedArrayBuffer references
		this._sharedBuffer = null;
		this._sharedBufferChannels = 0;
		this._sharedBufferSampleRate = 0;

		// Call super.dispose last
		super.dispose();
		return this;
	}
}
