import { useState, useRef, useCallback, useEffect } from 'react';

import { trpcClient } from '@/main';

type TranscribeState = 'idle' | 'recording' | 'transcribing';

export type VoiceInputError =
	| 'unsupported'
	| 'permission-denied'
	| 'no-microphone'
	| 'microphone-unavailable'
	| 'transcription-failed'
	| 'nothing-recognized';

/** Keeps a recording well under the backend's audio body limit and the model's input limit. */
export const MAX_RECORDING_SECONDS = 600;

export function useTranscribe({ onTranscribed }: { onTranscribed: (text: string) => void }) {
	const [state, setState] = useState<TranscribeState>('idle');
	const [error, setError] = useState<VoiceInputError | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const discardRef = useRef(false);
	const startingRef = useRef(false);
	const maxDurationTimerRef = useRef(0);
	// The last recording whose transcription failed, kept so it can be retried instead of re-recorded.
	const failedAudioRef = useRef<string | null>(null);
	const onTranscribedRef = useRef(onTranscribed);
	useEffect(() => {
		onTranscribedRef.current = onTranscribed;
	});

	const releaseMedia = useCallback(() => {
		window.clearTimeout(maxDurationTimerRef.current);
		streamRef.current?.getTracks().forEach((t) => t.stop());
		streamRef.current = null;
		audioCtxRef.current?.close();
		audioCtxRef.current = null;
		analyserRef.current = null;
	}, []);

	const transcribeAudio = useCallback(async (audio: string) => {
		setState('transcribing');
		setError(null);
		try {
			const { text } = await trpcClient.transcribe.transcribe.mutate({ audio });
			failedAudioRef.current = null;
			if (text?.trim()) {
				onTranscribedRef.current(text.trim());
			} else {
				setError('nothing-recognized');
			}
		} catch (err) {
			console.error('Transcription error:', err);
			failedAudioRef.current = audio;
			setError('transcription-failed');
		} finally {
			setState('idle');
		}
	}, []);

	const stopRecorder = useCallback((discard: boolean) => {
		discardRef.current = discard;
		if (mediaRecorderRef.current?.state === 'recording') {
			mediaRecorderRef.current.stop();
		}
	}, []);

	const finish = useCallback(() => stopRecorder(false), [stopRecorder]);
	const cancel = useCallback(() => stopRecorder(true), [stopRecorder]);

	useEffect(() => {
		if (state !== 'recording') {
			return;
		}

		// Capture phase, so Enter finishes the recording instead of also submitting the prompt.
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				cancel();
			} else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				e.stopPropagation();
				finish();
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [state, cancel, finish]);

	useEffect(
		() => () => {
			discardRef.current = true;
			if (mediaRecorderRef.current?.state === 'recording') {
				mediaRecorderRef.current.stop();
			}
			releaseMedia();
		},
		[releaseMedia],
	);

	const start = useCallback(async () => {
		if (state !== 'idle' || startingRef.current) {
			return;
		}
		setError(null);
		failedAudioRef.current = null;

		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			setError('unsupported');
			return;
		}

		startingRef.current = true;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			setError(classifyMediaError(err));
			return;
		} finally {
			startingRef.current = false;
		}
		streamRef.current = stream;

		const audioCtx = new AudioContext();
		const source = audioCtx.createMediaStreamSource(stream);
		const analyser = audioCtx.createAnalyser();
		analyser.fftSize = 512;
		analyser.smoothingTimeConstant = 0.4;
		source.connect(analyser);
		audioCtxRef.current = audioCtx;
		analyserRef.current = analyser;

		const mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });
		mediaRecorderRef.current = mediaRecorder;
		chunksRef.current = [];
		discardRef.current = false;

		mediaRecorder.ondataavailable = (e) => {
			if (e.data.size > 0) {
				chunksRef.current.push(e.data);
			}
		};

		mediaRecorder.onstop = async () => {
			releaseMedia();
			const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
			chunksRef.current = [];
			if (discardRef.current || blob.size === 0) {
				setState('idle');
				return;
			}

			let audio: string;
			try {
				audio = await blobToBase64(blob);
			} catch {
				setError('transcription-failed');
				setState('idle');
				return;
			}
			await transcribeAudio(audio);
		};

		mediaRecorder.start();
		setState('recording');
		maxDurationTimerRef.current = window.setTimeout(() => stopRecorder(false), MAX_RECORDING_SECONDS * 1000);
	}, [state, releaseMedia, transcribeAudio, stopRecorder]);

	const toggle = useCallback(() => {
		if (state === 'recording') {
			finish();
		} else if (state === 'idle') {
			start();
		}
	}, [state, start, finish]);

	const retry = useCallback(() => {
		const audio = failedAudioRef.current;
		if (audio && state === 'idle') {
			transcribeAudio(audio);
		}
	}, [state, transcribeAudio]);

	const dismissError = useCallback(() => {
		failedAudioRef.current = null;
		setError(null);
	}, []);

	return {
		state,
		toggle,
		finish,
		cancel,
		retry,
		error,
		dismissError,
		isRecording: state === 'recording',
		isTranscribing: state === 'transcribing',
		analyserRef,
	};
}

function classifyMediaError(err: unknown): VoiceInputError {
	const name = err instanceof DOMException ? err.name : '';
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		return 'permission-denied';
	}
	if (name === 'NotFoundError' || name === 'OverconstrainedError') {
		return 'no-microphone';
	}
	return 'microphone-unavailable';
}

function getSupportedMimeType(): string {
	const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
	return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.split(',')[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}
