const axios = require("axios");

class SalesforceService {
  constructor() {
    this.clientId = process.env.SALESFORCE_CLIENT_ID ? process.env.SALESFORCE_CLIENT_ID.trim() : "";
    this.clientSecret = process.env.SALESFORCE_CLIENT_SECRET ? process.env.SALESFORCE_CLIENT_SECRET.trim() : "";
    this.instanceUrl = process.env.SALESFORCE_INSTANCE_URL ? process.env.SALESFORCE_INSTANCE_URL.trim() : "";
    this.agentId = process.env.SALESFORCE_AGENT_ID ? process.env.SALESFORCE_AGENT_ID.trim() : "";
    this.accessToken = null;
    this.tokenExpiry = null;
    this.sessionSequences = new Map(); // Track sequence IDs for sessions
  }

  /**
   * Get OAuth 2.0 Access Token using Client Credentials Flow
   */
  async getAccessToken() {
    // Return cached token if valid
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      if (!this.instanceUrl) {
          throw new Error("Missing SALESFORCE_INSTANCE_URL environment variable");
      }
      if (!this.clientId || !this.clientSecret) {
          throw new Error("Missing Salesforce Client ID or Secret");
      }

      const response = await axios.post(
        `${this.instanceUrl}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );

      this.accessToken = response.data.access_token;
      // Set expiry to 1 hour (Salesforce default) minus 5 min buffer
      this.tokenExpiry = Date.now() + 55 * 60 * 1000;

      console.log("✅ Salesforce OAuth token obtained");
      return this.accessToken;
    } catch (error) {
      console.error("❌ Error getting Salesforce token:", error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Create a new Agent session
   * @returns {object} {sessionId, sessionKey}
   */
  async createSession() {
    const token = await this.getAccessToken();
    const sessionKey = this.generateUUID();

    try {
      // Use the global Einstein AI Agent API endpoint (matches Postman)
      const url = `https://api.salesforce.com/einstein/ai-agent/v1/agents/${this.agentId}/sessions`;
      
      console.log("🔍 [DEBUG] Creating Session with:");
      if (global.serverLog) {
         global.serverLog(`🔍 [DEBUG] Creating Session with:`);
         global.serverLog(`   - URL: ${url}`);
         global.serverLog(`   - Agent ID: ${this.agentId}`);
         global.serverLog(`   - Instance URL: ${this.instanceUrl}`);
      }

      const response = await axios.post(
        url,
        {
          externalSessionKey: sessionKey,
          instanceConfig: {
            endpoint: this.instanceUrl
          },
          streamingCapabilities: {
            chunkTypes: ["Text"]
          },
          bypassUser: true
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-client-feature-id": "ai-agent-api" // Often required for this API
          },
        }
      );

      // The response structure might be different, logging keys to be sure
      console.log("✅ API Response Keys:", Object.keys(response.data));
      
      const sessionId = response.data.sessionId || response.data.id;
      console.log("✅ Agent session created:", sessionId);
      
      // Initialize sequence ID for this session
      this.sessionSequences.set(sessionId, 1);
      
      return { sessionId, sessionKey };
    } catch (error) {
      console.error("❌ Error creating session:", error.response?.data || error.message);
      // Fallback log for URL verification
      if (error.response?.status === 404) {
          console.error("URL Attempted:", `${this.instanceUrl}/services/data/v60.0/einstein/ai-agent/v1/agents/${this.agentId}/sessions`);
      }
      throw error;
    }
  }

  /**
   * Generate a random UUID for session key
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Send message to Agent and get response
   * @param {string} sessionId
   * @param {string} userMessage
   * @returns {string} agentResponse
   */
  async sendMessage(sessionId, userMessage) {
    const token = await this.getAccessToken();

    try {
      // Get and increment sequence ID
      const sequenceId = this.sessionSequences.get(sessionId) || 1;
      this.sessionSequences.set(sessionId, sequenceId + 1);

      // Global Einstein AI Agent API endpoint
      const url = `https://api.salesforce.com/einstein/ai-agent/v1/sessions/${sessionId}/messages`;

      const response = await axios.post(
        url,
        {
          message: {
            sequenceId: sequenceId,
            type: "Text",
            text: userMessage
          }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-client-feature-id": "ai-agent-api"
          },
        }
      );

      // Parse response - API returns messages array
      const messages = response.data.messages || [];
      const agentReply = messages.length > 0 ? messages[messages.length - 1].text : "I didn't understand that.";
      
      console.log(`🤖 Agent: ${agentReply}`);
      return agentReply;
    } catch (error) {
      console.error("❌ Error sending message:", error.response?.data || error.message);
      // Fallback: If 404, maybe session expired or URL wrong
       if (error.response?.status === 404) {
          console.error("URL Attempted:", `${this.instanceUrl}/services/data/v60.0/einstein/ai-agent/v1/sessions/${sessionId}/messages`);
      }
      return "Sorry, I'm having trouble connecting right now.";
    }
  }

  /**
   * End an Agent session
   * @param {string} sessionId
   */
  async endSession(sessionId) {
    const token = await this.getAccessToken();

    try {
      // Global Einstein AI Agent API endpoint
      await axios.delete(
        `https://api.salesforce.com/einstein/ai-agent/v1/sessions/${sessionId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-session-end-reason": "UserRequest"
          },
        }
      );

      console.log("✅ Session ended:", sessionId);
      this.sessionSequences.delete(sessionId);
    } catch (error) {
      console.error("❌ Error ending session:", error.response?.data || error.message);
    }
  }
}

module.exports = new SalesforceService();
