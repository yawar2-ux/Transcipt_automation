require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve our frontend HTML file
app.use(express.static('public'));
app.use(express.json());

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Helper to get codebase context
function getCodebaseContext() {
    const filesToRead = ['server.js', 'public/index.html']; // Expand as needed
    let context = "CURRENT CODEBASE CONTEXT:\n\n";
    
    filesToRead.forEach(file => {
        try {
            const filePath = path.join(__dirname, file);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                context += `--- FILE: ${file} ---\n${content}\n\n`;
            }
        } catch (err) {
            console.error(`Could not read ${file} for context:`, err.message);
        }
    });
    return context;
}

// AI Thought Processing Endpoint
app.post('/process-thought', async (req, res) => {
    const { transcript } = req.body;
    console.log("🤖 Processing AI Thought for:", transcript);
    
    if (!transcript || transcript.trim().length < 2) {
        return res.status(400).json({ error: "Transcript too short or missing." });
    }

    try {
        const codebaseContext = getCodebaseContext();
        const systemPrompt = `
            You are a Personal Meeting Co-pilot for a Developer. 
            You are listening to a meeting and the developer just triggered you to process the last thought.
            
            YOUR MODES:
            1. CLARIFICATION: If the client/speaker said something vague (e.g. "add a dashboard"), generate 2-3 smart follow-up questions.
            2. ANSWER: If a technical question was asked, provide a concise, accurate answer based on the CODEBASE context.

            CODEBASE CONTEXT:
            ${codebaseContext}

            TRANSCRIPT SEGMENT:
            "${transcript}"

            Keep your response professional, concise, and focused on helping the developer respond effectively.
        `;

        const result = await aiModel.generateContent(systemPrompt);
        const response = await result.response;
        const text = response.text();

        res.json({ response: text });
    } catch (error) {
        console.error("❌ Gemini Error:", error);
        res.status(500).json({ error: "AI Failed to respond." });
    }
});

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
    interim_results: true, // <-- NEW: Receive words instantly for smooth transcription
    // detect_language: true, // <-- FIX 1: Automatically detects English vs Hindi
    endpointing: 250,      // <-- FIX 2: Cuts the latency by finalizing faster
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('🔗 Connected to Deepgram API');
    
    // THE FIX: Tell the browser it is safe to start recording
    ws.send(JSON.stringify({ type: 'DeepgramReady' }));
  });

  // When Deepgram sends text back, forward it to the browser
  // 1. See EVERYTHING Deepgram sends back, even the drafts
  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    try {
      const transcript = data.channel.alternatives[0].transcript;
      
      if (transcript) {
          console.log(`[Deepgram Hears]: ${transcript} | is_final: ${data.is_final}`);
      } else {
          console.log(`[Deepgram Empty]: is_final: ${data.is_final}`);
      }

      // Send both finalized and interim results to the frontend if it requires at least one word
      if (transcript && data.channel.alternatives[0].words && data.channel.alternatives[0].words.length > 0) {
        const speakerId = data.channel.alternatives[0].words[0].speaker;
        ws.send(JSON.stringify({ speaker: speakerId, text: transcript, is_final: data.is_final }));
      }
    } catch (err) {
      console.log('❌ Error parsing transcript:', err.message, JSON.stringify(data));
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Metadata, (data) => {
    console.log('📊 Deepgram Metadata:', data);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    console.log('🔴 Deepgram connection closed.');
  });
  
  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('❌ Deepgram Live API Error:', err);
  });

  dgConnection.on(LiveTranscriptionEvents.Unhandled, (event) => {
    console.log('❓ Deepgram Unhandled Event:', event);
  });

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
// testing// Start the server
server.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
});