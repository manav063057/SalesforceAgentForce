const axios = require("axios");

class SalesforceService {
  constructor() {
    this.clientId = process.env.SALESFORCE_CLIENT_ID;
    this.clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
    this.instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
    this.agentId = process.env.SALESFORCE_AGENT_ID;
    this.accessToken = null;
    this.tokenExpiry = null;
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
   * @returns {string} sessionId
   */
  async createSession() {
    const token = await this.getAccessToken();

    try {
      const response = await axios.post(
        `${this.instanceUrl}/services/data/v60.0/einstein/ai-agents/${this.agentId}/sessions`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("✅ Agent session created:", response.data.sessionId);
      return response.data.sessionId;
    } catch (error) {
      console.error("❌ Error creating session:", error.response?.data || error.message);
      throw error;
    }
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
      const response = await axios.post(
        `${this.instanceUrl}/services/data/v60.0/einstein/ai-agents/${this.agentId}/sessions/${sessionId}/messages`,
        {
          message: userMessage,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      const agentReply = response.data.messages?.[0]?.text || "I didn't understand that.";
      console.log(`🤖 Agent: ${agentReply}`);
      return agentReply;
    } catch (error) {
      console.error("❌ Error sending message:", error.response?.data || error.message);
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
      await axios.delete(
        `${this.instanceUrl}/services/data/v60.0/einstein/ai-agents/${this.agentId}/sessions/${sessionId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      console.log("✅ Session ended:", sessionId);
    } catch (error) {
      console.error("❌ Error ending session:", error.response?.data || error.message);
    }
  }
}

module.exports = new SalesforceService();
