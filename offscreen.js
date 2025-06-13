let mediaRecorder;
let audioChunks = [];
let combinedStream; // This will hold the stream for MediaRecorder

// AudioContext for mixing if both tab and mic are used
let audioContext;
let micSourceNode, tabSourceNode, destinationNode;

// AudioContext for continuing tab audio playback (separate from recording)
let playbackAudioContext;
let playbackSourceNode;

// Keep track of original streams to stop their tracks later
let originalMicStream, originalTabStream;


chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== 'offscreen') {
    return;
  }

  switch (message.type) {
    case 'OFFSCREEN_START_RECORDING':
      await startRecording(message.tabMediaStreamId, message.includeMicrophone);
      break;
    case 'OFFSCREEN_STOP_RECORDING':
      await stopRecordingAndSave();
      break;
    default:
      console.warn(`Unexpected message type received in offscreen: ${message.type}`);
  }
});

async function _getTabAudioStream(tabMediaStreamId) {
  if (!tabMediaStreamId) {
    console.warn("No tabMediaStreamId provided for tab capture.");
    return null;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: tabMediaStreamId
        }
      },
      video: false
    });
    console.log("Tab stream captured in offscreen.");

    // Restore playback
    try {
      playbackAudioContext = new AudioContext();
      playbackSourceNode = playbackAudioContext.createMediaStreamSource(stream);
      playbackSourceNode.connect(playbackAudioContext.destination);
      console.log("Tab audio playback restored.");
    } catch (playbackError) {
      console.warn("Could not restore tab audio playback:", playbackError);
    }
    return stream;
  } catch (error) {
    console.error("Error getting tab audio stream:", error);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ERROR', error: `Tab audio capture failed: ${error.message}` });
    return null;
  }
}

async function _getMicrophoneStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log("Mic stream captured in offscreen.");
    return stream;
  } catch (micError) {
    console.error('Error accessing microphone:', micError);
    let errorMessage = 'Microphone access failed.';
    if (micError.name === 'NotAllowedError') {
      errorMessage = 'Microphone permission denied. Please grant microphone access.';
    } else if (micError.name === 'NotFoundError') {
      errorMessage = 'No microphone found on your device.';
    } else if (micError.name === 'NotReadableError') {
      errorMessage = 'Microphone is being used by another application.';
    }
    // Send error message, but don't necessarily stop if tab audio is available.
    // The main startRecording function will decide based on whether any stream was acquired.
    chrome.runtime.sendMessage({ 
        type: 'OFFSCREEN_RECORDING_ERROR', 
        error: errorMessage 
    });
    return null;
  }
}

function _combineAudioStreams(tabStream, micStream) {
  if (!tabStream && !micStream) return null;
  if (tabStream && !micStream) return tabStream;
  if (!tabStream && micStream) return micStream;

  audioContext = new AudioContext();
  destinationNode = audioContext.createMediaStreamDestination();

  tabSourceNode = audioContext.createMediaStreamSource(tabStream);
  tabSourceNode.connect(destinationNode);

  micSourceNode = audioContext.createMediaStreamSource(micStream);
  micSourceNode.connect(destinationNode);

  console.log("Streams combined via AudioContext.");
  return destinationNode.stream;
}

function _setupMediaRecorder(stream, onDataAvailable, onStop, onError) {
  const options = { mimeType: 'audio/webm;codecs=opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    console.warn(`${options.mimeType} is not supported, trying audio/ogg;codecs=opus`);
    options.mimeType = 'audio/ogg;codecs=opus';
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      console.warn(`${options.mimeType} is not supported, trying default`);
      options.mimeType = ''; // Let browser pick
    }
  }

  const recorder = new MediaRecorder(stream, options);
  recorder.ondataavailable = onDataAvailable;
  recorder.onstop = onStop;
  recorder.onerror = onError;
  return recorder;
}

async function startRecording(tabMediaStreamId, includeMicrophone) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    console.warn('Recording already in progress.');
    return;
  }

  audioChunks = []; // Reset chunks
  originalTabStream = null;
  originalMicStream = null;

  try {
    originalTabStream = await _getTabAudioStream(tabMediaStreamId);

    if (includeMicrophone) {
      originalMicStream = await _getMicrophoneStream();
      if (!originalMicStream && originalTabStream) {
         // Mic failed, but tab stream is okay. User was already notified by _getMicrophoneStream.
         // Inform that recording continues with tab audio only.
         chrome.runtime.sendMessage({ 
            type: 'OFFSCREEN_RECORDING_ERROR', // Using same type for simplicity, could be a 'warning' type
            error: 'Microphone failed. Continuing with tab audio only.' 
         });
      }
    }

    combinedStream = _combineAudioStreams(originalTabStream, originalMicStream);

    if (!combinedStream) {
      console.error('No streams available to record.');
      // Error messages would have been sent by helper functions already for specific failures.
      // This is a fallback if both somehow returned null without specific errors sent to user.
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ERROR', error: 'No audio sources available to record.' });
      cleanupStreamsAndContext();
      return;
    }

    mediaRecorder = _setupMediaRecorder(
      combinedStream,
      (event) => { // onDataAvailable
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      },
      () => { // onStop
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        document.body.appendChild(a);
        a.style.display = 'none';
        a.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `recording-${timestamp}.${blob.type.split('/')[1].split(';')[0] || 'webm'}`;
        a.click();

        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        audioChunks = [];
        cleanupStreamsAndContext();

        chrome.runtime.sendMessage({ type: 'RECORDING_COMPLETE' });
        console.log("Recording stopped, file processed and download triggered.");
      },
      (event) => { // onError
        console.error('MediaRecorder error:', event.error);
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ERROR', error: `MediaRecorder error: ${event.error.name}` });
        cleanupStreamsAndContext();
      }
    );

    mediaRecorder.start();
    console.log("MediaRecorder started.");

  } catch (error) {
    // This catch is for unexpected errors in the orchestration logic itself.
    // Specific stream acquisition or MediaRecorder errors are handled by helpers or their callbacks.
    console.error('Error during offscreen recording orchestration:', error);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ERROR', error: `Core recording setup failed: ${error.message}` });
    cleanupStreamsAndContext();
  }
}

async function stopRecordingAndSave() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // This will trigger 'onstop' handler
    console.log("MediaRecorder stop requested.");
  } else {
    console.warn("MediaRecorder not active or already stopped.");
    cleanupStreamsAndContext();
    chrome.runtime.sendMessage({ type: 'RECORDING_COMPLETE' }); // Or a specific 'nothing_to_save'
  }
}

function cleanupStreamsAndContext() {
    console.log("Cleaning up streams and audio context...");
    // Stop all tracks on the original streams
    if (originalMicStream) {
        originalMicStream.getTracks().forEach(track => track.stop());
        originalMicStream = null;
    }
    if (originalTabStream) {
        originalTabStream.getTracks().forEach(track => track.stop());
        originalTabStream = null;
    }

    // If AudioContext was used for mixing
    if (micSourceNode) micSourceNode.disconnect();
    if (tabSourceNode) tabSourceNode.disconnect();
    if (destinationNode) destinationNode.disconnect();

    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().then(() => console.log("Recording AudioContext closed."));
    }
    audioContext = null;
    micSourceNode = null;
    tabSourceNode = null;
    destinationNode = null;
    combinedStream = null;
    
    // Clean up playback AudioContext
    if (playbackSourceNode) playbackSourceNode.disconnect();
    if (playbackAudioContext && playbackAudioContext.state !== 'closed') {
        playbackAudioContext.close().then(() => console.log("Playback AudioContext closed."));
    }
    playbackAudioContext = null;
    playbackSourceNode = null;
}
