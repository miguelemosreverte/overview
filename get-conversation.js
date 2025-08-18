#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Parse command line arguments
const args = process.argv.slice(2);
const projectName = args[0];
const count = parseInt(args[1]) || 3;
const provider = args[2]; // optional: filter by provider

if (!projectName) {
  console.log('Usage: node get-conversation.js <project-name> [count] [provider]');
  console.log('Example: node get-conversation.js overview 5');
  console.log('Example: node get-conversation.js overview 3 claude');
  process.exit(1);
}

// Convert project name to ID format
const projectId = projectName.replace(/[^a-zA-Z0-9]/g, '_');

// Path to conversation file
const CLAUDE_STATUS_DIR = path.join(os.homedir(), '.claude');
const CONVERSATIONS_DIR = path.join(CLAUDE_STATUS_DIR, 'conversations');
const conversationFile = path.join(CONVERSATIONS_DIR, `${projectId}.json`);

async function getConversations() {
  try {
    const data = await fs.readFile(conversationFile, 'utf-8');
    let conversations = JSON.parse(data);
    
    // Filter by provider if specified
    if (provider) {
      conversations = conversations.filter(msg => msg.provider === provider);
    }
    
    // Get last N messages
    const recent = conversations.slice(-count);
    
    if (recent.length === 0) {
      console.log('No conversations found.');
      return;
    }
    
    // Display conversations
    console.log(`\n=== Last ${recent.length} conversations for ${projectName} ===\n`);
    
    recent.forEach(msg => {
      const timestamp = new Date(msg.timestamp).toLocaleString();
      const role = msg.role === 'user' ? '👤 User' : '🤖 AI';
      const providerLabel = msg.provider ? ` (${msg.provider})` : '';
      
      console.log(`${role}${providerLabel} - ${timestamp}`);
      console.log(msg.content);
      console.log('---');
    });
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`No conversation history found for project: ${projectName}`);
    } else {
      console.error('Error reading conversation:', error);
    }
  }
}

getConversations();