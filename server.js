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

const MODEL_FALLBACK_CHAIN = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"];

// Helper for retrying AI calls with model fallback
async function withRetry(promptFn, retries = 2, delay = 1000) {
    for (const modelName of MODEL_FALLBACK_CHAIN) {
        try {
            const aiModel = genAI.getGenerativeModel({ model: modelName });
            for (let i = 0; i < retries; i++) {
                try {
                    console.log(`🤖 Trying model: ${modelName} (attempt ${i + 1})`);
                    return await promptFn(aiModel);
                } catch (err) {
                    const isOverloaded = err.status === 503 || err.status === 429;
                    if (!isOverloaded) throw err; // Let 404s or others be handled by the outer catch
                    console.log(`⚠️ ${modelName} overloaded (${err.status}), retry ${i + 1}/${retries}`);
                    await new Promise(res => setTimeout(res, delay * (i + 1)));
                }
            }
        } catch (err) {
            const isNotFound = err.status === 404;
            if (isNotFound) {
                console.log(`⚠️ ${modelName} not found (404), skipping...`);
            } else {
                console.log(`❌ Error with ${modelName}:`, err.message);
                throw err; // Stop if it's a fatal error like invalid API key
            }
        }
        console.log(`⏭️ Falling back from ${modelName}...`);
    }
    throw new Error("All models are currently unavailable. Please try again shortly.");
}

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
            You are a Personal Meeting Co-pilot for a Developer, acting as a Product Architect and Technical Lead. 
            You are listening to a meeting and providing high-level technical guidance.
            
            YOUR MODES:
            1. CLARIFICATION: If a speaker mentions a feature or concept that is vague or has multiple implementation paths, generate 2-3 smart follow-up questions to help the developer clarify requirements.
            2. ANSWER & ADVICE: 
               - If a question is about the current codebase, provide a concise answer based on the CODEBASE CONTEXT.
               - If a question is about a general technical concept or feature NOT in the codebase, provide expert architectural advice, industry best practices, or potential implementation strategies. Do NOT simply say "it is not in the codebase."

            CODEBASE CONTEXT:
            ${codebaseContext}

            TRANSCRIPT SEGMENT:
            "${transcript}"

            Keep your response professional, insightful, and focused on enabling the developer to participate effectively in the meeting. Provide enough detail to be useful but keep it readable in a fast-paced meeting.
        `;

        // Pass a function that accepts the model — withRetry will inject each fallback model
        const result = await withRetry((model) => model.generateContent(systemPrompt));
        const response = await result.response;
        const text = response.text();

        res.json({ response: text });
    } catch (error) {
        console.error("❌ Gemini Error:", error);
        const message = error.message || "AI Failed to respond.";
        res.status(503).json({ error: message });
    }
});

// Initialize Deepgram
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

wss.on('connection', (ws) => {
  console.log('📱 Browser connected to backend!');

  // Open the stream to Deepgram
  const dgConnection = deepgram.listen.live({
    model: 'nova-2',
    smart_format: true,
    diarize: true,
    interim_results: true,
    endpointing: 250,
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('🔗 Connected to Deepgram API');
    ws.send(JSON.stringify({ type: 'DeepgramReady' }));
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    try {
      const transcript = data.channel.alternatives[0].transcript;
      
      if (transcript) {
          console.log(`[Deepgram Hears]: ${transcript} | is_final: ${data.is_final}`);
      } else {
          console.log(`[Deepgram Empty]: is_final: ${data.is_final}`);
      }

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

  ws.on('message', (audioData) => {
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

// Start the server
server.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
});