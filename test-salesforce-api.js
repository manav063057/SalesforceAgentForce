#!/usr/bin/env node
/**
 * Simple test script to verify Salesforce Agent API connection
 * Usage: node test-salesforce-api.js
 */

require("dotenv").config();
const salesforceService = require("./salesforce-service");

async function testSalesforceConnection() {
  console.log("🧪 Testing Salesforce Agent API Connection...\n");

  try {
    // Step 1: Get Access Token
    console.log("1️⃣ Obtaining OAuth token...");
    await salesforceService.getAccessToken();

    // Step 2: Create Session
    console.log("\n2️⃣ Creating Agent session...");
    const sessionId = await salesforceService.createSession();

    // Step 3: Send Test Message
    console.log("\n3️⃣ Sending test message...");
    const response = await salesforceService.sendMessage(
      sessionId,
      "Hello, what is my order status?"
    );

    console.log(`\n✅ Agent Response: "${response}"\n`);

    // Step 4: End Session
    console.log("4️⃣ Ending session...");
    await salesforceService.endSession(sessionId);

    console.log("\n✅ All tests passed! Salesforce integration is working.\n");
  } catch (error) {
    console.error("\n❌ Test failed:", error.message);
    console.error("\nPlease verify:");
    console.error("  - SALESFORCE_CLIENT_ID is correct");
    console.error("  - SALESFORCE_CLIENT_SECRET is correct");
    console.error("  - SALESFORCE_INSTANCE_URL is correct");
    console.error("  - SALESFORCE_AGENT_ID exists and is active");
    console.error("  - Connected App has correct OAuth scopes\n");
    process.exit(1);
  }
}

testSalesforceConnection();
