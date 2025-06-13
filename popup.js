const startButton = document.getElementById('startRecord');
const stopButton = document.getElementById('stopRecord');
const micCheckbox = document.getElementById('includeMicrophone');
const micStatus = document.getElementById('micStatus');
const statusDiv = document.getElementById('status');
const settingsLink = document.getElementById('settingsLink');

let isRecording = false;
let microphonePermissionGranted = false;

// Function to update microphone status display
function updateMicrophoneStatus() {
  if (micCheckbox.checked) {
    if (microphonePermissionGranted) {
      micStatus.textContent = '[OK] Granted';
      micStatus.className = 'mic-status granted';
    } else {
      micStatus.textContent = '⚠ Setup needed'; // Clearly indicate setup is needed
      micStatus.className = 'mic-status denied';
    }
  } else {
    micStatus.textContent = '';
    micStatus.className = 'mic-status';
  }
}

// Function to open options page for microphone permission
function openOptionsPage() {
  chrome.runtime.openOptionsPage();
}

// Function to check if microphone permission is already granted
async function checkMicrophonePermission() {
  try {
    // Check stored permission status first
    const stored = await chrome.storage.local.get(['microphonePermissionGranted']);
    if (stored.microphonePermissionGranted) {
      microphonePermissionGranted = true;
      updateMicrophoneStatus();
      return true;
    }
    
    // If not stored, we can't check directly from popup (that's the problem we're solving)
    // So we assume it's not granted unless stored
    microphonePermissionGranted = false;
    updateMicrophoneStatus();
    return false;
  } catch (error) {
    console.log('Could not check microphone permission status:', error);
    microphonePermissionGranted = false;
    updateMicrophoneStatus();
    return false;
  }
}

// Function to update UI based on recording state
async function updateUI() {
  try {
    const state = await chrome.storage.local.get(['isRecording', 'includeMicrophone']);
    isRecording = state.isRecording || false;
    micCheckbox.checked = state.includeMicrophone || false; // Persist mic choice
    
    // Check microphone permission status if microphone is enabled
    if (micCheckbox.checked) {
      await checkMicrophonePermission();
    }

    if (isRecording) {
      startButton.style.display = 'none';
      stopButton.style.display = 'block';
      statusDiv.textContent = 'Recording...';
      micCheckbox.disabled = true;
    } else {
      startButton.style.display = 'block';
      stopButton.style.display = 'none';
      statusDiv.textContent = 'Ready to record.';
      micCheckbox.disabled = false;
    }
    
    // Update microphone status display
    updateMicrophoneStatus();
  } catch (error) {
    console.error("Error updating UI from storage:", error);
    statusDiv.textContent = 'Error loading state.';
  }
}

startButton.addEventListener('click', async () => {
  if (isRecording) return;

  const includeMicrophone = micCheckbox.checked;
  
  // Check microphone permission if microphone is requested
  if (includeMicrophone) {
    // Re-check permission status directly here as it's critical for starting
    const stored = await chrome.storage.local.get(['microphonePermissionGranted']);
    microphonePermissionGranted = stored.microphonePermissionGranted || false;

    if (!microphonePermissionGranted) {
      statusDiv.textContent = 'Microphone permission needed. Open Settings to grant.';
      updateMicrophoneStatus(); // Ensure mic status reflects this
      return;
    }
  }
  
  await chrome.storage.local.set({ includeMicrophone }); // Save preference

  // Get current active tab to capture
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    statusDiv.textContent = "No active tab found.";
    return;
  }
  if (tab.url?.startsWith("chrome://")) {
    statusDiv.textContent = "Cannot record chrome:// pages.";
    return;
  }

  chrome.runtime.sendMessage({
    type: 'START_RECORDING',
    targetTabId: tab.id,
    includeMicrophone: includeMicrophone
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error starting recording:", chrome.runtime.lastError.message);
      statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
      isRecording = false;
    } else if (response && response.success) {
      isRecording = true;
      statusDiv.textContent = 'Recording requested...';
    } else {
      statusDiv.textContent = response.error || 'Failed to start recording.';
      isRecording = false;
    }
    updateUI();
  });
});

stopButton.addEventListener('click', () => {
  if (!isRecording) return;

  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error stopping recording:", chrome.runtime.lastError.message);
      statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
    } else if (response && response.success) {
      statusDiv.textContent = 'Recording stopped. Preparing download...';
      isRecording = false;
    } else {
      statusDiv.textContent = response.error || 'Failed to stop.';
    }
    updateUI();
  });
});

// Event listeners
// Handle settings link click
settingsLink.addEventListener('click', openOptionsPage);

// Handle microphone checkbox changes
micCheckbox.addEventListener('change', async () => {
  const includeMic = micCheckbox.checked;
  await chrome.storage.local.set({ includeMicrophone: includeMic });

  if (includeMic) {
    // Check current permission status (might have been granted in another tab)
    const stored = await chrome.storage.local.get(['microphonePermissionGranted']);
    microphonePermissionGranted = stored.microphonePermissionGranted || false;

    if (!microphonePermissionGranted) {
      statusDiv.textContent = 'Microphone access needed. Open Settings to grant.';
    } else {
      statusDiv.textContent = 'Ready to record with microphone.';
    }
  } else {
    statusDiv.textContent = 'Ready to record.';
  }
  updateMicrophoneStatus(); // Update mic status display regardless
});

// Listen for state changes from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'RECORDING_STATE_CHANGED') {
    isRecording = message.isRecording;
    if (message.statusText) {
      statusDiv.textContent = message.statusText;
    }
    updateUI();
  }
  // No response needed for state change notifications - don't return true
});

// Listen for storage changes (e.g., when permission is granted in options page)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.microphonePermissionGranted) {
    microphonePermissionGranted = changes.microphonePermissionGranted.newValue;
    // If the checkbox is currently checked and permission was just granted,
    // update the main status message.
    if (micCheckbox.checked && microphonePermissionGranted) {
      statusDiv.textContent = 'Microphone permission granted! Ready to record.';
    }
    updateMicrophoneStatus(); // Always update the dedicated mic status indicator
  }
  // Also listen for changes to isRecording, e.g. if background stops it
  if (namespace === 'local' && changes.isRecording) {
    isRecording = changes.isRecording.newValue;
    updateUI(); // This will re-evaluate button states and status text
  }
});

// Initialize UI on popup open
updateUI();
