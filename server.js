require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const Twilio = require("twilio");
const http = require("http");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const salesforceService = require("./salesforce-service");

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const twilioClient = new Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

// Server Setup
const server = http.createServer(app);

// Simple log buffer for diagnostics
const logs = [];
const log = (msg) => {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  logs.push(entry);
  if (logs.length > 200) logs.shift();
};
// Expose log globally for salesforce-service.js (quick fix for observability)
global.serverLog = log;

/**
 * Diagnostic Endpoint: View recent logs
 */
app.get("/api/logs", (req, res) => {
  res.type("text/plain").send(logs.join("\n"));
});

/**
 * Endpoint 1: Initiate Call (Triggered by Salesforce Batch)
 */
app.post("/api/initiate-call", async (req, res) => {
  const { Phone, OrderNumber, DeliveryDate, OrderId, Address } = req.body;

  try {
    console.log(`📞 Initiating call to: ${Phone} for Order: ${OrderNumber}`);

    const call = await twilioClient.calls.create({
      to: Phone,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://${req.headers.host}/twiml-stream?order=${OrderNumber}`,
    });

    console.log(`✅ Call initiated! SID: ${call.sid}`);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error("❌ Error initiating call:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.all("/twiml-stream", (req, res) => {
  // Extract order number from body (POST) or query (GET)
  const orderNumber = req.body.order || req.query.order || "your order";
  const host = req.headers.host;
  
  log(`📨 TwiML requested (${req.method}). Host: ${host}, Order: ${orderNumber}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">
        Hello, this is a reminder about your order ${orderNumber} is expected to deliver today. Let me know if you have any query.
    </Say>
    <Connect>
        <Stream url="wss://${host}/stream" />
    </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

/**
 * WebSocket: Handle Audio Stream with AI Integration
 */
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", async (ws) => {
  log("📞 New Client Connected to WebSocket");

  let deepgramLive;
  let salesforceSession;

  // Initialize Deepgram for STT (Speech-to-Text)
  if (process.env.DEEPGRAM_API_KEY) {
    deepgramLive = deepgram.listen.live({
      model: "nova-2",
      language: "en-US",
      smart_format: true,
      encoding: "mulaw",
      sample_rate: 8000,
      interim_results: false,
      no_delay: true,
    });

    deepgramLive.on(LiveTranscriptionEvents.Open, () => {
      log("🟢 Deepgram STT connection opened");
    });

    deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript && data.is_final) {
        log(`🎤 [STT] Customer: "${transcript}"`);
        
        // Ensure session is ready
        if (process.env.SALESFORCE_AGENT_ID && !salesforceSession) {
           log("⏳ Salesforce session not ready, waiting...");
           let retries = 0;
           while (!salesforceSession && retries < 5) {
             await new Promise(r => setTimeout(r, 1000));
             retries++;
           }
        }

        // Send to Agent and get response
        await handleAgentConversation(transcript, salesforceSession?.sessionId, ws);
      }
    });

    deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
      log(`🔴 Deepgram Error: ${err.message}`);
    });
  }

  // Create Salesforce Agent session (Async - don't await)
  if (process.env.SALESFORCE_AGENT_ID) {
    log("🔄 Initializing Salesforce Agent session (Background)...");
    salesforceService.createSession().then(sessionData => {
       salesforceSession = sessionData;
       log(`✅ Salesforce session ready: ${salesforceSession.sessionId}`);
    }).catch(error => {
       log(`❌ Could not create Salesforce session: ${error.message}`);
    });
  }

  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case "connected":
          log("✅ Twilio WebSocket Connected");
          break;

        case "start":
          ws.streamSid = msg.start.streamSid; // Save for TTS streaming
          log(`🎙️ Stream Started. ID: ${ws.streamSid}`);
          break;

        case "media":
          // Forward audio to Deepgram for transcription
          if (deepgramLive) {
            const audioBuffer = Buffer.from(msg.media.payload, "base64");
            deepgramLive.send(audioBuffer);
          }
          break;

        case "stop":
          log("🛑 Stream Stopped");
          if (deepgramLive) deepgramLive.finish();
          if (salesforceSession) salesforceService.endSession(salesforceSession.sessionId);
          break;
      }
    } catch (e) {
      log(`❌ Error parsing WebSocket message: ${e.message}`);
    }
  });

  ws.on("close", () => {
    log("📴 WebSocket connection closed");
    if (deepgramLive) {
      deepgramLive.finish();
    }
    if (salesforceSession) {
      salesforceService.endSession(salesforceSession.sessionId);
    }
  });
});

/**
 * Handle conversation with Salesforce Agent and speak response back
 */
async function handleAgentConversation(userMessage, sessionId, ws) {
  let agentResponse;

  log(`🤖 [Agent] Processing message: "${userMessage}"...`);

  if (!sessionId) {
    log("⚠️ No Salesforce session - Falling back to Mock Agent");
    agentResponse = "I am a mock agent. Salesforce is still connecting, but I heard: " + userMessage;
  } else {
    try {
      // Send message to Salesforce Agent
      const response = await salesforceService.sendMessage(sessionId, userMessage);
      
      // Handle multiple message parts if present
      if (Array.isArray(response)) {
        agentResponse = response.join(" ");
      } else {
        agentResponse = response;
      }
      
    } catch (error) {
      log(`❌ Error in agent conversation: ${error.message}`);
      agentResponse = "I'm having trouble connecting to Salesforce right now.";
    }
  }

  log(`🤖 [Agent] Response: ${agentResponse}`);

  if (agentResponse && ws.streamSid) {
    try {
      log(`🔊 [TTS] Starting voice generation for: "${agentResponse.substring(0, 30)}..."`);
      
      // Convert text to speech using Deepgram Aura
      const ttsResponse = await deepgram.speak.request(
        { text: agentResponse },
        {
          model: "aura-asteria-en",
          encoding: "mulaw",
          sample_rate: 8000,
          container: "none"
        }
      );

      const audioStream = await ttsResponse.getStream();
      
      if (audioStream) {
        let chunkCount = 0;
        let totalBytes = 0;
        for await (const chunk of audioStream) {
          totalBytes += chunk.length;
          ws.send(JSON.stringify({
            event: "media",
            streamSid: ws.streamSid,
            media: {
              payload: chunk.toString("base64")
            }
          }));
          chunkCount++;
        }
        log(`✅ [TTS] Sent ${chunkCount} audio chunks (${totalBytes} bytes) to customer`);
      }
    } catch (error) {
      log(`❌ Error in Deepgram TTS: ${error.message}`);
    }
  } else {
    if (!ws.streamSid) log("⚠️ Cannot play audio: Missing streamSid");
    if (!agentResponse) log("⚠️ Cannot play audio: Empty agentResponse");
  }
}

server.listen(PORT, () => {
  log(`🚀 Server listening on port ${PORT}`);
  log(`📋 Deepgram API: ${process.env.DEEPGRAM_API_KEY ? "✅ Configured" : "❌ Missing"}`);
  log(`🤖 Salesforce Agent: ${process.env.SALESFORCE_AGENT_ID ? "✅ Configured" : "❌ Missing"}`);
});
