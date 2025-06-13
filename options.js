const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const requestButton = document.getElementById('requestPermission');
const testButton = document.getElementById('testMicrophone');
const messageBox = document.getElementById('messageBox');

let microphonePermissionGranted = false;

// Function to show messages to user
function showMessage(message, type = 'info') {
  messageBox.innerHTML = `<div class="${type}-box">${message}</div>`;
}

// Function to update permission status display
function updatePermissionStatus(granted) {
  microphonePermissionGranted = granted;
  
  if (granted) {
    statusIndicator.className = 'status-indicator status-granted';
    statusText.textContent = 'Microphone permission granted [OK]';
    requestButton.textContent = 'Permission Already Granted';
    requestButton.disabled = true;
    testButton.style.display = 'inline-block';
    showMessage('Microphone permission successfully granted! You can now use the microphone recording feature in the extension.', 'success');
  } else {
    statusIndicator.className = 'status-indicator status-denied';
    statusText.textContent = 'Microphone permission not granted';
    requestButton.textContent = 'Grant Microphone Permission';
    requestButton.disabled = false;
    testButton.style.display = 'none';
  }
}

// Function to check current microphone permission status
async function checkMicrophonePermission() {
  try {
    const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
    const granted = permissionStatus.state === 'granted';
    updatePermissionStatus(granted);
    
    // Listen for permission changes
    permissionStatus.onchange = () => {
      updatePermissionStatus(permissionStatus.state === 'granted');
    };
    
    return granted;
  } catch (error) {
    console.log('Could not check microphone permission:', error);
    statusIndicator.className = 'status-indicator status-unknown';
    statusText.textContent = 'Permission status unknown';
    return false;
  }
}

// Function to request microphone permission
async function requestMicrophonePermission() {
  try {
    showMessage('Requesting microphone permission... Please allow access when prompted.', 'info');
    requestButton.disabled = true;
    requestButton.textContent = 'Requesting Permission...';
    
    // Request microphone access
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Permission granted - stop the stream immediately
    stream.getTracks().forEach(track => track.stop());
    
    updatePermissionStatus(true);
    
    // Store permission status for the extension
    await chrome.storage.local.set({ 
      microphonePermissionGranted: true,
      lastPermissionCheck: Date.now()
    });
    
    console.log('Microphone permission granted successfully');
    
  } catch (error) {
    console.error('Microphone permission denied:', error);
    updatePermissionStatus(false);
    
    let errorMessage = 'Microphone permission was denied.';
    if (error.name === 'NotAllowedError') {
      errorMessage = 'Microphone access was denied. Please click "Allow" when prompted, or check your browser settings.';
    } else if (error.name === 'NotFoundError') {
      errorMessage = 'No microphone found. Please connect a microphone and try again.';
    } else if (error.name === 'NotReadableError') {
      errorMessage = 'Microphone is being used by another application. Please close other apps using the microphone and try again.';
    }
    
    showMessage(errorMessage, 'error');
    
    // Store denial status
    await chrome.storage.local.set({ 
      microphonePermissionGranted: false,
      lastPermissionCheck: Date.now()
    });
    
    requestButton.disabled = false;
    requestButton.textContent = 'Try Again';
  }
}

// Function to test microphone
async function testMicrophone() {
  try {
    showMessage('Testing microphone... Speak into your microphone.', 'info');
    testButton.disabled = true;
    testButton.textContent = 'Testing...';
    
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Create audio context to detect sound
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyzer = audioContext.createAnalyser();
    source.connect(analyzer);
    
    const dataArray = new Uint8Array(analyzer.frequencyBinCount);
    let soundDetected = false;
    let testDuration = 0;
    const maxTestTime = 5000; // 5 seconds
    
    const checkSound = () => {
      analyzer.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      
      if (average > 10) { // Sound threshold
        soundDetected = true;
        showMessage('Microphone test successful! Sound detected.', 'success');
        cleanup();
      } else if (testDuration < maxTestTime) {
        testDuration += 100;
        setTimeout(checkSound, 100);
      } else {
        showMessage('No sound detected. Please check your microphone settings and try speaking louder.', 'error');
        cleanup();
      }
    };
    
    const cleanup = () => {
      stream.getTracks().forEach(track => track.stop());
      audioContext.close();
      testButton.disabled = false;
      testButton.textContent = 'Test Microphone';
    };
    
    checkSound();
    
  } catch (error) {
    console.error('Microphone test failed:', error);
    showMessage('Microphone test failed. Please check your microphone connection.', 'error');
    testButton.disabled = false;
    testButton.textContent = 'Test Microphone';
  }
}

// Event listeners
requestButton.addEventListener('click', requestMicrophonePermission);
testButton.addEventListener('click', testMicrophone);

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  await checkMicrophonePermission();
});
