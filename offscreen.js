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

async function startRecording(tabMediaStreamId, includeMicrophone) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    console.warn('Recording already in progress.');
    return;
  }

  audioChunks = []; // Reset chunks
  const streamsToProcess = [];

  try {
    // 1. Get Tab Audio Stream (using the ID from background.js)
    if (tabMediaStreamId) {
        originalTabStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab', // Important: use 'tab' for tab audio
                    chromeMediaSourceId: tabMediaStreamId
                }
            },
            video: false
        });
        streamsToProcess.push(originalTabStream);
        console.log("Tab stream captured in offscreen.");
        
        // Continue to play the captured audio to the user (Chrome mutes it by default during capture)
        // This is the official solution from Chrome documentation
        try {
            playbackAudioContext = new AudioContext();
            playbackSourceNode = playbackAudioContext.createMediaStreamSource(originalTabStream);
            playbackSourceNode.connect(playbackAudioContext.destination);
            console.log("Tab audio playback restored.");
        } catch (playbackError) {
            console.warn("Could not restore tab audio playback:", playbackError);
            // Continue with recording even if playback fails
        }
    } else {
        console.warn("No tabMediaStreamId provided for tab capture.");
    }


    // 2. Get Microphone Stream (if requested)
    if (includeMicrophone) {
      try {
        originalMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamsToProcess.push(originalMicStream);
        console.log("Mic stream captured in offscreen.");
      } catch (micError) {
        console.error('Error accessing microphone:', micError);
        
        // Provide more specific error message based on error type
        let errorMessage = 'Microphone access failed.';
        if (micError.name === 'NotAllowedError') {
          errorMessage = 'Microphone permission denied. Please grant microphone access in the popup first.';
        } else if (micError.name === 'NotFoundError') {
          errorMessage = 'No microphone found on your device.';
        } else if (micError.name === 'NotReadableError') {
          errorMessage = 'Microphone is being used by another application.';
        }
        
        // If we have tab audio, continue recording without microphone
        if (originalTabStream) {
          console.log('Continuing with tab audio only (microphone failed)');
          chrome.runtime.sendMessage({ 
            type: 'OFFSCREEN_RECORDING_ERROR', 
            error: `${errorMessage} Recording will continue with tab audio only.` 
          });
          // Don't return - continue with tab audio only
        } else {
          // No streams available at all
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ERROR', error: errorMessage });
          cleanupStreamsAndContext(); 
          return;
        }
      }
    }

    if (streamsToProcess.length === 0) {
      console.error('No streams to record.');
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ERROR', error: 'No audio sources available to record.' });
      cleanupStreamsAndContext();
      return;
    }

    // 3. Combine Streams if multiple, or use single stream
    if (streamsToProcess.length > 1) {
      audioContext = new AudioContext();
      destinationNode = audioContext.createMediaStreamDestination();

      if (originalTabStream) {
        tabSourceNode = audioContext.createMediaStreamSource(originalTabStream);
        tabSourceNode.connect(destinationNode);
      }
      if (originalMicStream) {
        micSourceNode = audioContext.createMediaStreamSource(originalMicStream);
        micSourceNode.connect(destinationNode);
      }
      combinedStream = destinationNode.stream;
      console.log("Streams combined via AudioContext.");
    } else {
      combinedStream = streamsToProcess[0]; // Single stream (either tab or mic)
      console.log("Single stream being used.");
    }

    // 4. Setup MediaRecorder
    const options = { mimeType: 'audio/webm;codecs=opus' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        console.warn(`${options.mimeType} is not supported, trying audio/ogg;codecs=opus`);
        options.mimeType = 'audio/ogg;codecs=opus';
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.warn(`${options.mimeType} is not supported, trying default`);
            options.mimeType = ''; // Let browser pick
        }
    }

    mediaRecorder = new MediaRecorder(combinedStream, options);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const url = URL.createObjectURL(blob);

      // Offer download
      const a = document.createElement('a');
      document.body.appendChild(a); // Required for Firefox
      a.style.display = 'none';
      a.href = url;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `recording-${timestamp}.${blob.type.split('/')[1].split(';')[0] || 'webm'}`;
      a.click();

      // Clean up
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      audioChunks = []; // Reset for next recording
      cleanupStreamsAndContext();

      // Inform background script that recording is complete and saved
      chrome.runtime.sendMessage({ type: 'RECORDING_COMPLETE' });
      console.log("Recording stopped, file processed and download triggered.");
    };

    mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event.error);
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ERROR', error: `MediaRecorder error: ${event.error.name}` });
        cleanupStreamsAndContext();
    };

    mediaRecorder.start();
    console.log("MediaRecorder started.");

  } catch (error) {
    console.error('Error during offscreen recording setup:', error);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_ERROR', error: error.message });
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
