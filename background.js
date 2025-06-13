const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let recordingTabId = null;
let streamId = null; // MediaStream ID for tab capture

async function hasOffscreenDocument() {
  const matchedClients = await clients.matchAll();
  for (const client of matchedClients) {
    if (client.url.endsWith(OFFSCREEN_DOCUMENT_PATH)) {
      return true;
    }
  }
  return false;
}

async function setupOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.DISPLAY_MEDIA], // Though we only use USER_MEDIA for MediaRecorder
      justification: 'Recording audio with MediaRecorder and getUserMedia.',
    });
    console.log("Offscreen document created.");
  }
}

async function closeOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        await chrome.offscreen.closeDocument();
        console.log("Offscreen document closed.");
    }
}

// Helper function to reset recording state and clean up
async function resetRecordingState(reasonMessage = 'Recording stopped.') {
  console.log(`Resetting recording state: ${reasonMessage}`);
  if (recordingTabId && await hasOffscreenDocument()) {
    // If we were recording, tell offscreen to stop and clean up its resources.
    // This assumes offscreen.js's OFFSCREEN_STOP_RECORDING handles cases where it might already be stopped.
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_STOP_RECORDING', // This will trigger its own cleanup and eventually RECORDING_COMPLETE or error
      target: 'offscreen'
    }).catch(err => console.log("Error sending stop to offscreen during reset, it might be closed already:", err.message));
    // Note: offscreen.js will send 'RECORDING_COMPLETE' which then calls closeOffscreenDocument.
    // However, if the stop was due to an error or tab closure, we might want to ensure cleanup sooner.
    // For now, we rely on the existing flow, but if issues arise, direct call to closeOffscreenDocument here might be needed
    // after a short delay or if OFFSCREEN_STOP_RECORDING fails to send.
  } else if (await hasOffscreenDocument()) {
    // If there was no active recordingTabId but an offscreen doc exists, it might be orphaned.
    await closeOffscreenDocument();
  }

  recordingTabId = null;
  streamId = null;
  await chrome.storage.local.set({ isRecording: false });
  updateExtensionIcon(false);
  notifyPopupRecordingState(false, reasonMessage);
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.type === 'START_RECORDING') {
    if (recordingTabId) {
      sendResponse({ success: false, error: 'Already recording.' });
      return true;
    }

    recordingTabId = message.targetTabId;
    const includeMicrophone = message.includeMicrophone;

    try {
      // 1. Get Tab Media Stream ID
      await setupOffscreenDocument();

      const tabStream = await chrome.tabCapture.getMediaStreamId({
          targetTabId: recordingTabId,
      });

      if (!tabStream) {
        throw new Error("Could not get tab media stream ID.");
      }
      streamId = tabStream;

      // 2. Send request to offscreen document to start actual recording
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_START_RECORDING',
        target: 'offscreen',
        tabMediaStreamId: streamId,
        includeMicrophone: includeMicrophone
      });

      await chrome.storage.local.set({ isRecording: true });
      updateExtensionIcon(true);
      notifyPopupRecordingState(true, 'Recording started...');
      sendResponse({ success: true });

    } catch (error) {
      console.error('Error starting tab capture:', error);
      await resetRecordingState(`Error: ${error.message}`); // Use centralized reset
      sendResponse({ success: false, error: error.message });
      // closeOffscreenDocument is now handled by resetRecordingState if needed
    }
    return true; // Indicates an async response

  } else if (message.type === 'STOP_RECORDING') {
    if (!recordingTabId) {
      sendResponse({ success: false, error: 'Not recording.' });
      return true;
    }

    try {
      // Send message to offscreen document to stop recording and process audio
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_STOP_RECORDING',
        target: 'offscreen'
      });
      // Offscreen document will send 'RECORDING_COMPLETE' when done.
      // The 'RECORDING_COMPLETE' handler will call closeOffscreenDocument.

      // Partially reset state here; full reset happens on RECORDING_COMPLETE or if error.
      // We keep recordingTabId for a moment so onRemoved/onUpdated don't also try to stop.
      // await chrome.storage.local.set({ isRecording: false }); // This is now done by resetRecordingState or RECORDING_COMPLETE path
      // updateExtensionIcon(false); // Ditto
      notifyPopupRecordingState(false, 'Stopping recording...'); // Inform UI immediately
      // The actual isRecording state in storage will be set to false by RECORDING_COMPLETE handler or error handlers.
      sendResponse({ success: true });

    } catch (error) {
      console.error('Error stopping recording:', error);
      await resetRecordingState(`Error stopping: ${error.message}`); // Use centralized reset on error
      sendResponse({ success: false, error: error.message });
    }
    return true; // Indicates an async response

  } else if (message.type === 'RECORDING_COMPLETE') {
    // This message comes from offscreen.js after file is saved
    console.log("Recording complete and file saved.");
    // Reset state now that offscreen is done and has (or will) save the file.
    await resetRecordingState('Recording saved! Ready for new recording.');
    // closeOffscreenDocument is called by resetRecordingState if offscreen was used or by offscreen.js itself.
    // For clarity, ensure offscreen.js calls close on its own after saving and before sending this.
    // Or, rely on resetRecordingState to handle closing the offscreen document.
    // The `resetRecordingState` will handle setting storage, icon, and notifying popup.
    return false; // No response needed for this notification

  } else if (message.type === 'OFFSCREEN_RECORDING_ERROR') {
    console.error("Error from offscreen document:", message.error);
    await resetRecordingState(`Recording Error: ${message.error}`); // Use centralized reset
    // closeOffscreenDocument is handled by resetRecordingState
    return false; // No response needed for this notification
  }
  
  // Default: no response needed for unknown message types
  return false;
});

function updateExtensionIcon(isRecording) {
  const iconPath = isRecording ? "icons/icon_recording.png" : "icons/icon48.png";
  // You'll need an 'icon_recording.png' or similar
  chrome.action.setIcon({ path: iconPath });
}

function notifyPopupRecordingState(isRecording, statusText = '') {
  // Use a more robust approach to send messages to popup
  try {
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATE_CHANGED',
      isRecording: isRecording,
      statusText: statusText
    }).catch(err => {
      // This is expected when popup is closed - no need to log error
      if (err.message && !err.message.includes('Could not establish connection')) {
        console.log("Error sending message to popup:", err.message);
      }
    });
  } catch (error) {
    // Silently handle errors when popup is not available
    console.log("Popup not available for state update");
  }
}

// Optional: Clean up if the recording tab is closed or navigated away
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === recordingTabId) {
    console.log("Recording tab closed. Stopping recording.");
    await resetRecordingState('Tab closed. Recording stopped.');
    // The OFFSCREEN_STOP_RECORDING message and other cleanup is handled by resetRecordingState.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (tabId === recordingTabId && changeInfo.url) { // Navigated away
        console.log("Recording tab navigated. Stopping recording.");
        await resetRecordingState('Tab navigated. Recording stopped.');
        // The OFFSCREEN_STOP_RECORDING message and other cleanup is handled by resetRecordingState.
    }
});

// Initial state
chrome.runtime.onStartup.addListener(async () => {
    // Ensure a clean state on startup, especially if Chrome crashed during a recording.
    await resetRecordingState('Extension startup; ensuring clean state.');
    // Set default for microphone permission if not already set (optional)
    const checkPerm = await chrome.storage.local.get('microphonePermissionGranted');
    if (checkPerm.microphonePermissionGranted === undefined) {
        await chrome.storage.local.set({ microphonePermissionGranted: false });
    }
});
chrome.runtime.onInstalled.addListener(async (details) => {
    await resetRecordingState('Extension installed/updated; ensuring clean state.');
    // Set default for microphone permission on first install
    if (details.reason === 'install') {
        await chrome.storage.local.set({ microphonePermissionGranted: false });
    }
    // If updating, you might want to preserve existing settings or handle migrations.
});
