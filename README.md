# AudioTabRecorder - Chrome Extension

A Chrome extension for recording tab audio with optional microphone mixing.

## Features

- Records audio from browser tabs
- Optional microphone mixing
- Manifest V3 compliant
- Proper permission handling via options page
- Clean UI with status indicators
- Automatic audio download when recording stops

## Recent Improvements

- Simplified microphone permission flow
- Consolidated recording state management
- Refactored audio capture logic for better maintainability
- Improved error handling and user feedback

## Installation

1. Clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the extension directory

## Usage

1. Click the extension icon to open the popup
2. Check "Include Microphone" if desired (requires permission)
3. Click "Start Recording" and select the tab to record
4. Click "Stop Recording" when finished (audio will auto-download)

## Development

This extension uses:

- Chrome's tabCapture API
- Offscreen documents for audio processing
- chrome.storage for state management

## Contributing

Pull requests are welcome! Please ensure:

- Code follows existing style
- Changes are well-tested
- Documentation is updated
