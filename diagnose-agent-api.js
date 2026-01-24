#!/usr/bin/env node
/**
 * Diagnostic script to test Agent API access
 */

require("dotenv").config();
const axios = require("axios");

async function diagnose() {
  console.log("🔍 Salesforce Agent API Diagnostic Tool\n");
  
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
  const agentId = process.env.SALESFORCE_AGENT_ID;

  // Step 1: Get token
  console.log("1️⃣ Getting OAuth token...");
  try {
    const tokenResponse = await axios.post(
      `${instanceUrl}/services/oauth2/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    
    const token = tokenResponse.data.access_token;
    console.log("✅ Token obtained\n");

    // Step 2: Test API versions
    console.log("2️⃣ Testing API versions...");
    const versions = await axios.get(
      `${instanceUrl}/services/data/`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    
    const latestVersion = versions.data[versions.data.length - 1].version;
    console.log(`✅ Latest API version: v${latestVersion}\n`);

    // Step 3: Try multiple Agent API endpoints
    console.log("3️⃣ Testing Agent API endpoints...\n");
    
    const endpointsToTest = [
      {
        name: "Connect API (agent-sessions)",
        url: `${instanceUrl}/services/data/v${latestVersion}/connect/agent-sessions`,
        method: "POST",
        body: { agentId },
      },
      {
        name: "Einstein API (ai-agents)",
        url: `${instanceUrl}/services/data/v${latestVersion}/einstein/ai-agents/${agentId}/sessions`,
        method: "POST",
        body: {},
      },
      {
        name: "Agent API (legacy)",
        url: `${instanceUrl}/services/data/v${latestVersion}/agent/sessions`,
        method: "POST",
        body: { agentId },
      },
    ];

    for (const endpoint of endpointsToTest) {
      try {
        console.log(`   Testing: ${endpoint.name}`);
        console.log(`   URL: ${endpoint.url}`);
        
        const response = await axios({
          method: endpoint.method,
          url: endpoint.url,
          data: endpoint.body,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        
        console.log(`   ✅ SUCCESS! Status: ${response.status}`);
        console.log(`   Response:`, JSON.stringify(response.data, null, 2));
        console.log("");
        return; // Stop on first success
        
      } catch (error) {
        console.log(`   ❌ Failed: ${error.response?.status || 'Network Error'}`);
        if (error.response?.data) {
          console.log(`   Error:`, JSON.stringify(error.response.data, null, 2));
        }
        console.log("");
      }
    }

    // Step 4: Verify Agent exists using SOQL
    console.log("4️⃣ Checking if Agent exists in org...");
    try {
      const query = `SELECT Id, MasterLabel, Status FROM AIAgent WHERE Id = '${agentId}'`;
      const soqlResponse = await axios.get(
        `${instanceUrl}/services/data/v${latestVersion}/query/?q=${encodeURIComponent(query)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      if (soqlResponse.data.totalSize > 0) {
        console.log("✅ Agent found:");
        console.log(JSON.stringify(soqlResponse.data.records[0], null, 2));
      } else {
        console.log("❌ Agent not found with ID:", agentId);
        console.log("\n🔍 Tip: Check your Agent ID in Setup → Agent Builder");
      }
    } catch (error) {
      console.log("❌ Could not query agents:", error.response?.data || error.message);
    }

  } catch (error) {
    console.error("❌ OAuth failed:", error.response?.data || error.message);
  }
}

diagnose();
