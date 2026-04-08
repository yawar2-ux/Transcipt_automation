require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve our frontend HTML file
app.use(express.static('public'));

// Initialize Deepgram
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

wss.on('connection', (ws) => {
  console.log('📱 Browser connected to backend!');

  // Open the stream to Deepgram
  // Open the stream to Deepgram
  const dgConnection = deepgram.listen.live({
    model: 'nova-2',
    smart_format: true,
    diarize: true,
    // detect_language: true, // <-- FIX 1: Automatically detects English vs Hindi
    endpointing: 250,      // <-- FIX 2: Cuts the latency by finalizing faster
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('🔗 Connected to Deepgram API');
    
    // THE FIX: Tell the browser it is safe to start recording
    ws.send(JSON.stringify({ type: 'DeepgramReady' }));
  });

  // When Deepgram sends text back, forward it to the browser
  // When Deepgram sends text back, forward it to the browser
  // 1. See EVERYTHING Deepgram sends back, even the drafts
  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel.alternatives[0].transcript;
    
    // Log every single guess Deepgram makes to the terminal
    if (transcript) {
        console.log(`[Deepgram Hears]: ${transcript} | is_final: ${data.is_final}`);
    } else {
        console.log(`[Deepgram Empty]: is_final: ${data.is_final}`, data.type);
    }

    // Only send the finalized ones to the frontend
    if (transcript && data.is_final && data.channel.alternatives[0].words.length > 0) {
      const speakerId = data.channel.alternatives[0].words[0].speaker;
      ws.send(JSON.stringify({ speaker: speakerId, text: transcript }));
    }
  });

  dgConnection.on('error', (err) => console.error('Deepgram Error:', err));

  // When the browser sends audio chunks, forward them to Deepgram
 ws.on('message', (audioData) => {
    // Log the size of the audio chunk arriving from the browser
    console.log(`🎤 Received audio chunk: ${audioData.length} bytes`);
    
    if (dgConnection.getReadyState() === 1) { 
      dgConnection.send(audioData);
    }
  });

  ws.on('close', () => {
    console.log('📱 Browser disconnected');
    dgConnection.disconnect();
  });
});

server.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
});