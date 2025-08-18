const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const WebSocket = require('ws');
const pty = require('node-pty');
const http = require('http');
const yaml = require('js-yaml');
const chokidar = require('chokidar');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files including images
const PORT = 3000;
const DESKTOP_PATH = '/Users/miguel_lemos/Desktop';
const CLAUDE_STATUS_DIR = path.join(DESKTOP_PATH, '.claude');
const PROJECTS_CONFIG_FILE = path.join(DESKTOP_PATH, 'projects.yaml');

// Create HTTP server
const server = http.createServer(app);

// Single WebSocket server for all communications
const wss = new WebSocket.Server({ server });

// Store active terminal sessions - these persist across minimize/maximize
const terminals = new Map();
const terminalStates = new Map(); // Track state for each project
const fileWatchers = new Map(); // Track file watchers for projects
const nodeServers = new Map(); // Track running Node.js servers for projects
const usedPorts = new Set(); // Track used ports to avoid collisions

// Load projects configuration
async function loadProjectsConfig() {
  try {
    const configContent = await fs.readFile(PROJECTS_CONFIG_FILE, 'utf8');
    return yaml.load(configContent) || {};
  } catch (error) {
    // Config doesn't exist yet
    return {};
  }
}

// Save projects configuration
async function saveProjectsConfig(config) {
  const yamlContent = yaml.dump(config, { indent: 2 });
  await fs.writeFile(PROJECTS_CONFIG_FILE, yamlContent);
}

// Save scroll position for a project
async function saveProjectScrollPosition(projectName, scrollData) {
  try {
    const config = await loadProjectsConfig();
    if (!config.scrollPositions) {
      config.scrollPositions = {};
    }
    config.scrollPositions[projectName] = scrollData;
    await saveProjectsConfig(config);
  } catch (error) {
    console.error('Error saving scroll position:', error);
  }
}

// Ensure .claude directory exists
async function ensureClaudeDir() {
  try {
    await fs.mkdir(CLAUDE_STATUS_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating .claude directory:', error);
  }
}

// Path for persistent terminal states
const TERMINAL_STATES_FILE = path.join(CLAUDE_STATUS_DIR, 'terminal-states.json');

// Path for conversation history
const CONVERSATIONS_DIR = path.join(CLAUDE_STATUS_DIR, 'conversations');

// Ensure conversations directory exists (create it lazily when needed)
function ensureConversationsDir() {
  if (!require('fs').existsSync(CONVERSATIONS_DIR)) {
    require('fs').mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    console.log('Created conversations directory:', CONVERSATIONS_DIR);
  }
}

// Save terminal states to disk
async function saveTerminalStatesToDisk() {
  try {
    const states = {};
    for (const [id, state] of terminalStates.entries()) {
      // Only save essential data (not the terminal instance)
      states[id] = {
        projectPath: state.projectPath,
        projectName: state.projectName,
        hasSession: true,
        preferredAI: state.preferredAI || null,
        aiType: state.aiType || null,
        conversationContext: state.conversationContext || null
      };
    }
    await fs.writeFile(TERMINAL_STATES_FILE, JSON.stringify(states, null, 2));
  } catch (error) {
    console.error('Error saving terminal states:', error);
  }
}

// Load terminal states from disk
async function loadTerminalStatesFromDisk() {
  try {
    const data = await fs.readFile(TERMINAL_STATES_FILE, 'utf-8');
    const states = JSON.parse(data);
    for (const [id, state] of Object.entries(states)) {
      terminalStates.set(id, state);
    }
    console.log('Loaded terminal states:', terminalStates.size);
  } catch (error) {
    // File might not exist on first run
    if (error.code !== 'ENOENT') {
      console.error('Error loading terminal states:', error);
    }
  }
}

// Save conversation exchange to disk
async function saveConversationExchange(projectId, role, content) {
  try {
    // Aggressively clean the content before saving
    const cleanContent = content
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // Remove ALL ANSI escape sequences
      .replace(/\[\?[0-9;]+[a-z]/gi, '') // Remove device control sequences like [?1;2c
      .replace(/\[[0-9]*[A-Z]/g, '') // Remove cursor movement like [2K, [1A
      .replace(/\[[\dA-Z]+/g, '') // Remove any remaining bracket sequences
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
      .replace(/[╭─╮│╰╯┌┐└┘├┤┬┴┼]/g, '') // Remove box drawing characters
      .trim();
    
    // Skip if the content is mostly garbage
    if (cleanContent.length < 5 || 
        cleanContent.includes('[2K') || 
        cleanContent.includes('[1A') ||
        cleanContent.includes('[O') ||
        cleanContent.includes('[I')) {
      console.log(`Skipping garbage message: "${content.slice(0, 30)}..."`);
      return;
    }
    
    ensureConversationsDir(); // Make sure directory exists
    
    const conversationFile = path.join(CONVERSATIONS_DIR, `${projectId}.json`);
    let conversations = [];
    
    // Load existing conversations if file exists
    if (require('fs').existsSync(conversationFile)) {
      const data = await fs.readFile(conversationFile, 'utf-8');
      conversations = JSON.parse(data);
    }
    
    // Add new exchange with cleaned content
    conversations.push({
      role: role, // 'user' or 'assistant' 
      content: cleanContent,
      timestamp: new Date().toISOString(),
      provider: terminalStates.get(projectId)?.aiType || 'unknown'
    });
    
    // Keep only last 100 exchanges to prevent file from getting too large
    if (conversations.length > 100) {
      conversations = conversations.slice(-100);
    }
    
    // Save to disk
    await fs.writeFile(conversationFile, JSON.stringify(conversations, null, 2));
    console.log(`Saved clean ${role} message for ${projectId}: ${cleanContent.slice(0, 50)}...`);
  } catch (error) {
    console.error('Error saving conversation:', error);
  }
}

// Get last N conversation exchanges
async function getRecentConversations(projectId, count = 3) {
  try {
    const conversationFile = path.join(CONVERSATIONS_DIR, `${projectId}.json`);
    
    if (!require('fs').existsSync(conversationFile)) {
      // If no file exists, return empty array
      return [];
    }
    
    const data = await fs.readFile(conversationFile, 'utf-8');
    let conversations = JSON.parse(data);
    
    // Filter out any messages with escape sequences
    conversations = conversations.filter(msg => {
      const content = msg.content || '';
      // Skip messages that contain terminal escape codes
      return !content.includes('[2K') && 
             !content.includes('[1A') && 
             !content.includes('[?') &&
             !content.includes('[O') &&
             !content.includes('[I') &&
             content.length > 5;
    });
    
    // Return last N clean exchanges
    return conversations.slice(-count);
  } catch (error) {
    console.error('Error loading conversations:', error);
    return [];
  }
}

// Save conversation state
async function saveConversationState(projectPath, projectName) {
  const timestamp = new Date().toISOString()
    .replace(/T/, '--')
    .replace(/:/g, '-')
    .replace(/\..+/, '');
  
  const statusFile = path.join(CLAUDE_STATUS_DIR, `status-${timestamp}.md`);
  
  const content = `# Claude Session Status
**Project**: ${projectName}
**Path**: ${projectPath}
**Timestamp**: ${new Date().toISOString()}
**Session**: Saved for recovery

## Session Context
This session was automatically saved when:
- The terminal was minimized
- The server was shut down

## Recovery Instructions
To resume this session, use:
\`\`\`bash
cd "${projectPath}"
claude --continue
\`\`\`

## Notes
- Session data is preserved in Claude's internal session management
- Use \`claude --resume\` to interactively select from multiple sessions
- This status file helps track when and why sessions were saved
`;
  
  try {
    await fs.writeFile(statusFile, content);
    console.log(`Session state saved to ${statusFile}`);
  } catch (error) {
    console.error('Error saving session state:', error);
  }
}

// Project metadata with descriptions
const projectDescriptions = {
  '3p-false-positives-histograms': {
    tech: 'Go, SQLite, PostgreSQL',
    description: 'Traffic incident false positives analysis and reporting system with comprehensive dashboard generation for multiple regions.',
    category: 'Data Analysis',
    icon: '📊'
  },
  '3p-false-positives-histograms_old': {
    tech: 'Go, SQLite',
    description: 'Previous version of the false positives analysis system.',
    category: 'Archive',
    icon: '📦'
  },
  '3p-false-positives-histograms_trying_out': {
    tech: 'Go, SQLite',
    description: 'Experimental branch for testing new analysis approaches.',
    category: 'Experimental',
    icon: '🧪'
  },
  '3p-scala': {
    tech: 'Scala',
    description: 'Scala-based traffic data processing experiments.',
    category: 'Data Processing',
    icon: '🔧'
  },
  '3p-snapshot-improving-ingest': {
    tech: 'Go',
    description: 'Improved ingestion pipeline for traffic incident snapshots.',
    category: 'Data Pipeline',
    icon: '⚡'
  },
  '3p-snapshot-working-here-on-ingest-while-3p-snapshot-works-on-actual-report-workflow': {
    tech: 'Python',
    description: 'Parallel development branch for ingestion improvements.',
    category: 'Data Pipeline',
    icon: '🔄'
  },
  '3p-snapshot': {
    tech: 'Python',
    description: 'Traffic incident data analysis with workflow automation and geospatial processing.',
    category: 'Data Analysis',
    icon: '📷'
  },
  '3p-sqlite-wip': {
    tech: 'Go, SQLite',
    description: 'SQLite database exploration and direct manipulation tools.',
    category: 'Database Tools',
    icon: '🗃️'
  },
  'agents': {
    tech: 'Python, Ollama, SQLite',
    description: 'Multi-agent AI system for database exploration and insight generation with progressive scenario-based learning.',
    category: 'AI/ML',
    icon: '🤖'
  },
  'architecture-rust-web-gpu': {
    tech: 'Rust, WebGPU, WGSL',
    description: '3D architectural visualization system with composable primitives, native & web support.',
    category: 'Graphics',
    icon: '🏗️'
  },
  'blueprint-generation': {
    tech: 'Python, Scala, Ollama',
    description: 'AI-assisted exploration of SQLite databases with function calling and conversation management.',
    category: 'AI/ML',
    icon: '🔍'
  },
  'charts': {
    tech: 'WebGPU, JavaScript, Node.js',
    description: 'High-performance GPU-accelerated charting library with smart labeling, handles 100K+ data points.',
    category: 'Visualization',
    icon: '📈'
  },
  'claude-as-a-service': {
    tech: 'Go, Claude API, SQLite',
    description: 'Production-ready CSV processor using Claude AI for schedule extraction. Processed 669K+ traffic incidents.',
    category: 'AI/Production',
    icon: '⚙️'
  },
  'client-server-gi-working': {
    tech: 'Node.js, Express, Three.js',
    description: 'Server-based Global Illumination with texture atlas delivery and event-driven updates.',
    category: 'Graphics',
    icon: '💡'
  },
  'cornell-box-restir': {
    tech: 'Rust, WebGPU, Path Tracing',
    description: 'GPU-accelerated path tracer implementing ReSTIR algorithm with voxel-based rendering.',
    category: 'Graphics',
    icon: '🎨'
  },
  'data-pipelines': {
    tech: 'Scala, Scio, Kafka, Docker',
    description: 'Production ETL pipeline processing Protobuf events from Kafka to MySQL with Kubernetes deployment.',
    category: 'Data Pipeline',
    icon: '🔀'
  },
  'four-legged-simulation': {
    tech: 'Rust, WebGPU, Bevy, Rapier3D',
    description: 'GPU-accelerated genetic algorithm for quadruped robot evolution. Evaluates 4096 individuals in parallel.',
    category: 'Simulation',
    icon: '🦾'
  },
  'interview-pyspark': {
    tech: 'Python, PySpark, Flask',
    description: 'Gamified PySpark learning platform with typing trainer and 12 progressive challenges.',
    category: 'Education',
    icon: '🎓'
  },
  'kpi-driven-agentic-coding': {
    tech: 'Go, SQLite',
    description: 'Collaborative agent-based CSV processing with schedule pattern extraction. Found 5,379 unique patterns.',
    category: 'AI/Data Processing',
    icon: '📋'
  },
  'TableauConflationReports': {
    tech: 'Go, Tableau, PostgreSQL',
    description: 'Automated Tableau workbook generation for traffic incident reports with region-specific processing.',
    category: 'Reporting',
    icon: '📊'
  },
  'euskadi_analisis': {
    tech: 'XML, GeoJSON',
    description: 'Regional traffic data analysis for Euskadi/Basque region with GeoJSON normalization.',
    category: 'Data Analysis',
    icon: '🗺️'
  },
  'dot.mobi.ind': {
    tech: 'Python, HTML',
    description: 'Mobile traffic incident analysis and visualization.',
    category: 'Mobile/Analysis',
    icon: '📱'
  },
  '?': {
    tech: 'HTML',
    description: 'Experimental project or placeholder.',
    category: 'Experimental',
    icon: '❓'
  },
  '\\/': {
    tech: 'Go, Shell Scripts',
    description: 'Benchmark and validation system for incident resolution approaches.',
    category: 'Testing',
    icon: '🧪'
  }
};

// Get last modified time for a directory
async function getLastModified(dirPath) {
  try {
    const stats = await fs.stat(dirPath);
    return stats.mtime;
  } catch (error) {
    return new Date(0);
  }
}

// Check if directory is a git repo and get status
async function getGitInfo(dirPath) {
  try {
    const { stdout: isRepo } = await execPromise(`cd "${dirPath}" && git rev-parse --is-inside-work-tree 2>/dev/null`);
    if (isRepo.trim() === 'true') {
      const { stdout: lastCommit } = await execPromise(`cd "${dirPath}" && git log -1 --format="%cr" 2>/dev/null`);
      const { stdout: branch } = await execPromise(`cd "${dirPath}" && git branch --show-current 2>/dev/null`);
      const { stdout: status } = await execPromise(`cd "${dirPath}" && git status --porcelain 2>/dev/null`);
      
      return {
        isGitRepo: true,
        lastCommit: lastCommit.trim() || 'No commits',
        branch: branch.trim() || 'main',
        hasUncommittedChanges: status.trim().length > 0
      };
    }
  } catch (error) {
    // Not a git repo or git not available
  }
  return { isGitRepo: false };
}

// Get project info
async function getProjectInfo(dirName) {
  const fullPath = path.join(DESKTOP_PATH, dirName);
  const stats = await fs.stat(fullPath);
  
  if (!stats.isDirectory()) {
    return null;
  }
  
  const lastModified = await getLastModified(fullPath);
  const gitInfo = await getGitInfo(fullPath);
  const metadata = projectDescriptions[dirName] || {
    tech: 'Unknown',
    description: 'No description available.',
    category: 'Uncategorized',
    icon: '📁'
  };
  
  return {
    name: dirName,
    path: fullPath,
    lastModified: lastModified,
    ...metadata,
    ...gitInfo
  };
}

// Check if project has index.html
async function hasIndexHtml(projectPath) {
  try {
    await fs.access(path.join(projectPath, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

// Check if project is a Node.js project
async function isNodeProject(projectPath) {
  try {
    await fs.access(path.join(projectPath, 'package.json'));
    const packageJson = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8'));
    
    // Check for common server files or start scripts
    const serverFiles = [
      'server.js',
      'app.js', 
      'index.js',
      'dashboard.js',
      'main.js',
      'start.js'
    ];
    
    // Also check the main field in package.json
    if (packageJson.main && packageJson.main.endsWith('.js')) {
      serverFiles.push(packageJson.main);
    }
    
    const hasServerFile = await Promise.any(
      serverFiles.map(file => 
        fs.access(path.join(projectPath, file)).then(() => true)
      )
    ).catch(() => false);
    
    const hasStartScript = packageJson.scripts && (
      packageJson.scripts.start || 
      packageJson.scripts.dev ||
      packageJson.scripts.serve
    );
    
    // Also check if it has Express or other web framework dependencies
    const hasWebFramework = packageJson.dependencies && (
      packageJson.dependencies.express ||
      packageJson.dependencies.koa ||
      packageJson.dependencies.fastify ||
      packageJson.dependencies.hapi
    );
    
    return hasServerFile || hasStartScript || hasWebFramework;
  } catch {
    return false;
  }
}

// Get an available port in the 9500-9600 range
function getAvailablePort() {
  for (let port = 9500; port <= 9600; port++) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error('No available ports in range 9500-9600');
}

// Start Node.js server for a project
async function startNodeServer(projectName, projectPath) {
  // Prevent recursive self-hosting - don't start overview within itself
  if (projectName === 'overview' || projectPath.includes('/overview')) {
    throw new Error('Cannot start overview dashboard within itself (would cause recursion)');
  }
  
  // Check if server is already running
  if (nodeServers.has(projectName)) {
    return nodeServers.get(projectName);
  }
  
  const port = getAvailablePort();
  
  try {
    // Check for package.json to determine the right command
    const packageJson = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8'));
    
    let command;
    let args;
    
    // Determine which script to run
    if (packageJson.scripts) {
      if (packageJson.scripts.dev) {
        // Use npm run dev if available (likely already uses nodemon)
        command = 'npm';
        args = ['run', 'dev'];
      } else if (packageJson.scripts.start) {
        // Use nodemon with the start script's target
        const startScript = packageJson.scripts.start;
        const match = startScript.match(/node\s+(.+)/);
        if (match) {
          command = 'nodemon';
          args = [match[1], '--port', port.toString()];
        } else {
          command = 'npm';
          args = ['start'];
        }
      } else {
        // Default to nodemon with common entry points
        const serverFiles = [
          'server.js',
          'app.js',
          'index.js',
          'dashboard.js',
          'main.js',
          'start.js'
        ];
        
        // Check package.json main field
        if (packageJson.main && packageJson.main.endsWith('.js')) {
          serverFiles.unshift(packageJson.main);
        }
        
        const entryPoint = await Promise.any(
          serverFiles.map(file => 
            fs.access(path.join(projectPath, file)).then(() => file)
          )
        ).catch(() => 'index.js');
        
        command = 'nodemon';
        args = [entryPoint];
      }
    } else {
      // No package.json scripts, use nodemon with common entry point  
      const serverFiles = [
        'server.js',
        'app.js',
        'index.js',
        'dashboard.js',
        'main.js',
        'start.js'
      ];
      
      const entryPoint = await Promise.any(
        serverFiles.map(file => 
          fs.access(path.join(projectPath, file)).then(() => file)
        )
      ).catch(() => 'index.js');
      
      command = 'nodemon';
      args = [entryPoint];
    }
    
    // Set PORT environment variable
    const env = { ...process.env, PORT: port.toString() };
    
    // Spawn the server process
    const serverProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd: projectPath,
      env: env
    });
    
    const serverInfo = {
      port,
      process: serverProcess,
      projectName,
      projectPath,
      url: `http://localhost:${port}`
    };
    
    nodeServers.set(projectName, serverInfo);
    
    // Log server output
    serverProcess.onData((data) => {
      console.log(`[${projectName}:${port}] ${data}`);
    });
    
    // Handle server exit
    serverProcess.onExit(() => {
      console.log(`Node server for ${projectName} stopped`);
      nodeServers.delete(projectName);
      usedPorts.delete(port);
    });
    
    // Give server time to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return serverInfo;
  } catch (error) {
    console.error(`Failed to start Node server for ${projectName}:`, error);
    usedPorts.delete(port);
    throw error;
  }
}

// Stop Node.js server for a project
function stopNodeServer(projectName) {
  const serverInfo = nodeServers.get(projectName);
  if (serverInfo) {
    serverInfo.process.kill();
    nodeServers.delete(projectName);
    usedPorts.delete(serverInfo.port);
  }
}

// Store file content hashes to detect actual changes
const fileContentHashes = new Map();

// Setup file watcher for a project
function setupFileWatcher(projectName, projectPath) {
  const watcherId = projectName;
  
  // Clean up existing watcher if any
  if (fileWatchers.has(watcherId)) {
    fileWatchers.get(watcherId).close();
    fileWatchers.delete(watcherId);
  }
  
  const indexPath = path.join(projectPath, 'index.html');
  
  // Get initial content hash
  try {
    const content = require('fs').readFileSync(indexPath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex');
    fileContentHashes.set(indexPath, hash);
  } catch (error) {
    // File might not exist yet
    console.log(`File ${indexPath} not found yet`);
  }
  
  const watcher = chokidar.watch(indexPath, {
    persistent: true,
    ignoreInitial: true
  });
  
  watcher.on('change', () => {
    try {
      // Read the new content and compute hash
      const content = require('fs').readFileSync(indexPath, 'utf-8');
      const newHash = crypto.createHash('md5').update(content).digest('hex');
      
      // Get previous hash
      const oldHash = fileContentHashes.get(indexPath);
      
      // Only notify if content actually changed
      if (newHash !== oldHash) {
        fileContentHashes.set(indexPath, newHash);
        console.log(`Content changed for ${projectName}/index.html`);
        
        // Notify all connected file watcher clients
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.clientType === 'file-watcher') {
            client.send(JSON.stringify({
              type: 'file-changed',
              project: projectName,
              file: 'index.html'
            }));
          }
        });
      } else {
        console.log(`File touched but content unchanged for ${projectName}/index.html`);
      }
    } catch (error) {
      console.error(`Error reading file ${indexPath}:`, error);
    }
  });
  
  fileWatchers.set(watcherId, watcher);
  return watcher;
}

// Handle WebSocket connections for both terminals and file watching
wss.on('connection', (ws) => {
  ws.projectId = null; // Store project ID on WebSocket instance
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    
    // Handle file watcher messages
    if (msg.type === 'file-watcher-init') {
      ws.clientType = 'file-watcher';
      return;
    } else if (msg.type === 'watch-project') {
      setupFileWatcher(msg.projectName, msg.projectPath);
      return;
    }
    
    // Handle terminal messages
    if (msg.type === 'start' || msg.type === 'restore') {
      const projectId = msg.id; // Use const, not the outer variable
      const projectPath = msg.path;
      const projectName = msg.name;
      
      // Store project ID on this WebSocket connection
      ws.projectId = projectId;
      
      // Check if we already have a terminal for this project
      let term = terminals.get(projectId);
      
      if (!term) {
        // Check if project needs Valve Protocol upgrade
        const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
        let needsUpgrade = false;
        
        try {
          if (require('fs').existsSync(claudeMdPath)) {
            const content = require('fs').readFileSync(claudeMdPath, 'utf-8');
            if (!content.includes('Valve Protocol')) {
              needsUpgrade = true;
              console.log(`⚠️  Project ${projectName} has legacy CLAUDE.md - needs Valve Protocol upgrade`);
              
              // Auto-upgrade the file
              const upgradeScript = path.join(__dirname, 'upgrade-ai-context.sh');
              if (require('fs').existsSync(upgradeScript)) {
                const { execSync } = require('child_process');
                try {
                  execSync(`${upgradeScript} "${projectPath}"`, { stdio: 'pipe' });
                  console.log(`✅ Automatically upgraded ${projectName} to Valve Protocol`);
                } catch (e) {
                  console.log(`❌ Could not auto-upgrade: ${e.message}`);
                }
              }
            }
          } else {
            // No CLAUDE.md exists, create one with Valve Protocol
            const initScript = path.join(__dirname, 'init-ai-context.sh');
            if (require('fs').existsSync(initScript)) {
              const { execSync } = require('child_process');
              try {
                execSync(`cd "${projectPath}" && ${initScript}`, { stdio: 'pipe' });
                console.log(`✅ Initialized ${projectName} with Valve Protocol`);
              } catch (e) {
                console.log(`❌ Could not initialize: ${e.message}`);
              }
            }
          }
        } catch (e) {
          console.log(`Error checking Valve Protocol status: ${e.message}`);
        }
        
        // Only use --continue if explicitly restoring AND we had a previous session
        const shouldContinue = msg.isRestoring && terminalStates.get(projectId);
        const claudeArgs = shouldContinue ? 
          ['--continue', '--dangerously-skip-permissions'] : 
          ['--dangerously-skip-permissions'];
        
        // Find AI CLI command - try claude first, then gemini as fallback
        const claudePaths = [
          '/usr/local/bin/claude',
          '/opt/homebrew/bin/claude',
          process.env.HOME + '/.nvm/versions/node/v18.20.3/bin/claude',
          process.env.HOME + '/.local/bin/claude',
          'claude' // fallback to PATH
        ];
        
        const geminiPaths = [
          '/opt/homebrew/bin/gemini',
          '/usr/local/bin/gemini',
          process.env.HOME + '/.npm-global/bin/gemini',
          process.env.HOME + '/node_modules/.bin/gemini',
          'gemini' // fallback to PATH
        ];
        
        let aiCommand = null;
        let aiType = null;
        let aiArgs = [];
        
        // Check if user has a preference
        const existingState = terminalStates.get(projectId);
        const lastAIType = existingState?.aiType;
        const preferredAI = existingState?.preferredAI || lastAIType; // Use last active AI as a preference
        
        console.log(`Project ${projectId} preference: ${preferredAI}`);
        
        if (preferredAI === 'gemini') {
          // User wants Gemini specifically
          console.log('Looking for Gemini CLI...');
          for (const path of geminiPaths) {
            console.log(`Checking: ${path}`);
            if (require('fs').existsSync(path)) {
              aiCommand = path;
              aiType = 'gemini';
              // Gemini uses -c for checkpointing and -y for YOLO mode (auto-approve)
              aiArgs = shouldContinue ? ['--checkpointing', '--yolo'] : ['--yolo'];
              console.log('✅ Using preferred Gemini at:', aiCommand);
              break;
            }
          }
          // If Gemini not found but was preferred, show error
          if (!aiCommand) {
            console.error('❌ Gemini requested but not found');
          }
        } else if (preferredAI === 'claude') {
          // User wants Claude specifically
          for (const path of claudePaths) {
            if (require('fs').existsSync(path)) {
              aiCommand = path;
              aiType = 'claude';
              aiArgs = claudeArgs;
              console.log('Using preferred Claude at:', aiCommand);
              break;
            }
          }
          // If Claude not found but was preferred, show error
          if (!aiCommand) {
            console.error('Claude requested but not found');
          }
        } else {
          // No preference or 'auto' - try Claude first, then Gemini
          for (const path of claudePaths) {
            if (require('fs').existsSync(path)) {
              aiCommand = path;
              aiType = 'claude';
              aiArgs = claudeArgs;
              console.log('Found claude at:', aiCommand);
              break;
            }
          }
          
          // If Claude not found, try Gemini
          if (!aiCommand) {
            for (const path of geminiPaths) {
              if (require('fs').existsSync(path)) {
                aiCommand = path;
                aiType = 'gemini';
                // Gemini uses -c for checkpointing and -y for YOLO mode (auto-approve)
                aiArgs = shouldContinue ? ['--checkpointing', '--yolo'] : ['--yolo'];
                console.log('Claude not found, using Gemini at:', aiCommand);
                break;
              }
            }
          }
        }
        
        // If neither found, default to claude (will error but with clear message)
        if (!aiCommand) {
          aiCommand = 'claude';
          aiType = 'claude';
          aiArgs = claudeArgs;
          console.error('Neither Claude nor Gemini found in PATH');
        }
        
        // Create new PTY process
        term = pty.spawn(aiCommand, aiArgs, {
          name: 'xterm-256color',
          cols: 80,
          rows: 30,
          cwd: projectPath,
          env: {
            ...process.env,
            PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.PATH}`,
            // Use Google Code Assist authentication for Gemini
            GOOGLE_GENAI_USE_GCA: aiType === 'gemini' ? 'true' : '',
            // Keep other auth methods as fallback
            GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
            GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
            GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || ''
          }
        });
        
        terminals.set(projectId, term);
        
        // Check if we have conversation context from a previous AI provider
        const hasContext = existingState?.conversationContext;
        
        terminalStates.set(projectId, {
          projectPath,
          projectName,
          active: true,
          startTime: new Date(),
          buffer: [],
          hasSession: true,
          aiType: aiType,  // Track which AI is being used
          conversationContext: hasContext || null  // Preserve context if exists
        });
        saveTerminalStatesToDisk(); // Save state when new session created
        
        // If we have context from switching providers, inject it as the first message
        if (hasContext && hasContext.toProvider === aiType) {
          console.log(`Injecting context handoff from ${hasContext.fromProvider} to ${aiType}`);
          
          // Wait for the AI to fully initialize before sending context
          setTimeout(async () => {
            // Get recent conversation history
            const recentConversations = await getRecentConversations(projectId, 3);
            
            let contextMessage;
            if (recentConversations.length > 0) {
              // Build context from actual conversation history
              const conversationSummary = recentConversations
                .map(msg => `${msg.role}: ${msg.content.slice(0, 100)}`)
                .join('\n');
              
              contextMessage = `Switching from ${hasContext.fromProvider}. Recent conversation:\n${conversationSummary}\n` +
                `Tools: Use 'node ${hasContext.projectPath}/get-conversation.js ${hasContext.projectName} 10' to see more history. ` +
                `Check CLAUDE.md for project context and ${hasContext.projectPath}/.${hasContext.fromProvider}/ for session files.`;
            } else {
              // Fallback if no conversation history yet
              contextMessage = `Switching from ${hasContext.fromProvider} to continue on ${hasContext.projectName}. ` +
                `Check CLAUDE.md for project context. Use 'node ${hasContext.projectPath}/get-conversation.js ${hasContext.projectName} 10' to query conversation history. ` +
                `Previous session files in ${hasContext.projectPath}/.${hasContext.fromProvider}/. Check recent git commits for context.`;
            }
            
            // Send the context as input to the PTY
            console.log(`Sending handoff with ${recentConversations.length} recent messages`);
            
            // Type the message quickly but visibly
            let charIndex = 0;
            const typeInterval = setInterval(() => {
              if (charIndex < contextMessage.length) {
                term.write(contextMessage[charIndex]);
                charIndex++;
              } else {
                clearInterval(typeInterval);
                // Send Enter after typing completes
                setTimeout(() => {
                  term.write('\r');
                  console.log('Handoff message sent');
                }, 100);
              }
            }, 5); // Type faster - 5ms per character
            
            // Clear the context after using it
            const state = terminalStates.get(projectId);
            if (state) {
              state.conversationContext = null;
              terminalStates.set(projectId, state);
              saveTerminalStatesToDisk();
            }
          }, 4500); // Wait 4.5 seconds for AI to be ready
        }
        
        // Send output to WebSocket - capture projectId in closure
        const capturedProjectId = projectId;
        
        // Buffer for collecting rapid updates (helps with ANSI sequences)
        let outputBuffer = '';
        let outputTimer = null;
        
        const flushOutput = () => {
          if (outputBuffer) {
            const dataToSend = outputBuffer;
            outputBuffer = '';
            
            // Broadcast to all connected clients watching this terminal
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN && client.projectId === capturedProjectId) {
                client.send(JSON.stringify({ 
                  type: 'output', 
                  id: capturedProjectId,
                  data: dataToSend
                }));
              }
            });
          }
        };
        
        term.onData((data) => {
          // Store in buffer for reconnection
          const state = terminalStates.get(capturedProjectId);
          if (state) {
            if (!state.buffer) {
              state.buffer = [];
            }
            state.buffer.push(data);
            
            // Temporarily disable AI response capture due to terminal encoding issues
            // Will implement a better solution that doesn't rely on terminal parsing
            
            // Calculate total buffer size
            const totalLength = state.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
            if (totalLength > 50000) {
              // Keep only recent output
              while (state.buffer.length > 0 && 
                     state.buffer.reduce((sum, chunk) => sum + chunk.length, 0) > 50000) {
                state.buffer.shift();
              }
            }
          }
          
          // Buffer output to collect complete ANSI sequences
          outputBuffer += data;
          
          // Clear existing timer
          if (outputTimer) {
            clearTimeout(outputTimer);
          }
          
          // Flush immediately for newlines or when buffer gets large
          // Small delay helps collect complete escape sequences
          if (data.includes('\n') || outputBuffer.length > 1000) {
            flushOutput();
          } else {
            // Small delay to collect complete ANSI escape sequences
            outputTimer = setTimeout(flushOutput, 10);
          }
        });
        
        // Handle exit
        term.onExit(() => {
          // Save state before removing
          const state = terminalStates.get(capturedProjectId);
          if (state) {
            saveConversationState(state.projectPath, state.projectName);
            
            // Preserve AI preference and conversation context even when terminal exits
            if (state.preferredAI || state.conversationContext) {
              terminalStates.set(capturedProjectId, {
                projectPath: state.projectPath,
                projectName: state.projectName,
                hasSession: false,
                preferredAI: state.preferredAI,
                aiType: null,
                conversationContext: state.conversationContext // Preserve the context!
              });
            } else {
              terminalStates.delete(capturedProjectId);
            }
          } else {
            terminalStates.delete(capturedProjectId);
          }
          
          terminals.delete(capturedProjectId);
          saveTerminalStatesToDisk(); // Save state when session ends
          
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.projectId === capturedProjectId) {
              client.send(JSON.stringify({ 
                type: 'exit',
                id: capturedProjectId 
              }));
            }
          });
        });
      } else {
        // Terminal already exists - we're reconnecting
        const state = terminalStates.get(projectId);
        if (state) {
          if (!state.buffer) {
            state.buffer = [];
          }
          
          // Send buffered output to catch up the client
          if (state.buffer.length > 0) {
            ws.send(JSON.stringify({
              type: 'output',
              id: projectId,
              data: '\x1b[2J\x1b[H'
            }));
            
            setTimeout(() => {
              state.buffer.forEach(chunk => {
                ws.send(JSON.stringify({
                  type: 'output',
                  id: projectId,
                  data: chunk
                }));
              });
            }, 100);
          }
        }
      }
      
      ws.send(JSON.stringify({ type: 'ready', id: projectId }));
      
    } else if (msg.type === 'input') {
      const projectId = msg.id || ws.projectId;
      const term = terminals.get(projectId);
      const state = terminalStates.get(projectId);
      
      if (term && state) {
        // Track user input for conversation history
        if (!state.currentInput) {
          state.currentInput = '';
        }
        
        // Accumulate input until Enter is pressed
        if (msg.data.includes('\r') || msg.data.includes('\n')) {
          // User pressed Enter - save the complete input
          // Clean the message more thoroughly
          const userMessage = state.currentInput
            .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // Remove ANSI escape sequences
            .replace(/\[[\dA-Z]/g, '') // Remove bracket sequences like [I
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars except tab/newline/CR
            .trim();
          
          console.log(`User pressed Enter. Cleaned input: "${userMessage}"`);
          if (userMessage.length > 0 && !userMessage.startsWith('/')) {
            // Temporarily disable auto-capture due to encoding issues
            // Will re-enable once we have better terminal parsing
            // console.log(`Saving user message for ${projectId}: "${userMessage}"`);
            // saveConversationExchange(projectId, 'user', userMessage);
            // Mark that we should capture the AI response
            state.lastUserInput = userMessage;
          }
          state.currentInput = '';
        } else if (!msg.data.includes('\x1b')) {
          // Only accumulate non-escape characters
          state.currentInput += msg.data;
        }
        
        // Pass input to terminal
        term.write(msg.data);
      } else if (term) {
        // No state, just pass through
        term.write(msg.data);
      }
    } else if (msg.type === 'resize') {
      const term = terminals.get(msg.id || ws.projectId);
      if (term) {
        term.resize(msg.cols, msg.rows);
      }
    } else if (msg.type === 'minimize') {
      const state = terminalStates.get(msg.id);
      if (state) {
        state.minimized = true;
        saveConversationState(state.projectPath, state.projectName);
        saveTerminalStatesToDisk(); // Save state when minimized
      }
    } else if (msg.type === 'switch-ai-provider') {
      // Handle AI provider switching from client
      console.log(`Switching AI provider for ${msg.id} to ${msg.provider}`);
      let state = terminalStates.get(msg.id);
      
      // If state doesn't exist, create it (can happen if terminal hasn't been started yet)
      if (!state) {
        state = {
          projectPath: msg.projectPath || `/Users/miguel_lemos/Desktop/${msg.id.replace(/_/g, '-')}`,
          projectName: msg.id.replace(/_/g, '-'),
          hasSession: false
        };
        terminalStates.set(msg.id, state);
      }
      
      // Save context for switching - use saved conversations not buffer
      state.conversationContext = {
        fromProvider: state.aiType || 'unknown',
        toProvider: msg.provider,
        projectName: state.projectName,
        projectPath: state.projectPath,
        switchTime: new Date().toISOString(),
        useConversationFile: true  // Flag to use saved conversations instead of buffer
      };
      
      console.log(`Preparing context handoff from ${state.aiType} to ${msg.provider} for ${state.projectName}`);
      
      state.preferredAI = msg.provider;
      terminalStates.set(msg.id, state);
      saveTerminalStatesToDisk();
      console.log(`Saved ${msg.provider} preference for ${msg.id}`);
      
      // Send confirmation back to client
      ws.send(JSON.stringify({
        type: 'ai-provider-switched',
        id: msg.id,
        provider: msg.provider
      }));
    } else if (msg.type === 'kill-terminal') {
      // Kill terminal to allow restart with new AI provider
      const term = terminals.get(msg.id);
      if (term) {
        term.kill();
        terminals.delete(msg.id);
      }
    } else if (msg.type === 'get-ai-provider') {
      // Return the current AI provider for a project
      const state = terminalStates.get(msg.id);
      if (state) {
        ws.send(JSON.stringify({
          type: 'ai-provider-info',
          id: msg.id,
          provider: state.preferredAI || 'auto',
          aiType: state.aiType || null
        }));
      }
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket closed for project:', ws.projectId);
  });
});

// Graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  
  // Stop all Node.js servers
  for (const [projectName, serverInfo] of nodeServers.entries()) {
    console.log(`Stopping Node.js server for ${projectName}`);
    serverInfo.process.kill();
  }
  nodeServers.clear();
  usedPorts.clear();
  
  // Close all file watchers
  fileWatchers.forEach(watcher => watcher.close());
  fileWatchers.clear();
  
  // Save all active terminal states
  for (const [id, state] of terminalStates.entries()) {
    await saveConversationState(state.projectPath, state.projectName);
    
    const term = terminals.get(id);
    if (term) {
      term.kill();
    }
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Landing page HTML
const generateLandingHTML = () => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .card {
            backdrop-filter: blur(20px);
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 20px;
            padding: 2rem;
            transition: all 0.3s ease;
        }
        .card:hover {
            transform: translateY(-10px);
            background: rgba(255, 255, 255, 0.2);
        }
        .view-button {
            background: rgba(255, 255, 255, 0.9);
            color: #333;
            border: none;
            border-radius: 15px;
            padding: 1rem 2rem;
            cursor: pointer;
            transition: all 0.3s ease;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 0.75rem;
            width: 100%;
            justify-content: center;
        }
        .view-button:hover {
            background: white;
            transform: scale(1.05);
        }
        .last-view {
            background: #10b981;
            color: white;
        }
        .last-view:hover {
            background: #059669;
        }
    </style>
</head>
<body>
    <div class="container mx-auto px-4">
        <div class="text-center mb-12">
            <h1 class="text-6xl font-bold text-white mb-4">
                <i class="fas fa-desktop mr-4"></i>
                Claude Dashboard
            </h1>
            <p class="text-xl text-white opacity-90">
                Choose your preferred view to get started
            </p>
        </div>
        
        <div class="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            <!-- Grid View Card -->
            <div class="card">
                <div class="text-center mb-6">
                    <div class="text-6xl mb-4">📊</div>
                    <h2 class="text-2xl font-bold text-white mb-2">Grid View</h2>
                    <p class="text-white opacity-80 text-sm">
                        Classic card-based layout with project organization, terminal integration, and easy project management
                    </p>
                </div>
                <div class="space-y-3 mb-6">
                    <div class="text-white opacity-75 text-sm flex items-center">
                        <i class="fas fa-check text-green-400 mr-2"></i>
                        Card-based project grid
                    </div>
                    <div class="text-white opacity-75 text-sm flex items-center">
                        <i class="fas fa-check text-green-400 mr-2"></i>
                        Terminal integration
                    </div>
                    <div class="text-white opacity-75 text-sm flex items-center">
                        <i class="fas fa-check text-green-400 mr-2"></i>
                        Project organization
                    </div>
                    <div class="text-white opacity-75 text-sm flex items-center">
                        <i class="fas fa-check text-green-400 mr-2"></i>
                        Session persistence
                    </div>
                </div>
                <button class="view-button" onclick="selectView('grid')">
                    <i class="fas fa-th-large"></i>
                    Open Grid View
                </button>
            </div>
            
            <!-- Workspace View Card -->
            <div class="card">
                <div class="text-center mb-6">
                    <div class="text-6xl mb-4">🎯</div>
                    <h2 class="text-2xl font-bold text-white mb-2">Workspace View</h2>
                    <p class="text-white opacity-80 text-sm">
                        IDE-like interface with sidebar, terminal panel, and live preview for enhanced productivity
                    </p>
                </div>
                <div class="space-y-3 mb-6">
                    <div class="text-white opacity-75 text-sm flex items-center">
                        <i class="fas fa-check text-green-400 mr-2"></i>
                        Resizable panels
                    </div>
                    <div class="text-white opacity-75 text-sm flex items-center">
                        <i class="fas fa-check text-green-400 mr-2"></i>
                        Live preview
                    </div>
                    <div class="text-white opacity-75 text-sm flex items-center">
                        <i class="fas fa-check text-green-400 mr-2"></i>
                        File watching
                    </div>
                    <div class="text-white opacity-75 text-sm flex items-center">
                        <i class="fas fa-check text-green-400 mr-2"></i>
                        Layout switching
                    </div>
                </div>
                <button class="view-button" onclick="selectView('workspace')">
                    <i class="fas fa-code"></i>
                    Open Workspace View
                </button>
            </div>
        </div>
        
        <!-- Last Used View -->
        <div class="text-center mt-12" id="lastViewSection" style="display: none;">
            <div class="card max-w-md mx-auto">
                <h3 class="text-lg font-semibold text-white mb-4">Continue where you left off</h3>
                <button class="view-button last-view" id="lastViewButton">
                    <i class="fas fa-history"></i>
                    <span id="lastViewText">Continue with Grid View</span>
                </button>
            </div>
        </div>
        
        <div class="text-center mt-8">
            <p class="text-white opacity-60 text-sm">
                Your preference will be remembered for next time
            </p>
        </div>
    </div>
    
    <script>
        function selectView(view) {
            localStorage.setItem('preferredView', view);
            window.location.href = '/' + view;
        }
        
        // Show last used view if available
        const lastView = localStorage.getItem('preferredView');
        if (lastView) {
            document.getElementById('lastViewSection').style.display = 'block';
            const viewName = lastView === 'grid' ? 'Grid View' : 'Workspace View';
            document.getElementById('lastViewText').textContent = 'Continue with ' + viewName;
            document.getElementById('lastViewButton').onclick = () => selectView(lastView);
        }
        
        // Auto-redirect to last view after 5 seconds
        if (lastView) {
            let countdown = 5;
            const button = document.getElementById('lastViewButton');
            const originalText = document.getElementById('lastViewText').textContent;
            
            const timer = setInterval(() => {
                document.getElementById('lastViewText').textContent = originalText + ' (' + countdown + 's)';
                countdown--;
                
                if (countdown < 0) {
                    clearInterval(timer);
                    selectView(lastView);
                }
            }, 1000);
            
            // Clear timer if user clicks anything
            document.addEventListener('click', () => clearInterval(timer));
        }
    </script>
</body>
</html>`;
};

// Grid view HTML (enhanced from home.js)
const generateGridHTML = (projects, config) => {
  const getCategoryColor = (category) => {
    const colors = {
      'Active Traffic Analysis': 'bg-red-100 text-red-800',
      'AI & Machine Learning': 'bg-purple-100 text-purple-800',
      'Graphics & Visualization': 'bg-green-100 text-green-800',
      'Data Pipelines': 'bg-orange-100 text-orange-800',
      'Simulations & Education': 'bg-yellow-100 text-yellow-800',
      'Experimental & WIP': 'bg-gray-100 text-gray-800',
      'Database & Testing Tools': 'bg-blue-100 text-blue-800',
      'Archive': 'bg-stone-100 text-stone-800'
    };
    return colors[category] || 'bg-gray-100 text-gray-800';
  };
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Dashboard - Grid View</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
    <style>
        .category-badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .project-card {
            transition: all 0.3s ease;
            border: 1px solid transparent;
        }
        .project-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            border-color: #3b82f6;
        }
        .terminal-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }
        .terminal-container {
            background: #1e1e1e;
            border-radius: 8px;
            padding: 20px;
            width: 90%;
            height: 80%;
            max-width: 1200px;
            display: flex;
            flex-direction: column;
        }
        .terminal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px solid #444;
        }
        .terminal {
            flex: 1;
            overflow: hidden;
        }
        .terminal-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 14px;
        }
        .terminal-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        .terminal-btn.active {
            background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
        }
        .minimized-terminals {
            position: fixed;
            bottom: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            z-index: 999;
        }
        .minimized-terminal {
            background: #2d3748;
            color: white;
            padding: 10px 15px;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        }
        .minimized-terminal:hover {
            background: #4a5568;
            transform: translateX(-5px);
        }
        
        /* Navigation */
        .nav-button {
            background: #6366f1;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .nav-button:hover {
            background: #4f46e5;
        }
        
        /* Organization editor styles - keeping from original */
        .org-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.95);
            z-index: 2000;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .org-container {
            background: white;
            border-radius: 12px;
            padding: 30px;
            width: 100%;
            max-width: 1200px;
            max-height: 90vh;
            overflow-y: auto;
        }
        .cluster-editor {
            background: #f7fafc;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            border: 2px solid #e2e8f0;
        }
        .cluster-editor.drag-over {
            background: #bee3f8;
            border-color: #3182ce;
        }
        .project-pill {
            display: inline-block;
            background: white;
            padding: 8px 16px;
            margin: 4px;
            border-radius: 20px;
            font-size: 14px;
            cursor: move;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            transition: all 0.2s;
        }
        .project-pill:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
        }
        .cluster-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .cluster-name-input {
            font-size: 18px;
            font-weight: 600;
            background: transparent;
            border: 2px solid transparent;
            padding: 4px 8px;
            border-radius: 4px;
            transition: all 0.2s;
        }
        .cluster-name-input:hover, .cluster-name-input:focus {
            background: white;
            border-color: #3182ce;
            outline: none;
        }
    </style>
</head>
<body class="bg-gray-50">
    <div class="container mx-auto px-4 py-8">
        <header class="mb-8">
            <div class="flex justify-between items-center mb-4">
                <h1 class="text-4xl font-bold text-gray-900">
                    <i class="fas fa-th-large text-blue-600 mr-3"></i>
                    Grid View
                </h1>
                <div class="flex items-center gap-4">
                    <button onclick="window.location.href='/workspace'" class="nav-button">
                        <i class="fas fa-code"></i>
                        Switch to Workspace
                    </button>
                    <button onclick="window.location.href='/'" class="nav-button">
                        <i class="fas fa-home"></i>
                        Home
                    </button>
                </div>
            </div>
            <div class="flex justify-between items-center">
                <p class="text-gray-600">
                    ${projects.filter(p => !config.hiddenProjects?.includes(p.name)).length} visible projects • Last updated: ${new Date().toLocaleString()}
                </p>
                <button onclick="openOrganizer()" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition">
                    <i class="fas fa-edit mr-2"></i> Edit Organization
                </button>
            </div>
        </header>
        
        <div class="mb-6 flex flex-wrap gap-2">
            <button onclick="filterProjects('all')" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                All Projects
            </button>
            ${config.clusters ? config.clusters.map(cluster => `
                <button onclick="filterProjects('${cluster.name}')" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition">
                    ${cluster.name} (${cluster.projects.length})
                </button>
            `).join('') : ''}
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" id="projects-grid">
            ${projects.map(project => {
                const projectId = project.name.replace(/[^a-zA-Z0-9]/g, '_');
                
                // Check if project is hidden
                if (config.hiddenProjects && config.hiddenProjects.includes(project.name)) {
                    return '';
                }
                
                const bgColor = getCategoryColor(project.cluster);
                
                return `
                <div class="project-card bg-white rounded-lg shadow-md p-6" data-category="${project.category}" data-cluster="${project.cluster || ''}" data-name="${project.name}">
                    <div class="flex justify-between items-start mb-3">
                        <h2 class="text-xl font-semibold text-gray-900 flex-1">
                            ${project.icon} ${project.name}
                        </h2>
                        <div class="flex gap-2 items-center">
                            <button id="btn-${projectId}" class="terminal-btn" onclick="toggleTerminal('${projectId}', '${project.path.replace(/'/g, "\\'")}', '${project.name.replace(/'/g, "\\'")}')">
                                <i class="fas fa-terminal"></i>
                                Claude
                            </button>
                            ${project.isGitRepo ? `
                                <span class="text-xs px-2 py-1 bg-gray-100 rounded">
                                    <i class="fab fa-git-alt"></i> ${project.branch}
                                </span>
                            ` : ''}
                        </div>
                    </div>
                    
                    <div class="mb-3">
                        <span class="category-badge ${bgColor}">
                            ${project.cluster || project.category}
                        </span>
                    </div>
                    
                    <p class="text-gray-600 text-sm mb-4 line-clamp-3">
                        ${project.description}
                    </p>
                    
                    <div class="space-y-2 text-xs text-gray-500">
                        <div>
                            <i class="fas fa-code mr-1"></i>
                            <span class="font-medium">Tech:</span> ${project.tech}
                        </div>
                        
                        <div>
                            <i class="fas fa-folder mr-1"></i>
                            <span class="font-medium">Path:</span>
                            <code class="bg-gray-100 px-1 rounded">${project.path}</code>
                        </div>
                        
                        <div>
                            <i class="fas fa-clock mr-1"></i>
                            <span class="font-medium">Modified:</span> ${new Date(project.lastModified).toLocaleDateString()}
                        </div>
                        
                        ${project.isGitRepo ? `
                            <div>
                                <i class="fas fa-code-branch mr-1"></i>
                                <span class="font-medium">Last commit:</span> ${project.lastCommit}
                                ${project.hasUncommittedChanges ? '<span class="ml-2 text-yellow-600">• Uncommitted changes</span>' : ''}
                            </div>
                        ` : ''}
                    </div>
                </div>
                `;
            }).join('')}
        </div>
    </div>
    
    <!-- Organization Editor Modal -->
    <div id="orgModal" class="org-modal">
        <div class="org-container">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-2xl font-bold">Edit Project Organization</h2>
                <button onclick="closeOrganizer()" class="text-gray-500 hover:text-gray-700 text-2xl">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            
            <div id="clustersEditor">
                <!-- Clusters will be rendered here -->
            </div>
            
            <div class="flex gap-4 mt-6">
                <button onclick="addNewCluster()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                    <i class="fas fa-plus mr-2"></i> Add Cluster
                </button>
                <button onclick="saveOrganization()" class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold">
                    <i class="fas fa-save mr-2"></i> Save Changes
                </button>
            </div>
            
            <div class="mt-8 pt-6 border-t">
                <h3 class="text-lg font-semibold mb-4">Hidden Projects</h3>
                <div id="hiddenProjectsList" class="bg-gray-100 rounded-lg p-4 min-h-[60px]">
                    <!-- Hidden projects will be shown here -->
                </div>
            </div>
        </div>
    </div>
    
    <!-- Terminal Modal -->
    <div id="terminalModal" class="terminal-modal">
        <div class="terminal-container">
            <div class="terminal-header">
                <div class="text-white">
                    <i class="fas fa-terminal mr-2"></i>
                    <span id="terminalTitle">Claude Terminal</span>
                </div>
                <button onclick="minimizeTerminal()" class="text-white hover:text-yellow-400 text-xl" title="Minimize">
                    <i class="fas fa-minus"></i>
                </button>
            </div>
            <div id="terminal" class="terminal"></div>
        </div>
    </div>
    
    <!-- Minimized terminals -->
    <div id="minimizedTerminals" class="minimized-terminals"></div>
    
    <script>
        const terminals = new Map();
        const terminalConnections = new Map();
        const minimizedSessions = new Set();
        let currentTerminalId = null;
        let ws = null;
        
        // Session persistence
        const SESSION_STORAGE_KEY = 'claudeTerminalSessions';
        
        function saveSessionState() {
            const sessions = [];
            for (const [id, terminal] of terminals) {
                const btn = document.getElementById('btn-' + id);
                if (btn) {
                    sessions.push({
                        id: id,
                        path: btn.dataset.path,
                        name: btn.dataset.name,
                        minimized: minimizedSessions.has(id),
                        active: currentTerminalId === id
                    });
                }
            }
            localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
        }
        
        function restoreSessionsOnLoad() {
            const savedSessions = localStorage.getItem(SESSION_STORAGE_KEY);
            if (savedSessions) {
                try {
                    const sessions = JSON.parse(savedSessions);
                    sessions.forEach(session => {
                        const btn = document.getElementById('btn-' + session.id);
                        if (btn) {
                            btn.dataset.path = session.path;
                            btn.dataset.name = session.name;
                            
                            if (!btn.classList.contains('session-exists')) {
                                btn.classList.add('session-exists');
                                btn.style.backgroundColor = '#059669';
                            }
                            
                            if (session.minimized) {
                                minimizedSessions.add(session.id);
                                terminals.set(session.id, {});
                            }
                            
                            if (session.active && !session.minimized) {
                                setTimeout(() => {
                                    openTerminal(session.id, session.path, session.name, true);
                                }, 500);
                            }
                        }
                    });
                    
                    if (minimizedSessions.size > 0) {
                        updateMinimizedTerminals();
                    }
                } catch (error) {
                    console.error('Error restoring sessions:', error);
                }
            }
        }
        
        window.addEventListener('beforeunload', saveSessionState);
        window.addEventListener('DOMContentLoaded', () => {
            setTimeout(restoreSessionsOnLoad, 100);
        });
        
        // Organization data
        const allProjects = ${JSON.stringify(projects)};
        const currentConfig = ${JSON.stringify(config)};
        let editingConfig = JSON.parse(JSON.stringify(currentConfig));
        
        function openOrganizer() {
            document.getElementById('orgModal').style.display = 'flex';
            renderClusters();
        }
        
        function closeOrganizer() {
            document.getElementById('orgModal').style.display = 'none';
        }
        
        function renderClusters() {
            const container = document.getElementById('clustersEditor');
            const hiddenContainer = document.getElementById('hiddenProjectsList');
            
            // Initialize if needed
            if (!editingConfig.clusters) editingConfig.clusters = [];
            if (!editingConfig.hiddenProjects) editingConfig.hiddenProjects = [];
            
            // Render clusters
            container.innerHTML = editingConfig.clusters.map((cluster, index) => \`
                <div class="cluster-editor" data-cluster-index="\${index}" ondrop="dropProject(event, \${index})" ondragover="allowDrop(event)" ondragleave="leaveDrop(event)">
                    <div class="cluster-header">
                        <input type="text" class="cluster-name-input" value="\${cluster.name}" onchange="updateClusterName(\${index}, this.value)">
                        <div class="flex items-center gap-2">
                            <span class="text-sm text-gray-600">Priority: \${cluster.priority}</span>
                            <button onclick="moveClusterUp(\${index})" class="px-2 py-1 text-sm bg-gray-200 rounded hover:bg-gray-300" \${index === 0 ? 'disabled' : ''}>
                                <i class="fas fa-arrow-up"></i>
                            </button>
                            <button onclick="moveClusterDown(\${index})" class="px-2 py-1 text-sm bg-gray-200 rounded hover:bg-gray-300" \${index === editingConfig.clusters.length - 1 ? 'disabled' : ''}>
                                <i class="fas fa-arrow-down"></i>
                            </button>
                            <button onclick="deleteCluster(\${index})" class="px-2 py-1 text-sm bg-red-200 text-red-700 rounded hover:bg-red-300">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div class="projects-container">
                        \${cluster.projects.map(projectName => {
                            const project = allProjects.find(p => p.name === projectName);
                            if (!project) return '';
                            return \`<span class="project-pill" draggable="true" ondragstart="dragProject(event, '\${projectName}')">\${projectName}</span>\`;
                        }).join('')}
                    </div>
                </div>
            \`).join('');
            
            // Render hidden projects
            hiddenContainer.innerHTML = editingConfig.hiddenProjects.map(projectName => 
                \`<span class="project-pill" draggable="true" ondragstart="dragProject(event, '\${projectName}')">\${projectName}</span>\`
            ).join('') || '<span class="text-gray-500">Drop projects here to hide them</span>';
            
            // Make hidden container droppable
            hiddenContainer.ondrop = (e) => dropToHidden(e);
            hiddenContainer.ondragover = allowDrop;
            hiddenContainer.ondragleave = leaveDrop;
        }
        
        function allowDrop(ev) {
            ev.preventDefault();
            ev.currentTarget.classList.add('drag-over');
        }
        
        function leaveDrop(ev) {
            ev.currentTarget.classList.remove('drag-over');
        }
        
        function dragProject(ev, projectName) {
            ev.dataTransfer.setData("projectName", projectName);
        }
        
        function dropProject(ev, clusterIndex) {
            ev.preventDefault();
            ev.currentTarget.classList.remove('drag-over');
            const projectName = ev.dataTransfer.getData("projectName");
            
            // Remove from all clusters and hidden
            editingConfig.clusters.forEach(cluster => {
                cluster.projects = cluster.projects.filter(p => p !== projectName);
            });
            editingConfig.hiddenProjects = editingConfig.hiddenProjects.filter(p => p !== projectName);
            
            // Add to target cluster
            editingConfig.clusters[clusterIndex].projects.push(projectName);
            
            renderClusters();
        }
        
        function dropToHidden(ev) {
            ev.preventDefault();
            ev.currentTarget.classList.remove('drag-over');
            const projectName = ev.dataTransfer.getData("projectName");
            
            // Remove from all clusters
            editingConfig.clusters.forEach(cluster => {
                cluster.projects = cluster.projects.filter(p => p !== projectName);
            });
            
            // Add to hidden if not already there
            if (!editingConfig.hiddenProjects.includes(projectName)) {
                editingConfig.hiddenProjects.push(projectName);
            }
            
            renderClusters();
        }
        
        function updateClusterName(index, name) {
            editingConfig.clusters[index].name = name;
        }
        
        function moveClusterUp(index) {
            if (index > 0) {
                const temp = editingConfig.clusters[index];
                editingConfig.clusters[index] = editingConfig.clusters[index - 1];
                editingConfig.clusters[index - 1] = temp;
                
                // Update priorities
                editingConfig.clusters.forEach((cluster, i) => {
                    cluster.priority = i + 1;
                });
                
                renderClusters();
            }
        }
        
        function moveClusterDown(index) {
            if (index < editingConfig.clusters.length - 1) {
                const temp = editingConfig.clusters[index];
                editingConfig.clusters[index] = editingConfig.clusters[index + 1];
                editingConfig.clusters[index + 1] = temp;
                
                // Update priorities
                editingConfig.clusters.forEach((cluster, i) => {
                    cluster.priority = i + 1;
                });
                
                renderClusters();
            }
        }
        
        function deleteCluster(index) {
            if (confirm('Delete this cluster? Projects will be moved to hidden.')) {
                const cluster = editingConfig.clusters[index];
                editingConfig.hiddenProjects.push(...cluster.projects);
                editingConfig.clusters.splice(index, 1);
                
                // Update priorities
                editingConfig.clusters.forEach((cluster, i) => {
                    cluster.priority = i + 1;
                });
                
                renderClusters();
            }
        }
        
        function addNewCluster() {
            const name = prompt('Enter cluster name:');
            if (name) {
                editingConfig.clusters.push({
                    name: name,
                    priority: editingConfig.clusters.length + 1,
                    projects: []
                });
                renderClusters();
            }
        }
        
        function saveOrganization() {
            fetch('/api/save-organization', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editingConfig)
            }).then(() => {
                window.location.reload();
            });
        }
        
        function filterProjects(category) {
            const cards = document.querySelectorAll('.project-card');
            cards.forEach(card => {
                if (category === 'all') {
                    card.style.display = 'block';
                } else {
                    const cardCluster = card.dataset.cluster;
                    card.style.display = cardCluster === category ? 'block' : 'none';
                }
            });
            
            // Update button styles
            const buttons = document.querySelectorAll('button');
            buttons.forEach(button => {
                const text = button.textContent.trim();
                if ((text.includes('All Projects') && category === 'all') || text.startsWith(category)) {
                    if (!button.className.includes('bg-purple')) {
                        button.className = button.className.replace('bg-gray-200 text-gray-700', 'bg-blue-600 text-white');
                    }
                } else if (!button.className.includes('bg-purple')) {
                    button.className = button.className.replace('bg-blue-600 text-white', 'bg-gray-200 text-gray-700');
                }
            });
        }
        
        function toggleTerminal(id, path, name) {
            if (terminals.has(id)) {
                restoreTerminal(id, name);
            } else {
                openTerminal(id, path, name);
            }
        }
        
        function openTerminal(id, path, name, isRestoring = false) {
            currentTerminalId = id;
            document.getElementById('terminalTitle').textContent = 'Claude Terminal - ' + name;
            document.getElementById('terminalModal').style.display = 'flex';
            
            minimizedSessions.delete(id);
            updateMinimizedTerminals();
            
            const btn = document.getElementById('btn-' + id);
            if (btn) {
                btn.dataset.path = path;
                btn.dataset.name = name;
            }
            
            let terminal = terminals.get(id);
            
            if (!terminal || !terminal.write) {
                terminal = new Terminal({
                    cursorBlink: true,
                    fontSize: 14,
                    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                    theme: {
                        background: '#1e1e1e',
                        foreground: '#d4d4d4',
                        cursor: '#ffffff',
                        selection: 'rgba(255, 255, 255, 0.2)'
                    },
                    convertEol: true,  // Convert CRLF to LF
                    scrollback: 10000, // Increase scrollback buffer
                    cols: 100,
                    rows: 40,
                    cursorStyle: 'block',
                    allowTransparency: true
                });
                
                const fitAddon = new FitAddon.FitAddon();
                terminal.loadAddon(fitAddon);
                terminal.fitAddon = fitAddon;
                
                terminals.set(id, terminal);
            }
            
            const terminalDiv = document.getElementById('terminal');
            terminalDiv.innerHTML = '';
            terminal.open(terminalDiv);
            terminal.fitAddon.fit();
            
            if (terminalConnections.has(id)) {
                const oldWs = terminalConnections.get(id);
                if (oldWs && oldWs.readyState === WebSocket.OPEN) {
                    oldWs.close();
                }
                terminalConnections.delete(id);
            }
            
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);
            
            ws.onopen = () => {
                ws.send(JSON.stringify({ 
                    type: isRestoring ? 'restore' : 'start', 
                    id: id, 
                    path: path,
                    name: name,
                    isRestoring: isRestoring
                }));
            };
                
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.id === id) {
                    if (msg.type === 'output') {
                        // Filter out the bypass permissions text and other Claude banner text
                        let filteredData = msg.data;
                        
                        // Multiple patterns to filter out
                        const patternsToFilter = [
                            /bypass permissions on[^\\n]*/gi,  // Matches any bypass permissions line
                            /\\(shift\\+tab to cycle\\)/gi,      // Matches the shift+tab instruction
                            /dangerously[\\s-]*skip[\\s-]*permissions/gi,  // Matches the flag itself
                        ];
                        
                        patternsToFilter.forEach(pattern => {
                            filteredData = filteredData.replace(pattern, '');
                        });
                        
                        terminal.write(filteredData);
                    } else if (msg.type === 'exit') {
                        terminal.write('\\r\\n\\x1b[31mAI session ended.\\x1b[0m\\r\\n');
                        setTimeout(() => {
                            minimizeTerminal();
                            terminals.delete(id);
                            terminalConnections.delete(id);
                        }, 2000);
                    }
                }
            };
            
            ws.onerror = (error) => {
                terminal.write('\\r\\n\\x1b[31mConnection error. Please try again.\\x1b[0m\\r\\n');
            };
            
            terminal.onData((data) => {
                // Filter out number keys 1-9 when not modified
                if (data.length === 1 && data >= '1' && data <= '9') {
                    // Skip sending number keys to terminal, they're used for shortcuts
                    return;
                }
                
                // Send all input directly to server without interception
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'input', id: id, data: data }));
                }
            });
            
            terminalConnections.set(id, ws);
            document.getElementById('btn-' + id).classList.add('active');
            
            window.addEventListener('resize', () => {
                if (terminal.fitAddon) {
                    terminal.fitAddon.fit();
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'resize',
                            id: id,
                            cols: terminal.cols,
                            rows: terminal.rows
                        }));
                    }
                }
            });
        }
        
        function restoreTerminal(id, name) {
            currentTerminalId = id;
            document.getElementById('terminalTitle').textContent = 'Claude Terminal - ' + name;
            document.getElementById('terminalModal').style.display = 'flex';
            
            minimizedSessions.delete(id);
            updateMinimizedTerminals();
            
            const terminal = terminals.get(id);
            if (terminal) {
                const terminalDiv = document.getElementById('terminal');
                terminalDiv.innerHTML = '';
                terminal.open(terminalDiv);
                terminal.fitAddon.fit();
            }
            
            document.getElementById('btn-' + id).classList.add('active');
        }
        
        function minimizeTerminal() {
            if (currentTerminalId) {
                document.getElementById('terminalModal').style.display = 'none';
                minimizedSessions.add(currentTerminalId);
                updateMinimizedTerminals();
                
                const ws = terminalConnections.get(currentTerminalId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'minimize', id: currentTerminalId }));
                }
                
                currentTerminalId = null;
                saveSessionState();
            }
        }
        
        function updateMinimizedTerminals() {
            const container = document.getElementById('minimizedTerminals');
            container.innerHTML = '';
            
            minimizedSessions.forEach(id => {
                const projectName = id.replace(/_/g, ' ');
                const div = document.createElement('div');
                div.className = 'minimized-terminal';
                div.innerHTML = \`
                    <i class="fas fa-terminal"></i>
                    <span>\${projectName}</span>
                \`;
                div.onclick = () => restoreTerminal(id, projectName);
                container.appendChild(div);
            });
        }
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (document.getElementById('orgModal').style.display === 'flex') {
                    closeOrganizer();
                } else if (document.getElementById('terminalModal').style.display === 'flex') {
                    minimizeTerminal();
                }
            }
        });
        
        window.addEventListener('beforeunload', (e) => {
            saveSessionState();
        });
    </script>
</body>
</html>
`;
};

// Enhanced workspace view HTML with requested features
const generateWorkspaceHTML = (projects, config) => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Dashboard - Workspace View</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a1a;
            color: #e0e0e0;
            height: 100vh;
            overflow: hidden;
        }
        
        .workspace {
            display: flex;
            height: 100vh;
            flex-direction: column;
            position: relative;
        }
        
        /* Hidden header for clean layout */
        .header {
            display: none;
        }
        
        /* Minimal controls container */
        .minimal-controls {
            position: fixed;
            top: 15px;
            left: 15px;
            z-index: 1000;
            display: flex;
            gap: 8px;
            align-items: center;
            transition: left 0.3s ease;
        }
        
        .minimal-controls.sidebar-open {
            left: 265px;
        }
        
        /* Minimal floating hamburger button */
        .minimal-hamburger {
            background: rgba(45, 45, 45, 0.7);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: rgba(255, 255, 255, 0.4);
            font-size: 16px;
            width: 36px;
            height: 36px;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
        }
        
        .minimal-hamburger:hover {
            background: rgba(45, 45, 45, 0.9);
            color: rgba(255, 255, 255, 0.6);
            border-color: rgba(255, 255, 255, 0.15);
        }
        
        /* Project number indicators */
        .project-numbers {
            display: flex;
            gap: 4px;
            align-items: center;
            padding-left: 8px;
            border-left: 1px solid rgba(255, 255, 255, 0.1);
            margin-left: 4px;
        }
        
        .project-num-btn {
            background: transparent;
            border: 1px dashed rgba(255, 255, 255, 0.2);
            color: rgba(255, 255, 255, 0.4);
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .project-num-btn:hover {
            background: rgba(45, 45, 45, 0.5);
            border-color: rgba(255, 255, 255, 0.3);
            color: rgba(255, 255, 255, 0.6);
        }
        
        .project-num-btn.active {
            background: rgba(45, 45, 45, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.5);
            color: rgba(255, 255, 255, 0.9);
        }
        
        /* Layout control buttons */
        .layout-controls {
            display: flex;
            gap: 6px;
            align-items: center;
            padding-left: 8px;
            border-left: 1px solid rgba(255, 255, 255, 0.1);
            margin-left: 4px;
        }
        
        .layout-btn {
            background: rgba(45, 45, 45, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 6px;
            cursor: pointer;
            padding: 4px;
            transition: all 0.3s ease;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .layout-btn:hover {
            background: rgba(45, 45, 45, 0.8);
            border-color: rgba(255, 255, 255, 0.2);
        }
        
        .layout-btn.active {
            background: rgba(45, 45, 45, 0.9);
            border-color: rgba(255, 255, 255, 0.3);
        }
        
        .ai-btn {
            background: rgba(45, 45, 45, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 6px;
            cursor: pointer;
            padding: 6px;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
        }
        
        .ai-btn:hover {
            background: rgba(95, 150, 254, 0.1);
            border-color: rgba(95, 150, 254, 0.3);
        }
        
        .ai-btn.active {
            background: rgba(95, 150, 254, 0.2);
            border-color: rgba(95, 150, 254, 0.5);
            box-shadow: 0 0 10px rgba(95, 150, 254, 0.3);
        }
        
        .claude-btn.active {
            background: rgba(255, 132, 0, 0.2);
            border-color: rgba(255, 132, 0, 0.5);
            box-shadow: 0 0 10px rgba(255, 132, 0, 0.3);
        }
        
        .gemini-btn.active {
            background: rgba(66, 133, 244, 0.2);
            border-color: rgba(66, 133, 244, 0.5);
            box-shadow: 0 0 10px rgba(66, 133, 244, 0.3);
        }
        
        .layout-icon {
            width: 22px;
            height: 22px;
            display: flex;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 2px;
            overflow: hidden;
        }
        
        .layout-icon.horizontal {
            flex-direction: row;
        }
        
        .layout-icon.vertical {
            flex-direction: column;
        }
        
        .layout-box {
            background: transparent;
        }
        
        /* Layout toggle removed - can be accessed via keyboard shortcut */
        
        /* Nav buttons removed for cleaner UI */
        
        /* Main Content */
        .main-content {
            display: flex;
            flex: 1;
            overflow: hidden;
            height: 100vh;
        }
        
        .main-content.vertical {
            flex-direction: row; /* Keep sidebar on left */
        }
        
        .main-content.vertical .panels-container {
            flex-direction: column;
            width: 100%;
        }
        
        /* Sidebar */
        .sidebar {
            width: 20%;
            min-width: 250px;
            background: #2a2a2a;
            border-right: 1px solid #404040;
            display: flex;
            flex-direction: column;
            transition: all 0.3s ease;
            overflow: hidden;
        }
        
        .sidebar.collapsed {
            width: 0;
            min-width: 0;
        }
        
        .sidebar-header {
            padding: 15px;
            border-bottom: 1px solid #404040;
            background: #333;
        }
        
        .sidebar-title {
            font-size: 16px;
            font-weight: 600;
            color: #fff;
            margin-bottom: 10px;
        }
        
        .project-search {
            width: 100%;
            padding: 8px;
            background: #1a1a1a;
            border: 1px solid #404040;
            border-radius: 4px;
            color: #e0e0e0;
            font-size: 14px;
        }
        
        .project-search::placeholder {
            color: #888;
        }
        
        .projects-list {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        }
        
        .project-item {
            padding: 12px;
            margin: 4px 0;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 10px;
            background: #333;
            border: 1px solid transparent;
        }
        
        .project-item:hover {
            background: #404040;
            border-color: #555;
        }
        
        .project-item.active {
            background: #EB8C55;
            color: white;
            border-color: #F5A475;
        }
        
        .project-icon {
            font-size: 18px;
            width: 24px;
            text-align: center;
        }
        
        .project-info {
            flex: 1;
            min-width: 0;
        }
        
        .project-name {
            font-weight: 500;
            font-size: 14px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .project-tech {
            font-size: 11px;
            color: #aaa;
            margin-top: 2px;
        }
        
        .keyboard-shortcut {
            background: #555;
            color: #ccc;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: bold;
        }
        
        /* Panels */
        .panels-container {
            display: flex;
            flex: 1;
            overflow: hidden;
        }
        
        
        .center-panel {
            width: 50%;
            min-width: 300px;
            background: #1e1e1e;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
        }
        
        .main-content.vertical .center-panel {
            width: 100%;
            height: 50%;
            min-height: 200px;
        }
        
        .right-panel {
            width: 50%;
            min-width: 300px;
            background: #1a1a1a;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
        }
        
        .main-content.vertical .right-panel {
            width: 100%;
            height: 50%;
            min-height: 200px;
        }
        
        /* Splitter */
        .splitter {
            background: #404040;
            cursor: col-resize;
            width: 5px;
            transition: background-color 0.2s;
            position: relative;
        }
        
        .splitter:hover {
            background: #555;
        }
        
        .main-content.vertical .splitter {
            cursor: row-resize;
            width: 100%;
            height: 5px;
        }
        
        .splitter::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 3px;
            height: 30px;
            background: #666;
            border-radius: 2px;
        }
        
        .main-content.vertical .splitter::after {
            width: 30px;
            height: 3px;
        }
        
        /* Panel headers removed for cleaner look */
        
        /* Terminal */
        .terminal-container {
            flex: 1;
            overflow: hidden;
            position: relative;
            background: #1e1e1e;
            width: 100%;
            height: 100%;
        }
        
        .terminal-container #terminal {
            width: 100%;
            height: 100%;
        }
        
        /* Make Claude UI elements less prominent */
        .terminal-container .xterm-screen {
            padding: 10px;
            line-height: 1.4;
        }
        
        /* Custom terminal colors for cleaner look */
        .terminal-container .xterm .xterm-viewport {
            background-color: #1e1e1e;
        }
        
        /* Hide initial banner lines using CSS - experimental */
        .terminal-container .xterm-rows > div:first-child,
        .terminal-container .xterm-rows > div:nth-child(2),
        .terminal-container .xterm-rows > div:nth-child(3),
        .terminal-container .xterm-rows > div:nth-child(4),
        .terminal-container .xterm-rows > div:nth-child(5),
        .terminal-container .xterm-rows > div:nth-child(6),
        .terminal-container .xterm-rows > div:nth-child(7),
        .terminal-container .xterm-rows > div:nth-child(8),
        .terminal-container .xterm-rows > div:nth-child(9),
        .terminal-container .xterm-rows > div:nth-child(10) {
            opacity: 0.2;
            font-size: 10px;
            line-height: 0.8;
        }
        
        .terminal-placeholder {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100%;
            color: #666;
            text-align: center;
            padding: 40px;
        }
        
        .terminal-placeholder i {
            font-size: 48px;
            margin-bottom: 20px;
            color: #555;
        }
        
        /* Preview */
        .preview-container {
            flex: 1;
            overflow: hidden;
            position: relative;
            background: white;
        }
        
        .preview-iframe {
            width: 100%;
            height: 100%;
            border: none;
            background: white;
            display: block;
        }
        
        .preview-placeholder {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100%;
            color: #666;
            text-align: center;
            padding: 40px;
        }
        
        .preview-placeholder i {
            font-size: 48px;
            margin-bottom: 20px;
            color: #555;
        }
        
        /* Refresh button removed - use Ctrl+R or Cmd+R instead */
        
        /* Scrollbars */
        .projects-list::-webkit-scrollbar {
            width: 6px;
        }
        
        .projects-list::-webkit-scrollbar-track {
            background: #2a2a2a;
        }
        
        .projects-list::-webkit-scrollbar-thumb {
            background: #555;
            border-radius: 3px;
        }
        
        .projects-list::-webkit-scrollbar-thumb:hover {
            background: #666;
        }
        
        /* Animations */
        .sidebar,
        .center-panel,
        .right-panel {
            transition: all 0.3s ease;
        }
        
        /* Sortable */
        .sortable-ghost {
            opacity: 0.4;
            background: #555 !important;
        }
        
        .sortable-chosen {
            background: #444 !important;
            box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        }
        
        .sortable-drag {
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="workspace">
        <!-- Minimal Control Buttons -->
        <div class="minimal-controls">
            <button class="minimal-hamburger" onclick="toggleSidebar()" id="hamburgerBtn">
                <i class="fas fa-bars"></i>
            </button>
            
            <!-- Project Number Indicators -->
            <div class="project-numbers">
                ${projects.slice(0, 9).map((project, index) => `
                    <button class="project-num-btn ${index === 0 ? 'active' : ''}" 
                            onclick="selectProjectByIndex(${index})" 
                            data-index="${index}"
                            title="${project.name}">
                        ${index + 1}
                    </button>
                `).join('')}
            </div>
            
            <!-- Layout Control Buttons -->
            <div class="layout-controls">
                <!-- Horizontal Layouts -->
                <button class="layout-btn" onclick="setLayout('horizontal', 70, 30)" title="Terminal 70% - Preview 30%">
                    <div class="layout-icon horizontal">
                        <div class="layout-box" style="width: 70%; border-right: 1px solid rgba(255,255,255,0.3);"></div>
                        <div class="layout-box" style="width: 30%;"></div>
                    </div>
                </button>
                <button class="layout-btn" onclick="setLayout('horizontal', 50, 50)" title="Terminal 50% - Preview 50%">
                    <div class="layout-icon horizontal">
                        <div class="layout-box" style="width: 50%; border-right: 1px solid rgba(255,255,255,0.3);"></div>
                        <div class="layout-box" style="width: 50%;"></div>
                    </div>
                </button>
                <button class="layout-btn" onclick="setLayout('horizontal', 30, 70)" title="Terminal 30% - Preview 70%">
                    <div class="layout-icon horizontal">
                        <div class="layout-box" style="width: 30%; border-right: 1px solid rgba(255,255,255,0.3);"></div>
                        <div class="layout-box" style="width: 70%;"></div>
                    </div>
                </button>
                
                <!-- Vertical Layouts -->
                <button class="layout-btn" onclick="setLayout('vertical', 70, 30)" title="Terminal 70% - Preview 30%">
                    <div class="layout-icon vertical">
                        <div class="layout-box" style="height: 70%; border-bottom: 1px solid rgba(255,255,255,0.3);"></div>
                        <div class="layout-box" style="height: 30%;"></div>
                    </div>
                </button>
                <button class="layout-btn" onclick="setLayout('vertical', 50, 50)" title="Terminal 50% - Preview 50%">
                    <div class="layout-icon vertical">
                        <div class="layout-box" style="height: 50%; border-bottom: 1px solid rgba(255,255,255,0.3);"></div>
                        <div class="layout-box" style="height: 50%;"></div>
                    </div>
                </button>
                <button class="layout-btn" onclick="setLayout('vertical', 30, 70)" title="Terminal 30% - Preview 70%">
                    <div class="layout-icon vertical">
                        <div class="layout-box" style="height: 30%; border-bottom: 1px solid rgba(255,255,255,0.3);"></div>
                        <div class="layout-box" style="height: 70%;"></div>
                    </div>
                </button>
            </div>
            
            <!-- AI Provider Buttons (positioned at the right) -->
            <div class="ai-controls" style="margin-left: auto; display: flex; gap: 8px; margin-right: 16px;">
                <button class="ai-btn claude-btn" onclick="switchAIProvider('claude')" title="Switch to Claude (Anthropic)">
                    <!-- Official Anthropic Claude icon -->
                    <img src="anthropic-24.png" width="20" height="20" alt="Claude">
                </button>
                <button class="ai-btn gemini-btn" onclick="switchAIProvider('gemini')" title="Switch to Gemini (Google)">
                    <svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
                        <defs>
                            <linearGradient id="a" x1="32.963" x2="222.32" y1="222.32" y2="32.963" gradientUnits="userSpaceOnUse">
                            <stop stop-color="#89B5F7" offset="0"/>
                            <stop stop-color="#4285F4" offset=".13"/>
                            <stop stop-color="#C684EE" offset=".39"/>
                            <stop stop-color="#7844C7" offset=".5"/>
                            <stop stop-color="#C684EE" offset=".61"/>
                            <stop stop-color="#4285F4" offset=".87"/>
                            <stop stop-color="#89B5F7" offset="1"/>
                            </linearGradient>
                        </defs>
                        <path d="M128 256a128 128 0 1 0 0-256 128 128 0 0 0 0 256Z" fill="url(#a)"/>
                        <path d="M128 234.67a106.67 106.67 0 1 0 0-213.34 106.67 106.67 0 0 0 0 213.34Z" fill="#fff"/>
                        <path d="M128 213.33a85.33 85.33 0 1 0 0-170.66 85.33 85.33 0 0 0 0 170.66Z" fill="url(#a)"/>
                        <path d="m166.4 153.6-12.8-22.17-12.8 22.17h-25.6l25.6-44.34-25.6-44.33h25.6l12.8 22.17 12.8-22.17h25.6l-25.6 44.33 25.6 44.34Z" fill="#fff"/>
                    </svg>
                </button>
                <span class="ai-status" id="aiStatus" style="color: #888; font-size: 11px; align-self: center;"></span>
            </div>
        </div>
        
        <!-- Main Content -->
        <div class="main-content" id="mainContent">
            <!-- Left Sidebar -->
            <div class="sidebar" id="sidebar">
                <div class="sidebar-header">
                    <div class="sidebar-title">Projects</div>
                    <input type="text" class="project-search" placeholder="Search projects..." id="projectSearch">
                </div>
                <div class="projects-list" id="projectsList">
                    ${projects.map((project, index) => {
                      // Don't show hidden projects
                      if (config.hiddenProjects && config.hiddenProjects.includes(project.name)) {
                        return '';
                      }
                      
                      const shortcut = index < 9 ? `<span class="keyboard-shortcut">${index + 1}</span>` : '';
                      
                      return `
                        <div class="project-item" data-project="${project.name}" data-path="${project.path}">
                            <div class="project-icon">${project.icon}</div>
                            <div class="project-info">
                                <div class="project-name">${project.name}</div>
                                <div class="project-tech">${project.tech}</div>
                            </div>
                            ${shortcut}
                        </div>
                      `;
                    }).filter(Boolean).join('')}
                </div>
            </div>
            
            <!-- Panels Container -->
            <div class="panels-container">
                <!-- Center Panel (Terminal) -->
                <div class="center-panel">
                    <!-- Terminal without header -->
                    <div class="terminal-container" id="terminalContainer">
                        <div class="terminal-placeholder">
                            <i class="fas fa-terminal"></i>
                            <h3>Select a project to start</h3>
                            <p>Choose a project from the sidebar to launch Claude terminal</p>
                        </div>
                    </div>
                </div>
                
                <!-- Splitter -->
                <div class="splitter" id="splitter"></div>
                
                <!-- Right Panel (Preview) -->
                <div class="right-panel">
                    <!-- Preview without header -->
                    <div class="preview-container" id="previewContainer">
                        <div class="preview-placeholder">
                            <i class="fas fa-eye"></i>
                            <h3>No preview available</h3>
                            <p>Select a project with index.html to see live preview</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentProject = null;
        let currentTerminal = null;
        let currentWs = null;
        let fileWs = null;
        let isSwitchingProvider = false; // Track when we're intentionally switching
        const projects = ${JSON.stringify(projects.filter(p => !config.hiddenProjects?.includes(p.name)))};
        
        // Terminal pooling - keep top 5 terminals in memory
        const terminalPool = new Map();
        const wsPool = new Map();
        const MAX_POOL_SIZE = 5;
        
        // Layout and UI state
        let sidebarCollapsed = false;
        let isVerticalLayout = false;
        
        // Session persistence for workspace view
        const WORKSPACE_SESSION_KEY = 'workspaceTerminalSession';
        
        function saveWorkspaceSession() {
            if (currentProject && currentTerminal) {
                const session = {
                    projectName: currentProject.name,
                    projectPath: currentProject.path,
                    timestamp: Date.now()
                };
                localStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(session));
            }
        }
        
        function restoreWorkspaceSession() {
            const savedSession = localStorage.getItem(WORKSPACE_SESSION_KEY);
            if (savedSession) {
                try {
                    const session = JSON.parse(savedSession);
                    // Check if session is less than 24 hours old
                    if (Date.now() - session.timestamp < 86400000) {
                        const projectElement = document.querySelector(\`[data-project="\${session.projectName}"]\`);
                        if (projectElement) {
                            setTimeout(() => {
                                selectProject(session.projectName, session.projectPath, true);
                                // Auto-focus terminal after restoring session
                                setTimeout(() => {
                                    if (window.currentTerminal) {
                                        window.currentTerminal.focus();
                                    }
                                }, 500);
                            }, 500);
                            return true;
                        }
                    }
                } catch (e) {
                    console.error('Error restoring session:', e);
                }
            }
            return false;
        }
        
        // Initialize WebSocket connections
        function initializeWebSockets() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            
            // File watcher WebSocket
            fileWs = new WebSocket(protocol + '//' + window.location.host);
            fileWs.onopen = () => {
                fileWs.send(JSON.stringify({ type: 'file-watcher-init' }));
            };
            fileWs.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'file-changed' && msg.project === currentProject?.name) {
                    refreshPreview();
                }
            };
        }
        
        // Layout functions
        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            const controls = document.querySelector('.minimal-controls');
            sidebarCollapsed = !sidebarCollapsed;
            
            if (sidebarCollapsed) {
                sidebar.classList.add('collapsed');
                controls.classList.remove('sidebar-open');
            } else {
                sidebar.classList.remove('collapsed');
                controls.classList.add('sidebar-open');
            }
            
            // Save preference
            localStorage.setItem('sidebarCollapsed', sidebarCollapsed);
        }
        
        // Switch AI provider (Claude or Gemini)
        async function switchAIProvider(provider) {
            if (!currentProject) {
                document.getElementById('aiStatus').textContent = 'Select a project first';
                return;
            }
            
            // Generate the project ID (same as how terminals are created)
            const projectId = currentProject.name.replace(/[^a-zA-Z0-9]/g, '_');
            
            // First, check if we're already using this provider
            const currentProvider = document.querySelector('.ai-btn.active');
            const isAlreadyActive = currentProvider && currentProvider.classList.contains(\`\${provider}-btn\`);
            
            if (isAlreadyActive) {
                // Already using this provider, no need to switch
                document.getElementById('aiStatus').textContent = \`Already using \${provider}\`;
                return;
            }
            
            // Update button states
            document.querySelectorAll('.ai-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelector(\`.\${provider}-btn\`).classList.add('active');
            
            // Update status
            document.getElementById('aiStatus').textContent = \`Switching \${currentProject.name} to \${provider}\`;
            
            // Send message to server to switch AI provider
            if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                currentWs.send(JSON.stringify({ 
                    type: 'switch-ai-provider', 
                    id: projectId, 
                    provider: provider 
                }));
                
                // Set flag to indicate we're switching providers
                isSwitchingProvider = true;
                
                // Kill current terminal to force restart with new provider
                setTimeout(() => {
                    if (currentWs) {
                        currentWs.send(JSON.stringify({ 
                            type: 'kill-terminal', 
                            id: projectId 
                        }));
                    }
                    document.getElementById('aiStatus').textContent = \`Starting \${provider}...\`;
                    
                    // Clear the terminal display and show a brief switching message
                    if (currentTerminal) {
                        currentTerminal.clear();
                        currentTerminal.write(\`\\r\\n\\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\x1b[0m\\r\\n\`);
                        currentTerminal.write(\`\\r\\n  \\x1b[33m⚡ Switching to \${provider}...\\x1b[0m\\r\\n\\r\\n\`);
                        currentTerminal.write(\`  \\x1b[90mℹ️  Recent conversation context will be passed to \${provider}\\x1b[0m\\r\\n\`);
                        currentTerminal.write(\`  \\x1b[90m   Full history available in .\${provider === 'claude' ? 'claude' : 'gemini'} session files\\x1b[0m\\r\\n\\r\\n\`);
                        currentTerminal.write(\`\\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\x1b[0m\\r\\n\`);
                    }
                    
                    // Remove from pool so it gets recreated
                    terminalPool.delete(projectId);
                    wsPool.delete(projectId);
                    
                    // Auto-restart the terminal with the new provider after a brief delay
                    setTimeout(() => {
                        if (currentProject) {
                            isSwitchingProvider = false; // Reset flag
                            startTerminal(currentProject.name, currentProject.path);
                            document.getElementById('aiStatus').textContent = \`Using \${provider}\`;
                        }
                    }, 500);
                }, 500);
            } else {
                document.getElementById('aiStatus').textContent = 'No active terminal';
            }
        }
        
        // Update AI provider display based on current project's setting
        async function updateAIProviderDisplay(projectName) {
            const projectId = projectName.replace(/[^a-zA-Z0-9]/g, '_');
            
            // Request current AI provider from server
            if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                currentWs.send(JSON.stringify({
                    type: 'get-ai-provider',
                    id: projectId
                }));
            }
            
            // Default state - no provider active
            document.querySelectorAll('.ai-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById('aiStatus').textContent = '';
        }
        
        // Set specific layout with percentages
        function setLayout(orientation, terminalPercent, previewPercent) {
            const mainContent = document.getElementById('mainContent');
            const centerPanel = document.querySelector('.center-panel');
            const rightPanel = document.querySelector('.right-panel');
            const splitter = document.getElementById('splitter');
            
            // Remove existing active states
            document.querySelectorAll('.layout-btn').forEach(btn => btn.classList.remove('active'));
            
            // Add active state to clicked button
            event.currentTarget.classList.add('active');
            
            if (orientation === 'vertical') {
                mainContent.classList.add('vertical');
                splitter.style.top = terminalPercent + '%';
                splitter.style.left = '';
                centerPanel.style.height = terminalPercent + '%';
                centerPanel.style.width = '';
                rightPanel.style.height = previewPercent + '%';
                rightPanel.style.width = '';
            } else {
                mainContent.classList.remove('vertical');
                splitter.style.left = terminalPercent + '%';
                splitter.style.top = '';
                centerPanel.style.width = terminalPercent + '%';
                centerPanel.style.height = '';
                rightPanel.style.width = previewPercent + '%';
                rightPanel.style.height = '';
            }
            
            // Save preferences
            localStorage.setItem('layoutOrientation', orientation);
            localStorage.setItem('terminalPercent', terminalPercent);
            localStorage.setItem('previewPercent', previewPercent);
            
            // Trigger resize for terminals
            if (window.currentTerminal && window.currentTerminal.fitAddon) {
                setTimeout(() => window.currentTerminal.fitAddon.fit(), 100);
            }
        }
        
        function toggleLayout() {
            const mainContent = document.getElementById('mainContent');
            const layoutIcon = document.getElementById('layoutIcon');
            const layoutText = document.getElementById('layoutText');
            
            isVerticalLayout = !isVerticalLayout;
            
            if (isVerticalLayout) {
                mainContent.classList.add('vertical');
                layoutIcon.className = 'fas fa-grip-lines';
                layoutText.textContent = 'Horizontal';
            } else {
                mainContent.classList.remove('vertical');
                layoutIcon.className = 'fas fa-columns';
                layoutText.textContent = 'Vertical';
            }
            
            // Resize terminal after layout change
            if (currentTerminal && currentTerminal.fitAddon) {
                setTimeout(() => {
                    currentTerminal.fitAddon.fit();
                }, 300);
            }
            
            // Save preference
            localStorage.setItem('layoutVertical', isVerticalLayout);
        }
        
        // Load layout preferences
        function loadLayoutPreferences() {
            const savedSidebarState = localStorage.getItem('sidebarCollapsed');
            const savedOrientation = localStorage.getItem('layoutOrientation');
            const savedTerminalPercent = localStorage.getItem('terminalPercent');
            const savedPreviewPercent = localStorage.getItem('previewPercent');
            const controls = document.querySelector('.minimal-controls');
            
            // Set initial controls position
            if (!savedSidebarState || savedSidebarState === 'false') {
                controls.classList.add('sidebar-open');
            }
            
            if (savedSidebarState === 'true') {
                toggleSidebar();
            }
            
            // Restore saved layout if exists
            if (savedOrientation && savedTerminalPercent && savedPreviewPercent) {
                // Find and activate the corresponding button
                const orientation = savedOrientation;
                const terminal = parseInt(savedTerminalPercent);
                const preview = parseInt(savedPreviewPercent);
                
                // Apply the layout without clicking a button
                const mainContent = document.getElementById('mainContent');
                const centerPanel = document.querySelector('.center-panel');
                const rightPanel = document.querySelector('.right-panel');
                const splitter = document.getElementById('splitter');
                
                if (orientation === 'vertical') {
                    mainContent.classList.add('vertical');
                    splitter.style.top = terminal + '%';
                    centerPanel.style.height = terminal + '%';
                    rightPanel.style.height = preview + '%';
                } else {
                    mainContent.classList.remove('vertical');
                    splitter.style.left = terminal + '%';
                    centerPanel.style.width = terminal + '%';
                    rightPanel.style.width = preview + '%';
                }
            }
        }
        
        // Make panels resizable
        function makeResizable() {
            const splitter = document.getElementById('splitter');
            const centerPanel = document.querySelector('.center-panel');
            const rightPanel = document.querySelector('.right-panel');
            const mainContent = document.getElementById('mainContent');
            
            let isResizing = false;
            let startPos, startSize;
            let rafId = null; // For requestAnimationFrame
            
            splitter.addEventListener('mousedown', (e) => {
                isResizing = true;
                startPos = isVerticalLayout ? e.clientY : e.clientX;
                startSize = isVerticalLayout ? 
                    centerPanel.offsetHeight : 
                    centerPanel.offsetWidth;
                e.preventDefault();
            });
            
            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                
                // Cancel previous animation frame to reduce lag
                if (rafId) {
                    cancelAnimationFrame(rafId);
                }
                
                rafId = requestAnimationFrame(() => {
                    const currentPos = isVerticalLayout ? e.clientY : e.clientX;
                    const diff = currentPos - startPos;
                    const newSize = startSize + diff;
                    
                    if (isVerticalLayout) {
                        const container = document.querySelector('.panels-container');
                        const totalHeight = container.offsetHeight - 5; // minus splitter
                        const minHeight = 200;
                        const maxHeight = totalHeight - minHeight;
                        
                        if (newSize >= minHeight && newSize <= maxHeight) {
                            const percentage = (newSize / totalHeight) * 100;
                            // Snap to 5% increments for smoother experience
                            const snappedPercentage = Math.round(percentage / 5) * 5;
                            centerPanel.style.height = snappedPercentage + '%';
                            rightPanel.style.height = (100 - snappedPercentage) + '%';
                        }
                    } else {
                        const container = document.querySelector('.panels-container');
                        const totalWidth = container.offsetWidth - 5; // minus splitter
                        const minWidth = 300;
                        const maxWidth = totalWidth - minWidth;
                        
                        if (newSize >= minWidth && newSize <= maxWidth) {
                            const percentage = (newSize / totalWidth) * 100;
                            // Snap to 5% increments for smoother experience
                            const snappedPercentage = Math.round(percentage / 5) * 5;
                            centerPanel.style.width = snappedPercentage + '%';
                            rightPanel.style.width = (100 - snappedPercentage) + '%';
                        }
                    }
                    
                    // Resize terminal with debounce
                    if (currentTerminal && currentTerminal.fitAddon) {
                        clearTimeout(window.resizeTerminalTimeout);
                        window.resizeTerminalTimeout = setTimeout(() => {
                            currentTerminal.fitAddon.fit();
                        }, 100);
                    }
                });
            });
            
            document.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false;
                    
                    // Save panel sizes
                    const centerSize = isVerticalLayout ? 
                        centerPanel.style.height : 
                        centerPanel.style.width;
                    const rightSize = isVerticalLayout ? 
                        rightPanel.style.height : 
                        rightPanel.style.width;
                    
                    localStorage.setItem('centerPanelSize', centerSize);
                    localStorage.setItem('rightPanelSize', rightSize);
                }
            });
        }
        
        // Load panel sizes
        function loadPanelSizes() {
            // Check if we have a saved layout preference
            const savedOrientation = localStorage.getItem('layoutOrientation');
            const savedTerminalPercent = localStorage.getItem('terminalPercent');
            const savedPreviewPercent = localStorage.getItem('previewPercent');
            
            // If we have specific layout settings, use those instead of raw sizes
            if (savedOrientation && savedTerminalPercent && savedPreviewPercent) {
                const centerPanel = document.querySelector('.center-panel');
                const rightPanel = document.querySelector('.right-panel');
                const splitter = document.getElementById('splitter');
                
                if (savedOrientation === 'vertical') {
                    centerPanel.style.height = savedTerminalPercent + '%';
                    rightPanel.style.height = savedPreviewPercent + '%';
                    centerPanel.style.width = '';
                    rightPanel.style.width = '';
                    splitter.style.top = savedTerminalPercent + '%';
                    splitter.style.left = '';
                } else {
                    centerPanel.style.width = savedTerminalPercent + '%';
                    rightPanel.style.width = savedPreviewPercent + '%';
                    centerPanel.style.height = '';
                    rightPanel.style.height = '';
                    splitter.style.left = savedTerminalPercent + '%';
                    splitter.style.top = '';
                }
                return; // Don't load old panel sizes
            }
            
            // Fallback to old saved sizes (for backwards compatibility)
            const centerSize = localStorage.getItem('centerPanelSize');
            const rightSize = localStorage.getItem('rightPanelSize');
            
            if (centerSize && rightSize) {
                const centerPanel = document.querySelector('.center-panel');
                const rightPanel = document.querySelector('.right-panel');
                
                if (isVerticalLayout) {
                    centerPanel.style.height = centerSize;
                    rightPanel.style.height = rightSize;
                } else {
                    centerPanel.style.width = centerSize;
                    rightPanel.style.width = rightSize;
                }
            }
        }
        
        // Select project by index (for number shortcuts)
        function selectProjectByIndex(index) {
            // Use projects directly, config.hiddenProjects is handled at generation time
            const visibleProjects = projects;
            if (index >= 0 && index < visibleProjects.length && index < 9) {
                const project = visibleProjects[index];
                selectProject(project.name, project.path);
                
                // Update number button states
                document.querySelectorAll('.project-num-btn').forEach(btn => {
                    btn.classList.remove('active');
                });
                const activeBtn = document.querySelector(\`.project-num-btn[data-index="\${index}"]\`);
                if (activeBtn) {
                    activeBtn.classList.add('active');
                }
            }
        }
        
        // Project selection
        function selectProject(projectName, projectPath, isRestoring = false) {
            // Update active project
            document.querySelectorAll('.project-item').forEach(item => {
                item.classList.remove('active');
            });
            document.querySelector(\`[data-project="\${projectName}"]\`).classList.add('active');
            
            const project = projects.find(p => p.name === projectName);
            currentProject = project;
            
            // Update number button to show active project
            const visibleProjects = projects;
            const projectIndex = visibleProjects.findIndex(p => p.name === projectName);
            if (projectIndex >= 0 && projectIndex < 9) {
                document.querySelectorAll('.project-num-btn').forEach(btn => {
                    btn.classList.remove('active');
                });
                const activeBtn = document.querySelector(\`.project-num-btn[data-index="\${projectIndex}"]\`);
                if (activeBtn) {
                    activeBtn.classList.add('active');
                }
            }
            
            // Update terminal
            startTerminal(projectName, projectPath);
            
            // Check and display current AI provider for this project
            updateAIProviderDisplay(projectName);
            
            // Save session
            saveWorkspaceSession();
            
            // Update preview
            updatePreview(projectName, projectPath);
            
            // Ensure everything fits properly after selection
            setTimeout(() => {
                if (window.currentTerminal && window.currentTerminal.fitAddon) {
                    window.currentTerminal.fitAddon.fit();
                }
                // Trigger resize to fix preview width
                window.dispatchEvent(new Event('resize'));
            }, 150);
            
            // Setup file watcher if needed
            if (fileWs && fileWs.readyState === WebSocket.OPEN) {
                fileWs.send(JSON.stringify({
                    type: 'watch-project',
                    projectName: projectName,
                    projectPath: projectPath
                }));
            }
            
            // Save last selected project
            localStorage.setItem('lastSelectedProject', JSON.stringify({
                name: projectName,
                path: projectPath
            }));
        }
        
        // Start terminal for project (with pooling)
        function startTerminal(projectName, projectPath) {
            const container = document.getElementById('terminalContainer');
            const projectId = projectName.replace(/[^a-zA-Z0-9]/g, '_');
            
            // Check if terminal exists in pool
            if (terminalPool.has(projectId)) {
                // Reuse existing terminal
                currentTerminal = terminalPool.get(projectId);
                currentWs = wsPool.get(projectId);
                
                // Clear container and re-attach terminal
                container.innerHTML = '<div id="terminal"></div>';
                currentTerminal.open(document.getElementById('terminal'));
                
                // Fit terminal to container and focus
                if (currentTerminal.fitAddon) {
                    setTimeout(() => {
                        currentTerminal.fitAddon.fit();
                        currentTerminal.focus();
                    }, 0);
                }
                
                console.log(\`Reused pooled terminal for \${projectName}\`);
                
                // Save session when reusing pooled terminal
                saveWorkspaceSession();
                return;
            }
            
            // Create new terminal
            container.innerHTML = '<div id="terminal"></div>';
            
            const terminal = new Terminal({
                cursorBlink: true,
                fontSize: 14,
                fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                theme: {
                    background: '#1e1e1e',
                    foreground: '#d4d4d4',
                    cursor: '#ffffff',
                    selection: 'rgba(255, 255, 255, 0.2)'
                },
                convertEol: true,  // Convert CRLF to LF
                scrollback: 10000, // Increase scrollback buffer
                cols: 100,
                rows: 40,
                cursorStyle: 'block',
                allowTransparency: true
            });
            
            const fitAddon = new FitAddon.FitAddon();
            terminal.loadAddon(fitAddon);
            terminal.fitAddon = fitAddon;
            terminal.open(document.getElementById('terminal'));
            fitAddon.fit();
            
            // Auto-focus terminal for voice-to-text support
            setTimeout(() => {
                terminal.focus();
            }, 100);
            
            // Add to pool
            terminalPool.set(projectId, terminal);
            currentTerminal = terminal;
            window.currentTerminal = terminal; // Export for layout functions
            
            // Manage pool size - remove oldest if exceeds max
            if (terminalPool.size > MAX_POOL_SIZE) {
                const oldestKey = terminalPool.keys().next().value;
                const oldTerminal = terminalPool.get(oldestKey);
                const oldWs = wsPool.get(oldestKey);
                
                // Clean up old terminal
                if (oldTerminal) {
                    oldTerminal.dispose();
                }
                if (oldWs) {
                    oldWs.close();
                }
                
                terminalPool.delete(oldestKey);
                wsPool.delete(oldestKey);
                console.log(\`Removed \${oldestKey} from pool (exceeded max size)\`);
            }
            
            // WebSocket connection (also pooled)
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(protocol + '//' + window.location.host);
            
            ws.onopen = () => {
                // Check if we have a saved session for THIS specific project
                const savedSession = localStorage.getItem(WORKSPACE_SESSION_KEY);
                let isRestoring = false;
                
                if (savedSession) {
                    try {
                        const session = JSON.parse(savedSession);
                        // Only restore if it's the SAME project
                        isRestoring = (session.projectName === projectName);
                    } catch (e) {}
                }
                
                ws.send(JSON.stringify({
                    type: isRestoring ? 'restore' : 'start',
                    id: projectId,
                    path: projectPath,
                    name: projectName,
                    isRestoring: isRestoring
                }));
            };
            
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'ai-provider-info') {
                    // Update AI provider buttons based on current setting
                    document.querySelectorAll('.ai-btn').forEach(btn => btn.classList.remove('active'));
                    if (msg.provider && msg.provider !== 'auto') {
                        const btn = document.querySelector(\`.\${msg.provider}-btn\`);
                        if (btn) {
                            btn.classList.add('active');
                        }
                        document.getElementById('aiStatus').textContent = \`Using \${msg.provider}\`;
                    } else if (msg.aiType) {
                        // Show what's actually being used
                        const btn = document.querySelector(\`.\${msg.aiType}-btn\`);
                        if (btn) {
                            btn.classList.add('active');
                        }
                        document.getElementById('aiStatus').textContent = \`Auto: \${msg.aiType}\`;
                    } else {
                        document.getElementById('aiStatus').textContent = 'Auto';
                    }
                } else if (msg.type === 'output') {
                    // Filter out the bypass permissions text and other Claude banner text
                    let filteredData = msg.data;
                    
                    // Multiple patterns to filter out
                    const patternsToFilter = [
                        /bypass permissions on[^\\n]*/gi,  // Matches any bypass permissions line
                        /\\(shift\\+tab to cycle\\)/gi,      // Matches the shift+tab instruction
                        /dangerously[\\s-]*skip[\\s-]*permissions/gi,  // Matches the flag itself
                    ];
                    
                    patternsToFilter.forEach(pattern => {
                        filteredData = filteredData.replace(pattern, '');
                    });
                    
                    terminal.write(filteredData);
                } else if (msg.type === 'exit') {
                    // Only show "session ended" if we're not intentionally switching
                    if (!isSwitchingProvider) {
                        terminal.write('\\r\\n\\x1b[31mSession ended.\\x1b[0m\\r\\n');
                    }
                    // Remove from pool if session ends
                    terminalPool.delete(projectId);
                    wsPool.delete(projectId);
                }
            };
            
            ws.onerror = () => {
                terminal.write('\\r\\n\\x1b[31mConnection error. Please try again.\\x1b[0m\\r\\n');
            };
            
            terminal.onData((data) => {
                // Filter out number keys 1-9 when not modified
                if (data.length === 1 && data >= '1' && data <= '9') {
                    // Skip sending number keys to terminal, they're used for shortcuts
                    return;
                }
                
                // Send all input directly to server without interception
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'input',
                        id: projectId,
                        data: data
                    }));
                }
            });
            
            // Add WebSocket to pool
            wsPool.set(projectId, ws);
            currentWs = ws;
            
            // Handle resize
            const resizeHandler = () => {
                if (currentTerminal && currentTerminal.fitAddon) {
                    currentTerminal.fitAddon.fit();
                    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                        currentWs.send(JSON.stringify({
                            type: 'resize',
                            id: projectName.replace(/[^a-zA-Z0-9]/g, '_'),
                            cols: currentTerminal.cols,
                            rows: currentTerminal.rows
                        }));
                    }
                }
            };
            
            window.addEventListener('resize', resizeHandler);
            
            // Cleanup old resize listeners
            if (window.currentResizeHandler) {
                window.removeEventListener('resize', window.currentResizeHandler);
            }
            window.currentResizeHandler = resizeHandler;
        }
        
        // Update preview panel
        async function updatePreview(projectName, projectPath) {
            const container = document.getElementById('previewContainer');
            
            try {
                const response = await fetch(\`/api/project/\${encodeURIComponent(projectName)}/has-index\`);
                const data = await response.json();
                
                if (data.isNodeServer) {
                    if (data.error) {
                        // Special message for overview project
                        const isOverviewProject = data.error.includes('recursion');
                        container.innerHTML = \`
                            <div class="preview-placeholder">
                                <i class="fas fa-\${isOverviewProject ? 'infinity' : 'server'}"></i>
                                <h3>\${isOverviewProject ? 'Recursive Protection' : 'Node.js Server Error'}</h3>
                                <p>\${isOverviewProject ? 
                                    'Cannot start overview dashboard within itself' : 
                                    'Failed to start server for ' + projectName}</p>
                                <p class="error-detail" style="color: #888; font-size: 12px; margin-top: 10px;">
                                    \${isOverviewProject ? 
                                        'This would create an infinite recursion. The overview dashboard is already running!' :
                                        data.error}
                                </p>
                            </div>
                        \`;
                    } else {
                        // Node.js server running, show in iframe
                        container.innerHTML = \`
                            <div style="width: 100%; height: 100%; display: flex; flex-direction: column;">
                                <div style="background: #2d2d2d; color: #10b981; padding: 8px; font-size: 12px; border-bottom: 1px solid #444;">
                                    <i class="fas fa-server"></i> Node.js server running on port \${data.port}
                                </div>
                                <iframe class="preview-iframe" src="\${data.serverUrl}" id="previewIframe" style="flex: 1;"></iframe>
                            </div>
                        \`;
                        console.log(\`Node.js server started for \${projectName} at \${data.serverUrl}\`);
                    }
                } else if (data.hasIndex) {
                    container.innerHTML = \`<iframe class="preview-iframe" src="/project/\${encodeURIComponent(projectName)}/index.html" id="previewIframe"></iframe>\`;
                    
                    // Set up scroll position tracking and restoration
                    const iframe = document.getElementById('previewIframe');
                    if (iframe) {
                        iframe.onload = () => {
                            // Restore scroll position if available
                            fetch(\`/api/project/\${encodeURIComponent(projectName)}/scroll-position\`)
                                .then(res => res.json())
                                .then(data => {
                                    if (data.scrollPosition) {
                                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                                        if (iframeDoc && iframeDoc.documentElement) {
                                            iframeDoc.documentElement.scrollTop = data.scrollPosition.scrollTop || 0;
                                            iframeDoc.documentElement.scrollLeft = data.scrollPosition.scrollLeft || 0;
                                            iframeDoc.body.scrollTop = data.scrollPosition.scrollTop || 0;
                                            iframeDoc.body.scrollLeft = data.scrollPosition.scrollLeft || 0;
                                        }
                                    }
                                })
                                .catch(err => console.log('No saved scroll position'));
                            
                            // Track scroll changes
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            if (iframeDoc) {
                                let scrollTimeout;
                                const saveScroll = () => {
                                    clearTimeout(scrollTimeout);
                                    scrollTimeout = setTimeout(() => {
                                        const scrollData = {
                                            scrollTop: iframeDoc.documentElement.scrollTop || iframeDoc.body.scrollTop || 0,
                                            scrollLeft: iframeDoc.documentElement.scrollLeft || iframeDoc.body.scrollLeft || 0,
                                            timestamp: Date.now()
                                        };
                                        fetch(\`/api/project/\${encodeURIComponent(projectName)}/scroll-position\`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify(scrollData)
                                        });
                                    }, 500); // Debounce scroll saves
                                };
                                iframeDoc.addEventListener('scroll', saveScroll, true);
                            }
                        };
                    }
                } else {
                    container.innerHTML = \`
                        <div class="preview-placeholder">
                            <i class="fas fa-file-code"></i>
                            <h3>No index.html found</h3>
                            <p>Create an index.html file in \${projectName} to see live preview</p>
                        </div>
                    \`;
                }
            } catch (error) {
                container.innerHTML = \`
                    <div class="preview-placeholder">
                        <i class="fas fa-exclamation-triangle"></i>
                        <h3>Preview Error</h3>
                        <p>Could not load preview for \${projectName}</p>
                    </div>
                \`;
            }
        }
        
        // Refresh preview iframe without blinking
        function refreshPreview() {
            const iframe = document.getElementById('previewIframe');
            if (!iframe) return;
            
            // Get current scroll position before reload
            let scrollTop = 0;
            let scrollLeft = 0;
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (iframeDoc && iframeDoc.documentElement) {
                    scrollTop = iframeDoc.documentElement.scrollTop || iframeDoc.body.scrollTop || 0;
                    scrollLeft = iframeDoc.documentElement.scrollLeft || iframeDoc.body.scrollLeft || 0;
                }
            } catch (e) {
                // Cross-origin restrictions might prevent access
            }
            
            // Create a hidden iframe to load the new content
            const container = iframe.parentElement;
            const tempIframe = document.createElement('iframe');
            tempIframe.className = 'preview-iframe';
            tempIframe.style.cssText = 'position: absolute; visibility: hidden; pointer-events: none;';
            tempIframe.src = iframe.src + '?t=' + Date.now(); // Force reload with cache buster
            
            // When the hidden iframe loads, swap it with the visible one
            tempIframe.onload = () => {
                // Set scroll position on the new iframe
                try {
                    const newDoc = tempIframe.contentDocument || tempIframe.contentWindow.document;
                    if (newDoc && newDoc.documentElement) {
                        // Wait for any images/assets to load
                        setTimeout(() => {
                            newDoc.documentElement.scrollTop = scrollTop;
                            newDoc.documentElement.scrollLeft = scrollLeft;
                            if (newDoc.body) {
                                newDoc.body.scrollTop = scrollTop;
                                newDoc.body.scrollLeft = scrollLeft;
                            }
                            
                            // Now swap the iframes
                            tempIframe.id = 'previewIframe';
                            tempIframe.style.visibility = 'visible';
                            tempIframe.style.position = '';
                            tempIframe.style.pointerEvents = '';
                            iframe.remove();
                            
                            // Re-setup scroll tracking
                            if (newDoc && currentProject) {
                                let scrollTimeout;
                                const saveScroll = () => {
                                    clearTimeout(scrollTimeout);
                                    scrollTimeout = setTimeout(() => {
                                        const scrollData = {
                                            scrollTop: newDoc.documentElement.scrollTop || newDoc.body.scrollTop || 0,
                                            scrollLeft: newDoc.documentElement.scrollLeft || newDoc.body.scrollLeft || 0,
                                            timestamp: Date.now()
                                        };
                                        fetch(\`/api/project/\${encodeURIComponent(currentProject.name)}/scroll-position\`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify(scrollData)
                                        });
                                    }, 500);
                                };
                                newDoc.addEventListener('scroll', saveScroll, true);
                            }
                        }, 50); // Small delay to ensure content is rendered
                    }
                } catch (e) {
                    // If we can't set scroll, just swap anyway
                    tempIframe.id = 'previewIframe';
                    tempIframe.style.visibility = 'visible';
                    tempIframe.style.position = '';
                    tempIframe.style.pointerEvents = '';
                    iframe.remove();
                }
            };
            
            // Add the hidden iframe to start loading
            container.appendChild(tempIframe);
        }
        
        // Search functionality
        document.getElementById('projectSearch').addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            document.querySelectorAll('.project-item').forEach(item => {
                const name = item.dataset.project.toLowerCase();
                const tech = item.querySelector('.project-tech').textContent.toLowerCase();
                const visible = name.includes(query) || tech.includes(query);
                item.style.display = visible ? 'flex' : 'none';
            });
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key >= '1' && e.key <= '3') {
                const index = parseInt(e.key) - 1;
                const items = Array.from(document.querySelectorAll('.project-item:not([style*="display: none"])'));
                if (items[index]) {
                    const projectName = items[index].dataset.project;
                    const projectPath = items[index].dataset.path;
                    selectProject(projectName, projectPath);
                }
            }
        });
        
        // Project item click handlers
        document.querySelectorAll('.project-item').forEach(item => {
            let clickCount = 0;
            let clickTimer = null;
            
            item.addEventListener('click', (e) => {
                const projectName = item.dataset.project;
                const projectPath = item.dataset.path;
                
                clickCount++;
                
                if (clickCount === 1) {
                    // Single click - select project
                    clickTimer = setTimeout(() => {
                        selectProject(projectName, projectPath);
                        clickCount = 0;
                    }, 300);
                } else if (clickCount === 2) {
                    // Double click - just reset for now
                    clearTimeout(clickTimer);
                    clickTimer = setTimeout(() => {
                        selectProject(projectName, projectPath);
                        clickCount = 0;
                    }, 300);
                } else if (clickCount === 3) {
                    // Triple click - make priority 1
                    clearTimeout(clickTimer);
                    clickCount = 0;
                    
                    // Make this project priority 1
                    fetch('/api/set-priority-one', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectName })
                    }).then(response => {
                        if (response.ok) {
                            // Move element to top visually
                            const projectsList = document.getElementById('projectsList');
                            projectsList.insertBefore(item, projectsList.firstChild);
                            
                            // Flash green to indicate success
                            item.style.backgroundColor = '#10b981';
                            setTimeout(() => {
                                item.style.backgroundColor = '';
                            }, 300);
                            
                            // Select the project
                            selectProject(projectName, projectPath);
                        }
                    });
                }
            });
        });
        
        // Make projects sortable with drag-and-drop
        function makeProjectsSortable() {
            const projectsList = document.getElementById('projectsList');
            
            new Sortable(projectsList, {
                animation: 150,
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                dragClass: 'sortable-drag',
                handle: '.project-item',
                onEnd: function(evt) {
                    // Get new order of projects
                    const items = Array.from(projectsList.querySelectorAll('.project-item'));
                    const newOrder = items.map(item => item.dataset.project);
                    
                    // Send new order to server to save
                    fetch('/api/reorder-projects', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ order: newOrder })
                    }).then(response => {
                        if (response.ok) {
                            console.log('Project order saved');
                        }
                    });
                }
            });
        }
        
        // Note: Removed pre-initialization as it was causing shared terminal issues
        // Pooling happens after first use which is sufficient for performance
        
        // Initialize everything
        function initialize() {
            initializeWebSockets();
            loadLayoutPreferences();
            makeResizable();
            makeProjectsSortable();
            
            
            // Load panel sizes after layout is set
            setTimeout(() => {
                // If no saved layout, set default 50-50
                if (!localStorage.getItem('layoutOrientation')) {
                    const centerPanel = document.querySelector('.center-panel');
                    const rightPanel = document.querySelector('.right-panel');
                    const splitter = document.getElementById('splitter');
                    
                    centerPanel.style.width = '50%';
                    rightPanel.style.width = '50%';
                    splitter.style.left = '50%';
                    
                    // Save this as the default
                    localStorage.setItem('layoutOrientation', 'horizontal');
                    localStorage.setItem('terminalPercent', '50');
                    localStorage.setItem('previewPercent', '50');
                }
                
                // Load panel sizes (will use the layout settings)
                loadPanelSizes();
                
                // Force resize to ensure panels occupy full space
                window.dispatchEvent(new Event('resize'));
                
                // Also fit any existing terminal
                if (window.currentTerminal && window.currentTerminal.fitAddon) {
                    setTimeout(() => {
                        window.currentTerminal.fitAddon.fit();
                    }, 100);
                }
            }, 100);
            
            // Try to restore workspace session first
            const sessionRestored = restoreWorkspaceSession();
            
            if (!sessionRestored) {
                // Auto-select last project or first project
                const lastProject = localStorage.getItem('lastSelectedProject');
                if (lastProject) {
                    try {
                        const project = JSON.parse(lastProject);
                        const projectElement = document.querySelector(\`[data-project="\${project.name}"]\`);
                        if (projectElement) {
                            setTimeout(() => {
                                selectProject(project.name, project.path);
                                // Auto-focus terminal after initial project selection
                                setTimeout(() => {
                                    if (window.currentTerminal) {
                                        window.currentTerminal.focus();
                                    }
                                }, 500);
                            }, 300);
                            return;
                        }
                    } catch (e) {}
                }
                
                // Fallback to first project
                const firstProject = document.querySelector('.project-item');
                if (firstProject) {
                    setTimeout(() => {
                        const projectName = firstProject.dataset.project;
                        const projectPath = firstProject.dataset.path;
                        selectProject(projectName, projectPath);
                        // Auto-focus terminal after initial project selection
                        setTimeout(() => {
                            if (window.currentTerminal) {
                                window.currentTerminal.focus();
                            }
                        }, 500);
                    }, 300);
                }
            }
        }
        
        // Save session on page unload
        window.addEventListener('beforeunload', () => {
            saveWorkspaceSession();
        });
        
        // Global keyboard shortcuts for projects 1-9
        document.addEventListener('keydown', (e) => {
            // Number keys 1-9 to switch projects (works globally, including in terminal)
            if (e.key >= '1' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                // Check if we're in a regular input field (not terminal)
                const activeElement = document.activeElement;
                const isInputField = activeElement.tagName === 'INPUT' || 
                                    activeElement.tagName === 'TEXTAREA' ||
                                    (activeElement.contentEditable === 'true');
                
                // Check if terminal has focus
                const terminalHasFocus = activeElement.classList.contains('xterm-helper-textarea');
                
                if (!isInputField || terminalHasFocus) {
                    e.preventDefault();
                    e.stopPropagation();
                    selectProjectByIndex(parseInt(e.key) - 1);
                    
                    // Re-focus terminal after switching if it had focus
                    if (terminalHasFocus) {
                        setTimeout(() => {
                            const terminalTextarea = document.querySelector('.xterm-helper-textarea');
                            if (terminalTextarea) {
                                terminalTextarea.focus();
                            }
                        }, 100);
                    }
                }
            }
        }, true);  // Use capture phase to intercept before terminal
        
        initialize();
    </script>
</body>
</html>
`;
};

// Serve static files from project directories
app.use('/project/:projectName', (req, res, next) => {
  const projectName = decodeURIComponent(req.params.projectName);
  const projectPath = path.join(DESKTOP_PATH, projectName);
  express.static(projectPath)(req, res, next);
});

// API routes
app.post('/api/save-organization', async (req, res) => {
  await saveProjectsConfig(req.body);
  res.json({ success: true });
});

app.post('/api/reorder-projects', async (req, res) => {
  try {
    const { order } = req.body;
    const config = await loadProjectsConfig();
    
    // Save the custom order
    if (!config.customOrder) {
      config.customOrder = [];
    }
    config.customOrder = order;
    
    await saveProjectsConfig(config);
    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering projects:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/set-priority-one', async (req, res) => {
  try {
    const { projectName } = req.body;
    const config = await loadProjectsConfig();
    
    // Get current order or use existing projects
    let currentOrder = config.customOrder || [];
    
    // If no custom order exists, get all projects
    if (currentOrder.length === 0) {
      const files = await fs.readdir(DESKTOP_PATH);
      const projects = [];
      
      for (const file of files) {
        const filePath = path.join(DESKTOP_PATH, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory() && !file.startsWith('.')) {
          projects.push(file);
        }
      }
      currentOrder = projects;
    }
    
    // Remove the project from its current position
    const index = currentOrder.indexOf(projectName);
    if (index > -1) {
      currentOrder.splice(index, 1);
    }
    
    // Add it to the beginning (priority 1)
    currentOrder.unshift(projectName);
    
    // Save the new order
    config.customOrder = currentOrder;
    await saveProjectsConfig(config);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error setting project priority:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reset-organization', async (req, res) => {
  await saveProjectsConfig({});
  res.json({ success: true });
});

// Get scroll position for a project
app.get('/api/project/:projectName/scroll-position', async (req, res) => {
  const projectName = decodeURIComponent(req.params.projectName);
  try {
    const config = await loadProjectsConfig();
    const scrollPosition = config.scrollPositions?.[projectName] || null;
    res.json({ scrollPosition });
  } catch (error) {
    res.json({ scrollPosition: null });
  }
});

// Save scroll position for a project
app.post('/api/project/:projectName/scroll-position', async (req, res) => {
  const projectName = decodeURIComponent(req.params.projectName);
  const scrollData = req.body;
  
  try {
    await saveProjectScrollPosition(projectName, scrollData);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save scroll position' });
  }
});

app.get('/api/project/:projectName/has-index', async (req, res) => {
  const projectName = decodeURIComponent(req.params.projectName);
  const projectPath = path.join(DESKTOP_PATH, projectName);
  
  // Check if it's a Node.js project first
  const isNode = await isNodeProject(projectPath);
  if (isNode) {
    try {
      const serverInfo = await startNodeServer(projectName, projectPath);
      res.json({ 
        hasIndex: false, 
        isNodeServer: true, 
        serverUrl: serverInfo.url,
        port: serverInfo.port 
      });
    } catch (error) {
      res.json({ 
        hasIndex: false, 
        isNodeServer: true, 
        error: error.message 
      });
    }
  } else {
    const hasIndex = await hasIndexHtml(projectPath);
    res.json({ hasIndex, isNodeServer: false });
  }
});

// Routes
app.get('/', async (req, res) => {
  const html = generateLandingHTML();
  res.send(html);
});

app.get('/grid', async (req, res) => {
  try {
    await ensureClaudeDir();
    
    const config = await loadProjectsConfig();
    const files = await fs.readdir(DESKTOP_PATH);
    
    // Filter and get project info
    const projectPromises = files
      .filter(file => !file.startsWith('.') && !file.endsWith('.png') && !file.endsWith('.app') && !file.endsWith('.zip') && !file.endsWith('.pdf') && !file.endsWith('.json') && !file.endsWith('.xml') && !file.endsWith('.log') && !file.endsWith('.sh') && !file.endsWith('.go') && !file.endsWith('.html') && !file.endsWith('.md') && !file.endsWith('.yaml') && !file.startsWith('Screenshot'))
      .map(file => getProjectInfo(file));
    
    let projects = (await Promise.all(projectPromises))
      .filter(p => p !== null);
    
    // Apply organization if exists
    if (config.organized && config.clusters) {
      // Add cluster info to projects
      projects = projects.map(project => {
        for (const cluster of config.clusters) {
          if (cluster.projects.includes(project.name)) {
            return { ...project, cluster: cluster.name, priority: cluster.priority };
          }
        }
        return project;
      });
      
      // Sort by priority then by last modified
      projects.sort((a, b) => {
        if (a.priority && b.priority) {
          return a.priority - b.priority;
        }
        if (a.priority) return -1;
        if (b.priority) return 1;
        return b.lastModified - a.lastModified;
      });
    } else {
      // Default sort by last modified
      projects.sort((a, b) => b.lastModified - a.lastModified);
    }
    
    const html = generateGridHTML(projects, config);
    res.send(html);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send(`
      <html>
        <head><title>Error</title></head>
        <body>
          <h1>Error loading projects</h1>
          <pre>${error.message}</pre>
        </body>
      </html>
    `);
  }
});

app.get('/workspace', async (req, res) => {
  try {
    await ensureClaudeDir();
    
    const config = await loadProjectsConfig();
    const files = await fs.readdir(DESKTOP_PATH);
    
    // Filter and get project info
    const projectPromises = files
      .filter(file => !file.startsWith('.') && 
                     !file.endsWith('.png') && 
                     !file.endsWith('.app') && 
                     !file.endsWith('.zip') && 
                     !file.endsWith('.pdf') && 
                     !file.endsWith('.json') && 
                     !file.endsWith('.xml') && 
                     !file.endsWith('.log') && 
                     !file.endsWith('.sh') && 
                     !file.endsWith('.go') && 
                     !file.endsWith('.html') && 
                     !file.endsWith('.md') && 
                     !file.endsWith('.yaml') && 
                     !file.startsWith('Screenshot'))
      .map(file => getProjectInfo(file));
    
    let projects = (await Promise.all(projectPromises))
      .filter(p => p !== null);
    
    // Apply organization and sorting
    if (config.customOrder && config.customOrder.length > 0) {
      // Use custom order from drag-and-drop
      projects.sort((a, b) => {
        const indexA = config.customOrder.indexOf(a.name);
        const indexB = config.customOrder.indexOf(b.name);
        if (indexA === -1 && indexB === -1) return b.lastModified - a.lastModified;
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });
    } else if (config.organized && config.clusters) {
      // Add cluster info to projects
      projects = projects.map(project => {
        for (const cluster of config.clusters) {
          if (cluster.projects.includes(project.name)) {
            return { ...project, cluster: cluster.name, priority: cluster.priority };
          }
        }
        return project;
      });
      
      // Sort by priority then by last modified
      projects.sort((a, b) => {
        if (a.priority && b.priority) {
          return a.priority - b.priority;
        }
        if (a.priority) return -1;
        if (b.priority) return 1;
        return b.lastModified - a.lastModified;
      });
    } else {
      // Default sort by last modified
      projects.sort((a, b) => b.lastModified - a.lastModified);
    }
    
    const html = generateWorkspaceHTML(projects, config);
    res.send(html);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send(`
      <html>
        <head><title>Error</title></head>
        <body style="background: #1a1a1a; color: #e0e0e0; font-family: monospace; padding: 20px;">
          <h1>Error loading workspace</h1>
          <pre>${error.message}</pre>
        </body>
      </html>
    `);
  }
});

// Initialize
ensureClaudeDir().then(async () => {
  await loadTerminalStatesFromDisk(); // Load saved states on startup
  server.listen(PORT, () => {
    console.log(`🚀 Unified Dashboard server running at http://localhost:${PORT}`);
    console.log(`📁 Serving projects from: ${DESKTOP_PATH}`);
    console.log(`🖥️  Terminal support enabled with session persistence`);
    console.log(`👁️  File watching enabled for auto-refresh`);
    console.log(`💾 Session states saved to: ${CLAUDE_STATUS_DIR}`);
    console.log(`🎯 Project organization loaded from: ${PROJECTS_CONFIG_FILE}`);
    console.log(`📌 Use Ctrl+C for graceful shutdown`);
    console.log(`\n🎨 Available Views:`);
    console.log(`   / - Landing page with view selector`);
    console.log(`   /grid - Card-based grid view with organization`);
    console.log(`   /workspace - IDE-like workspace with panels`);
    console.log(`\n⌨️  Features:`);
    console.log(`   • Single WebSocket server (no path conflicts)`);
    console.log(`   • Terminal persistence across views`);
    console.log(`   • Resizable & collapsible panels`);
    console.log(`   • Layout switching (horizontal/vertical)`);
    console.log(`   • Auto file watching and preview refresh`);
    console.log(`   • Drag-and-drop project organization`);
    console.log(`   • Layout preferences saved to localStorage`);
  });
});