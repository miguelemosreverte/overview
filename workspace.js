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

const app = express();
app.use(express.json());
const PORT = 3001;
const DESKTOP_PATH = '/Users/miguel_lemos/Desktop';
const CLAUDE_STATUS_DIR = path.join(DESKTOP_PATH, '.claude');
const PROJECTS_CONFIG_FILE = path.join(DESKTOP_PATH, 'projects.yaml');

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for terminal sessions
const wss = new WebSocket.Server({ server, path: '/terminal' });

// WebSocket server for file watching
const fileWss = new WebSocket.Server({ server, path: '/file-watcher' });

// Store active terminal sessions - these persist across minimize/maximize
const terminals = new Map();
const terminalStates = new Map(); // Track state for each project
const fileWatchers = new Map(); // Track file watchers for projects

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

// Ensure .claude directory exists
async function ensureClaudeDir() {
  try {
    await fs.mkdir(CLAUDE_STATUS_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating .claude directory:', error);
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

// Get project info
async function getProjectInfo(dirName) {
  const fullPath = path.join(DESKTOP_PATH, dirName);
  
  try {
    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory()) {
      return null;
    }
    
    const metadata = projectDescriptions[dirName] || {
      tech: 'Unknown',
      description: 'No description available.',
      category: 'Uncategorized',
      icon: '📁'
    };
    
    return {
      name: dirName,
      path: fullPath,
      lastModified: stats.mtime,
      ...metadata
    };
  } catch (error) {
    return null;
  }
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

// Setup file watcher for a project
function setupFileWatcher(projectName, projectPath) {
  const watcherId = projectName;
  
  // Clean up existing watcher if any
  if (fileWatchers.has(watcherId)) {
    fileWatchers.get(watcherId).close();
    fileWatchers.delete(watcherId);
  }
  
  const indexPath = path.join(projectPath, 'index.html');
  
  const watcher = chokidar.watch(indexPath, {
    persistent: true,
    ignoreInitial: true
  });
  
  watcher.on('change', () => {
    // Notify all connected file watcher clients
    fileWss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'file-changed',
          project: projectName,
          file: 'index.html'
        }));
      }
    });
  });
  
  fileWatchers.set(watcherId, watcher);
  return watcher;
}

// Handle WebSocket connections for file watching
fileWss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    
    if (msg.type === 'watch-project') {
      setupFileWatcher(msg.projectName, msg.projectPath);
    }
  });
});

// Handle WebSocket connections for terminals
wss.on('connection', (ws) => {
  let currentProjectId = null;
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    
    if (msg.type === 'start' || msg.type === 'restore') {
      currentProjectId = msg.id;
      const projectPath = msg.path;
      const projectName = msg.name;
      
      // Check if we already have a terminal for this project
      let term = terminals.get(currentProjectId);
      
      if (!term) {
        // Check if we should continue a previous session
        const hasExistingSession = msg.isRestoring || terminalStates.get(currentProjectId);
        const claudeArgs = hasExistingSession ? 
          ['--continue', '--dangerously-skip-permissions'] : 
          ['--dangerously-skip-permissions'];
        
        // Create new PTY process
        term = pty.spawn('claude', claudeArgs, {
          name: 'xterm-256color',
          cols: 80,
          rows: 30,
          cwd: projectPath,
          env: process.env
        });
        
        terminals.set(currentProjectId, term);
        terminalStates.set(currentProjectId, {
          projectPath,
          projectName,
          active: true,
          startTime: new Date(),
          buffer: []
        });
        
        // Send output to WebSocket
        term.onData((data) => {
          // Store in buffer for reconnection
          const state = terminalStates.get(currentProjectId);
          if (state) {
            if (!state.buffer) {
              state.buffer = [];
            }
            state.buffer.push(data);
            
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
          
          // Broadcast to all connected clients watching this terminal
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ 
                type: 'output', 
                id: currentProjectId,
                data 
              }));
            }
          });
        });
        
        // Handle exit
        term.onExit(() => {
          // Save state before removing
          const state = terminalStates.get(currentProjectId);
          if (state) {
            saveConversationState(state.projectPath, state.projectName);
          }
          
          terminals.delete(currentProjectId);
          terminalStates.delete(currentProjectId);
          
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ 
                type: 'exit',
                id: currentProjectId 
              }));
            }
          });
        });
      } else {
        // Terminal already exists - we're reconnecting
        const state = terminalStates.get(currentProjectId);
        if (state) {
          if (!state.buffer) {
            state.buffer = [];
          }
          
          // Send buffered output to catch up the client
          if (state.buffer.length > 0) {
            ws.send(JSON.stringify({
              type: 'output',
              id: currentProjectId,
              data: '\x1b[2J\x1b[H'
            }));
            
            setTimeout(() => {
              state.buffer.forEach(chunk => {
                ws.send(JSON.stringify({
                  type: 'output',
                  id: currentProjectId,
                  data: chunk
                }));
              });
            }, 100);
          }
        }
      }
      
      ws.projectId = currentProjectId;
      ws.send(JSON.stringify({ type: 'ready', id: currentProjectId }));
      
    } else if (msg.type === 'input') {
      const term = terminals.get(msg.id || ws.projectId);
      if (term) {
        term.write(msg.data);
      }
    } else if (msg.type === 'resize') {
      const term = terminals.get(msg.id || ws.projectId);
      if (term) {
        term.resize(msg.cols, msg.rows);
      }
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket closed for project:', ws.projectId);
  });
});

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

app.get('/api/project/:projectName/has-index', async (req, res) => {
  const projectName = decodeURIComponent(req.params.projectName);
  const projectPath = path.join(DESKTOP_PATH, projectName);
  const hasIndex = await hasIndexHtml(projectPath);
  res.json({ hasIndex });
});

// Graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  
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

// HTML template for workspace
const generateWorkspaceHTML = (projects, config) => {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Workspace</title>
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
        }
        
        .sidebar {
            width: 20%;
            min-width: 250px;
            background: #2a2a2a;
            border-right: 1px solid #404040;
            display: flex;
            flex-direction: column;
            resize: horizontal;
            overflow: hidden;
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
            background: #4a9eff;
            color: white;
            border-color: #6bb6ff;
        }
        
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
        
        .center-panel {
            width: 40%;
            min-width: 300px;
            background: #1e1e1e;
            border-right: 1px solid #404040;
            display: flex;
            flex-direction: column;
            resize: horizontal;
            overflow: hidden;
        }
        
        .terminal-header {
            padding: 10px 15px;
            background: #333;
            border-bottom: 1px solid #404040;
            display: flex;
            justify-content: between;
            align-items: center;
        }
        
        .terminal-title {
            font-size: 14px;
            font-weight: 500;
            color: #fff;
        }
        
        .terminal-container {
            flex: 1;
            overflow: hidden;
            position: relative;
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
        
        .right-panel {
            width: 40%;
            min-width: 300px;
            background: #1a1a1a;
            display: flex;
            flex-direction: column;
            resize: horizontal;
            overflow: hidden;
        }
        
        .preview-header {
            padding: 10px 15px;
            background: #333;
            border-bottom: 1px solid #404040;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .preview-title {
            font-size: 14px;
            font-weight: 500;
            color: #fff;
        }
        
        .refresh-btn {
            background: #4a9eff;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }
        
        .refresh-btn:hover {
            background: #6bb6ff;
        }
        
        .preview-container {
            flex: 1;
            overflow: hidden;
            position: relative;
        }
        
        .preview-iframe {
            width: 100%;
            height: 100%;
            border: none;
            background: white;
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
        
        .resize-handle {
            width: 5px;
            background: #404040;
            cursor: col-resize;
            transition: background-color 0.2s;
        }
        
        .resize-handle:hover {
            background: #555;
        }
        
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
    </style>
</head>
<body>
    <div class="workspace">
        <!-- Left Sidebar -->
        <div class="sidebar">
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
                  
                  const shortcut = index < 3 ? `<span class="keyboard-shortcut">${index + 1}</span>` : '';
                  
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
        
        <!-- Center Panel -->
        <div class="center-panel">
            <div class="terminal-header">
                <div class="terminal-title" id="terminalTitle">Claude Terminal</div>
            </div>
            <div class="terminal-container" id="terminalContainer">
                <div class="terminal-placeholder">
                    <i class="fas fa-terminal"></i>
                    <h3>Select a project to start</h3>
                    <p>Choose a project from the sidebar to launch Claude terminal</p>
                </div>
            </div>
        </div>
        
        <!-- Right Panel -->
        <div class="right-panel">
            <div class="preview-header">
                <div class="preview-title" id="previewTitle">Preview</div>
                <button class="refresh-btn" id="refreshBtn" onclick="refreshPreview()" style="display: none;">
                    <i class="fas fa-sync-alt"></i> Refresh
                </button>
            </div>
            <div class="preview-container" id="previewContainer">
                <div class="preview-placeholder">
                    <i class="fas fa-eye"></i>
                    <h3>No preview available</h3>
                    <p>Select a project with index.html to see live preview</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentProject = null;
        let currentTerminal = null;
        let currentWs = null;
        let fileWs = null;
        const projects = ${JSON.stringify(projects.filter(p => !config.hiddenProjects?.includes(p.name)))};
        
        // Initialize WebSocket connections
        function initializeWebSockets() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            
            // File watcher WebSocket
            fileWs = new WebSocket(protocol + '//' + window.location.host + '/file-watcher');
            fileWs.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'file-changed' && msg.project === currentProject?.name) {
                    refreshPreview();
                }
            };
        }
        
        // Project selection
        function selectProject(projectName, projectPath) {
            // Update active project
            document.querySelectorAll('.project-item').forEach(item => {
                item.classList.remove('active');
            });
            document.querySelector(\`[data-project="\${projectName}"]\`).classList.add('active');
            
            const project = projects.find(p => p.name === projectName);
            currentProject = project;
            
            // Update terminal
            startTerminal(projectName, projectPath);
            
            // Update preview
            updatePreview(projectName, projectPath);
            
            // Setup file watcher if needed
            if (fileWs && fileWs.readyState === WebSocket.OPEN) {
                fileWs.send(JSON.stringify({
                    type: 'watch-project',
                    projectName: projectName,
                    projectPath: projectPath
                }));
            }
        }
        
        // Start terminal for project
        function startTerminal(projectName, projectPath) {
            const container = document.getElementById('terminalContainer');
            const title = document.getElementById('terminalTitle');
            
            title.textContent = \`Claude Terminal - \${projectName}\`;
            container.innerHTML = '<div id="terminal"></div>';
            
            // Close existing connection
            if (currentWs) {
                currentWs.close();
            }
            
            // Create new terminal
            currentTerminal = new Terminal({
                cursorBlink: true,
                fontSize: 14,
                fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                theme: {
                    background: '#1e1e1e',
                    foreground: '#d4d4d4'
                }
            });
            
            const fitAddon = new FitAddon.FitAddon();
            currentTerminal.loadAddon(fitAddon);
            currentTerminal.open(document.getElementById('terminal'));
            fitAddon.fit();
            
            // WebSocket connection
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            currentWs = new WebSocket(protocol + '//' + window.location.host + '/terminal');
            
            currentWs.onopen = () => {
                currentWs.send(JSON.stringify({
                    type: 'start',
                    id: projectName.replace(/[^a-zA-Z0-9]/g, '_'),
                    path: projectPath,
                    name: projectName
                }));
            };
            
            currentWs.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'output') {
                    currentTerminal.write(msg.data);
                } else if (msg.type === 'exit') {
                    currentTerminal.write('\\r\\n\\x1b[31mClaude session ended.\\x1b[0m\\r\\n');
                }
            };
            
            currentWs.onerror = () => {
                currentTerminal.write('\\r\\n\\x1b[31mConnection error. Please try again.\\x1b[0m\\r\\n');
            };
            
            currentTerminal.onData((data) => {
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                    currentWs.send(JSON.stringify({
                        type: 'input',
                        id: projectName.replace(/[^a-zA-Z0-9]/g, '_'),
                        data: data
                    }));
                }
            });
            
            // Handle resize
            window.addEventListener('resize', () => {
                fitAddon.fit();
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                    currentWs.send(JSON.stringify({
                        type: 'resize',
                        id: projectName.replace(/[^a-zA-Z0-9]/g, '_'),
                        cols: currentTerminal.cols,
                        rows: currentTerminal.rows
                    }));
                }
            });
        }
        
        // Update preview panel
        async function updatePreview(projectName, projectPath) {
            const container = document.getElementById('previewContainer');
            const title = document.getElementById('previewTitle');
            const refreshBtn = document.getElementById('refreshBtn');
            
            title.textContent = \`Preview - \${projectName}\`;
            
            try {
                const response = await fetch(\`/api/project/\${encodeURIComponent(projectName)}/has-index\`);
                const data = await response.json();
                
                if (data.hasIndex) {
                    container.innerHTML = \`<iframe class="preview-iframe" src="/project/\${encodeURIComponent(projectName)}/index.html" id="previewIframe"></iframe>\`;
                    refreshBtn.style.display = 'block';
                } else {
                    container.innerHTML = \`
                        <div class="preview-placeholder">
                            <i class="fas fa-file-code"></i>
                            <h3>No index.html found</h3>
                            <p>Create an index.html file in \${projectName} to see live preview</p>
                        </div>
                    \`;
                    refreshBtn.style.display = 'none';
                }
            } catch (error) {
                container.innerHTML = \`
                    <div class="preview-placeholder">
                        <i class="fas fa-exclamation-triangle"></i>
                        <h3>Preview Error</h3>
                        <p>Could not load preview for \${projectName}</p>
                    </div>
                \`;
                refreshBtn.style.display = 'none';
            }
        }
        
        // Refresh preview iframe
        function refreshPreview() {
            const iframe = document.getElementById('previewIframe');
            if (iframe) {
                iframe.src = iframe.src;
            }
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
            item.addEventListener('click', () => {
                const projectName = item.dataset.project;
                const projectPath = item.dataset.path;
                selectProject(projectName, projectPath);
            });
        });
        
        // Make panels resizable
        function makeResizable() {
            const sidebar = document.querySelector('.sidebar');
            const centerPanel = document.querySelector('.center-panel');
            const rightPanel = document.querySelector('.right-panel');
            
            let isResizing = false;
            let startX, startWidth, targetElement;
            
            // Add resize handles
            sidebar.style.resize = 'horizontal';
            centerPanel.style.resize = 'horizontal';
            
            // Custom resize logic for better control
            function startResize(e, element) {
                isResizing = true;
                startX = e.clientX;
                startWidth = parseInt(getComputedStyle(element).width, 10);
                targetElement = element;
                e.preventDefault();
            }
            
            function doResize(e) {
                if (!isResizing) return;
                
                const dx = e.clientX - startX;
                const newWidth = Math.max(250, Math.min(startWidth + dx, window.innerWidth * 0.6));
                targetElement.style.width = newWidth + 'px';
            }
            
            function stopResize() {
                isResizing = false;
                targetElement = null;
            }
            
            document.addEventListener('mousemove', doResize);
            document.addEventListener('mouseup', stopResize);
        }
        
        // Initialize
        initializeWebSockets();
        makeResizable();
        
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
        
        makeProjectsSortable();
        
        // Auto-select first project if available
        const firstProject = document.querySelector('.project-item');
        if (firstProject) {
            setTimeout(() => {
                firstProject.click();
            }, 500);
        }
    </script>
</body>
</html>
`;
};

// Main route
app.get('/', async (req, res) => {
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
ensureClaudeDir().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Workspace server running at http://localhost:${PORT}`);
    console.log(`📁 Serving projects from: ${DESKTOP_PATH}`);
    console.log(`🖥️  Terminal support enabled with session persistence`);
    console.log(`👁️  File watching enabled for auto-refresh`);
    console.log(`💾 Session states saved to: ${CLAUDE_STATUS_DIR}`);
    console.log(`🎯 Project organization loaded from: ${PROJECTS_CONFIG_FILE}`);
    console.log(`📌 Use Ctrl+C for graceful shutdown`);
    console.log(`\n⌨️  Keyboard shortcuts:`);
    console.log(`   1, 2, 3 - Switch to top 3 projects`);
    console.log(`   Search - Filter projects in sidebar`);
  });
});