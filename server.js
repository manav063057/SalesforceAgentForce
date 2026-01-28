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

/**
 * Endpoint 2: TwiML Webhook (Called by Twilio when user answers)
 */
app.get("/twiml-stream", (req, res) => {
  // Extract order number from query parameter
  const orderNumber = req.query.order || "your order";
  
  const twiml = `
    <Response>
        <Say voice="Polly.Joanna">
            Hello, this is a reminder about your order ${orderNumber} is expected to deliver today. Let me know if you have any query.
        </Say>
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
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", async (ws) => {
  console.log("📞 New Client Connected to WebSocket");

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
      console.log("🟢 Deepgram STT connection opened");
    });

    deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript && data.is_final) {
        console.log(`🎤 Customer said: ${transcript}`);
        // Send to Agent and get response
        await handleAgentConversation(transcript, salesforceSession?.sessionId, ws);
      }
    });

    deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
      console.error("🔴 Deepgram Error:", err);
    });
  }

  // Create Salesforce Agent session if configured
  if (process.env.SALESFORCE_AGENT_ID) {
    try {
      const sessionData = await salesforceService.createSession();
      salesforceSession = sessionData;
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
        ws.streamSid = msg.start.streamSid; // Save for TTS streaming
        console.log("🎙️ Stream Started", msg.start.streamSid);
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
        if (deepgramLive) deepgramLive.finish();
        if (salesforceSession) salesforceService.endSession(salesforceSession.sessionId);
        break;
    }
  });

  ws.on("close", () => {
    console.log("📴 WebSocket connection closed");
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

  if (!sessionId) {
    console.log("⚠️ No Salesforce session available - Using Mock Agent");
    agentResponse = "I am a mock agent. Salesforce is currently offline, but I received your message: " + userMessage;
  } else {
    try {
      // Send message to Salesforce Agent
      agentResponse = await salesforceService.sendMessage(sessionId, userMessage);
    } catch (error) {
      console.error("❌ Error in agent conversation:", error);
      agentResponse = "I'm having trouble connecting to Salesforce right now.";
    }
  }

  // Log the response (Mock or Real)
  console.log(`🤖 Agent Response: ${agentResponse}`);

  if (agentResponse && ws.streamSid) {
    try {
      // Convert text to speech using Deepgram Aura
      const ttsResponse = await deepgram.speak.request(
        { text: agentResponse },
        {
          model: "aura-asteria-en", // Natural female voice
          encoding: "mulaw",         // Twilio format
          sample_rate: 8000,         // Twilio requirement
          container: "none"          // Raw audio stream
        }
      );

      const audioStream = await ttsResponse.getStream();
      
      // Stream audio back to Twilio
      if (audioStream) {
        for await (const chunk of audioStream) {
          ws.send(JSON.stringify({
            event: "media",
            streamSid: ws.streamSid,
            media: {
              payload: chunk.toString("base64")
            }
          }));
        }
        console.log("🔊 Sent voice response back to customer");
      }
    } catch (error) {
      console.error("❌ Error in Deepgram TTS:", error.message);
    }
  }
}

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📋 Deepgram: ${process.env.DEEPGRAM_API_KEY ? "✅ Configured" : "❌ Missing"}`);
  console.log(`🤖 Salesforce Agent: ${process.env.SALESFORCE_AGENT_ID ? "✅ Configured" : "❌ Missing"}`);
});
