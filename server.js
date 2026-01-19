require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const Twilio = require("twilio");
const http = require("http");

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
    // We pass custom params so the webhook knows the context
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
  // Construct TwiML
  // We start a Media Stream connected to our WebSocket
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
 * WebSocket: Handle Audio Stream
 */
wss.on("connection", (ws) => {
  console.log("New Client Connected to Media Stream");

  ws.on("message", (message) => {
    const msg = JSON.parse(message);
    switch (msg.event) {
      case "connected":
        console.log("Twilio Media Stream Connected");
        break;
      case "start":
        console.log("Stream Started", msg.start);
        break;
      case "media":
        // Payload is base64 encoded audio
        // TODO: Send to Speech-to-Text Service (Deepgram/Google)
        // console.log('Received Audio Chunk');
        break;
      case "stop":
        console.log("Stream Stopped");
        break;
    }
  });

  // Placeholder: Simulate sending audio back (Greeting)
  // In real app, this comes from TTS service
  // ws.send(JSON.stringify({ event: 'media', media: { payload: '...' } }));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
