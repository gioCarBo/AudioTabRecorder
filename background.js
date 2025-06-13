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
      // Note: chrome.tabCapture.capture requires the tab to be audible or recently audible.
      // For a more robust solution, you might need to inject a content script to play a silent sound
      // if the tab isn't making noise, but that's more complex.
      // Here, we rely on the tab producing sound.
      //
      // An alternative is `chrome.desktopCapture` for entire screen audio,
      // but `tabCapture` is more specific to the request.

      // First, ensure the offscreen document is ready as it will receive the stream ID
      await setupOffscreenDocument();

      // Get a media stream ID for the tab
      // This stream ID will be used by the offscreen document to get the actual MediaStream
      const tabStream = await chrome.tabCapture.getMediaStreamId({
          targetTabId: recordingTabId,
      });

      if (!tabStream) {
        throw new Error("Could not get tab media stream ID.");
      }
      streamId = tabStream; // Save for potential re-use or stop

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
      recordingTabId = null;
      streamId = null;
      await chrome.storage.local.set({ isRecording: false });
      updateExtensionIcon(false);
      notifyPopupRecordingState(false, `Error: ${error.message}`);
      sendResponse({ success: false, error: error.message });
      await closeOffscreenDocument(); // Clean up if failed
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
      // Offscreen document will send 'RECORDING_COMPLETE' when done

      // Reset state here, actual cleanup of offscreen will happen on RECORDING_COMPLETE
      recordingTabId = null;
      streamId = null;
      await chrome.storage.local.set({ isRecording: false });
      updateExtensionIcon(false);
      notifyPopupRecordingState(false, 'Stopping recording...');
      sendResponse({ success: true });

    } catch (error) {
      console.error('Error stopping recording:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true; // Indicates an async response

  } else if (message.type === 'RECORDING_COMPLETE') {
    // This message comes from offscreen.js after file is saved
    console.log("Recording complete and file saved. Closing offscreen document.");
    await closeOffscreenDocument();
    notifyPopupRecordingState(false, 'Recording saved! Ready for new recording.');
    // No response needed for this notification
    return false;

  } else if (message.type === 'OFFSCREEN_RECORDING_ERROR') {
    console.error("Error from offscreen document:", message.error);
    recordingTabId = null;
    streamId = null;
    await chrome.storage.local.set({ isRecording: false });
    updateExtensionIcon(false);
    notifyPopupRecordingState(false, `Recording Error: ${message.error}`);
    await closeOffscreenDocument();
    // No response needed for this notification
    return false;
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
    if (await hasOffscreenDocument()){
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_RECORDING', target: 'offscreen' });
    }
    recordingTabId = null;
    streamId = null;
    await chrome.storage.local.set({ isRecording: false });
    updateExtensionIcon(false);
    notifyPopupRecordingState(false, 'Tab closed. Recording stopped.');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (tabId === recordingTabId && changeInfo.url) { // Navigated away
        console.log("Recording tab navigated. Stopping recording.");
        if (await hasOffscreenDocument()){
            chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_RECORDING', target: 'offscreen' });
        }
        recordingTabId = null;
        streamId = null;
        await chrome.storage.local.set({ isRecording: false });
        updateExtensionIcon(false);
        notifyPopupRecordingState(false, 'Tab navigated. Recording stopped.');
    }
});

// Initial state
chrome.runtime.onStartup.addListener(async () => {
    await chrome.storage.local.set({ isRecording: false });
    updateExtensionIcon(false);
});
chrome.runtime.onInstalled.addListener(async () => {
    await chrome.storage.local.set({ isRecording: false });
    updateExtensionIcon(false);
});
