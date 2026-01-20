require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const Twilio = require("twilio");
const http = require("http");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const salesforceService = require("./salesforce-service");

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
const wss = new WebSocketServer({ server });

/**
 * Endpoint 1: Initiate Call (Called by Salesforce)
 */
app.post("/api/initiate-call", async (req, res) => {
  try {
    const { Phone, OrderId, OrderNumber, DeliveryDate, Address } = req.body;

    console.log(`Initiating call to ${Phone} for Order ${OrderNumber}`);

    if (!Phone) return res.status(400).json({ error: "Phone number missing" });

    // Initiate Call via Twilio
    const call = await twilioClient.calls.create({
      to: Phone,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://${req.headers.host}/twiml-stream?name=Customer&order=${OrderNumber}&date=${DeliveryDate}&address=${encodeURIComponent(Address)}`,
    });

    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error("Error initiating call:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint 2: TwiML Webhook (Called by Twilio when user answers)
 */
app.get("/twiml-stream", (req, res) => {
  const twiml = `
    <Response>
        <Connect>
            <Stream url="wss://${req.headers.host}/stream" />
        </Connect>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

/**
 * WebSocket: Handle Audio Stream with AI Integration
 */
wss.on("connection", async (ws) => {
  console.log("📞 New Client Connected to Media Stream");

  let deepgramLive = null;
  let salesforceSession = null;
  let transcriptBuffer = "";

  // Initialize Deepgram if API key is available
  if (process.env.DEEPGRAM_API_KEY) {
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
    deepgramLive = deepgram.listen.live({
      model: "nova-2",
      language: "en-US",
      smart_format: true,
      encoding: "mulaw",
      sample_rate: 8000,
    });

    // Handle Deepgram transcription events
    deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const transcript = data.channel.alternatives[0].transcript;

      if (transcript && transcript.trim().length > 0) {
        console.log(`🎤 Customer said: ${transcript}`);
        transcriptBuffer += transcript + " ";

        // If customer paused (is_final), send to Agent
        if (data.is_final) {
          const userMessage = transcriptBuffer.trim();
          transcriptBuffer = "";

          if (userMessage) {
            await handleAgentConversation(userMessage, salesforceSession, ws);
          }
        }
      }
    });

    deepgramLive.on(LiveTranscriptionEvents.Error, (error) => {
      console.error("❌ Deepgram error:", error);
    });
  }

  // Create Salesforce Agent session if configured
  if (process.env.SALESFORCE_AGENT_ID) {
    try {
      salesforceSession = await salesforceService.createSession();
    } catch (error) {
      console.error("❌ Could not create Salesforce session:", error.message);
    }
  }

  ws.on("message", (message) => {
    const msg = JSON.parse(message);

    switch (msg.event) {
      case "connected":
        console.log("✅ Twilio Media Stream Connected");
        break;

      case "start":
        console.log("🎙️ Stream Started", msg.start);
        break;

      case "media":
        // Forward audio to Deepgram for transcription
        if (deepgramLive) {
          const audioBuffer = Buffer.from(msg.media.payload, "base64");
          deepgramLive.send(audioBuffer);
        }
        break;

      case "stop":
        console.log("🛑 Stream Stopped");
        if (deepgramLive) {
          deepgramLive.finish();
        }
        if (salesforceSession) {
          salesforceService.endSession(salesforceSession);
        }
        break;
    }
  });

  ws.on("close", () => {
    console.log("📴 WebSocket connection closed");
    if (deepgramLive) {
      deepgramLive.finish();
    }
    if (salesforceSession) {
      salesforceService.endSession(salesforceSession);
    }
  });
});

/**
 * Handle conversation with Salesforce Agent
 */
async function handleAgentConversation(userMessage, sessionId, ws) {
  if (!sessionId) {
    console.log("⚠️ No Salesforce session available");
    return;
  }

  try {
    // Send message to Salesforce Agent
    const agentResponse = await salesforceService.sendMessage(sessionId, userMessage);

    // TODO: Convert agent response to speech using ElevenLabs/Google TTS
    // For now, just log it
    console.log(`🤖 Agent Response: ${agentResponse}`);

    // In production, you would:
    // 1. Call ElevenLabs API to convert agentResponse to audio
    // 2. Stream the audio back to Twilio via WebSocket
    // Example (pseudo-code):
    // const audioBuffer = await textToSpeech(agentResponse);
    // ws.send(JSON.stringify({
    //   event: 'media',
    //   media: { payload: audioBuffer.toString('base64') }
    // }));

  } catch (error) {
    console.error("❌ Error in agent conversation:", error);
  }
}

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📋 Deepgram: ${process.env.DEEPGRAM_API_KEY ? "✅ Configured" : "❌ Missing"}`);
  console.log(`🤖 Salesforce Agent: ${process.env.SALESFORCE_AGENT_ID ? "✅ Configured" : "❌ Missing"}`);
});
